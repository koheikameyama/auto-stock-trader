/**
 * Mean Reversion (平均回帰) シミュレーションエンジン
 *
 * エントリー条件（全て満たす場合）:
 *   - RSI(14) < rsiOversold (30)
 *   - 終値 < ボリンジャーバンド下限 (SMA20 - 2*stddev)
 *   - 出来高 > avgVolume25 * volSurgeRatio
 *   - ユニバースフィルター通過
 *
 * エグジット条件（いずれか）:
 *   - RSI(14) > exitRsi (50) → "take_profit"
 *   - 終値 > SMA(exitSmaPeriod) → "take_profit"
 *   - checkPositionExit() による SL / トレーリングストップ / タイムストップ
 */

import type { OHLCVData } from "../../core/technical-analysis";
import { analyzeTechnicals } from "../../core/technical-analysis";
import { calculateSMA, calculateRSI, calculateBollingerBands } from "../../lib/technical-indicators";
import { checkPositionExit } from "../../core/exit-checker";
import { calculateUSTransactionCosts } from "./us-trading-costs";
import { determineMarketRegime } from "../../core/market-regime";
import { calculateMetrics } from "../metrics";
import {
  US_MIN_WINDOW_BARS,
  passesUSUniverseGates,
  calculateUSPositionSize,
  closeUSPosition,
  precomputeUSSimData,
  type USPrecomputedSimData,
} from "./us-simulation-helpers";
import { US_MEAN_REVERSION_RISK_PER_TRADE_PCT } from "./us-mean-reversion-config";
import type {
  USMeanReversionBacktestConfig,
  USMeanReversionBacktestResult,
} from "./us-types";
import type {
  SimulatedPosition,
  DailyEquity,
  RegimeLevel,
} from "../types";

// ──────────────────────────────────────────
// シグナル型
// ──────────────────────────────────────────

/** 事前計算された Mean Reversion シグナル */
export interface PrecomputedMeanReversionSignal {
  ticker: string;
  entryPrice: number;
  rsi: number;
  atr14: number;
  volumeSurgeRatio: number;
}

export type PrecomputedMeanReversionSignals = Map<string, PrecomputedMeanReversionSignal[]>;

// ──────────────────────────────────────────
// シグナル事前計算
// ──────────────────────────────────────────

/**
 * Mean Reversion シグナルを事前計算する
 *
 * 各営業日について、RSI < rsiOversold + BB下限割れ + 出来高サージ を
 * 満たす銘柄を抽出し、RSI昇順（最も売られすぎ順）でソートする。
 */
export function precomputeUSMeanReversionDailySignals(
  config: Pick<USMeanReversionBacktestConfig,
    | "maxPrice" | "minPrice" | "minAtrPct" | "minAvgVolume25" | "minTurnover"
    | "rsiOversold" | "bbLookback" | "bbStdDev" | "volSurgeRatio"
    | "marketTrendFilter" | "marketTrendThreshold" | "indexTrendFilter"
  >,
  allData: Map<string, OHLCVData[]>,
  precomputed: USPrecomputedSimData,
): PrecomputedMeanReversionSignals {
  const result: PrecomputedMeanReversionSignals = new Map();
  const { tradingDays, dailyBreadth, dailyIndexAboveSma } = precomputed;
  const breadthThreshold = config.marketTrendThreshold ?? 0.5;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const today = tradingDays[dayIdx];

    // マーケットフィルター
    if (config.marketTrendFilter && (dailyBreadth.get(today) ?? 0) < breadthThreshold) continue;
    if (config.indexTrendFilter && !dailyIndexAboveSma.get(today)) continue;

    const daySignals: PrecomputedMeanReversionSignal[] = [];

    for (const [ticker, bars] of allData) {
      const tickerIndex = precomputed.dateIndexMap.get(ticker);
      const todayIdx = tickerIndex?.get(today);
      if (todayIdx == null) continue;

      const todayBar = bars[todayIdx];

      // テクニカル指標計算
      const windowEnd = todayIdx + 1;
      const windowStart = Math.max(0, windowEnd - US_MIN_WINDOW_BARS);
      const window = bars.slice(windowStart, windowEnd);
      if (window.length < 30) continue;

      const summary = analyzeTechnicals([...window].reverse());
      if (summary.atr14 == null || summary.rsi == null) continue;

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

      // RSI < rsiOversold
      if (summary.rsi >= config.rsiOversold) continue;

      // ボリンジャーバンド下限割れ
      // analyzeTechnicals は BB(20, 2.0) をデフォルトで計算するが、
      // config のパラメータに合わせて再計算する
      const priceData = [...window].reverse().map((d) => ({
        close: d.close,
        high: d.high,
        low: d.low,
      }));
      const bb = calculateBollingerBands(priceData, config.bbLookback, config.bbStdDev);
      if (bb.lower == null || todayBar.close >= bb.lower) continue;

      // 出来高サージ
      const volumeSurgeRatio = todayBar.volume / avgVolume25;
      if (volumeSurgeRatio < config.volSurgeRatio) continue;

      const entryPrice = todayBar.close;
      const atr14 = summary.atr14;

      // SLプレビュー
      const rawSL = entryPrice - atr14;
      if (rawSL >= entryPrice) continue;

      daySignals.push({
        ticker,
        entryPrice,
        rsi: summary.rsi,
        atr14,
        volumeSurgeRatio: Math.round(volumeSurgeRatio * 100) / 100,
      });
    }

    if (daySignals.length > 0) {
      // RSI昇順ソート（最も売られすぎ = 最も反発余地がある銘柄優先）
      daySignals.sort((a, b) => a.rsi - b.rsi);
      result.set(today, daySignals);
    }
  }

  return result;
}

// ──────────────────────────────────────────
// バックテスト本体
// ──────────────────────────────────────────

/**
 * Mean Reversion バックテストを実行する
 */
export function runUSMeanReversionBacktest(
  config: USMeanReversionBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData?: Map<string, number>,
  indexData?: Map<string, number>,
  precomputed?: USPrecomputedSimData,
  precomputedSignals?: PrecomputedMeanReversionSignals,
): USMeanReversionBacktestResult {
  const openPositions: SimulatedPosition[] = [];
  const closedTrades: SimulatedPosition[] = [];
  const equityCurve: DailyEquity[] = [];
  const lastExitDayIdx = new Map<string, number>();
  let cash = config.initialBudget;
  const pendingSettlement: { amount: number; availableDayIdx: number }[] = [];
  const US_SETTLEMENT_DAYS = 1;

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
    precomputedSignals = precomputeUSMeanReversionDailySignals(config, allData, precomputed);
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

    // ── 1. オープンポジションの出口判定 ──
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

      // ── 平均回帰固有の利確判定（標準exit-checkerより先に評価） ──
      let mrExitPrice: number | null = null;
      let mrExitReason: SimulatedPosition["exitReason"] = null;

      // RSI / SMA を計算
      const windowEnd = barIdx + 1;
      const windowStart = Math.max(0, windowEnd - US_MIN_WINDOW_BARS);
      const window = bars.slice(windowStart, windowEnd);
      if (window.length >= 30) {
        const priceData = [...window].reverse().map((d) => ({
          close: d.close,
          high: d.high,
          low: d.low,
        }));

        const rsi = calculateRSI(priceData);
        const sma = calculateSMA(priceData, config.exitSmaPeriod);

        // RSI回復 → 平均回帰ターゲット到達
        if (rsi != null && rsi > config.exitRsi) {
          mrExitPrice = todayBar.close;
          mrExitReason = "take_profit";
        }

        // SMA回帰 → 平均回帰ターゲット到達
        if (mrExitPrice == null && sma != null && todayBar.close > sma) {
          mrExitPrice = todayBar.close;
          mrExitReason = "take_profit";
        }
      }

      if (mrExitPrice != null && mrExitReason != null) {
        closeUSPosition(pos, mrExitPrice, mrExitReason, dayIdx, closedTrades, tradingDays, config.costModelEnabled, config.verbose);
        toClose.push(i);
        const proceeds = mrExitPrice * pos.quantity - (pos.exitCommission ?? 0);
        pendingSettlement.push({ amount: proceeds, availableDayIdx: dayIdx + US_SETTLEMENT_DAYS });
        lastExitDayIdx.set(pos.ticker, dayIdx);
        continue;
      }

      // ── 標準出口判定（SL / トレーリングストップ） ──
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

    // ── 2. エントリー ──
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

        // TP（実質無効、MR固有exitとTSに委ねる）
        const takeProfitPrice = signal.entryPrice + signal.atr14 * 5;

        // ポジションサイジング（1株単位）
        const quantity = calculateUSPositionSize({
          cash,
          entryPrice: signal.entryPrice,
          stopLossPrice,
          riskPerTradePct: US_MEAN_REVERSION_RISK_PER_TRADE_PCT,
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
            `  [${today}] ${signal.ticker} MR entry: $${signal.entryPrice.toFixed(2)} x${finalQuantity}` +
            ` (RSI=${signal.rsi.toFixed(1)}, vol${signal.volumeSurgeRatio.toFixed(1)}x, SL$${stopLossPrice.toFixed(2)})`,
          );
        }
      }
    }

    // ── 3. エクイティ更新 ──
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
