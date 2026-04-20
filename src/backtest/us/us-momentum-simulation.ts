/**
 * Cross-Sectional Momentum シミュレーションエンジン
 *
 * rebalanceDays ごとに全銘柄を lookbackDays リターンでランキングし、
 * 上位 topN をポートフォリオに組み入れる。
 * リバランス間はトレーリングストップ + タイムストップで出口管理。
 * リバランス時に上位から脱落した銘柄は rotation_exit でクローズ。
 */

import type { OHLCVData } from "../../core/technical-analysis";
import { analyzeTechnicals } from "../../core/technical-analysis";
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
import { US_MOMENTUM_RISK_PER_TRADE_PCT } from "./us-momentum-config";
import type {
  USMomentumBacktestConfig,
  USMomentumBacktestResult,
} from "./us-types";
import type {
  SimulatedPosition,
  DailyEquity,
  RegimeLevel,
} from "../types";

// ──────────────────────────────────────────
// シグナル型
// ──────────────────────────────────────────

/** 事前計算されたモメンタムシグナル */
export interface PrecomputedMomentumSignal {
  ticker: string;
  entryPrice: number;
  returnPct: number;
  atr14: number;
  avgVolume25: number;
}

export type PrecomputedMomentumSignals = Map<string, PrecomputedMomentumSignal[]>;

// ──────────────────────────────────────────
// シグナル事前計算
// ──────────────────────────────────────────

/**
 * モメンタムシグナルを事前計算する
 *
 * リバランス日（dayIdx % rebalanceDays === 0）に全銘柄の
 * lookbackDays リターンを算出し、上位をランキング。
 */
export function precomputeUSMomentumDailySignals(
  config: Pick<USMomentumBacktestConfig,
    | "maxPrice" | "minPrice" | "minAtrPct" | "minAvgVolume25" | "minTurnover"
    | "lookbackDays" | "topN" | "rebalanceDays" | "minReturnPct"
    | "marketTrendFilter" | "marketTrendThreshold" | "indexTrendFilter"
  >,
  allData: Map<string, OHLCVData[]>,
  precomputed: USPrecomputedSimData,
): PrecomputedMomentumSignals {
  const result: PrecomputedMomentumSignals = new Map();
  const { tradingDays, dateIndexMap, dailyBreadth, dailyIndexAboveSma } = precomputed;
  const breadthThreshold = config.marketTrendThreshold ?? 0.5;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    // リバランス日のみ計算
    if (dayIdx % config.rebalanceDays !== 0) continue;

    const today = tradingDays[dayIdx];

    // マーケットフィルター
    if (config.marketTrendFilter && (dailyBreadth.get(today) ?? 0) < breadthThreshold) continue;
    if (config.indexTrendFilter && !dailyIndexAboveSma.get(today)) continue;

    const daySignals: PrecomputedMomentumSignal[] = [];

    for (const [ticker, bars] of allData) {
      const tickerIndex = dateIndexMap.get(ticker);
      const todayIdx = tickerIndex?.get(today);
      if (todayIdx == null) continue;

      const todayBar = bars[todayIdx];
      if (!todayBar) continue;

      // lookbackDays 前のバーを探す
      const lookbackIdx = todayIdx - config.lookbackDays;
      if (lookbackIdx < 0) continue;
      const lookbackBar = bars[lookbackIdx];
      if (!lookbackBar || lookbackBar.close <= 0) continue;

      // リターン計算
      const returnPct = ((todayBar.close - lookbackBar.close) / lookbackBar.close) * 100;
      if (returnPct < config.minReturnPct) continue;

      // テクニカル指標計算
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

      // SLプレビュー（ATR × 1.5 がデフォルトだが、config参照前なので仮チェック）
      const rawSL = todayBar.close - summary.atr14;
      if (rawSL >= todayBar.close) continue;

      daySignals.push({
        ticker,
        entryPrice: todayBar.close,
        returnPct: Math.round(returnPct * 100) / 100,
        atr14: summary.atr14,
        avgVolume25,
      });
    }

    if (daySignals.length > 0) {
      // リターン降順ソート → topN
      daySignals.sort((a, b) => b.returnPct - a.returnPct);
      const topSignals = daySignals.slice(0, config.topN);
      result.set(today, topSignals);
    }
  }

  return result;
}

// ──────────────────────────────────────────
// メインシミュレーション
// ──────────────────────────────────────────

/**
 * Cross-Sectional Momentum バックテストを実行する
 */
export function runUSMomentumBacktest(
  config: USMomentumBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData?: Map<string, number>,
  indexData?: Map<string, number>,
  precomputed?: USPrecomputedSimData,
  precomputedSignals?: PrecomputedMomentumSignals,
): USMomentumBacktestResult {
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
    precomputedSignals = precomputeUSMomentumDailySignals(config, allData, precomputed);
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

    // ── 1. オープンポジションの出口判定（SL/TS/タイムストップ） ──
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

    // ── 2. リバランス日: ローテーション + 新規エントリー ──
    if (todayRegime !== "crisis" && dayIdx % config.rebalanceDays === 0) {
      const signals = precomputedSignals?.get(today) ?? [];
      const topTickers = new Set(signals.map((s) => s.ticker));

      // 2a. トップNから脱落した銘柄を rotation_exit でクローズ
      const rotationClose: number[] = [];
      for (let i = 0; i < openPositions.length; i++) {
        const pos = openPositions[i];
        if (!topTickers.has(pos.ticker)) {
          const rotBarIdx = dateIndexMap.get(pos.ticker)?.get(today);
          if (rotBarIdx == null) continue;
          const todayBar = allData.get(pos.ticker)![rotBarIdx];
          closeUSPosition(pos, todayBar.close, "rotation_exit", dayIdx, closedTrades, tradingDays, config.costModelEnabled, config.verbose);
          rotationClose.push(i);
          const proceeds = todayBar.close * pos.quantity - (pos.exitCommission ?? 0);
          pendingSettlement.push({ amount: proceeds, availableDayIdx: dayIdx + US_SETTLEMENT_DAYS });
          lastExitDayIdx.set(pos.ticker, dayIdx);
        }
      }
      for (let i = rotationClose.length - 1; i >= 0; i--) {
        openPositions.splice(rotationClose[i], 1);
      }

      // 2b. 新規エントリー（上位銘柄のうち未保有のもの）
      for (const signal of signals) {
        if (openPositions.length >= config.maxPositions) break;

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

        // ポジションサイジング
        const quantity = calculateUSPositionSize({
          cash,
          entryPrice: signal.entryPrice,
          stopLossPrice,
          riskPerTradePct: US_MOMENTUM_RISK_PER_TRADE_PCT,
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
          volumeSurgeRatio: 0,
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

        if (config.verbose) {
          console.log(
            `  [${today}] ${signal.ticker} Momentum entry: $${signal.entryPrice.toFixed(2)} x${finalQuantity}` +
            ` (ret+${signal.returnPct.toFixed(1)}%, SL$${stopLossPrice.toFixed(2)})`,
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
