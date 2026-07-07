/**
 * マーケット評価ジョブ
 *
 * 市場指標データ取得 → メカニカルレジーム判定 → VIXベース機械的市場評価 → MarketAssessment DB保存。
 * market-scanner オーケストレーターから呼ばれるほか、単独実行も可能。
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB, getPreviousTradingDay } from "../lib/market-date";
import { MARKET_INDEX, MARKET_REGIME, MARKET_BREADTH } from "../lib/constants";
import { getCMEStatus } from "../lib/market-hours";
import { fetchMarketData } from "../core/market-data";
import { notifyMarketAssessment, notifyRiskAlert } from "../lib/slack";
import {
  determineMarketRegime,
  determinePreMarketRegime,
  calculateCmeDivergence,
} from "../core/market-regime";
import type { MarketRegime, Sentiment } from "../core/market-regime";
import { calculateDrawdownStatus } from "../core/drawdown-manager";
import type { DrawdownStatus } from "../core/drawdown-manager";
import { calculateMarketBreadth } from "../core/market-breadth";
import { getNikkeiLastSessionChange } from "../core/market-index";

/** market-assessment の結果（オーケストレーターや stock-scanner に渡す） */
export interface MarketAssessmentContext {
  regime: MarketRegime;
  isShadowMode: boolean;
  marketData: Awaited<ReturnType<typeof fetchMarketData>>;
  drawdown: DrawdownStatus;
  cmeDivergencePct: number | null;
  breadth: number | null;
  assessment: { shouldTrade: boolean; sentiment: Sentiment; reasoning: string } | null;
}

/** MarketAssessment保存用の市場指標フィールドを構築する */
function buildMarketFields(
  marketData: Awaited<ReturnType<typeof fetchMarketData>>,
  extra?: { breadth?: number | null; cmeDivergencePct?: number | null },
) {
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
    breadth: extra?.breadth ?? null,
    cmeDivergencePct: extra?.cmeDivergencePct ?? null,
  };
}

export async function main(): Promise<MarketAssessmentContext> {
  console.log("=== Market Assessment 開始 ===");
  let isShadowMode = false;
  // 最終結果通知（Slack）はどの経路でも notifyMarketAssessment カードに統一する。
  // shadow系（キルスイッチ/ドローダウン/見送り）も含めここに結果を集約し、末尾で1回だけ送る。
  let finalOutcome: { shouldTrade: boolean; sentiment: Sentiment; reasoning: string } | null = null;

  // 1. 市場指標データ取得 + Breadth計算 + 日経DB前日比（並列）
  console.log("[1/2] 市場指標データ + Breadth 取得中...");
  const [marketData, breadthResult, nikkeiDbChange] = await Promise.all([
    fetchMarketData(),
    calculateMarketBreadth().catch((e) => {
      console.warn("Breadth計算に失敗:", e);
      return null;
    }),
    getNikkeiLastSessionChange().catch((e) => {
      console.warn("日経DB前日比の取得に失敗:", e);
      return null;
    }),
  ]);
  const breadthValue = breadthResult?.breadth ?? null;
  if (breadthResult) {
    const asOf = breadthResult.asOfDate.toISOString().slice(0, 10);
    console.log(`  Breadth: ${(breadthResult.breadth * 100).toFixed(1)}% (${breadthResult.above}/${breadthResult.total}銘柄, asOf ${asOf})`);
  }

  if (!marketData.nikkei) {
    console.error("市場データの取得に失敗しました");
    await notifyRiskAlert({
      type: "データ取得エラー",
      message: "日経平均データの取得に失敗しました。手動確認してください。",
    });
    throw new Error("市場データの取得に失敗しました（nikkei が null）");
  }

  // 日経インデックスの鮮度ガード（stale-data 誤発火対策）:
  // 場中前(08:02 JST)の yfinance ライブ値は直近確定セッションの足を1営業日取りこぼし、
  // stale な前日比でキルスイッチ/CME乖離が誤作動する（2026-06-30 実例）。
  // breadth と同じく DB(StockDailyBar) を権威ソースとして上書きし、鮮度を揃える。
  if (nikkeiDbChange) {
    const asOf = nikkeiDbChange.asOfDate.toISOString().slice(0, 10);
    // DB 自体の鮮度チェック: DB を権威ソースにできるのは「DB が前営業日の確定足を
    // 持っている」前提。EODバックフィルが失敗して DB が古いままだと、stale な DB 値を
    // silent に採用してしまう（liveが正しくてもDBで上書きして誤発火し得る）。
    // asOf が想定される前営業日より古ければ DB採用を見送り、live のまま続行する。
    const expected = getPreviousTradingDay(getTodayForDB()).toISOString().slice(0, 10);
    if (asOf < expected) {
      const msg = `日経DBが古い: asOf ${asOf} < 想定前営業日 ${expected}（EODバックフィル未反映の疑い）。DB値の採用を見送り、yfinanceライブ値のまま続行`;
      console.warn(`[1.5/2] [stale-guard] ${msg}`);
      await notifyRiskAlert({
        type: "日経DB鮮度不足",
        message: `${msg}\n（DBが前営業日の確定足を持っていないため、権威ソースとして使えません。EODバックフィルの成否を確認してください）`,
      }).catch((e) => console.warn("DB鮮度通知に失敗:", e));
    } else {
      const liveChange = marketData.nikkei.changePercent;
      const dbChange = nikkeiDbChange.changePercent;
      const drift = Math.abs(liveChange - dbChange);
      if (drift > MARKET_INDEX.NIKKEI_STALE_TOLERANCE_PCT) {
        const msg = `日経 live ${liveChange.toFixed(2)}% と DB ${dbChange.toFixed(2)}% (asOf ${asOf}) が ${drift.toFixed(2)}pp 乖離。live が stale の疑い → DB値を採用`;
        console.warn(`[1.5/2] [stale-guard] ${msg}`);
        await notifyRiskAlert({
          type: "日経データstale検知",
          message: `${msg}\n（market-assessment の日経前日比を DB 権威値で補正しました）`,
        }).catch((e) => console.warn("stale通知に失敗:", e));
      } else {
        console.log(`[1.5/2] 日経DB前日比 ${dbChange.toFixed(2)}% (asOf ${asOf}) — live と整合`);
      }
      // DB を真実源として上書き（kill switch / CME乖離 / 表示の鮮度を一貫させる）
      marketData.nikkei.price = nikkeiDbChange.close;
      marketData.nikkei.previousClose = nikkeiDbChange.previousClose;
      marketData.nikkei.changePercent = dbChange;
    }
  } else {
    console.warn("[1.5/2] [stale-guard] 日経DB前日比が取得不可。yfinance ライブ値のまま続行（stale の可能性に注意）");
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
  const cmeStatus = getCMEStatus();
  if (marketData.cmeFutures && marketData.usdjpy && marketData.nikkei.price > 0) {
    // CME乖離率は「今夜のCME先物 → 翌営業日の寄り付きギャップ」を測る指標。
    // 基準は直近確定終値(marketData.nikkei.price)。その1つ前の終値(previousClose)を
    // 使うと直近セッションの値動きを二重計上し、乖離率が誤って膨らむ
    // （2026-07-08: 7/7 -2.12% 下落を二重計上し CMEキルスイッチが -3.04% で誤発火。
    //   正しい基準では -0.94% で発火しない）。
    cmeDivergencePct = calculateCmeDivergence(
      marketData.cmeFutures.price,
      marketData.usdjpy.price,
      marketData.nikkei.price,
    );
    const staleNote = cmeStatus === "closed" ? "（CME休場中 — データは前セッション終値）" : "";
    console.log(`[1.7/2] CME先物乖離率: ${cmeDivergencePct.toFixed(2)}%${staleNote}`);

    // CME休場中はデータが古いためレジーム引き上げをスキップ
    if (cmeStatus === "closed") {
      console.log("  → CME休場中: 乖離率は参考値として記録のみ（レジーム判定には使用しない）");
    } else {
      const preMarket = determinePreMarketRegime(cmeDivergencePct);
      if (preMarket.minLevel === "crisis") {
        console.log(`  → ${preMarket.reason}`);
        const assessmentData = {
          ...buildMarketFields(marketData, { breadth: breadthValue, cmeDivergencePct }),
          sentiment: "crisis" as const,
          shouldTrade: false,
          reasoning: `[CME先物乖離率キルスイッチ] ${preMarket.reason}`,
          selectedStocks: [],
        };
        await prisma.marketAssessment.upsert({
          where: { date: getTodayForDB() },
          update: assessmentData,
          create: { date: getTodayForDB(), ...assessmentData },
        });
        finalOutcome = { shouldTrade: false, sentiment: "crisis", reasoning: assessmentData.reasoning };
        isShadowMode = true;
      } else if (preMarket.minLevel) {
        console.log(`  → ${preMarket.reason}（レジーム下限を${preMarket.minLevel}に引き上げ）`);
      }
    }
  } else {
    console.log("[1.7/2] CME先物乖離率: データ不足のためスキップ");
  }

  // 1.8. VIXレジーム判定
  console.log("[1.8/2] VIXレジーム判定...");
  let regime: MarketRegime = determineMarketRegime(marketData.vix.price);

  // CME乖離率によるレジーム引き上げ（CME休場中はスキップ — データが古い）
  if (cmeDivergencePct != null && cmeStatus !== "closed") {
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

  // VIX ≥ 30: EODで強制決済される（end-of-day.tsで処理）

  // 1.8.5. 日経平均キルスイッチ
  if (
    !isShadowMode &&
    marketData.nikkei.changePercent <= MARKET_INDEX.NIKKEI_CRISIS_THRESHOLD
  ) {
    const reason = `日経平均 ${marketData.nikkei.changePercent.toFixed(2)}% ≤ ${MARKET_INDEX.NIKKEI_CRISIS_THRESHOLD}%: 急落キルスイッチ発動。全取引停止`;
    console.log(`[1.8.5/2] ${reason}`);
    const assessmentData = {
      ...buildMarketFields(marketData, { breadth: breadthValue, cmeDivergencePct }),
      sentiment: "crisis" as const,
      shouldTrade: false,
      reasoning: `[日経平均キルスイッチ] ${reason}`,
      selectedStocks: [],
    };
    await prisma.marketAssessment.upsert({
      where: { date: getTodayForDB() },
      update: assessmentData,
      create: { date: getTodayForDB(), ...assessmentData },
    });
    finalOutcome = { shouldTrade: false, sentiment: "crisis", reasoning: assessmentData.reasoning };
    isShadowMode = true;
  }

  // N225 SMA50フィルターは廃止（2026-04-01）
  // WF検証でbreadth73%+他ゲート（VIX/CME/ドローダウン）で十分と判定。
  // SMA50は遅行指標でリバウンド初期の機会を逃すため撤廃。

  // 1.9. ドローダウンチェック
  console.log("[1.9/2] ドローダウンチェック...");
  const drawdown = await calculateDrawdownStatus();
  console.log(
    `  → 週次損益: ¥${drawdown.weeklyPnl.toLocaleString()}, 月次損益: ¥${drawdown.monthlyPnl.toLocaleString()}`,
  );

  if (drawdown.shouldHaltTrading) {
    console.log(`ドローダウンにより取引停止: ${drawdown.reason}`);
    const latestAssessment = await prisma.marketAssessment.findFirst({
      orderBy: { createdAt: "desc" },
      select: { sentiment: true },
    });
    const drawdownSentiment = (latestAssessment?.sentiment ?? "normal") as
      | "normal"
      | "crisis";
    console.log(
      `  → ドローダウン停止時のsentiment: ${drawdownSentiment}（市場評価を維持）`,
    );
    const drawdownAssessmentData = {
      ...buildMarketFields(marketData, { breadth: breadthValue, cmeDivergencePct }),
      sentiment: drawdownSentiment,
      shouldTrade: false,
      reasoning: `[ドローダウン自動停止] ${drawdown.reason}（sentiment=${drawdownSentiment}は市場評価を維持）`,
      selectedStocks: [],
    };
    await prisma.marketAssessment.upsert({
      where: { date: getTodayForDB() },
      update: drawdownAssessmentData,
      create: { date: getTodayForDB(), ...drawdownAssessmentData },
    });
    finalOutcome = { shouldTrade: false, sentiment: drawdownSentiment, reasoning: drawdownAssessmentData.reasoning };
    isShadowMode = true;
  }

  // 2. VIXベース機械的市場評価
  let assessment: MarketAssessmentContext["assessment"] = null;

  if (!isShadowMode) {
    console.log("[2/2] VIXベース市場評価...");

    // breadthフィルター（全戦略共通、band 55-80%）
    const breadthPct = breadthValue != null ? (breadthValue * 100).toFixed(1) : "N/A";
    const lowerPct = (MARKET_BREADTH.THRESHOLD * 100).toFixed(1);
    const upperPct = (MARKET_BREADTH.UPPER_CAP * 100).toFixed(1);
    if (breadthValue == null || breadthValue < MARKET_BREADTH.THRESHOLD) {
      assessment = {
        shouldTrade: false,
        sentiment: "normal" as Sentiment,
        reasoning: `breadth ${breadthPct}% < ${lowerPct}%: 弱気でエントリー見送り`,
      };
    } else if (breadthValue > MARKET_BREADTH.UPPER_CAP) {
      assessment = {
        shouldTrade: false,
        sentiment: "normal" as Sentiment,
        reasoning: `breadth ${breadthPct}% > ${upperPct}%: 過熱でエントリー見送り`,
      };
    } else {
      assessment = {
        shouldTrade: true,
        sentiment: "normal" as Sentiment,
        reasoning: `機械判定: VIX ${marketData.vix.price.toFixed(1)} / breadth ${breadthPct}%（${lowerPct}-${upperPct}%band内） — レジーム・キルスイッチで制御`,
      };
    }
    console.log(
      `  → shouldTrade: ${assessment.shouldTrade}, sentiment: ${assessment.sentiment}`,
    );

    const assessmentData = {
      ...buildMarketFields(marketData, { breadth: breadthValue, cmeDivergencePct }),
      sentiment: assessment.sentiment,
      shouldTrade: assessment.shouldTrade,
      reasoning: assessment.reasoning,
      selectedStocks: [],
    };
    await prisma.marketAssessment.upsert({
      where: { date: getTodayForDB() },
      update: assessmentData,
      create: { date: getTodayForDB(), ...assessmentData },
    });
    finalOutcome = assessment;

    if (!assessment.shouldTrade) {
      console.log("取引見送り → シャドウスコアリングへ");
      isShadowMode = true;
    }
  } else {
    console.log("[2/2] VIXベース市場評価: スキップ（シャドウモード）");
  }

  // Slack通知（1箇所で送信）: キルスイッチ/ドローダウン/見送り/実行のどの結果でも
  // 「市場評価」カード形式に統一する（stale検知・データ取得エラーの警告は途中で
  // notifyRiskAlert 済み＝診断用の別通知として残す）。
  if (finalOutcome) {
    await notifyMarketAssessment({
      shouldTrade: finalOutcome.shouldTrade,
      sentiment: finalOutcome.sentiment,
      reasoning: finalOutcome.reasoning,
      nikkeiChange: marketData.nikkei.changePercent,
      vix: marketData.vix.price,
      sp500Change: marketData.sp500?.changePercent ?? null,
      nasdaqChange: marketData.nasdaq?.changePercent ?? null,
      dowChange: marketData.dow?.changePercent ?? null,
      soxChange: marketData.sox?.changePercent ?? null,
      usdjpy: marketData.usdjpy?.price ?? null,
      cmeFuturesPrice: marketData.cmeFutures?.price ?? null,
      cmeDivergencePct,
      breadth: breadthValue,
    });
  }

  console.log("=== Market Assessment 完了 ===");

  return {
    regime,
    isShadowMode,
    marketData,
    drawdown,
    cmeDivergencePct,
    breadth: breadthValue,
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
