/**
 * Wheel戦略バックテスト シミュレーションエンジン
 *
 * ステートマシン:
 *   CSP売り → [アサイン: 株保有 → CC売り → [コール: サイクル完了]] or [満期消滅]
 *
 * 日次ループで各フェーズの判定・遷移を処理。
 * オプション価格は Black-Scholes で算出（VIXをIVプロキシとして使用）。
 */

import type { OHLCVData } from "../../core/technical-analysis";
import {
  bsPutPrice,
  bsCallPrice,
  bsCallDelta,
  findStrikeForTargetDelta,
} from "../../core/options-pricing";
import { calculateMetrics } from "../metrics";
import {
  precomputeUSSimData,
  passesUSUniverseGates,
  type USPrecomputedSimData,
} from "./us-simulation-helpers";
import type {
  USWheelBacktestConfig,
  USWheelBacktestResult,
  WheelPosition,
  WheelPerformanceMetrics,
  SimulatedOption,
} from "./us-wheel-types";
import type { SimulatedPosition, DailyEquity } from "../types";

const CONTRACT_SIZE = 100;

function daysToYears(days: number): number {
  return days / 365;
}

function daysBetween(dateA: string, dateB: string): number {
  return Math.round(
    (new Date(dateB).getTime() - new Date(dateA).getTime()) / (1000 * 60 * 60 * 24),
  );
}

/**
 * 満期日を算出（dte営業日後ではなくdte暦日後の最近取引日）
 */
function findExpirationDate(
  entryDate: string,
  dte: number,
  tradingDays: string[],
  tradingDayIndex: Map<string, number>,
): string {
  const targetDate = new Date(entryDate);
  targetDate.setDate(targetDate.getDate() + dte);
  const targetStr = targetDate.toISOString().slice(0, 10);

  // 当該日 or それ以前の最近取引日を探す
  let bestDay = tradingDays[tradingDays.length - 1];
  for (const day of tradingDays) {
    if (day >= targetStr) {
      bestDay = day;
      break;
    }
    bestDay = day;
  }

  // tradingDayIndex にある日を返す
  if (tradingDayIndex.has(bestDay)) return bestDay;
  return tradingDays[tradingDays.length - 1];
}

/**
 * VIXからIVを取得
 */
function getIV(vixData: Map<string, number> | undefined, date: string, ivScaleFactor: number): number {
  const vix = vixData?.get(date);
  if (vix == null) return 0.20;
  return (vix / 100) * ivScaleFactor;
}

/**
 * CSP候補銘柄のスクリーニング
 */
function screenCSPCandidates(
  config: USWheelBacktestConfig,
  today: string,
  allData: Map<string, OHLCVData[]>,
  precomputed: USPrecomputedSimData,
  iv: number,
  availableCash: number,
  existingTickers: Set<string>,
): Array<{
  ticker: string;
  strike: number;
  premium: number;
  delta: number;
  premiumYieldAnnualized: number;
  spotPrice: number;
}> {
  const candidates: Array<{
    ticker: string;
    strike: number;
    premium: number;
    delta: number;
    premiumYieldAnnualized: number;
    spotPrice: number;
  }> = [];

  const tte = daysToYears(config.dte);
  if (tte <= 0 || iv <= 0) return candidates;

  for (const [ticker, bars] of allData) {
    if (existingTickers.has(ticker)) continue;

    const idxMap = precomputed.dateIndexMap.get(ticker);
    if (!idxMap) continue;
    const barIdx = idxMap.get(today);
    if (barIdx == null) continue;

    const bar = bars[barIdx];
    if (!bar) continue;

    // ユニバースフィルター
    const windowStart = Math.max(0, barIdx - 25);
    const window25 = bars.slice(windowStart, barIdx + 1);
    const avgVolume25 =
      window25.length >= 25
        ? window25.reduce((s, b) => s + b.volume, 0) / window25.length
        : 0;

    // ATR (14日)
    const windowStart14 = Math.max(0, barIdx - 14);
    const window14 = bars.slice(windowStart14, barIdx + 1);
    let atrSum = 0;
    for (let i = 1; i < window14.length; i++) {
      const tr = Math.max(
        window14[i].high - window14[i].low,
        Math.abs(window14[i].high - window14[i - 1].close),
        Math.abs(window14[i].low - window14[i - 1].close),
      );
      atrSum += tr;
    }
    const atr14 = window14.length > 1 ? atrSum / (window14.length - 1) : 0;
    const atrPct = bar.close > 0 ? (atr14 / bar.close) * 100 : 0;

    if (
      !passesUSUniverseGates({
        price: bar.close,
        avgVolume25,
        atrPct,
        maxPrice: config.maxPrice,
        minPrice: config.minPrice,
        minAvgVolume25: config.minAvgVolume25,
        minAtrPct: config.minAtrPct,
        minTurnover: config.minTurnover,
      })
    )
      continue;

    // アフォーダビリティ事前チェック
    if (bar.close * CONTRACT_SIZE > availableCash * 1.2) continue;

    // ストライク探索
    const result = findStrikeForTargetDelta({
      spotPrice: bar.close,
      targetDelta: -config.putDelta,
      tte,
      riskFreeRate: config.riskFreeRate,
      iv,
      optionType: "put",
    });

    // 担保チェック
    if (result.strike * CONTRACT_SIZE > availableCash) continue;

    // 最低プレミアムチェック（手数料の2倍以上）
    if (result.premium * CONTRACT_SIZE < config.optionsCommission * 2) continue;

    // 年率プレミアム利回り
    const premiumYield = (result.premium * CONTRACT_SIZE) / (result.strike * CONTRACT_SIZE);
    const annualized = premiumYield * (365 / config.dte);

    candidates.push({
      ticker,
      strike: result.strike,
      premium: result.premium,
      delta: result.delta,
      premiumYieldAnnualized: annualized,
      spotPrice: bar.close,
    });
  }

  // ソート
  if (config.selectionSort === "premiumYield") {
    candidates.sort((a, b) => b.premiumYieldAnnualized - a.premiumYieldAnnualized);
  } else if (config.selectionSort === "delta") {
    candidates.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  } else {
    candidates.sort((a, b) => b.premiumYieldAnnualized - a.premiumYieldAnnualized);
  }

  return candidates;
}

/**
 * WheelPosition[] → SimulatedPosition[] 変換（既存metricsの再利用用）
 */
function convertToSimulatedPositions(cycles: WheelPosition[]): SimulatedPosition[] {
  return cycles
    .filter((c) => c.cycleEndDate != null && c.cyclePnl != null)
    .map((cycle) => {
      const collateral = cycle.collateralLocked > 0
        ? cycle.collateralLocked
        : (cycle.stockCostBasis ?? 0) * CONTRACT_SIZE;
      const cycleDays = daysBetween(cycle.cycleStartDate, cycle.cycleEndDate!);
      const pnlPct =
        collateral > 0
          ? (cycle.cyclePnl! / collateral) * 100
          : 0;

      // entryPrice/exitPriceを使ってpnlPctが正しく計算されるようにする
      // metricsはpnlPctを直接使うので、entryPrice=100, exitPrice=100+pnlPctとする
      const normalizedEntry = 100;
      const normalizedExit = normalizedEntry * (1 + pnlPct / 100);

      return {
        ticker: cycle.ticker,
        entryDate: cycle.cycleStartDate,
        entryPrice: normalizedEntry,
        takeProfitPrice: 0,
        stopLossPrice: 0,
        quantity: 1,
        volumeSurgeRatio: 0,
        regime: null,
        maxHighDuringHold: 0,
        minLowDuringHold: 0,
        trailingStopPrice: null,
        entryAtr: null,
        exitDate: cycle.cycleEndDate,
        exitPrice: normalizedExit,
        exitReason: "time_stop" as const,
        pnl: Math.round(cycle.cyclePnl! * 100) / 100,
        pnlPct: Math.round(pnlPct * 100) / 100,
        holdingDays: cycleDays,
        limitLockDays: 0,
        entryCommission: cycle.totalCommissions / 2,
        exitCommission: cycle.totalCommissions / 2,
        totalCost: cycle.totalCommissions,
        tax: 0,
        grossPnl: Math.round((cycle.cyclePnl! + cycle.totalCommissions) * 100) / 100,
        netPnl: Math.round(cycle.cyclePnl! * 100) / 100,
      };
    });
}

/**
 * Wheel固有メトリクスの計算
 */
function calculateWheelMetrics(
  cycles: WheelPosition[],
  equityCurve: DailyEquity[],
  initialBudget: number,
  _config: USWheelBacktestConfig,
): WheelPerformanceMetrics {
  const simulatedPositions = convertToSimulatedPositions(cycles);
  const baseMetrics = calculateMetrics(simulatedPositions, equityCurve, initialBudget);

  const completedCycles = cycles.filter((c) => c.cycleEndDate != null);
  const allCSPs = cycles.filter((c) => c.csp != null);
  const assignedCSPs = allCSPs.filter(
    (c) => c.csp?.closeReason === "assigned",
  );
  const allCCs = cycles.flatMap((c) => [...c.ccHistory, ...(c.cc ? [c.cc] : [])]);
  const calledCCs = allCCs.filter((c) => c.closeReason === "called_away");
  const earlyClosedOptions = [
    ...allCSPs.filter((c) => c.csp?.closeReason === "early_close"),
    ...cycles.filter((c) => c.ccHistory.some((cc) => cc.closeReason === "early_close") || c.cc?.closeReason === "early_close"),
  ];
  const totalOptions = allCSPs.length + allCCs.length;

  const totalPremiumCollected = cycles.reduce(
    (s, c) => s + c.totalPremiumCollected,
    0,
  );

  // 年率プレミアム利回り（加重平均）
  // collateralLocked はアサイン/満期時に0にリセットされるため、CSPストライクから元の担保額を復元
  let premiumYieldSum = 0;
  let premiumYieldWeight = 0;
  for (const cycle of completedCycles) {
    const originalCollateral = (cycle.csp?.strike ?? 0) * CONTRACT_SIZE;
    if (originalCollateral > 0 && cycle.cycleEndDate) {
      const days = daysBetween(cycle.cycleStartDate, cycle.cycleEndDate);
      if (days > 0) {
        const yieldPct = cycle.totalPremiumCollected / originalCollateral;
        const annualized = yieldPct * (365 / days);
        premiumYieldSum += annualized * originalCollateral;
        premiumYieldWeight += originalCollateral;
      }
    }
  }
  const avgPremiumYieldAnnualized =
    premiumYieldWeight > 0 ? premiumYieldSum / premiumYieldWeight : 0;

  const avgCycleDays =
    completedCycles.length > 0
      ? completedCycles.reduce(
          (s, c) => s + daysBetween(c.cycleStartDate, c.cycleEndDate!),
          0,
        ) / completedCycles.length
      : 0;

  return {
    ...baseMetrics,
    totalPremiumCollected: Math.round(totalPremiumCollected * 100) / 100,
    assignmentRate:
      allCSPs.length > 0
        ? Math.round((assignedCSPs.length / allCSPs.length) * 10000) / 100
        : 0,
    calledAwayRate:
      allCCs.length > 0
        ? Math.round((calledCCs.length / allCCs.length) * 10000) / 100
        : 0,
    avgPremiumYieldAnnualized:
      Math.round(avgPremiumYieldAnnualized * 10000) / 100,
    completedCycles: completedCycles.length,
    avgCycleDays: Math.round(avgCycleDays * 10) / 10,
    cspCount: allCSPs.length,
    ccCount: allCCs.length,
    earlyCloseRate:
      totalOptions > 0
        ? Math.round((earlyClosedOptions.length / totalOptions) * 10000) / 100
        : 0,
  };
}

/**
 * Wheel戦略バックテスト実行
 */
export function runUSWheelBacktest(
  config: USWheelBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData?: Map<string, number>,
  indexData?: Map<string, number>,
  precomputed?: USPrecomputedSimData,
): USWheelBacktestResult {
  // precompute
  const simData =
    precomputed ??
    precomputeUSSimData(
      config.startDate,
      config.endDate,
      allData,
      config.marketTrendFilter,
      config.indexTrendFilter,
      config.indexTrendSmaPeriod,
      indexData,
    );

  const { tradingDays, tradingDayIndex } = simData;
  const startIdx = tradingDays.findIndex((d) => d >= config.startDate);
  if (startIdx < 0) {
    return { config, cycles: [], equityCurve: [], metrics: emptyWheelMetrics() };
  }

  let cash = config.initialBudget;
  const activePositions: WheelPosition[] = [];
  const completedCycles: WheelPosition[] = [];
  const equityCurve: DailyEquity[] = [];

  for (let dayIdx = startIdx; dayIdx < tradingDays.length; dayIdx++) {
    const today = tradingDays[dayIdx];
    if (today > config.endDate) break;

    const iv = getIV(vixData, today, config.ivScaleFactor);

    // ────────────────────────────────────────
    // 1. CSP満期 & 早期クローズ チェック
    // ────────────────────────────────────────
    for (let i = activePositions.length - 1; i >= 0; i--) {
      const pos = activePositions[i];
      if (pos.state !== "CSP_OPEN" || !pos.csp) continue;

      const spotPrice = getSpotPrice(pos.ticker, today, allData, simData);
      if (spotPrice == null) continue;

      if (today >= pos.csp.expirationDate) {
        // 満期判定
        if (spotPrice <= pos.csp.strike) {
          // アサイン: 株を取得
          pos.csp.closeDate = today;
          pos.csp.closeReason = "assigned";
          cash -= pos.csp.strike * CONTRACT_SIZE;
          pos.collateralLocked = 0;
          pos.state = "STOCK_HELD";
          pos.stockCostBasis = pos.csp.strike;
          pos.stockQuantity = CONTRACT_SIZE;
          pos.stockAssignmentDate = today;

          if (config.verbose) {
            console.log(`  [${today}] ${pos.ticker} CSP ASSIGNED @ $${pos.csp.strike.toFixed(2)} (spot=$${spotPrice.toFixed(2)})`);
          }
        } else {
          // 満期消滅: プレミアム確保、サイクル完了
          pos.csp.closeDate = today;
          pos.csp.closeReason = "expired_worthless";
          pos.collateralLocked = 0;
          pos.cycleEndDate = today;
          pos.cyclePnl = pos.totalPremiumCollected - pos.totalCommissions;
          completedCycles.push(pos);
          activePositions.splice(i, 1);

          if (config.verbose) {
            console.log(`  [${today}] ${pos.ticker} CSP EXPIRED worthless → P&L: $${pos.cyclePnl.toFixed(2)}`);
          }
        }
      } else {
        // 早期クローズチェック
        const daysLeft = daysBetween(today, pos.csp.expirationDate);
        const tteRemaining = daysToYears(daysLeft);
        if (tteRemaining > 0 && iv > 0) {
          const currentPremium = bsPutPrice(spotPrice, pos.csp.strike, tteRemaining, config.riskFreeRate, iv);
          const profitPct = 1 - currentPremium / pos.csp.premium;

          if (profitPct >= config.profitTarget) {
            // 買い戻して早期クローズ
            const buybackCost = currentPremium * CONTRACT_SIZE + config.optionsCommission;
            cash -= buybackCost;
            pos.totalCommissions += config.optionsCommission;
            pos.totalPremiumCollected -= currentPremium * CONTRACT_SIZE;
            pos.csp.closeDate = today;
            pos.csp.closePremium = currentPremium;
            pos.csp.closeReason = "early_close";
            pos.collateralLocked = 0;
            pos.cycleEndDate = today;
            pos.cyclePnl = pos.totalPremiumCollected - pos.totalCommissions;
            completedCycles.push(pos);
            activePositions.splice(i, 1);

            if (config.verbose) {
              console.log(`  [${today}] ${pos.ticker} CSP EARLY CLOSE (${(profitPct * 100).toFixed(0)}% profit) → P&L: $${pos.cyclePnl.toFixed(2)}`);
            }
          }
        }
      }
    }

    // ────────────────────────────────────────
    // 2. CC満期 & 早期クローズ チェック
    // ────────────────────────────────────────
    for (let i = activePositions.length - 1; i >= 0; i--) {
      const pos = activePositions[i];
      if (pos.state !== "CC_OPEN" || !pos.cc) continue;

      const spotPrice = getSpotPrice(pos.ticker, today, allData, simData);
      if (spotPrice == null) continue;

      if (today >= pos.cc.expirationDate) {
        if (spotPrice >= pos.cc.strike) {
          // コール: 株を売却、サイクル完了
          pos.cc.closeDate = today;
          pos.cc.closeReason = "called_away";
          cash += pos.cc.strike * CONTRACT_SIZE - config.optionsCommission;
          pos.totalCommissions += config.optionsCommission;
          pos.ccHistory.push(pos.cc);
          pos.cc = null;
          pos.stockQuantity = 0;

          // サイクルP&L: 全プレミアム + (コールストライク - 取得原価) × 100
          const stockPnl = pos.stockCostBasis
            ? (pos.ccHistory[pos.ccHistory.length - 1].strike - pos.stockCostBasis) * CONTRACT_SIZE
            : 0;
          pos.cyclePnl = pos.totalPremiumCollected - pos.totalCommissions + stockPnl;
          pos.cycleEndDate = today;
          pos.state = "STOCK_HELD"; // 一時的、すぐ完了
          completedCycles.push(pos);
          activePositions.splice(i, 1);

          if (config.verbose) {
            console.log(`  [${today}] ${pos.ticker} CC CALLED AWAY @ $${pos.ccHistory[pos.ccHistory.length - 1].strike.toFixed(2)} → cycle P&L: $${pos.cyclePnl.toFixed(2)}`);
          }
        } else {
          // 満期消滅: プレミアム確保、再度CC売り待ち
          pos.cc.closeDate = today;
          pos.cc.closeReason = "expired_worthless";
          pos.ccHistory.push(pos.cc);
          pos.cc = null;
          pos.state = "STOCK_HELD";

          if (config.verbose) {
            console.log(`  [${today}] ${pos.ticker} CC EXPIRED worthless → STOCK_HELD`);
          }
        }
      } else {
        // CC早期クローズチェック
        const daysLeft = daysBetween(today, pos.cc.expirationDate);
        const tteRemaining = daysToYears(daysLeft);
        if (tteRemaining > 0 && iv > 0) {
          const currentPremium = bsCallPrice(spotPrice, pos.cc.strike, tteRemaining, config.riskFreeRate, iv);
          const profitPct = 1 - currentPremium / pos.cc.premium;

          if (profitPct >= config.profitTarget) {
            const buybackCost = currentPremium * CONTRACT_SIZE + config.optionsCommission;
            cash -= buybackCost;
            pos.totalCommissions += config.optionsCommission;
            pos.totalPremiumCollected -= currentPremium * CONTRACT_SIZE;
            pos.cc.closeDate = today;
            pos.cc.closePremium = currentPremium;
            pos.cc.closeReason = "early_close";
            pos.ccHistory.push(pos.cc);
            pos.cc = null;
            pos.state = "STOCK_HELD";

            if (config.verbose) {
              console.log(`  [${today}] ${pos.ticker} CC EARLY CLOSE (${(profitPct * 100).toFixed(0)}% profit) → STOCK_HELD`);
            }
          }
        }
      }
    }

    // ────────────────────────────────────────
    // 2.5. 株保有フェーズのSL / タイムストップ
    // ────────────────────────────────────────
    for (let i = activePositions.length - 1; i >= 0; i--) {
      const pos = activePositions[i];
      if (pos.state !== "STOCK_HELD" || pos.stockCostBasis == null || pos.stockQuantity === 0) continue;

      const spotPrice = getSpotPrice(pos.ticker, today, allData, simData);
      if (spotPrice == null) continue;

      const dropPct = (spotPrice - pos.stockCostBasis) / pos.stockCostBasis;
      const holdDays = pos.stockAssignmentDate ? daysBetween(pos.stockAssignmentDate, today) : 0;

      const hitSL = config.stockStopLossPct > 0 && dropPct <= -config.stockStopLossPct;
      const hitTime = config.stockMaxHoldingDays > 0 && holdDays >= config.stockMaxHoldingDays;

      if (hitSL || hitTime) {
        // 株を売却してサイクル終了
        cash += spotPrice * pos.stockQuantity;
        const stockPnl = (spotPrice - pos.stockCostBasis) * pos.stockQuantity;
        pos.cyclePnl = pos.totalPremiumCollected - pos.totalCommissions + stockPnl;
        pos.cycleEndDate = today;
        pos.stockQuantity = 0;
        completedCycles.push(pos);
        activePositions.splice(i, 1);

        if (config.verbose) {
          const reason = hitSL ? `STOCK SL (${(dropPct * 100).toFixed(1)}%)` : `STOCK TIME STOP (${holdDays}d)`;
          console.log(`  [${today}] ${pos.ticker} ${reason} @ $${spotPrice.toFixed(2)} → cycle P&L: $${pos.cyclePnl.toFixed(2)}`);
        }
      }
    }

    // ────────────────────────────────────────
    // 3. STOCK_HELD → 新規CC売り
    // ────────────────────────────────────────
    for (const pos of activePositions) {
      if (pos.state !== "STOCK_HELD" || pos.cc != null || pos.stockQuantity === 0) continue;

      const spotPrice = getSpotPrice(pos.ticker, today, allData, simData);
      if (spotPrice == null) continue;

      const tte = daysToYears(config.dte);
      if (tte <= 0 || iv <= 0) continue;

      // CCストライクは取得原価以上（損失確定を避ける）
      const result = findStrikeForTargetDelta({
        spotPrice,
        targetDelta: config.callDelta,
        tte,
        riskFreeRate: config.riskFreeRate,
        iv,
        optionType: "call",
      });

      // 取得原価以上のストライクを確保
      let ccStrike = result.strike;
      if (pos.stockCostBasis != null && ccStrike < pos.stockCostBasis) {
        ccStrike = Math.ceil(pos.stockCostBasis * 2) / 2; // $0.50刻みに切り上げ
      }

      // ストライク変更後のプレミアム再計算
      const premium =
        ccStrike === result.strike
          ? result.premium
          : bsCallPrice(spotPrice, ccStrike, tte, config.riskFreeRate, iv);

      // 最低プレミアムチェック
      if (premium * CONTRACT_SIZE < config.optionsCommission) continue;

      const expirationDate = findExpirationDate(today, config.dte, tradingDays, tradingDayIndex);

      const ccOption: SimulatedOption = {
        ticker: pos.ticker,
        optionType: "call",
        strike: ccStrike,
        premium,
        entryDate: today,
        expirationDate,
        entrySpotPrice: spotPrice,
        entryIV: iv,
        entryDelta: bsCallDelta(spotPrice, ccStrike, tte, config.riskFreeRate, iv),
      };

      cash += premium * CONTRACT_SIZE - config.optionsCommission;
      pos.totalPremiumCollected += premium * CONTRACT_SIZE;
      pos.totalCommissions += config.optionsCommission;
      pos.cc = ccOption;
      pos.state = "CC_OPEN";

      if (config.verbose) {
        console.log(`  [${today}] ${pos.ticker} SELL CC: strike=$${ccStrike.toFixed(2)}, prem=$${premium.toFixed(2)}, exp=${expirationDate}`);
      }
    }

    // ────────────────────────────────────────
    // 4. 新規CSP売り（IDLE枠がある場合）
    // ────────────────────────────────────────
    const currentPositionCount = activePositions.length;
    if (currentPositionCount < config.maxWheelPositions) {
      // マーケットフィルター
      let marketPass = true;
      if (config.marketTrendFilter) {
        const breadth = simData.dailyBreadth.get(today) ?? 0;
        if (breadth < config.marketTrendThreshold) marketPass = false;
      }
      if (config.indexTrendFilter) {
        const above = simData.dailyIndexAboveSma.get(today);
        if (above === false) marketPass = false;
      }

      if (marketPass) {
        const totalCollateralLocked = activePositions.reduce(
          (s, p) => s + p.collateralLocked,
          0,
        );
        const availableCash = cash - totalCollateralLocked;
        const existingTickers = new Set(activePositions.map((p) => p.ticker));

        const candidates = screenCSPCandidates(
          config,
          today,
          allData,
          simData,
          iv,
          availableCash,
          existingTickers,
        );

        const slotsAvailable = config.maxWheelPositions - currentPositionCount;

        for (let ci = 0; ci < Math.min(candidates.length, slotsAvailable); ci++) {
          const cand = candidates[ci];
          const collateral = cand.strike * CONTRACT_SIZE;

          // 再度利用可能資金チェック
          const currentCollateral = activePositions.reduce((s, p) => s + p.collateralLocked, 0);
          if (cash - currentCollateral < collateral) break;

          const expirationDate = findExpirationDate(today, config.dte, tradingDays, tradingDayIndex);

          const cspOption: SimulatedOption = {
            ticker: cand.ticker,
            optionType: "put",
            strike: cand.strike,
            premium: cand.premium,
            entryDate: today,
            expirationDate,
            entrySpotPrice: cand.spotPrice,
            entryIV: iv,
            entryDelta: cand.delta,
          };

          const premiumReceived = cand.premium * CONTRACT_SIZE;
          const commission = config.optionsCommission;

          cash += premiumReceived - commission;

          const wheelPos: WheelPosition = {
            ticker: cand.ticker,
            state: "CSP_OPEN",
            cycleStartDate: today,
            csp: cspOption,
            collateralLocked: collateral,
            stockCostBasis: null,
            stockQuantity: 0,
            stockAssignmentDate: null,
            cc: null,
            ccHistory: [],
            totalPremiumCollected: premiumReceived,
            totalCommissions: commission,
            cycleEndDate: null,
            cyclePnl: null,
          };

          activePositions.push(wheelPos);

          if (config.verbose) {
            console.log(
              `  [${today}] ${cand.ticker} SELL CSP: strike=$${cand.strike.toFixed(2)}, ` +
                `prem=$${cand.premium.toFixed(2)} (yield=${(cand.premiumYieldAnnualized * 100).toFixed(1)}%/yr), ` +
                `exp=${expirationDate}`,
            );
          }
        }
      }
    }

    // ────────────────────────────────────────
    // 5. エクイティカーブ
    // ────────────────────────────────────────
    let stocksMarketValue = 0;
    for (const pos of activePositions) {
      if (pos.stockQuantity > 0) {
        const spotPrice = getSpotPrice(pos.ticker, today, allData, simData);
        if (spotPrice != null) {
          stocksMarketValue += spotPrice * pos.stockQuantity;
        }
      }
    }

    const totalEquity = cash + stocksMarketValue;
    const openCount = activePositions.length;

    equityCurve.push({
      date: today,
      cash,
      positionsValue: stocksMarketValue,
      totalEquity,
      openPositionCount: openCount,
    });
  }

  // 未完了ポジションの強制クローズ（バックテスト終了時）
  const lastDay = tradingDays[tradingDays.length - 1];
  for (const pos of activePositions) {
    if (pos.state === "CSP_OPEN") {
      // CSP: 担保解放、プレミアムは確保済み
      pos.collateralLocked = 0;
      pos.cycleEndDate = lastDay;
      pos.cyclePnl = pos.totalPremiumCollected - pos.totalCommissions;
    } else if (pos.state === "STOCK_HELD" || pos.state === "CC_OPEN") {
      // 株保有中: 時価で売却
      const spotPrice = getSpotPrice(pos.ticker, lastDay, allData, simData);
      if (spotPrice != null && pos.stockCostBasis != null) {
        const stockPnl = (spotPrice - pos.stockCostBasis) * pos.stockQuantity;
        cash += spotPrice * pos.stockQuantity;
        pos.cyclePnl = pos.totalPremiumCollected - pos.totalCommissions + stockPnl;
      } else {
        pos.cyclePnl = pos.totalPremiumCollected - pos.totalCommissions;
      }
      pos.cycleEndDate = lastDay;
    }
    completedCycles.push(pos);
  }

  const allCycles = [...completedCycles];
  const metrics = calculateWheelMetrics(allCycles, equityCurve, config.initialBudget, config);

  return { config, cycles: allCycles, equityCurve, metrics };
}

/**
 * 指定日の株価を取得
 */
function getSpotPrice(
  ticker: string,
  date: string,
  allData: Map<string, OHLCVData[]>,
  simData: USPrecomputedSimData,
): number | null {
  const bars = allData.get(ticker);
  if (!bars) return null;
  const idxMap = simData.dateIndexMap.get(ticker);
  if (!idxMap) return null;
  const barIdx = idxMap.get(date);
  if (barIdx == null) return null;
  return bars[barIdx]?.close ?? null;
}

function emptyWheelMetrics(): WheelPerformanceMetrics {
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    stillOpen: 0,
    winRate: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    profitFactor: 0,
    maxDrawdown: 0,
    maxDrawdownPeriod: null,
    sharpeRatio: null,
    avgHoldingDays: 0,
    totalPnl: 0,
    totalReturnPct: 0,
    byRegime: {},
    totalCommission: 0,
    totalTax: 0,
    totalGrossPnl: 0,
    totalNetPnl: 0,
    netReturnPct: 0,
    costImpactPct: 0,
    expectancy: 0,
    riskRewardRatio: 0,
    totalPremiumCollected: 0,
    assignmentRate: 0,
    calledAwayRate: 0,
    avgPremiumYieldAnnualized: 0,
    completedCycles: 0,
    avgCycleDays: 0,
    cspCount: 0,
    ccCount: 0,
    earlyCloseRate: 0,
  };
}
