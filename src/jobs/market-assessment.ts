/**
 * マーケット評価ジョブ
 *
 * 市場指標データ取得 → メカニカルレジーム判定 → VIXベース機械的市場評価 → MarketAssessment DB保存。
 * market-scanner オーケストレーターから呼ばれるほか、単独実行も可能。
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/date-utils";
import { MARKET_INDEX, MARKET_REGIME, STRATEGY_SWITCHING } from "../lib/constants";
import { fetchMarketData } from "../core/market-data";
import { notifyMarketAssessment, notifyRiskAlert } from "../lib/slack";
import {
  determineMarketRegime,
  determinePreMarketRegime,
  calculateCmeDivergence,
  determineTradingStrategy,
} from "../core/market-regime";
import type { MarketRegime, StrategyDecision, Sentiment } from "../core/market-regime";
import { calculateDrawdownStatus } from "../core/drawdown-manager";
import type { DrawdownStatus } from "../core/drawdown-manager";

/** market-assessment の結果（オーケストレーターや stock-scanner に渡す） */
export interface MarketAssessmentContext {
  regime: MarketRegime;
  isShadowMode: boolean;
  marketData: Awaited<ReturnType<typeof fetchMarketData>>;
  drawdown: DrawdownStatus;
  strategyDecision: StrategyDecision;
  cmeDivergencePct: number | null;
  assessment: { shouldTrade: boolean; sentiment: Sentiment; reasoning: string } | null;
}

/** MarketAssessment保存用の市場指標フィールドを構築する */
function buildMarketFields(marketData: Awaited<ReturnType<typeof fetchMarketData>>) {
  return {
    nikkeiPrice: marketData.nikkei!.price,
    nikkeiChange: marketData.nikkei!.changePercent,
    sp500Change: marketData.sp500?.changePercent,
    nasdaqChange: marketData.nasdaq?.changePercent,
    dowChange: marketData.dow?.changePercent,
    soxChange: marketData.sox?.changePercent,
    vix: marketData.vix?.price,
    nikkeiVi: null as null,
    usdjpy: marketData.usdjpy?.price,
    cmeFuturesPrice: marketData.cmeFutures?.price,
  };
}

export async function main(): Promise<MarketAssessmentContext> {
  console.log("=== Market Assessment 開始 ===");
  let isShadowMode = false;

  // 1. 市場指標データ取得
  console.log("[1/2] 市場指標データ取得中...");
  const marketData = await fetchMarketData();

  if (!marketData.nikkei) {
    console.error("市場データの取得に失敗しました");
    await notifyRiskAlert({
      type: "データ取得エラー",
      message: "日経平均データの取得に失敗しました。手動確認してください。",
    });
    throw new Error("市場データの取得に失敗しました（nikkei が null）");
  }

  if (!marketData.vix) {
    console.error("VIXの取得に失敗しました");
    await notifyRiskAlert({
      type: "データ取得エラー",
      message: "VIXが取得できませんでした。手動確認してください。",
    });
    throw new Error("市場データの取得に失敗しました（vix が null）");
  }

  // 米国市場オーバーナイトデータログ
  const usLog = [
    marketData.nasdaq ? `NASDAQ ${marketData.nasdaq.changePercent >= 0 ? "+" : ""}${marketData.nasdaq.changePercent.toFixed(2)}%` : null,
    marketData.dow ? `ダウ ${marketData.dow.changePercent >= 0 ? "+" : ""}${marketData.dow.changePercent.toFixed(2)}%` : null,
    marketData.sox ? `SOX ${marketData.sox.changePercent >= 0 ? "+" : ""}${marketData.sox.changePercent.toFixed(2)}%` : null,
  ].filter(Boolean);
  if (usLog.length > 0) {
    console.log(`  米国市場（前日）: ${usLog.join(", ")}`);
  }

  // 1.7. CME先物ナイトセッション乖離率チェック
  let cmeDivergencePct: number | null = null;
  if (marketData.cmeFutures && marketData.usdjpy && marketData.nikkei.previousClose > 0) {
    cmeDivergencePct = calculateCmeDivergence(
      marketData.cmeFutures.price,
      marketData.usdjpy.price,
      marketData.nikkei.previousClose,
    );
    console.log(`[1.7/2] CME先物乖離率: ${cmeDivergencePct.toFixed(2)}%`);

    const preMarket = determinePreMarketRegime(cmeDivergencePct);
    if (preMarket.minLevel === "crisis") {
      console.log(`  → ${preMarket.reason}`);
      await notifyRiskAlert({
        type: "CME先物乖離率キルスイッチ",
        message: preMarket.reason!,
      });
      const assessmentData = {
        ...buildMarketFields(marketData),
        sentiment: "crisis" as const,
        shouldTrade: false,
        reasoning: `[CME先物乖離率キルスイッチ] ${preMarket.reason}`,
        selectedStocks: [],
        tradingStrategy: "day_trade",
      };
      await prisma.marketAssessment.upsert({
        where: { date: getTodayForDB() },
        update: assessmentData,
        create: { date: getTodayForDB(), ...assessmentData },
      });
      isShadowMode = true;
    } else if (preMarket.minLevel) {
      console.log(`  → ${preMarket.reason}（レジーム下限を${preMarket.minLevel}に引き上げ）`);
    }
  } else {
    console.log("[1.7/2] CME先物乖離率: データ不足のためスキップ");
  }

  // 1.8. VIXレジーム判定
  console.log("[1.8/2] VIXレジーム判定...");
  let regime: MarketRegime = determineMarketRegime(marketData.vix.price);

  // CME乖離率によるレジーム引き上げ
  if (cmeDivergencePct != null) {
    const preMarket = determinePreMarketRegime(cmeDivergencePct);
    if (preMarket.minLevel && !regime.shouldHaltTrading) {
      const levelOrder: Record<string, number> = { normal: 0, elevated: 1, high: 2, crisis: 3 };
      if (levelOrder[preMarket.minLevel] > levelOrder[regime.level]) {
        console.log(`  → CME乖離率によりレジームを ${regime.level} → ${preMarket.minLevel} に引き上げ`);
        if (preMarket.minLevel === "crisis") {
          regime = { ...regime, level: "crisis", maxPositions: MARKET_REGIME.CRISIS.maxPositions, minScore: MARKET_REGIME.CRISIS.minScore, shouldHaltTrading: false, reason: `${regime.reason} + ${preMarket.reason}` };
        } else if (preMarket.minLevel === "elevated" && regime.level === "normal") {
          regime = { ...regime, level: "elevated", maxPositions: 2, minScore: 60, reason: `${regime.reason} + ${preMarket.reason}` };
        }
      }
    }
  }

  console.log(`  → レジーム: ${regime.level}（${regime.reason}）`);

  // 1.8.1. 戦略決定
  const strategyDecision: StrategyDecision = determineTradingStrategy(
    marketData.vix.price,
    cmeDivergencePct,
  );
  console.log(`[1.8.1/2] 戦略決定: ${strategyDecision.strategy}（${strategyDecision.reason}）`);

  // VIX ≥ 30: 既存swingポジションの戦略をday_tradeに切替
  // breakoutはstrategyを変えず、EODで強制決済（TSパラメータ・戦略情報を保持）
  if (marketData.vix.price >= STRATEGY_SWITCHING.VIX_SWING_FORCE_CLOSE_THRESHOLD) {
    const updated = await prisma.tradingPosition.updateMany({
      where: { status: "open", strategy: "swing" },
      data: { strategy: "day_trade" },
    });
    if (updated.count > 0) {
      console.log(`  → VIX ${marketData.vix.price.toFixed(1)} ≥ ${STRATEGY_SWITCHING.VIX_SWING_FORCE_CLOSE_THRESHOLD}: ${updated.count}件のswingポジションをday_tradeに切替`);
    }
  }

  // 1.8.5. 日経平均キルスイッチ
  if (
    !isShadowMode &&
    marketData.nikkei.changePercent <= MARKET_INDEX.NIKKEI_CRISIS_THRESHOLD
  ) {
    const reason = `日経平均 ${marketData.nikkei.changePercent.toFixed(2)}% ≤ ${MARKET_INDEX.NIKKEI_CRISIS_THRESHOLD}%: 急落キルスイッチ発動。全取引停止`;
    console.log(`[1.8.5/2] ${reason}`);
    await notifyRiskAlert({
      type: "日経平均キルスイッチ",
      message: reason,
    });
    const assessmentData = {
      ...buildMarketFields(marketData),
      sentiment: "crisis" as const,
      shouldTrade: false,
      reasoning: `[日経平均キルスイッチ] ${reason}`,
      selectedStocks: [],
      tradingStrategy: strategyDecision.strategy,
    };
    await prisma.marketAssessment.upsert({
      where: { date: getTodayForDB() },
      update: assessmentData,
      create: { date: getTodayForDB(), ...assessmentData },
    });
    isShadowMode = true;
  }

  // 1.8.6. N225 SMA50フィルター（バックテストの indexTrendFilter と同等）
  // N225終値がSMA50以下の場合はエントリー停止（中期下降トレンド）
  if (!isShadowMode) {
    console.log("[1.8.6/2] N225 SMA50チェック...");
    const SMA_PERIOD = 50;
    const n225Bars = await prisma.stockDailyBar.findMany({
      where: { tickerCode: "^N225" },
      orderBy: { date: "desc" },
      take: SMA_PERIOD + 5,
      select: { date: true, close: true },
    });

    if (n225Bars.length >= SMA_PERIOD) {
      const recentClose = n225Bars[0].close;
      const sma50 = n225Bars.slice(0, SMA_PERIOD).reduce((s, b) => s + b.close, 0) / SMA_PERIOD;
      console.log(`  N225: ¥${recentClose.toLocaleString()} / SMA50: ¥${Math.round(sma50).toLocaleString()}`);

      if (recentClose < sma50) {
        const reason = `N225 ¥${recentClose.toLocaleString()} < SMA50 ¥${Math.round(sma50).toLocaleString()}: 中期下降トレンドのためエントリー停止`;
        console.log(`  → ${reason}`);
        const assessmentData = {
          ...buildMarketFields(marketData),
          sentiment: "bullish" as const,
          shouldTrade: false,
          reasoning: `[N225 SMA50フィルター] ${reason}`,
          selectedStocks: [],
          tradingStrategy: strategyDecision.strategy,
        };
        await prisma.marketAssessment.upsert({
          where: { date: getTodayForDB() },
          update: assessmentData,
          create: { date: getTodayForDB(), ...assessmentData },
        });
        isShadowMode = true;
      } else {
        console.log(`  → N225 SMA50以上: エントリー継続`);
      }
    } else {
      console.log(`  N225データ不足（${n225Bars.length}件）: SMA50チェックをスキップ`);
    }
  }

  // 1.9. ドローダウンチェック
  console.log("[1.9/2] ドローダウンチェック...");
  const drawdown = await calculateDrawdownStatus();
  console.log(
    `  → 週次損益: ¥${drawdown.weeklyPnl.toLocaleString()}, 月次損益: ¥${drawdown.monthlyPnl.toLocaleString()}`,
  );

  if (drawdown.shouldHaltTrading) {
    console.log(`ドローダウンにより取引停止: ${drawdown.reason}`);
    await notifyRiskAlert({
      type: "ドローダウン停止",
      message: drawdown.reason,
    });
    const latestAssessment = await prisma.marketAssessment.findFirst({
      orderBy: { createdAt: "desc" },
      select: { sentiment: true },
    });
    const drawdownSentiment = (latestAssessment?.sentiment ?? "neutral") as
      | "bullish"
      | "neutral"
      | "cautious"
      | "bearish"
      | "crisis";
    console.log(
      `  → ドローダウン停止時のsentiment: ${drawdownSentiment}（市場評価を維持）`,
    );
    const drawdownAssessmentData = {
      ...buildMarketFields(marketData),
      sentiment: drawdownSentiment,
      shouldTrade: false,
      reasoning: `[ドローダウン自動停止] ${drawdown.reason}（sentiment=${drawdownSentiment}は市場評価を維持）`,
      selectedStocks: [],
      tradingStrategy: strategyDecision.strategy,
    };
    await prisma.marketAssessment.upsert({
      where: { date: getTodayForDB() },
      update: drawdownAssessmentData,
      create: { date: getTodayForDB(), ...drawdownAssessmentData },
    });
    isShadowMode = true;
  }

  // 2. VIXベース機械的市場評価
  let assessment: MarketAssessmentContext["assessment"] = null;

  if (!isShadowMode) {
    console.log("[2/2] VIXベース市場評価...");
    assessment = {
      shouldTrade: true,
      sentiment: "bullish" as Sentiment,
      reasoning: `機械判定: VIX ${marketData.vix.price.toFixed(1)} — レジーム・キルスイッチで制御`,
    };
    console.log(
      `  → shouldTrade: ${assessment.shouldTrade}, sentiment: ${assessment.sentiment}`,
    );

    // Slack通知
    await notifyMarketAssessment({
      shouldTrade: assessment.shouldTrade,
      sentiment: assessment.sentiment,
      reasoning: assessment.reasoning,
      nikkeiChange: marketData.nikkei.changePercent,
      vix: marketData.vix.price,
    });

    const assessmentData = {
      ...buildMarketFields(marketData),
      sentiment: assessment.sentiment,
      shouldTrade: assessment.shouldTrade,
      reasoning: assessment.reasoning,
      selectedStocks: [],
      tradingStrategy: strategyDecision.strategy,
    };
    await prisma.marketAssessment.upsert({
      where: { date: getTodayForDB() },
      update: assessmentData,
      create: { date: getTodayForDB(), ...assessmentData },
    });

    if (!assessment.shouldTrade) {
      console.log("取引見送り → シャドウスコアリングへ");
      isShadowMode = true;
    }
  } else {
    console.log("[2/2] VIXベース市場評価: スキップ（シャドウモード）");
  }

  console.log("=== Market Assessment 完了 ===");

  return {
    regime,
    isShadowMode,
    marketData,
    drawdown,
    strategyDecision,
    cmeDivergencePct,
    assessment,
  };
}

const isDirectRun = process.argv[1]?.includes("market-assessment");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Market Assessment エラー:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
