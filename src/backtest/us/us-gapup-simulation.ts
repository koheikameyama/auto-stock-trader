/**
 * US GapUp シミュレーションエンジン
 *
 * ギャップアップ + 出来高サージ + 陽線 → 終値エントリー。
 * checkPositionExit() でトレーリングストップ + タイムストップ。
 * 決算日フィルターなし（純粋な gap + volume シグナル）。
 */

import type { OHLCVData } from "../../core/technical-analysis";
import { analyzeTechnicals } from "../../core/technical-analysis";
import { checkPositionExit } from "../../core/exit-checker";
import { isGapUpSignal } from "../../core/gapup/entry-conditions";
import { calculateUSTransactionCosts } from "./us-trading-costs";
import { determineMarketRegime } from "../../core/market-regime";
import { calculateMetrics } from "../metrics";
import {
  US_SETTLEMENT_DAYS,
  US_MIN_WINDOW_BARS,
  passesUSUniverseGates,
  calculateUSPositionSize,
  closeUSPosition,
  precomputeUSSimData,
  type USPrecomputedSimData,
} from "./us-simulation-helpers";
import { US_GAPUP_RISK_PER_TRADE_PCT } from "./us-gapup-config";
import type {
  USGapUpBacktestConfig,
  USGapUpBacktestResult,
} from "./us-types";
import type {
  SimulatedPosition,
  DailyEquity,
  RegimeLevel,
} from "../types";

/** 事前計算された GapUp シグナル */
export interface PrecomputedUSGapUpSignal {
  ticker: string;
  entryPrice: number;
  gapPct: number;
  atr14: number;
  volumeSurgeRatio: number;
}

export type PrecomputedUSGapUpSignals = Map<string, PrecomputedUSGapUpSignal[]>;

/**
 * US GapUp シグナルを事前計算する
 * 決算日フィルターなし。ギャップ + 出来高サージ + 陽線を検出。
 */
export function precomputeUSGapUpDailySignals(
  config: Pick<USGapUpBacktestConfig,
    | "maxPrice" | "minPrice" | "minAtrPct" | "minAvgVolume25" | "minTurnover"
    | "gapMinPct" | "volSurgeRatio"
    | "marketTrendFilter" | "marketTrendThreshold" | "indexTrendFilter"
    | "maxLossPct" | "signalSortMethod"
    | "gapRelaxVolThreshold" | "gapMinPctRelaxed"
  >,
  allData: Map<string, OHLCVData[]>,
  precomputed: USPrecomputedSimData,
): PrecomputedUSGapUpSignals {
  const result: PrecomputedUSGapUpSignals = new Map();
  const { tradingDays, dateIndexMap, dailyBreadth, dailyIndexAboveSma } = precomputed;
  const breadthThreshold = config.marketTrendThreshold ?? 0.5;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const today = tradingDays[dayIdx];

    // マーケットフィルター
    if (config.marketTrendFilter && (dailyBreadth.get(today) ?? 0) < breadthThreshold) continue;
    if (config.indexTrendFilter && !dailyIndexAboveSma.get(today)) continue;

    const daySignals: PrecomputedUSGapUpSignal[] = [];

    for (const [ticker, bars] of allData) {
      const tickerIndex = dateIndexMap.get(ticker);
      const todayIdx = tickerIndex?.get(today);
      if (todayIdx == null || todayIdx < 1) continue;

      const todayBar = bars[todayIdx];
      const prevBar = bars[todayIdx - 1];
      if (!todayBar || !prevBar) continue;

      // テクニカル指標計算用ウィンドウ
      const windowEnd = todayIdx + 1;
      const windowStart = Math.max(0, windowEnd - US_MIN_WINDOW_BARS);
      const window = bars.slice(windowStart, windowEnd);
      if (window.length < 30) continue;

      const summary = analyzeTechnicals([...window].reverse());
      if (summary.atr14 == null) continue;

      const atrPct = (summary.atr14 / todayBar.close) * 100;
      const avgVolume25 = summary.volumeAnalysis.avgVolume20;
      if (avgVolume25 == null) continue;

      // ユニバースフィルター
      if (!passesUSUniverseGates({
        price: todayBar.close, avgVolume25, atrPct,
        maxPrice: config.maxPrice, minPrice: config.minPrice,
        minAvgVolume25: config.minAvgVolume25, minAtrPct: config.minAtrPct,
        minTurnover: config.minTurnover,
      })) continue;

      const volumeSurgeRatio = todayBar.volume / avgVolume25;

      // ギャップアップ判定（isGapUpSignal で陽線 + gap + volume を一括チェック）
      if (!isGapUpSignal({
        open: todayBar.open,
        close: todayBar.close,
        prevClose: prevBar.close,
        volume: todayBar.volume,
        avgVolume25,
        gapMinPct: config.gapMinPct,
        volSurgeRatio: config.volSurgeRatio,
        gapRelaxVolThreshold: config.gapRelaxVolThreshold,
        gapMinPctRelaxed: config.gapMinPctRelaxed,
      })) continue;

      const gapPct = (todayBar.open - prevBar.close) / prevBar.close;
      const entryPrice = todayBar.close;
      const atr14 = summary.atr14;

      // SL プレビュー（riskPerShare <= 0 の銘柄を早期除外）
      const rawSL = entryPrice - atr14;
      if (rawSL >= entryPrice) continue;

      daySignals.push({
        ticker,
        entryPrice,
        gapPct: Math.round(gapPct * 10000) / 10000,
        atr14,
        volumeSurgeRatio: Math.round(volumeSurgeRatio * 100) / 100,
      });
    }

    if (daySignals.length > 0) {
      const sortMethod = config.signalSortMethod ?? "gapvol";
      if (sortMethod === "rr") {
        // RR比 → SL% → 出来高サージ
        const slAtrMul = 1.0;
        const maxLossPct = config.maxLossPct;
        daySignals.sort((a, b) => {
          const aRawSL = a.entryPrice - a.atr14 * slAtrMul;
          const aMaxSL = a.entryPrice * (1 - maxLossPct);
          const aRisk = a.entryPrice - Math.max(aRawSL, aMaxSL);
          const aRR = aRisk > 0 ? (a.atr14 * 5.0) / aRisk : 0;
          const aSlPct = aRisk / a.entryPrice;

          const bRawSL = b.entryPrice - b.atr14 * slAtrMul;
          const bMaxSL = b.entryPrice * (1 - maxLossPct);
          const bRisk = b.entryPrice - Math.max(bRawSL, bMaxSL);
          const bRR = bRisk > 0 ? (b.atr14 * 5.0) / bRisk : 0;
          const bSlPct = bRisk / b.entryPrice;

          if (Math.abs(bRR - aRR) >= 0.1) return bRR - aRR;
          if (Math.abs(aSlPct - bSlPct) >= 0.001) return aSlPct - bSlPct;
          return b.volumeSurgeRatio - a.volumeSurgeRatio;
        });
      } else if (sortMethod === "volume") {
        // 出来高サージ降順のみ
        daySignals.sort((a, b) => b.volumeSurgeRatio - a.volumeSurgeRatio);
      } else {
        // デフォルト: gapPct * volumeSurgeRatio 降順
        daySignals.sort((a, b) => (b.gapPct * b.volumeSurgeRatio) - (a.gapPct * a.volumeSurgeRatio));
      }
      result.set(today, daySignals);
    }
  }

  return result;
}

/**
 * US GapUp バックテストを実行する
 */
export function runUSGapUpBacktest(
  config: USGapUpBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData?: Map<string, number>,
  indexData?: Map<string, number>,
  precomputed?: USPrecomputedSimData,
  precomputedSignals?: PrecomputedUSGapUpSignals,
): USGapUpBacktestResult {
  const openPositions: SimulatedPosition[] = [];
  const closedTrades: SimulatedPosition[] = [];
  const equityCurve: DailyEquity[] = [];
  const lastExitDayIdx = new Map<string, number>();
  let cash = config.initialBudget;
  const pendingSettlement: { amount: number; availableDayIdx: number }[] = [];

  if (!precomputed) {
    precomputed = precomputeUSSimData(
      config.startDate, config.endDate, allData,
      config.marketTrendFilter ?? false,
      config.indexTrendFilter ?? false,
      config.indexTrendSmaPeriod ?? 50,
      indexData,
    );
  }

  if (!precomputedSignals) {
    precomputedSignals = precomputeUSGapUpDailySignals(config, allData, precomputed);
  }

  const { tradingDays, tradingDayIndex, dateIndexMap } = precomputed;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const today = tradingDays[dayIdx];

    // T+1 受渡完了分をcashに解放
    for (let i = pendingSettlement.length - 1; i >= 0; i--) {
      if (pendingSettlement[i].availableDayIdx <= dayIdx) {
        cash += pendingSettlement[i].amount;
        pendingSettlement.splice(i, 1);
      }
    }

    // VIXレジーム判定
    const todayVix = vixData?.get(today);
    const todayRegime: RegimeLevel =
      todayVix != null ? determineMarketRegime(todayVix).level : "normal";

    // -- 1. オープンポジションの出口判定 --
    const toClose: number[] = [];
    for (let i = 0; i < openPositions.length; i++) {
      const pos = openPositions[i];
      const bars = allData.get(pos.ticker);
      if (!bars) continue;
      const barIdx = dateIndexMap.get(pos.ticker)?.get(today);
      if (barIdx == null) continue;
      const todayBar = bars[barIdx];

      const entryDayIdx = tradingDayIndex.get(pos.entryDate) ?? -1;
      const holdingDays = entryDayIdx >= 0 ? dayIdx - entryDayIdx : 0;

      // エントリー日はSL判定スキップ
      if (holdingDays === 0) {
        pos.maxHighDuringHold = Math.max(pos.maxHighDuringHold, todayBar.high);
        pos.minLowDuringHold = Math.min(pos.minLowDuringHold, todayBar.low);
        continue;
      }

      const exitResult = checkPositionExit(
        {
          entryPrice: pos.entryPrice,
          takeProfitPrice: pos.takeProfitPrice,
          stopLossPrice: pos.stopLossPrice,
          entryAtr: pos.entryAtr,
          maxHighDuringHold: pos.maxHighDuringHold,
          minLowDuringHold: pos.minLowDuringHold,
          currentTrailingStop: pos.trailingStopPrice,
          strategy: "gapup",
          holdingBusinessDays: holdingDays,
          beActivationMultiplierOverride: config.beActivationMultiplier,
          trailMultiplierOverride: config.trailMultiplier,
          maxHoldingDaysOverride: config.maxExtendedHoldingDays,
          baseLimitHoldingDaysOverride: config.maxHoldingDays,
        },
        { open: todayBar.open, high: todayBar.high, low: todayBar.low, close: todayBar.close },
      );

      pos.maxHighDuringHold = exitResult.newMaxHigh;
      pos.trailingStopPrice = exitResult.trailingStopPrice;

      let exitPrice = exitResult.exitPrice;
      let exitReason: SimulatedPosition["exitReason"] = exitResult.exitReason;

      // タイムストップ
      if (exitPrice == null && holdingDays >= config.maxHoldingDays) {
        const hasProfit = todayBar.close > pos.entryPrice;
        const hasTrailingStop = pos.trailingStopPrice != null;
        if (!hasProfit || holdingDays >= config.maxExtendedHoldingDays || !hasTrailingStop) {
          exitPrice = todayBar.close;
          exitReason = "time_stop";
        }
      }

      if (exitPrice != null && exitReason != null) {
        closeUSPosition(pos, exitPrice, exitReason, dayIdx, closedTrades, tradingDays, config.costModelEnabled, config.verbose);
        toClose.push(i);
        const proceeds = exitPrice * pos.quantity - (pos.exitCommission ?? 0);
        pendingSettlement.push({ amount: proceeds, availableDayIdx: dayIdx + US_SETTLEMENT_DAYS });
        lastExitDayIdx.set(pos.ticker, dayIdx);
      }
    }

    for (let i = toClose.length - 1; i >= 0; i--) {
      openPositions.splice(toClose[i], 1);
    }

    // crisis 時の強制クローズ
    if (todayRegime === "crisis") {
      const defClose: number[] = [];
      for (let i = 0; i < openPositions.length; i++) {
        const pos = openPositions[i];
        const defBarIdx = dateIndexMap.get(pos.ticker)?.get(today);
        if (defBarIdx == null) continue;
        const todayBar = allData.get(pos.ticker)![defBarIdx];
        closeUSPosition(pos, todayBar.close, "defensive_exit", dayIdx, closedTrades, tradingDays, config.costModelEnabled, config.verbose);
        defClose.push(i);
        const defProceeds = todayBar.close * pos.quantity - (pos.exitCommission ?? 0);
        pendingSettlement.push({ amount: defProceeds, availableDayIdx: dayIdx + US_SETTLEMENT_DAYS });
        lastExitDayIdx.set(pos.ticker, dayIdx);
      }
      for (let i = defClose.length - 1; i >= 0; i--) {
        openPositions.splice(defClose[i], 1);
      }
    }

    // -- 2. エントリー --
    if (todayRegime !== "crisis" && openPositions.length < config.maxPositions) {
      const signals = precomputedSignals?.get(today) ?? [];
      let dailyEntryCount = 0;

      for (const signal of signals) {
        if (openPositions.length >= config.maxPositions) break;
        if (config.maxDailyEntries != null && dailyEntryCount >= config.maxDailyEntries) break;

        // 重複排除
        if (openPositions.some((p) => p.ticker === signal.ticker)) continue;

        // クールダウン
        const lastExit = lastExitDayIdx.get(signal.ticker);
        if (lastExit != null && dayIdx - lastExit < config.cooldownDays) continue;

        // SL計算
        const rawSL = signal.entryPrice - signal.atr14 * config.atrMultiplier;
        const maxSL = signal.entryPrice * (1 - config.maxLossPct);
        const stopLossPrice = Math.max(rawSL, maxSL);
        if (stopLossPrice >= signal.entryPrice) continue;

        // TP（実質無効、TSに委ねる）
        const takeProfitPrice = signal.entryPrice + signal.atr14 * 5;

        // ポジションサイジング（1株単位）
        const quantity = calculateUSPositionSize({
          cash,
          entryPrice: signal.entryPrice,
          stopLossPrice,
          riskPerTradePct: US_GAPUP_RISK_PER_TRADE_PCT,
          positionCapEnabled: config.positionCapEnabled !== false,
        });
        if (quantity <= 0) continue;

        // VIX elevated: サイズ半減
        const finalQuantity = todayRegime === "elevated"
          ? Math.max(1, Math.floor(quantity / 2))
          : quantity;

        const tradeValue = signal.entryPrice * finalQuantity;
        const entryCost = config.costModelEnabled ? calculateUSTransactionCosts(tradeValue, false) : 0;
        cash -= tradeValue + entryCost;

        const position: SimulatedPosition = {
          ticker: signal.ticker,
          entryDate: today,
          entryPrice: signal.entryPrice,
          takeProfitPrice,
          stopLossPrice,
          quantity: finalQuantity,
          volumeSurgeRatio: signal.volumeSurgeRatio,
          regime: todayRegime,
          maxHighDuringHold: signal.entryPrice,
          minLowDuringHold: signal.entryPrice,
          trailingStopPrice: null,
          entryAtr: signal.atr14,
          exitDate: null,
          exitPrice: null,
          exitReason: null,
          pnl: null,
          pnlPct: null,
          holdingDays: null,
          limitLockDays: 0,
          entryCommission: Math.round(entryCost * 100) / 100,
          exitCommission: null,
          totalCost: null,
          tax: null,
          grossPnl: null,
          netPnl: null,
        };

        openPositions.push(position);
        dailyEntryCount++;

        if (config.verbose) {
          console.log(
            `  [${today}] ${signal.ticker} GapUp entry: $${signal.entryPrice.toFixed(2)} x${finalQuantity}` +
            ` (gap${(signal.gapPct * 100).toFixed(1)}%, vol${signal.volumeSurgeRatio.toFixed(1)}x, SL$${stopLossPrice.toFixed(2)})`,
          );
        }
      }
    }

    // -- 3. エクイティ更新 --
    let positionsValue = 0;
    for (const pos of openPositions) {
      const eqBarIdx = dateIndexMap.get(pos.ticker)?.get(today);
      const markPrice = eqBarIdx != null ? allData.get(pos.ticker)![eqBarIdx].close : pos.entryPrice;
      positionsValue += markPrice * pos.quantity;
    }
    const pendingTotal = pendingSettlement.reduce((sum, s) => sum + s.amount, 0);
    equityCurve.push({
      date: today,
      cash,
      positionsValue,
      totalEquity: cash + positionsValue + pendingTotal,
      openPositionCount: openPositions.length,
    });
  }

  // 未クローズポジション
  for (const pos of openPositions) {
    pos.exitReason = "still_open";
    closedTrades.push(pos);
  }

  const metrics = calculateMetrics(closedTrades, equityCurve, config.initialBudget);
  return { config, trades: closedTrades, equityCurve, metrics };
}
