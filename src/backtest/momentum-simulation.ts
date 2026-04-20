/**
 * モメンタム バックテスト・シミュレーションエンジン
 *
 * リバランス駆動: rebalanceDays ごとに全銘柄をリターンでランキングし、
 * 上位 topN 銘柄を保有。トップN外に落ちた銘柄はローテーション出口で決済。
 * リバランス日以外はSL・トレーリングストップ・タイムストップのみ動作。
 */

import type { OHLCVData } from "../core/technical-analysis";
import { checkPositionExit } from "../core/exit-checker";
import { calculateCommission, calculateTax } from "../core/trading-costs";
import { getLimitDownPrice } from "../lib/constants/price-limits";
import { determineMarketRegime } from "../core/market-regime";
import { UNIT_SHARES } from "../lib/constants/trading";
import { getDynamicMaxPositionPct } from "../core/risk-manager";
import { calculateMetrics } from "./metrics";
import { MOMENTUM_RISK_PER_TRADE_PCT } from "./momentum-config";
import { rankByMomentum } from "../core/momentum/entry-conditions";
import { passesUniverseGates } from "../core/breakout/entry-conditions";
import { precomputeSimData, type PrecomputedSimData } from "./breakout-simulation";
import type {
  MomentumBacktestConfig,
  MomentumBacktestResult,
  SimulatedPosition,
  DailyEquity,
  RegimeLevel,
} from "./types";

/**
 * リバランス日のランキング結果（事前計算用）
 */
export interface PrecomputedMomentumSignal {
  ticker: string;
  returnPct: number;
  currentPrice: number;
  atr14: number;
  avgVolume25: number;
}

/** rebalanceDate → ranked signals */
export type PrecomputedMomentumSignals = Map<string, PrecomputedMomentumSignal[]>;

/**
 * モメンタムランキングを一括事前計算する。
 * WFでは IS/OOS それぞれ1回呼んで全コンボに渡す。
 */
export function precomputeMomentumSignals(
  config: Pick<MomentumBacktestConfig,
    | "maxPrice" | "minAtrPct" | "minAvgVolume25" | "minTurnover" | "minPrice"
    | "lookbackDays" | "topN" | "rebalanceDays" | "minReturnPct"
    | "marketTrendFilter" | "marketTrendThreshold" | "indexTrendFilter"
  >,
  allData: Map<string, OHLCVData[]>,
  precomputed: PrecomputedSimData,
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

    // モメンタムランキング
    const rankings = rankByMomentum(
      allData, dateIndexMap, tradingDays, dayIdx,
      config.lookbackDays, config.minReturnPct,
    );

    // ユニバースフィルター適用
    const filtered: PrecomputedMomentumSignal[] = [];
    for (const r of rankings) {
      const atrPct = (r.atr14 / r.currentPrice) * 100;
      if (!passesUniverseGates({
        price: r.currentPrice, avgVolume25: r.avgVolume25, atrPct,
        maxPrice: config.maxPrice, minAvgVolume25: config.minAvgVolume25, minAtrPct: config.minAtrPct,
        minTurnover: config.minTurnover, minPrice: config.minPrice,
      })) continue;

      filtered.push({
        ticker: r.ticker,
        returnPct: r.returnPct,
        currentPrice: r.currentPrice,
        atr14: r.atr14,
        avgVolume25: r.avgVolume25,
      });

      // topN分あれば十分（バッファとして2倍取得）
      if (filtered.length >= config.topN * 2) break;
    }

    if (filtered.length > 0) {
      result.set(today, filtered);
    }
  }

  return result;
}

/**
 * モメンタムバックテストを実行する
 */
export function runMomentumBacktest(
  config: MomentumBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData?: Map<string, number>,
  indexData?: Map<string, number>,
  precomputed?: PrecomputedSimData,
  precomputedSignals?: PrecomputedMomentumSignals,
): MomentumBacktestResult {
  const openPositions: SimulatedPosition[] = [];
  const closedTrades: SimulatedPosition[] = [];
  const equityCurve: DailyEquity[] = [];
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

    precomputedSignals = precomputeMomentumSignals(config, allData, computed);
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

    // ── 1. オープンポジションの出口判定（SL/TS/タイムストップ）──
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
          strategy: "momentum",
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
      }
    }

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
      }
      for (let i = defClose.length - 1; i >= 0; i--) {
        openPositions.splice(defClose[i], 1);
      }
    }

    // ── 2. リバランス（リバランス日のみ） ──
    if (todayRegime !== "crisis" && dayIdx % config.rebalanceDays === 0) {
      const signals = precomputedSignals?.get(today) ?? [];
      const topNTickers = new Set(signals.slice(0, config.topN).map((s) => s.ticker));

      // 2a. トップN外のポジションをローテーション出口でクローズ
      const rotationClose: number[] = [];
      for (let i = 0; i < openPositions.length; i++) {
        const pos = openPositions[i];
        if (topNTickers.has(pos.ticker)) continue; // まだトップNにいる

        const barIdx = dateIndexMap.get(pos.ticker)?.get(today);
        if (barIdx == null) continue;
        const todayBar = allData.get(pos.ticker)![barIdx];

        closePosition(pos, todayBar.close, "rotation_exit", dayIdx, closedTrades, tradingDays, config);
        rotationClose.push(i);
        const proceeds = todayBar.close * pos.quantity - (pos.exitCommission ?? 0) - (pos.tax ?? 0);
        pendingSettlement.push({ amount: proceeds, availableDayIdx: dayIdx + 2 });
      }
      for (let i = rotationClose.length - 1; i >= 0; i--) {
        openPositions.splice(rotationClose[i], 1);
      }

      // 2b. 新たにトップNに入った銘柄をエントリー
      const heldTickers = new Set(openPositions.map((p) => p.ticker));
      for (const signal of signals) {
        if (openPositions.length >= config.maxPositions) break;
        if (heldTickers.has(signal.ticker)) continue;
        if (!topNTickers.has(signal.ticker)) continue;

        // SL計算
        const rawSL = signal.currentPrice - signal.atr14 * config.atrMultiplier;
        const maxSL = signal.currentPrice * (1 - config.maxLossPct);
        const stopLossPrice = Math.round(Math.max(rawSL, maxSL));
        if (stopLossPrice >= signal.currentPrice) continue;

        // TP（実質無効、TSに委ねる）
        const takeProfitPrice = Math.round(signal.currentPrice + signal.atr14 * 5);

        // ポジションサイジング
        const riskPerShare = signal.currentPrice - stopLossPrice;
        if (riskPerShare <= 0) continue;
        const riskAmount = cash * (MOMENTUM_RISK_PER_TRADE_PCT / 100);
        const riskBasedShares = Math.floor(riskAmount / riskPerShare);
        const maxPositionPct = config.positionCapEnabled !== false ? getDynamicMaxPositionPct(cash, signal.currentPrice) : 100;
        const budgetBasedShares = Math.floor(cash * (maxPositionPct / 100) / signal.currentPrice);
        const quantity = Math.floor(Math.min(riskBasedShares, budgetBasedShares) / UNIT_SHARES) * UNIT_SHARES;
        if (quantity <= 0) continue;
        if (signal.currentPrice * quantity > cash) continue;

        // VIX elevated: サイズ半減
        const finalQuantity = todayRegime === "elevated"
          ? Math.floor(quantity / 2 / UNIT_SHARES) * UNIT_SHARES
          : quantity;
        if (finalQuantity <= 0) continue;

        const tradeValue = signal.currentPrice * finalQuantity;
        const entryCommission = config.costModelEnabled ? calculateCommission(tradeValue) : 0;
        cash -= tradeValue + entryCommission;

        const position: SimulatedPosition = {
          ticker: signal.ticker,
          entryDate: today,
          entryPrice: signal.currentPrice,
          takeProfitPrice,
          stopLossPrice,
          quantity: finalQuantity,
          volumeSurgeRatio: 0, // モメンタム戦略では出来高サージは使わない
          regime: todayRegime,
          maxHighDuringHold: signal.currentPrice,
          minLowDuringHold: signal.currentPrice,
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
        heldTickers.add(signal.ticker);

        if (config.verbose) {
          console.log(
            `  [${today}] ${signal.ticker} エントリー: ¥${signal.currentPrice} x${finalQuantity}` +
            ` (ret${signal.returnPct.toFixed(1)}%, SL¥${stopLossPrice})`,
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
  config: MomentumBacktestConfig,
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
