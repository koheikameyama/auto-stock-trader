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
} from "../lib/constants";
import { fetchStockQuote, fetchHistoricalData } from "../core/market-data";
import {
  analyzeTechnicals,
  formatScoreForAI,
} from "../core/technical-analysis";
import { scoreTechnicals } from "../core/technical-scorer";
import { detectChartPatterns } from "../lib/chart-patterns";
import { analyzeSingleCandle } from "../lib/candlestick-patterns";
import { calculateEntryCondition } from "../core/entry-calculator";
import { reviewTrade } from "../core/ai-decision";
import type { MarketAssessmentResult } from "../core/ai-decision";
import { canOpenPosition, validateStopLoss } from "../core/risk-manager";
import { getCashBalance } from "../core/position-manager";
import { notifyOrderPlaced, notifyRiskAlert, notifySlack } from "../lib/slack";
import { getSectorGroup } from "../lib/constants";
import type { EntrySnapshot } from "../types/snapshots";
import dayjs from "dayjs";

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

  // 2. 残高を取得
  const cashBalance = await getCashBalance();

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

  // 3. 各銘柄に対してロジック算出 → AIレビュー
  let ordersCreated = 0;

  for (const selected of selectedStocks) {
    console.log(`\n  [${selected.tickerCode}] エントリー条件算出中...`);

    // 銘柄データ取得
    const stock = await prisma.stock.findUnique({
      where: { tickerCode: selected.tickerCode },
    });
    if (!stock) {
      console.log(
        `    → 銘柄マスタに存在しません: ${selected.tickerCode}`,
      );
      continue;
    }

    const quote = await fetchStockQuote(stock.tickerCode);
    if (!quote) {
      console.log(`    → 株価取得失敗: ${stock.tickerCode}`);
      continue;
    }

    // テクニカル分析 + スコアリング
    const historical = await fetchHistoricalData(stock.tickerCode);
    if (
      !historical ||
      historical.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS
    ) {
      console.log(`    → ヒストリカルデータ不足: ${stock.tickerCode}`);
      continue;
    }

    const techSummary = analyzeTechnicals(historical);

    // チャートパターン検出
    const historicalOldestFirst = [...historical].reverse().map((d) => ({
      date: d.date,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
    }));
    const chartPatterns = detectChartPatterns(historicalOldestFirst);

    // ローソク足パターン検出
    const latestCandle = {
      date: historical[0].date,
      open: historical[0].open,
      high: historical[0].high,
      low: historical[0].low,
      close: historical[0].close,
    };
    const candlestickPattern = analyzeSingleCandle(latestCandle);

    // スコアリング
    const score = scoreTechnicals({
      summary: techSummary,
      chartPatterns,
      candlestickPattern,
      historicalData: historical,
      latestPrice: quote.price,
      latestVolume: Number(stock.latestVolume ?? 0),
      weeklyVolatility: stock.volatility ? Number(stock.volatility) : null,
    });

    const strategy = selected.strategy as "day_trade" | "swing";

    // ロジックでエントリー条件を算出
    const entryCondition = calculateEntryCondition(
      quote.price,
      techSummary,
      score,
      strategy,
      cashBalance,
      maxPositionPct,
    );

    console.log(
      `    → ロジック算出: 指値¥${entryCondition.limitPrice} / 利確¥${entryCondition.takeProfitPrice} / 損切¥${entryCondition.stopLossPrice} / ${entryCondition.quantity}株 / RR 1:${entryCondition.riskRewardRatio}`,
    );

    // 数量0 → 予算不足
    if (entryCondition.quantity === 0) {
      console.log(`    → 予算不足でスキップ`);
      continue;
    }

    // 銘柄別ニュースコンテキスト
    const catalysts = stockCatalysts?.filter(
      (c) => c.tickerCode === stock.tickerCode,
    );
    const newsContext =
      catalysts && catalysts.length > 0
        ? catalysts.map((c) => `[${c.type}] ${c.summary}`).join("\n")
        : undefined;

    // AIレビュー
    const scoreFormatted = formatScoreForAI(score, techSummary);
    const review = await reviewTrade(
      {
        tickerCode: stock.tickerCode,
        name: stock.name,
        price: quote.price,
        sector: getSectorGroup(stock.sector) ?? stock.sector ?? "不明",
        scoreFormatted,
        newsContext,
      },
      entryCondition,
      assessment,
    );

    console.log(`    → AIレビュー: ${review.decision}`);

    if (review.decision === "reject") {
      console.log(`    → AI却下: ${review.reasoning}`);
      continue;
    }

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

    // リスクチェック
    const riskCheck = await canOpenPosition(
      stock.id,
      finalCondition.quantity,
      finalCondition.limitPrice,
    );

    if (!riskCheck.allowed) {
      console.log(`    → リスクチェック不可: ${riskCheck.reason}`);
      await notifyRiskAlert({
        type: "注文制限",
        message: `${stock.tickerCode} ${stock.name}: ${riskCheck.reason}`,
      });
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
        technical: score.technical,
        pattern: score.pattern,
        liquidity: score.liquidity,
        topPattern: score.topPattern,
        technicalSignal: score.technicalSignal,
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
        stockId: stock.id,
        side: "buy",
        orderType: "limit",
        strategy: finalCondition.strategy,
        limitPrice: finalCondition.limitPrice,
        quantity: finalCondition.quantity,
        status: "pending",
        reasoning: review.reasoning,
        expiresAt,
        entrySnapshot: entrySnapshot as object,
      },
    });

    ordersCreated++;

    // Slack通知
    await notifyOrderPlaced({
      tickerCode: stock.tickerCode,
      name: stock.name,
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
