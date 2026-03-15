/**
 * 注文マネージャー（9:20 JST / 平日）
 *
 * 「ロジックが主役、AIが最終審判」フロー:
 * 1. 今日のMarketAssessmentを確認（shouldTrade = true のみ）
 * 2. 各銘柄のテクニカル分析 + スコアリング
 * 3. ロジックでエントリー条件算出（指値・利確・損切り・数量）
 * 4. AIレビュー（承認/修正/却下）
 * 5. 損切り検証（AIが修正した場合も再検証）
 * 6. リスクチェック
 * 7. TradingOrder作成（pending状態）
 * 8. Slackに注文内容を通知
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/date-utils";
import {
  TRADING_SCHEDULE,
  ORDER_EXPIRY,
  TECHNICAL_MIN_DATA,
  JOB_CONCURRENCY,
  DEFENSIVE_MODE,
  WEEKEND_RISK,
} from "../lib/constants";
import { countNonTradingDaysAhead } from "../lib/market-calendar";
import { fetchStockQuote, fetchHistoricalData } from "../core/market-data";
import { analyzeTechnicals } from "../core/technical-analysis";
import type { TechnicalSummary } from "../core/technical-analysis";
import { scoreStock, formatScoreForAI } from "../core/scoring";
import type { NewLogicScore } from "../core/scoring";
import { calculateEntryCondition } from "../core/entry-calculator";
import type { EntryCondition } from "../core/entry-calculator";
import { reviewTrade } from "../core/ai-decision";
import type {
  MarketAssessmentResult,
  TradeReviewResult,
} from "../core/ai-decision";
import { canOpenPosition, validateStopLoss } from "../core/risk-manager";
import { getCashBalance } from "../core/position-manager";
import { notifyOrderPlaced, notifyRiskAlert, notifySlack } from "../lib/slack";
import { getSectorGroup } from "../lib/constants";
import type { EntrySnapshot } from "../types/snapshots";
import dayjs from "dayjs";
import pLimit from "p-limit";

/** フェーズ1（並列分析）の結果型 */
interface AnalysisResult {
  tickerCode: string;
  stockId: string;
  stockName: string;
  sector: string;
  latestVolume: number;
  quote: { price: number };
  techSummary: TechnicalSummary;
  score: NewLogicScore;
  entryCondition: EntryCondition;
  review: TradeReviewResult;
  newsContext: string | undefined;
  strategy: "day_trade" | "swing";
}

export async function main() {
  console.log("=== Order Manager 開始 ===");

  // 1. 今日のMarketAssessmentを取得
  const todayAssessment = await prisma.marketAssessment.findUnique({
    where: { date: getTodayForDB() },
  });

  if (!todayAssessment) {
    console.log(
      "今日のMarketAssessmentがありません。market-scannerを先に実行してください。",
    );
    return;
  }

  if (!todayAssessment.shouldTrade) {
    console.log("今日は取引見送りです。");
    return;
  }

  // ディフェンシブモード（bearish/crisis）: 新規買い注文を作らない
  const isDefensiveMode =
    todayAssessment.sentiment != null &&
    DEFENSIVE_MODE.ENABLED_SENTIMENTS.includes(todayAssessment.sentiment);
  if (isDefensiveMode) {
    console.log(
      `ディフェンシブモード（${todayAssessment.sentiment}）のため新規買い注文を見送ります。`,
    );
    return;
  }

  const selectedStocks = todayAssessment.selectedStocks as Array<{
    tickerCode: string;
    strategy: string;
    reasoning: string;
    technicalScore?: number;
    technicalRank?: string;
    riskFlags?: string[];
  }> | null;

  if (!selectedStocks || selectedStocks.length === 0) {
    console.log("選定銘柄がありません。");
    return;
  }

  // 1.5. 当日選定外のpending買い注文をキャンセル
  const selectedTickerCodes = new Set(selectedStocks.map((s) => s.tickerCode));
  const pendingBuyOrders = await prisma.tradingOrder.findMany({
    where: { side: "buy", status: "pending" },
    include: { stock: true },
  });
  const staleOrders = pendingBuyOrders.filter(
    (o) => !selectedTickerCodes.has(o.stock.tickerCode),
  );
  if (staleOrders.length > 0) {
    await prisma.tradingOrder.updateMany({
      where: { id: { in: staleOrders.map((o) => o.id) } },
      data: { status: "cancelled" },
    });
    for (const o of staleOrders) {
      console.log(
        `  [${o.stock.tickerCode}] 当日選定外のためpending注文キャンセル (order: ${o.id})`,
      );
    }
    console.log(`  選定外pending注文キャンセル: ${staleOrders.length}件`);
  }

  // 2. 残高を取得（ループ内で注文作成ごとに減算する）
  let cashBalance = await getCashBalance();

  const assessment: MarketAssessmentResult = {
    shouldTrade: todayAssessment.shouldTrade,
    sentiment:
      todayAssessment.sentiment as MarketAssessmentResult["sentiment"],
    reasoning: todayAssessment.reasoning,
  };

  // TradingConfig から maxPositionPct を取得
  const config = await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });
  const maxPositionPct = config ? Number(config.maxPositionPct) : 30;

  // ニュース分析データ取得
  const newsAnalysis = await prisma.newsAnalysis.findUnique({
    where: { date: getTodayForDB() },
  });
  const stockCatalysts = newsAnalysis?.stockCatalysts as
    | Array<{ tickerCode: string; type: string; summary: string }>
    | undefined;

  console.log(
    `  選定銘柄数: ${selectedStocks.length}, 現金残高: ¥${cashBalance.toLocaleString()}`,
  );

  // =========================================
  // フェーズ1: 並列分析（データ取得 → スコアリング → AIレビュー）
  // =========================================
  console.log(`\n  [フェーズ1] 並列分析開始（同時実行数: ${JOB_CONCURRENCY.ORDER_MANAGER}）`);

  // 週末リスク: 金曜/連休前はポジションサイズを縮小
  const nonTradingDays = countNonTradingDaysAhead();
  const isWeekendRisk = nonTradingDays >= WEEKEND_RISK.SIZE_REDUCTION_THRESHOLD;
  if (isWeekendRisk) {
    console.log(
      `  週末リスク: ポジションサイズ50%に縮小（非営業日: ${nonTradingDays}日）`,
    );
  }

  const limit = pLimit(JOB_CONCURRENCY.ORDER_MANAGER);

  const analysisResults = await Promise.all(
    selectedStocks.map((selected) =>
      limit(async (): Promise<AnalysisResult | null> => {
        const { tickerCode } = selected;

        // 銘柄データ取得
        const stock = await prisma.stock.findUnique({
          where: { tickerCode },
        });
        if (!stock) {
          console.log(`    [${tickerCode}] 銘柄マスタに存在しません`);
          return null;
        }

        // 同一銘柄の既存ポジションまたはpending買い注文があればスキップ
        const existingPosition = await prisma.tradingPosition.findFirst({
          where: { stockId: stock.id, status: "open" },
        });
        if (existingPosition) {
          console.log(`    [${tickerCode}] 既存ポジションあり、スキップ`);
          return null;
        }

        const pendingBuyOrder = await prisma.tradingOrder.findFirst({
          where: { stockId: stock.id, side: "buy", status: "pending" },
        });
        if (pendingBuyOrder) {
          console.log(`    [${tickerCode}] pending買い注文あり、スキップ`);
          return null;
        }

        const quote = await fetchStockQuote(tickerCode);
        if (!quote) {
          console.log(`    [${tickerCode}] 株価取得失敗`);
          return null;
        }

        // テクニカル分析 + スコアリング
        const historical = await fetchHistoricalData(tickerCode);
        if (
          !historical ||
          historical.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS
        ) {
          console.log(`    [${tickerCode}] ヒストリカルデータ不足`);
          return null;
        }

        const techSummary = analyzeTechnicals(historical);

        // 新3カテゴリスコアリング
        const score = scoreStock({
          historicalData: historical,
          latestPrice: quote.price,
          latestVolume: Number(stock.latestVolume ?? 0),
          weeklyVolatility: stock.volatility ? Number(stock.volatility) : null,
          avgVolume25: techSummary.volumeAnalysis.avgVolume20,
          summary: techSummary,
        });

        const strategy = selected.strategy as "day_trade" | "swing";

        const budgetForSizing = isWeekendRisk
          ? cashBalance * WEEKEND_RISK.POSITION_SIZE_MULTIPLIER
          : cashBalance;

        const entryCondition = calculateEntryCondition(
          quote.price,
          techSummary,
          score,
          strategy,
          budgetForSizing,
          maxPositionPct,
          historical,
        );

        if (entryCondition.quantity === 0) {
          console.log(`    [${tickerCode}] 予算不足でスキップ`);
          return null;
        }

        // 銘柄別ニュースコンテキスト
        const catalysts = stockCatalysts?.filter(
          (c) => c.tickerCode === tickerCode,
        );
        const newsContext =
          catalysts && catalysts.length > 0
            ? catalysts.map((c) => `[${c.type}] ${c.summary}`).join("\n")
            : undefined;

        // AIレビュー
        const scoreFormatted = formatScoreForAI(score, techSummary);
        const review = await reviewTrade(
          {
            tickerCode,
            name: stock.name,
            price: quote.price,
            sector: getSectorGroup(stock.sector) ?? stock.sector ?? "不明",
            scoreFormatted,
            newsContext,
          },
          entryCondition,
          assessment,
        );

        if (review.decision === "reject") {
          console.log(`    [${tickerCode}] AI却下: ${review.reasoning}`);
          return null;
        }

        return {
          tickerCode,
          stockId: stock.id,
          stockName: stock.name,
          sector: stock.sector ?? "不明",
          latestVolume: Number(stock.latestVolume ?? 0),
          quote,
          techSummary,
          score,
          entryCondition,
          review,
          newsContext,
          strategy,
        };
      }),
    ),
  );

  const passed = analysisResults.filter(
    (r): r is AnalysisResult => r !== null,
  );

  console.log(
    `  [フェーズ1] 分析完了: ${selectedStocks.length}銘柄中 ${passed.length}銘柄が条件通過`,
  );

  // =========================================
  // フェーズ2: 直列注文作成（スコア順 → リスク品質タイブレーク）
  // =========================================
  passed.sort((a, b) => {
    // 第1キー: totalScore 降順
    if (b.score.totalScore !== a.score.totalScore) {
      return b.score.totalScore - a.score.totalScore;
    }
    // 第2キー: リスク品質スコア 降順（タイブレーク）
    if (b.score.riskQuality.total !== a.score.riskQuality.total) {
      return b.score.riskQuality.total - a.score.riskQuality.total;
    }
    // 第3キー: 出来高実数値 降順
    return b.latestVolume - a.latestVolume;
  });

  console.log(`\n  [フェーズ2] 注文作成開始（スコア順）`);

  let ordersCreated = 0;

  for (const result of passed) {
    const {
      tickerCode,
      stockId,
      stockName,
      techSummary,
      score,
      entryCondition,
      review,
      newsContext,
    } = result;

    console.log(
      `\n  [${tickerCode}] スコア: ${score.totalScore}点（${score.rank}） / リスク品質: ${score.riskQuality.total}点`,
    );
    console.log(
      `    → ロジック算出: 指値¥${entryCondition.limitPrice} / 利確¥${entryCondition.takeProfitPrice} / 損切¥${entryCondition.stopLossPrice} / ${entryCondition.quantity}株 / RR 1:${entryCondition.riskRewardRatio}`,
    );
    console.log(`    → AIレビュー: ${review.decision}`);

    // AIの修正を適用
    const finalCondition = { ...entryCondition };
    if (
      review.decision === "approve_with_modification" &&
      review.modification
    ) {
      if (review.modification.adjustLimitPrice != null) {
        finalCondition.limitPrice = review.modification.adjustLimitPrice;
        console.log(
          `    → 指値修正: ¥${entryCondition.limitPrice} → ¥${finalCondition.limitPrice}`,
        );
      }
      if (review.modification.adjustTakeProfitPrice != null) {
        finalCondition.takeProfitPrice =
          review.modification.adjustTakeProfitPrice;
        console.log(
          `    → 利確修正: ¥${entryCondition.takeProfitPrice} → ¥${finalCondition.takeProfitPrice}`,
        );
      }
      if (review.modification.adjustQuantity != null) {
        finalCondition.quantity = review.modification.adjustQuantity;
        console.log(
          `    → 数量修正: ${entryCondition.quantity} → ${finalCondition.quantity}株`,
        );
      }

      // 損切り: AIが修正した場合でもロジックで再検証
      if (review.modification.adjustStopLossPrice != null) {
        const reValidation = validateStopLoss(
          finalCondition.limitPrice,
          review.modification.adjustStopLossPrice,
          techSummary.atr14,
          techSummary.supports,
        );
        finalCondition.stopLossPrice = Math.round(
          reValidation.validatedPrice,
        );
        if (reValidation.wasOverridden) {
          console.log(
            `    → 損切り修正（AI→ロジック再検証）: ¥${review.modification.adjustStopLossPrice} → ¥${finalCondition.stopLossPrice}（${reValidation.reason}）`,
          );
        } else {
          console.log(
            `    → 損切り修正: ¥${entryCondition.stopLossPrice} → ¥${finalCondition.stopLossPrice}`,
          );
        }
      }
    }

    // リスクチェック（DB最新状態を参照）
    const riskCheck = await canOpenPosition(
      stockId,
      finalCondition.quantity,
      finalCondition.limitPrice,
      result.strategy,
    );

    if (!riskCheck.allowed) {
      console.log(`    → リスクチェック不可: ${riskCheck.reason}`);
      await notifyRiskAlert({
        type: "注文制限",
        message: `${tickerCode} ${stockName}: ${riskCheck.reason}`,
      });
      continue;
    }

    // 残高チェック（並列分析時は初期値で算出しているため再確認）
    const requiredAmount = finalCondition.limitPrice * finalCondition.quantity;
    if (cashBalance < requiredAmount) {
      console.log(
        `    → 残高不足でスキップ（必要: ¥${requiredAmount.toLocaleString()} / 残高: ¥${cashBalance.toLocaleString()}）`,
      );
      continue;
    }

    // 注文有効期限設定
    const now = dayjs();
    let expiresAt: Date;

    if (finalCondition.strategy === "day_trade") {
      expiresAt = now
        .hour(TRADING_SCHEDULE.DAY_TRADE_FORCE_EXIT.hour)
        .minute(TRADING_SCHEDULE.DAY_TRADE_FORCE_EXIT.minute)
        .second(0)
        .toDate();
    } else {
      expiresAt = now
        .add(ORDER_EXPIRY.SWING_DAYS, "day")
        .hour(15)
        .minute(0)
        .second(0)
        .toDate();
    }

    // エントリースナップショット構築
    const entrySnapshot: EntrySnapshot = {
      score: {
        totalScore: score.totalScore,
        rank: score.rank,
        gate: score.gate,
        trendQuality: score.trendQuality,
        entryTiming: score.entryTiming,
        riskQuality: score.riskQuality,
        isDisqualified: score.isDisqualified,
        disqualifyReason: score.disqualifyReason,
      },
      technicals: {
        rsi: techSummary.rsi,
        sma5: techSummary.sma5,
        sma25: techSummary.sma25,
        sma75: techSummary.sma75,
        macd: techSummary.macd,
        bollingerBands: techSummary.bollingerBands,
        atr14: techSummary.atr14,
        volumeRatio: techSummary.volumeAnalysis.volumeRatio,
        deviationRate25: techSummary.deviationRate25,
        maAlignment: techSummary.maAlignment,
        supports: techSummary.supports,
        resistances: techSummary.resistances,
      },
      logicEntryCondition: entryCondition,
      aiReview: {
        decision: review.decision,
        reasoning: review.reasoning,
        modification: review.modification,
        riskFlags: review.riskFlags,
      },
      marketContext: {
        sentiment: assessment.sentiment,
        reasoning: assessment.reasoning.slice(0, 500),
      },
      newsContext: newsContext ?? null,
    };

    // TradingOrder作成
    await prisma.tradingOrder.create({
      data: {
        stockId,
        side: "buy",
        orderType: "limit",
        strategy: finalCondition.strategy,
        limitPrice: finalCondition.limitPrice,
        takeProfitPrice: finalCondition.takeProfitPrice,
        stopLossPrice: finalCondition.stopLossPrice,
        quantity: finalCondition.quantity,
        status: "pending",
        reasoning: review.reasoning,
        expiresAt,
        entrySnapshot: entrySnapshot as object,
      },
    });

    ordersCreated++;
    cashBalance -= requiredAmount;

    // Slack通知
    await notifyOrderPlaced({
      tickerCode,
      name: stockName,
      side: "buy",
      strategy: finalCondition.strategy,
      limitPrice: finalCondition.limitPrice,
      takeProfitPrice: finalCondition.takeProfitPrice,
      stopLossPrice: finalCondition.stopLossPrice,
      quantity: finalCondition.quantity,
      reasoning: review.reasoning,
    });
  }

  console.log(`\n  注文作成数: ${ordersCreated}`);

  // サマリー通知
  await notifySlack({
    title: `📋 注文マネージャー完了`,
    message:
      ordersCreated > 0
        ? `${selectedStocks.length}銘柄を分析し、${ordersCreated}件の注文を発行しました`
        : `${selectedStocks.length}銘柄を分析しましたが、注文条件を満たす銘柄はありませんでした`,
    color: ordersCreated > 0 ? "good" : "#808080",
    fields: [
      {
        title: "分析銘柄数",
        value: `${selectedStocks.length}件`,
        short: true,
      },
      { title: "注文作成数", value: `${ordersCreated}件`, short: true },
    ],
  });

  console.log("=== Order Manager 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("order-manager");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Order Manager エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
