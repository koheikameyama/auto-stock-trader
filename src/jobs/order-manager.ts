/**
 * 注文マネージャー（9:30 JST / 平日）
 *
 * ルールベースフロー:
 * 1. 今日のMarketAssessmentを確認（shouldTrade = true のみ）
 * 2. 各銘柄のテクニカル分析 + スコアリング
 * 3. ロジックでエントリー条件算出（指値・利確・損切り・数量）
 * 4. リスクチェック
 * 5. TradingOrder作成（pending状態）
 * 6. Slackに注文内容を通知
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
  SPREAD_FILTER,
} from "../lib/constants";
import { countNonTradingDaysAhead } from "../lib/market-calendar";
import { fetchStockQuote, fetchHistoricalData } from "../core/market-data";
import { analyzeTechnicals } from "../core/technical-analysis";
import type { TechnicalSummary } from "../core/technical-analysis";
// scoring は無効化済み（breakout 戦略に移行）
 
const scoreStock = (_params: unknown): { totalScore: number } => ({ totalScore: 0 });
 
import { calculateEntryCondition } from "../core/entry-calculator";
import type { EntryCondition } from "../core/entry-calculator";
import { canOpenPosition, getDynamicMaxPositionPct } from "../core/risk-manager";
import { getCashBalance, getEffectiveCapital } from "../core/position-manager";
import { analyzeOpeningSession } from "../core/opening-session";
import { notifyOrderPlaced, notifyRiskAlert, notifySlack, notifyBrokerError } from "../lib/slack";
import { submitOrder as submitBrokerOrder } from "../core/broker-orders";
import type { EntrySnapshot } from "../types/snapshots";
import type { TradingStrategy } from "../core/market-regime";
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  score: any;
  entryCondition: EntryCondition;
  strategy: TradingStrategy;
  pendingBuyOrderId: string | null;
}

export async function main() {
  console.log("=== Order Manager 開始 ===");

  try {

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

  // 1.5. 選定外のpending買い注文をキャンセル（EOD失敗時のフォールバック）
  const selectedTickerCodes = new Set(selectedStocks.map((s) => s.tickerCode));
  const staleOrders = await prisma.tradingOrder.findMany({
    where: {
      side: "buy",
      status: "pending",
      stock: { tickerCode: { notIn: [...selectedTickerCodes] } },
    },
    include: { stock: true },
  });
  if (staleOrders.length > 0) {
    await prisma.tradingOrder.updateMany({
      where: { id: { in: staleOrders.map((o) => o.id) } },
      data: { status: "cancelled" },
    });
    for (const o of staleOrders) {
      console.log(`  [${o.stock.tickerCode}] 選定外のためpending注文キャンセル`);
    }
    console.log(`  選定外pending注文キャンセル: ${staleOrders.length}件`);
  }

  // 2. 残高を取得（ループ内で注文作成ごとに減算する）
  let cashBalance = await getCashBalance();
  const effectiveCapital = await getEffectiveCapital();

  const assessment = {
    shouldTrade: todayAssessment.shouldTrade,
    sentiment: todayAssessment.sentiment as string,
    reasoning: todayAssessment.reasoning,
  };

  const maxPositionPct = getDynamicMaxPositionPct(effectiveCapital);

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

        const quote = await fetchStockQuote(tickerCode);
        if (!quote) {
          console.log(`    [${tickerCode}] 株価取得失敗`);
          return null;
        }

        // スプレッドフィルタ: 板情報が取得できている場合のみチェック
        if (quote.askPrice && quote.bidPrice && quote.askPrice > 0) {
          const spreadPct = ((quote.askPrice - quote.bidPrice) / quote.askPrice) * 100;
          if (spreadPct > SPREAD_FILTER.MAX_SPREAD_PCT) {
            console.log(`    [${tickerCode}] スプレッド過大 (${spreadPct.toFixed(2)}%) → スキップ`);
            return null;
          }
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

        const strategy = selected.strategy as TradingStrategy;

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

        // askSizeによる数量キャップ: 板を動かさないために最良売気配の数量以内に制限
        let adjustedEntryCondition = entryCondition;
        if (quote.askSize && quote.askSize > 0 && entryCondition.quantity > quote.askSize) {
          console.log(`    [${tickerCode}] 数量を板に合わせて制限 ${entryCondition.quantity} → ${quote.askSize}株`);
          adjustedEntryCondition = { ...entryCondition, quantity: quote.askSize };
        }

        // 寄り付きセッション分析
        const openingAnalysis = analyzeOpeningSession(
          quote,
          techSummary.volumeAnalysis.avgVolume20 ?? 0,
        );
        if (openingAnalysis.summary) {
          console.log(`    [${tickerCode}] 寄り付き: ${openingAnalysis.summary.replace(/\n/g, " / ")}`);
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
          entryCondition: adjustedEntryCondition,
          strategy,
          pendingBuyOrderId: pendingBuyOrder?.id ?? null,
        };
      }),
    ),
  );

  let passed = analysisResults.filter(
    (r): r is AnalysisResult => r !== null,
  );

  console.log(
    `  [フェーズ1] 分析完了: ${selectedStocks.length}銘柄中 ${passed.length}銘柄が条件通過`,
  );

  // =========================================
  // フェーズ1.7: 統合優先順位付け（既存pending + 新規候補をスコア順で余力配分）
  // =========================================
  console.log(`\n  [フェーズ1.7] 統合優先順位付け...`);
  const totalOrderBudget = await getCashBalance();

  // 残存 pending buy 注文を取得（EODで全キャンセル済みのため通常0件）
  const remainingPendingBuys = await prisma.tradingOrder.findMany({
    where: { side: "buy", status: "pending" },
    include: { stock: true },
  });

  interface BudgetCandidate {
    type: "existing" | "new";
    tickerCode: string;
    stockName: string;
    score: number;
    requiredAmount: number;
    orderId?: string;
  }

  const budgetCandidates: BudgetCandidate[] = [];

  // 既存 pending を追加
  for (const order of remainingPendingBuys) {
    const snapshot = order.entrySnapshot as Record<string, unknown> | null;
    const scoreObj = snapshot?.score as Record<string, unknown> | undefined;
    const score = (scoreObj?.totalScore as number) ?? 0;
    budgetCandidates.push({
      type: "existing",
      tickerCode: order.stock.tickerCode,
      stockName: order.stock.name,
      score,
      requiredAmount: Number(order.limitPrice) * order.quantity,
      orderId: order.id,
    });
  }

  // 新規 passed を追加（既存 pending と同じ銘柄は除外 — Phase 2 で update するため）
  const existingPendingTickers = new Set(
    remainingPendingBuys.map((o) => o.stock.tickerCode),
  );
  for (const result of passed) {
    if (existingPendingTickers.has(result.tickerCode)) continue;
    budgetCandidates.push({
      type: "new",
      tickerCode: result.tickerCode,
      stockName: result.stockName,
      score: result.score.totalScore,
      requiredAmount:
        result.entryCondition.limitPrice * result.entryCondition.quantity,
    });
  }

  // スコア順ソート
  budgetCandidates.sort((a, b) => b.score - a.score);

  // 予算配分
  let budgetUsed = 0;
  const keepOrderIds = new Set<string>();
  const keepNewTickers = new Set<string>();
  const cancelOrderIds: string[] = [];
  const cancelledInfo: Array<{ tickerCode: string; stockName: string; score: number }> = [];

  for (const c of budgetCandidates) {
    if (budgetUsed + c.requiredAmount <= totalOrderBudget) {
      budgetUsed += c.requiredAmount;
      if (c.type === "existing") keepOrderIds.add(c.orderId!);
      else {
        keepNewTickers.add(c.tickerCode);
      }
    } else {
      if (c.type === "existing") {
        cancelOrderIds.push(c.orderId!);
        cancelledInfo.push({ tickerCode: c.tickerCode, stockName: c.stockName, score: c.score });
      }
      // new は passed から除外される（keepNewTickers に入らない）
    }
  }

  // 余力超過の既存 pending をキャンセル
  if (cancelOrderIds.length > 0) {
    await prisma.tradingOrder.updateMany({
      where: { id: { in: cancelOrderIds } },
      data: { status: "cancelled" },
    });
    for (const info of cancelledInfo) {
      console.log(
        `  [${info.tickerCode}] 余力超過のためpending注文キャンセル（スコア: ${info.score}点）`,
      );
    }
    await notifySlack({
      title: `余力超過: ${cancelOrderIds.length}件のpending注文をキャンセル`,
      message: cancelledInfo
        .map((i) => `- ${i.tickerCode} ${i.stockName}（${i.score}点）`)
        .join("\n"),
      color: "warning",
    });
  }

  // passed を余力内の新規 + 既存pendingと同銘柄のみに絞る
  passed = passed.filter(
    (r) =>
      existingPendingTickers.has(r.tickerCode) ||
      keepNewTickers.has(r.tickerCode),
  );

  // Phase 2 の cashBalance は既存 pending 予約分を差し引いて開始
  const existingReserved = remainingPendingBuys
    .filter((o) => keepOrderIds.has(o.id))
    .reduce((sum, o) => sum + Number(o.limitPrice) * o.quantity, 0);
  cashBalance = totalOrderBudget - existingReserved;

  console.log(
    `  統合結果: 総予算=¥${totalOrderBudget.toLocaleString()}, 既存pending予約=¥${existingReserved.toLocaleString()}, 新規注文用残高=¥${cashBalance.toLocaleString()}`,
  );
  console.log(
    `  既存pending維持: ${keepOrderIds.size}件, 余力超過キャンセル: ${cancelOrderIds.length}件, 新規候補: ${passed.filter((r) => !existingPendingTickers.has(r.tickerCode)).length}件`,
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
  let ordersUpdated = 0;

  for (const result of passed) {
    const {
      tickerCode,
      stockId,
      stockName,
      techSummary,
      score,
      entryCondition,
      pendingBuyOrderId,
    } = result;

    console.log(
      `\n  [${tickerCode}] スコア: ${score.totalScore}点 / リスク品質: ${score.riskQuality.total}点`,
    );
    console.log(
      `    → ロジック算出: 指値¥${entryCondition.limitPrice} / 利確¥${entryCondition.takeProfitPrice} / 損切¥${entryCondition.stopLossPrice} / ${entryCondition.quantity}株 / RR 1:${entryCondition.riskRewardRatio}`,
    );
    const finalCondition = { ...entryCondition };

    // リスクチェック（DB最新状態を参照）
    const riskCheck = await canOpenPosition(
      stockId,
      finalCondition.quantity,
      finalCondition.limitPrice,
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
      aiReview: null,
      marketContext: {
        sentiment: assessment.sentiment,
        reasoning: assessment.reasoning.slice(0, 500),
      },
      newsContext: null,
    };

    // TradingOrder作成 or 既存pending注文を更新
    if (pendingBuyOrderId) {
      await prisma.tradingOrder.update({
        where: { id: pendingBuyOrderId },
        data: {
          limitPrice: finalCondition.limitPrice,
          takeProfitPrice: finalCondition.takeProfitPrice,
          stopLossPrice: finalCondition.stopLossPrice,
          quantity: finalCondition.quantity,
          reasoning: `${result.strategy}戦略エントリー`,
          expiresAt,
          entrySnapshot: entrySnapshot as object,
        },
      });
      console.log(`    → 既存pending注文を更新 (${pendingBuyOrderId})`);
      ordersUpdated++;
    } else {
      const newOrder = await prisma.tradingOrder.create({
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
          reasoning: `${result.strategy}戦略エントリー`,
          expiresAt,
          entrySnapshot: entrySnapshot as object,
        },
      });
      ordersCreated++;

      // ブローカー発注（Phase 1: エラーでもシミュレーションは止めない）
      try {
        const brokerResult = await submitBrokerOrder({
          ticker: tickerCode,
          side: "buy",
          quantity: finalCondition.quantity,
          limitPrice: finalCondition.limitPrice,
          stopTriggerPrice: finalCondition.stopLossPrice,
          stopOrderPrice: undefined, // SL成行
          expireDay: finalCondition.strategy === "day_trade" ? undefined : dayjs(expiresAt).format("YYYYMMDD"),
        });
        if (brokerResult.success && brokerResult.orderNumber) {
          await prisma.tradingOrder.update({
            where: { id: newOrder.id },
            data: {
              brokerOrderId: brokerResult.orderNumber,
              brokerBusinessDay: brokerResult.businessDay,
            },
          });
        } else if (!brokerResult.success) {
          console.warn(
            `[order-manager] Broker order failed for ${tickerCode}: ${brokerResult.error}`,
          );
          await notifyBrokerError(
            `注文送信失敗: ${tickerCode}`,
            brokerResult.error ?? "Unknown error",
          );
        }
      } catch (brokerErr) {
        console.error(
          `[order-manager] Broker error for ${tickerCode}:`,
          brokerErr,
        );
      }
    }
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
      reasoning: `${result.strategy}戦略エントリー`,
    });
  }

  console.log(`\n  注文作成数: ${ordersCreated} / 更新数: ${ordersUpdated}`);

  // サマリー通知
  const totalActions = ordersCreated + ordersUpdated;
  await notifySlack({
    title: `📋 注文マネージャー完了`,
    message:
      totalActions > 0
        ? `${selectedStocks.length}銘柄を分析し、${ordersCreated}件の注文を発行、${ordersUpdated}件を更新しました`
        : `${selectedStocks.length}銘柄を分析しましたが、注文条件を満たす銘柄はありませんでした`,
    color: totalActions > 0 ? "good" : "#808080",
    fields: [
      {
        title: "分析銘柄数",
        value: `${selectedStocks.length}件`,
        short: true,
      },
      { title: "新規/更新", value: `${ordersCreated}件 / ${ordersUpdated}件`, short: true },
    ],
  });

  console.log("=== Order Manager 終了 ===");

  } finally {
    // ensureSession による自動ログインに任せるため cleanup 不要
  }
}

const isDirectRun = process.argv[1]?.includes("order-manager");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Order Manager エラー:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
