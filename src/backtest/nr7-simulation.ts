/**
 * NR7ブレイクバックテスト・シミュレーションエンジン
 *
 * 日次ループでNR7シグナルを検出し、当日終値でエントリー。
 * エグジットは既存の checkPositionExit() を再利用。
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
import { NR7_RISK_PER_TRADE_PCT } from "./nr7-config";
import { isNR7Signal } from "../core/nr7/entry-conditions";
import { passesUniverseGates } from "../core/breakout/entry-conditions";
import { precomputeSimData, type PrecomputedSimData } from "./breakout-simulation";
import type {
  NR7BacktestConfig,
  NR7BacktestResult,
  SimulatedPosition,
  DailyEquity,
  RegimeLevel,
} from "./types";

const MIN_WINDOW_BARS = 80;

/**
 * NR7シグナルの事前計算結果（1銘柄分）
 */
export interface PrecomputedNR7Signal {
  ticker: string;
  entryPrice: number;
  atr14: number;
  volumeSurgeRatio: number;
  /** 当日レンジ（ボラ圧縮度の参考値） */
  squeezeRange: number;
}

/** entryDate → signals (volumeSurgeRatio 降順) */
export type PrecomputedNR7Signals = Map<string, PrecomputedNR7Signal[]>;

/**
 * NR7シグナルを一括事前計算する。
 * WFでは IS/OOS それぞれ1回呼んで全コンボに渡す。
 */
export function precomputeNR7DailySignals(
  config: Pick<NR7BacktestConfig,
    | "maxPrice" | "minAtrPct" | "minAvgVolume25" | "minTurnover" | "minPrice"
    | "lookbackDays" | "volSurgeRatio"
    | "marketTrendFilter" | "marketTrendThreshold" | "indexTrendFilter"
    | "maxLossPct"
    | "indexTrendOffBufferPct" | "indexTrendOnBufferPct"
  >,
  allData: Map<string, OHLCVData[]>,
  precomputed: PrecomputedSimData,
): PrecomputedNR7Signals {
  const result: PrecomputedNR7Signals = new Map();
  const { tradingDays, dateIndexMap, dailyBreadth, dailyIndexAboveSma } = precomputed;
  const breadthThreshold = config.marketTrendThreshold ?? 0.5;
  const lookback = config.lookbackDays;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const today = tradingDays[dayIdx];

    // マーケットフィルター（breadth + index）
    if (config.marketTrendFilter !== false && (dailyBreadth.get(today) ?? 0) < breadthThreshold) continue;
    if (config.indexTrendFilter && !dailyIndexAboveSma.get(today)) continue;

    const daySignals: PrecomputedNR7Signal[] = [];

    for (const [ticker, bars] of allData) {
      const tickerIndex = dateIndexMap.get(ticker);
      const todayIdx = tickerIndex?.get(today);
      if (todayIdx == null || todayIdx < 1) continue;

      // lookback日分のデータが必要
      if (todayIdx < lookback) continue;

      const todayBar = bars[todayIdx];
      if (!todayBar) continue;

      // テクニカル指標計算用ウィンドウ
      const windowEnd = todayIdx + 1;
      const windowStart = Math.max(0, windowEnd - MIN_WINDOW_BARS);
      const window = bars.slice(windowStart, windowEnd);
      if (window.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) continue;

      const summary = analyzeTechnicals([...window].reverse());
      if (summary.atr14 == null) continue;

      const atrPct = (summary.atr14 / todayBar.close) * 100;
      const avgVolume25 = summary.volumeAnalysis.avgVolume20;
      if (avgVolume25 == null) continue;

      // ユニバースフィルター
      if (!passesUniverseGates({
        price: todayBar.close, avgVolume25, atrPct,
        maxPrice: config.maxPrice, minAvgVolume25: config.minAvgVolume25, minAtrPct: config.minAtrPct,
        minTurnover: config.minTurnover, minPrice: config.minPrice,
      })) continue;

      // 直近 lookback 日分のレンジ配列を構築
      const ranges: number[] = [];
      let prevHigh6 = -Infinity;
      for (let i = lookback - 1; i >= 0; i--) {
        const bar = bars[todayIdx - i];
        if (!bar) { ranges.length = 0; break; }
        ranges.push(bar.high - bar.low);
        // 当日（i=0）以外の高値を集めて前6日最高値を求める
        if (i > 0) {
          prevHigh6 = Math.max(prevHigh6, bar.high);
        }
      }
      if (ranges.length < lookback) continue;

      const volumeSurgeRatio = todayBar.volume / avgVolume25;

      // NR7シグナル判定
      if (!isNR7Signal({
        ranges,
        close: todayBar.close,
        open: todayBar.open,
        prevHigh6,
        volume: todayBar.volume,
        avgVolume25,
        volSurgeRatio: config.volSurgeRatio,
      })) continue;

      const entryPrice = todayBar.close;
      const atr14 = summary.atr14;

      // SL プレビュー（riskPerShare <= 0 の銘柄を早期除外）
      const rawSL = entryPrice - atr14;
      if (rawSL >= entryPrice) continue;

      daySignals.push({
        ticker,
        entryPrice,
        atr14,
        volumeSurgeRatio: Math.round(volumeSurgeRatio * 100) / 100,
        squeezeRange: Math.round((todayBar.high - todayBar.low) * 10) / 10,
      });
    }

    if (daySignals.length > 0) {
      // volumeSurgeRatio 降順
      daySignals.sort((a, b) => b.volumeSurgeRatio - a.volumeSurgeRatio);
      result.set(today, daySignals);
    }
  }

  return result;
}

/**
 * NR7バックテストを実行する
 */
export function runNR7Backtest(
  config: NR7BacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData?: Map<string, number>,
  indexData?: Map<string, number>,
  precomputed?: PrecomputedSimData,
  precomputedSignals?: PrecomputedNR7Signals,
): NR7BacktestResult {
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

    // シグナルも計算
    precomputedSignals = precomputeNR7DailySignals(config, allData, computed);
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
          strategy: "nr7",
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

        // ポジションサイジング（リスクベース + 資金上限キャップ）
        const riskPerShare = signal.entryPrice - stopLossPrice;
        if (riskPerShare <= 0) continue;
        const riskAmount = cash * (NR7_RISK_PER_TRADE_PCT / 100);
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
            ` (vol${signal.volumeSurgeRatio.toFixed(1)}x, range¥${signal.squeezeRange}, SL¥${stopLossPrice})`,
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
  config: NR7BacktestConfig,
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
