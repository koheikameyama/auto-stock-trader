/**
 * 週足レンジブレイク バックテスト・シミュレーションエンジン
 *
 * 週足レベルでN週高値ブレイクを検出し、ブレイク週の最終営業日終値でエントリー。
 * エグジットは日足ベースで checkPositionExit() を再利用。
 */

import type { OHLCVData } from "../core/technical-analysis";
import { analyzeTechnicals } from "../core/technical-analysis";
import { checkPositionExit } from "../core/exit-checker";
import { calculateCommission, calculateTax } from "../core/trading-costs";
import { getLimitDownPrice } from "../lib/constants/price-limits";
import { determineMarketRegime } from "../core/market-regime";
import { UNIT_SHARES } from "../lib/constants/trading";
import { getDynamicMaxPositionPct } from "../core/risk-manager";
import { TECHNICAL_MIN_DATA } from "../lib/constants";
import { calculateMetrics } from "./metrics";
import { WEEKLY_BREAK_RISK_PER_TRADE_PCT } from "./weekly-break-config";
import { passesUniverseGates } from "../core/breakout/entry-conditions";
import { aggregateDailyToWeekly } from "../lib/technical-indicators";
import { isWeeklyBreakSignal } from "../core/weekly-break/entry-conditions";
import { precomputeSimData, type PrecomputedSimData } from "./breakout-simulation";
import type {
  WeeklyBreakBacktestConfig,
  WeeklyBreakBacktestResult,
  SimulatedPosition,
  DailyEquity,
  RegimeLevel,
} from "./types";

const MIN_WINDOW_BARS = 80;

/**
 * 週足ブレイクシグナルの事前計算結果（1銘柄分）
 */
export interface PrecomputedWeeklyBreakSignal {
  ticker: string;
  /** エントリー価格（ブレイク週最終営業日の終値） */
  entryPrice: number;
  /** 日足ATR14（エントリー日時点） */
  atr14: number;
  /** N週高値 */
  weeklyHigh: number;
  /** 週足出来高サージ倍率 */
  weeklyVolSurge: number;
  /** ブレイク強度: (close - weeklyHigh) / weeklyHigh */
  breakStrength: number;
}

/** weekEndDate → signals (breakStrength 降順) */
export type PrecomputedWeeklyBreakSignals = Map<string, PrecomputedWeeklyBreakSignal[]>;

/**
 * 週足ブレイクシグナルを一括事前計算する。
 * WFでは IS/OOS それぞれ1回呼んで全コンボに渡す。
 */
export function precomputeWeeklyBreakSignals(
  config: Pick<WeeklyBreakBacktestConfig,
    | "maxPrice" | "minAtrPct" | "minAvgVolume25" | "minTurnover" | "minPrice"
    | "weeklyHighLookback" | "weeklyVolSurgeRatio"
    | "marketTrendFilter" | "marketTrendThreshold" | "indexTrendFilter"
    | "maxLossPct"
  >,
  allData: Map<string, OHLCVData[]>,
  precomputed: PrecomputedSimData,
): PrecomputedWeeklyBreakSignals {
  const result: PrecomputedWeeklyBreakSignals = new Map();
  const { dateIndexMap, dailyBreadth, dailyIndexAboveSma, tradingDayIndex } = precomputed;
  const breadthThreshold = config.marketTrendThreshold ?? 0.5;

  // 各銘柄ごとに週足を生成し、ブレイクを検出
  for (const [ticker, bars] of allData) {
    const tickerIndex = dateIndexMap.get(ticker);
    if (!tickerIndex) continue;

    // 日足→週足に集計（oldest-first前提）
    const weeklyBars = aggregateDailyToWeekly(bars);
    if (weeklyBars.length < config.weeklyHighLookback + 1) continue;

    // 各週についてブレイク判定
    for (let wi = config.weeklyHighLookback; wi < weeklyBars.length; wi++) {
      const weekSlice = weeklyBars.slice(0, wi + 1);
      const signal = isWeeklyBreakSignal(weekSlice, config.weeklyHighLookback, config.weeklyVolSurgeRatio);
      if (!signal.isBreak) continue;

      // ブレイク週の最終営業日を特定
      // weeklyBar.date は週初日。その週に含まれる最後の日足の日付を探す
      const weekStartDate = weeklyBars[wi].date;
      const nextWeekStartDate = wi + 1 < weeklyBars.length ? weeklyBars[wi + 1].date : "9999-12-31";

      // その週に含まれる日足の最終日を見つける
      let weekEndDate: string | null = null;
      let weekEndBarIdx: number | null = null;
      for (let di = bars.length - 1; di >= 0; di--) {
        if (bars[di].date >= weekStartDate && bars[di].date < nextWeekStartDate) {
          weekEndDate = bars[di].date;
          weekEndBarIdx = di;
          break;
        }
      }
      if (!weekEndDate || weekEndBarIdx == null) continue;

      // シミュレーション期間内か確認
      const dayIdxInSim = tradingDayIndex.get(weekEndDate);
      if (dayIdxInSim == null) continue;

      // マーケットフィルター
      if (config.marketTrendFilter && (dailyBreadth.get(weekEndDate) ?? 0) < breadthThreshold) continue;
      if (config.indexTrendFilter && !dailyIndexAboveSma.get(weekEndDate)) continue;

      // テクニカル指標計算（日足ベース）
      const windowEnd = weekEndBarIdx + 1;
      const windowStart = Math.max(0, windowEnd - MIN_WINDOW_BARS);
      const window = bars.slice(windowStart, windowEnd);
      if (window.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) continue;

      const summary = analyzeTechnicals([...window].reverse());
      if (summary.atr14 == null) continue;

      const entryPrice = bars[weekEndBarIdx].close;
      const atrPct = (summary.atr14 / entryPrice) * 100;
      const avgVolume25 = summary.volumeAnalysis.avgVolume20;
      if (avgVolume25 == null) continue;

      // ユニバースフィルター
      if (!passesUniverseGates({
        price: entryPrice, avgVolume25, atrPct,
        maxPrice: config.maxPrice, minAvgVolume25: config.minAvgVolume25, minAtrPct: config.minAtrPct,
        minTurnover: config.minTurnover, minPrice: config.minPrice,
      })) continue;

      // SL プレビュー
      const rawSL = entryPrice - summary.atr14;
      if (rawSL >= entryPrice) continue;

      const breakStrength = (signal.weeklyClose - signal.weeklyHigh) / signal.weeklyHigh;

      const existing = result.get(weekEndDate) ?? [];
      existing.push({
        ticker,
        entryPrice,
        atr14: summary.atr14,
        weeklyHigh: signal.weeklyHigh,
        weeklyVolSurge: Math.round(signal.weeklyVolSurge * 100) / 100,
        breakStrength: Math.round(breakStrength * 10000) / 10000,
      });
      result.set(weekEndDate, existing);
    }
  }

  // 各日のシグナルをブレイク強度でソート
  for (const [, signals] of result) {
    signals.sort((a, b) => b.breakStrength - a.breakStrength);
  }

  return result;
}

/**
 * 週足レンジブレイクバックテストを実行する
 */
export function runWeeklyBreakBacktest(
  config: WeeklyBreakBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData?: Map<string, number>,
  indexData?: Map<string, number>,
  precomputed?: PrecomputedSimData,
  precomputedSignals?: PrecomputedWeeklyBreakSignals,
): WeeklyBreakBacktestResult {
  const openPositions: SimulatedPosition[] = [];
  const closedTrades: SimulatedPosition[] = [];
  const equityCurve: DailyEquity[] = [];
  const lastExitDayIdx = new Map<string, number>();
  let cash = config.initialBudget;
  const pendingSettlement: { amount: number; availableDayIdx: number }[] = [];

  let dateIndexMap: Map<string, Map<string, number>>;
  let tradingDays: string[];
  let tradingDayIndex: Map<string, number>;

  if (precomputed) {
    dateIndexMap = precomputed.dateIndexMap;
    tradingDays = precomputed.tradingDays;
    tradingDayIndex = precomputed.tradingDayIndex;
  } else {
    const computed = precomputeSimData(
      config.startDate, config.endDate, allData,
      config.marketTrendFilter ?? false,
      config.indexTrendFilter ?? false,
      config.indexTrendSmaPeriod ?? 50,
      indexData,
      undefined,
      undefined,
      config.indexTrendOffBufferPct,
      config.indexTrendOnBufferPct,
    ) as PrecomputedSimData;
    dateIndexMap = computed.dateIndexMap;
    tradingDays = computed.tradingDays;
    tradingDayIndex = computed.tradingDayIndex;

    precomputedSignals = precomputeWeeklyBreakSignals(config, allData, computed);
  }

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const today = tradingDays[dayIdx];

    // T+2 受渡完了分をcashに解放
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

      // エントリー日はSL判定をスキップ
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
          strategy: "weekly-break",
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

      // 値幅制限シミュレーション
      if (config.priceLimitEnabled && exitPrice != null && exitReason === "stop_loss") {
        const prevBarIdx = dayIdx > 0 ? dateIndexMap.get(pos.ticker)?.get(tradingDays[dayIdx - 1]) : undefined;
        const prevBar = prevBarIdx != null ? bars[prevBarIdx] : null;
        if (prevBar) {
          const limitDown = getLimitDownPrice(prevBar.close);
          if (todayBar.open <= limitDown && todayBar.low <= limitDown && todayBar.close <= limitDown) {
            exitPrice = null;
            exitReason = null;
            pos.limitLockDays++;
          } else if (exitPrice < limitDown) {
            exitPrice = limitDown;
          }
        }
      }

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
        closePosition(pos, exitPrice, exitReason, dayIdx, closedTrades, tradingDays, config);
        toClose.push(i);
        const proceeds = exitPrice * pos.quantity - (pos.exitCommission ?? 0) - (pos.tax ?? 0);
        pendingSettlement.push({ amount: proceeds, availableDayIdx: dayIdx + 2 });
        lastExitDayIdx.set(pos.ticker, dayIdx);
      }
    }

    // クローズしたポジションを除去（逆順）
    for (let i = toClose.length - 1; i >= 0; i--) {
      openPositions.splice(toClose[i], 1);
    }

    // ── 1.5 ディフェンシブ: crisis 時の強制クローズ ──
    if (todayRegime === "crisis") {
      const defClose: number[] = [];
      for (let i = 0; i < openPositions.length; i++) {
        const pos = openPositions[i];
        const defBarIdx = dateIndexMap.get(pos.ticker)?.get(today);
        if (defBarIdx == null) continue;
        const todayBar = allData.get(pos.ticker)![defBarIdx];
        closePosition(pos, todayBar.close, "defensive_exit", dayIdx, closedTrades, tradingDays, config);
        defClose.push(i);
        const defProceeds = todayBar.close * pos.quantity - (pos.exitCommission ?? 0) - (pos.tax ?? 0);
        pendingSettlement.push({ amount: defProceeds, availableDayIdx: dayIdx + 2 });
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
        const stopLossPrice = Math.round(Math.max(rawSL, maxSL));
        if (stopLossPrice >= signal.entryPrice) continue;

        // TP（実質無効、TSに委ねる）
        const takeProfitPrice = Math.round(signal.entryPrice + signal.atr14 * 5);

        // ポジションサイジング
        const riskPerShare = signal.entryPrice - stopLossPrice;
        if (riskPerShare <= 0) continue;
        const riskAmount = cash * (WEEKLY_BREAK_RISK_PER_TRADE_PCT / 100);
        const riskBasedShares = Math.floor(riskAmount / riskPerShare);
        const maxPositionPct = config.positionCapEnabled !== false ? getDynamicMaxPositionPct(cash, signal.entryPrice) : 100;
        const budgetBasedShares = Math.floor(cash * (maxPositionPct / 100) / signal.entryPrice);
        const quantity = Math.floor(Math.min(riskBasedShares, budgetBasedShares) / UNIT_SHARES) * UNIT_SHARES;
        if (quantity <= 0) continue;
        if (signal.entryPrice * quantity > cash) continue;

        // VIX elevated: サイズ半減
        const finalQuantity = todayRegime === "elevated"
          ? Math.floor(quantity / 2 / UNIT_SHARES) * UNIT_SHARES
          : quantity;
        if (finalQuantity <= 0) continue;

        const tradeValue = signal.entryPrice * finalQuantity;
        const entryCommission = config.costModelEnabled ? calculateCommission(tradeValue) : 0;
        cash -= tradeValue + entryCommission;

        const position: SimulatedPosition = {
          ticker: signal.ticker,
          entryDate: today,
          entryPrice: signal.entryPrice,
          takeProfitPrice,
          stopLossPrice,
          quantity: finalQuantity,
          volumeSurgeRatio: signal.weeklyVolSurge,
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
          entryCommission,
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
            `  [${today}] ${signal.ticker} エントリー: ¥${signal.entryPrice} x${finalQuantity}` +
            ` (wkHigh${signal.weeklyHigh}, vol${signal.weeklyVolSurge}x, SL¥${stopLossPrice})`,
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

  // 未クローズポジションを still_open としてマーク
  for (const pos of openPositions) {
    pos.exitReason = "still_open";
    closedTrades.push(pos);
  }

  const allTrades = [...closedTrades];
  const metrics = calculateMetrics(allTrades, equityCurve, config.initialBudget);

  return { config, trades: allTrades, equityCurve, metrics };
}

/** ポジションクローズ共通処理 */
function closePosition(
  pos: SimulatedPosition,
  exitPrice: number,
  exitReason: SimulatedPosition["exitReason"],
  dayIdx: number,
  closedTrades: SimulatedPosition[],
  tradingDays: string[],
  config: WeeklyBreakBacktestConfig,
): void {
  const grossPnl = (exitPrice - pos.entryPrice) * pos.quantity;
  const pnlPct = pos.entryPrice > 0
    ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
    : 0;
  const entryDayIdx = tradingDays.indexOf(pos.entryDate);
  const holdingDays = entryDayIdx >= 0 ? dayIdx - entryDayIdx : 1;

  const exitValue = exitPrice * pos.quantity;
  const exitCommission = config.costModelEnabled ? calculateCommission(exitValue) : 0;
  const totalCost = (pos.entryCommission ?? 0) + exitCommission;
  const tax = grossPnl > 0 && config.costModelEnabled ? calculateTax(grossPnl, totalCost) : 0;
  const netPnl = grossPnl - totalCost - tax;

  pos.exitDate = tradingDays[dayIdx];
  pos.exitPrice = exitPrice;
  pos.exitReason = exitReason;
  pos.pnl = Math.round(grossPnl);
  pos.pnlPct = Math.round(pnlPct * 100) / 100;
  pos.holdingDays = holdingDays;
  pos.exitCommission = exitCommission;
  pos.totalCost = Math.round(totalCost);
  pos.tax = Math.round(tax);
  pos.grossPnl = Math.round(grossPnl);
  pos.netPnl = Math.round(netPnl);

  closedTrades.push(pos);

  if (config.verbose) {
    console.log(
      `  [${tradingDays[dayIdx]}] ${pos.ticker} ${exitReason}: ¥${exitPrice} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%, ${holdingDays}日)`,
    );
  }
}
