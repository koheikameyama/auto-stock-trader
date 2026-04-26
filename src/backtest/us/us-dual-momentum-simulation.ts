/**
 * Dual Momentum (Antonacci GEM) バックテスト
 *
 * 各リバランス日に:
 *   1. equityUniverse の各 ETF の lookbackDays リターンを計算
 *   2. 絶対モメンタム陽性の最高リターン銘柄を選択
 *   3. すべて陰性なら riskOffAsset へ退避
 *   4. 前回保有と異なれば全売却→新規購入
 */

import { calculateMetrics } from "../metrics";
import type {
  USDualMomentumBacktestConfig,
  USDualMomentumBacktestResult,
  SimulatedRotationPosition,
  DualMomentumRebalance,
  DualMomentumPerformanceMetrics,
} from "./us-dual-momentum-types";
import type { OHLCVData } from "../../core/technical-analysis";
import type { SimulatedPosition, DailyEquity } from "../types";

function pctReturn(prices: number[], lookback: number): number | null {
  if (prices.length < lookback + 1) return null;
  const recent = prices[prices.length - 1];
  const past = prices[prices.length - 1 - lookback];
  if (past <= 0) return null;
  return ((recent - past) / past) * 100;
}

export function runUSDualMomentumBacktest(
  config: USDualMomentumBacktestConfig,
  etfData: Map<string, OHLCVData[]>,
): USDualMomentumBacktestResult {
  const allTickers = [...config.equityUniverse, config.riskOffAsset];

  // 全ETFの共通取引日リスト
  const dateSets = allTickers.map((t) => new Set((etfData.get(t) ?? []).map((b) => b.date)));
  const commonDates = [...(dateSets[0] ?? new Set<string>())]
    .filter((d) => dateSets.every((s) => s.has(d)))
    .sort();
  const tradingDays = commonDates.filter((d) => d >= config.startDate && d <= config.endDate);

  // ticker -> date -> close map（高速参照用）
  const closeByDate = new Map<string, Map<string, number>>();
  for (const t of allTickers) {
    const m = new Map<string, number>();
    for (const b of etfData.get(t) ?? []) m.set(b.date, b.close);
    closeByDate.set(t, m);
  }

  // ticker -> sorted price array up to each date（lookback計算用）
  function getPrices(ticker: string, upToDate: string): number[] {
    const bars = etfData.get(ticker) ?? [];
    return bars.filter((b) => b.date <= upToDate).map((b) => b.close);
  }

  let cash = config.initialBudget;
  let currentTicker: string | null = null;
  let currentShares = 0;

  const positions: SimulatedRotationPosition[] = [];
  const rebalances: DualMomentumRebalance[] = [];
  const equityCurve: DailyEquity[] = [];
  const assetDays = new Map<string, number>();
  let riskOffDays = 0;

  let daysSinceLastRebalance = config.rebalanceDays; // 初回エントリーをすぐ実行

  for (const today of tradingDays) {
    const isRebalance = daysSinceLastRebalance >= config.rebalanceDays;

    if (isRebalance) {
      // 各 equity ETF のモメンタム計算
      const rankings: Array<{ ticker: string; momentum: number }> = [];
      for (const ticker of config.equityUniverse) {
        const prices = getPrices(ticker, today);
        const ret = pctReturn(prices, config.lookbackDays);
        if (ret != null) rankings.push({ ticker, momentum: ret });
      }
      rankings.sort((a, b) => b.momentum - a.momentum);

      let selected: string;
      let reason: "best_equity" | "risk_off";

      if (rankings.length > 0 && rankings[0].momentum > config.absoluteMomentumThreshold) {
        selected = rankings[0].ticker;
        reason = "best_equity";
      } else {
        selected = config.riskOffAsset;
        reason = "risk_off";
      }

      const switched = currentTicker !== selected;

      if (switched) {
        // 既存ポジ売却
        if (currentTicker && currentShares > 0) {
          const closeM = closeByDate.get(currentTicker)!;
          const exitPrice = closeM.get(today)!;
          const proceeds = currentShares * exitPrice;
          const slippage = proceeds * (config.slippagePct / 100);
          cash += proceeds - config.commissionPerTrade - slippage;

          const lastPos = positions[positions.length - 1];
          if (lastPos && lastPos.exitDate === undefined) {
            lastPos.exitDate = today;
            lastPos.exitPrice = exitPrice;
            lastPos.exitReason = "rotation_exit";
            lastPos.netPnl = (exitPrice - lastPos.entryPrice) * lastPos.shares - 2 * config.commissionPerTrade;
            lastPos.pnlPct = ((exitPrice - lastPos.entryPrice) / lastPos.entryPrice) * 100;
            lastPos.holdingDays = Math.round(
              (new Date(today).getTime() - new Date(lastPos.entryDate).getTime()) / 86400000
            );
          }
        }

        // 新規ポジ購入
        const newPriceM = closeByDate.get(selected)!;
        const newPrice = newPriceM.get(today)!;
        const slippage = cash * (config.slippagePct / 100);
        const usableCash = cash - config.commissionPerTrade - slippage;
        const shares = Math.floor(usableCash / newPrice);
        if (shares > 0) {
          cash -= shares * newPrice + config.commissionPerTrade + slippage;
          currentTicker = selected;
          currentShares = shares;

          positions.push({
            ticker: selected,
            entryDate: today,
            entryPrice: newPrice,
            shares,
          });
        }
      }

      rebalances.push({
        date: today,
        selectedAsset: selected,
        selectedReason: reason,
        rankings,
        prevAsset: currentTicker,
        switched,
      });

      daysSinceLastRebalance = 0;
    }

    // 在場資産カウント
    if (currentTicker) {
      assetDays.set(currentTicker, (assetDays.get(currentTicker) ?? 0) + 1);
      if (currentTicker === config.riskOffAsset) riskOffDays++;
    }

    // equity curve
    let positionValue = 0;
    if (currentTicker && currentShares > 0) {
      const px = closeByDate.get(currentTicker)?.get(today);
      if (px != null) positionValue = currentShares * px;
    }
    equityCurve.push({
      date: today,
      cash,
      positionsValue: positionValue,
      totalEquity: cash + positionValue,
      openPositionCount: currentTicker ? 1 : 0,
    });

    daysSinceLastRebalance++;
  }

  // 期末: 残ポジを still_open として記録
  if (positions.length && positions[positions.length - 1].exitDate === undefined) {
    positions[positions.length - 1].exitReason = "still_open";
  }

  // ── メトリクス計算 ──
  const closedPositions = positions.filter((p) => p.exitReason === "rotation_exit");

  const tradeShape: SimulatedPosition[] = closedPositions.map((p) => ({
    ticker: p.ticker,
    entryDate: p.entryDate,
    entryPrice: p.entryPrice,
    takeProfitPrice: 0,
    stopLossPrice: 0,
    quantity: p.shares,
    volumeSurgeRatio: 0,
    regime: null,
    maxHighDuringHold: p.entryPrice,
    minLowDuringHold: p.entryPrice,
    trailingStopPrice: null,
    entryAtr: null,
    exitDate: p.exitDate ?? null,
    exitPrice: p.exitPrice ?? null,
    exitReason: "rotation_exit",
    pnl: p.netPnl ?? 0,
    pnlPct: p.pnlPct ?? 0,
    holdingDays: p.holdingDays ?? 0,
    limitLockDays: 0,
    entryCommission: config.commissionPerTrade,
    exitCommission: config.commissionPerTrade,
    totalCost: 2 * config.commissionPerTrade,
    tax: 0,
    grossPnl: p.netPnl ?? 0,
    netPnl: p.netPnl ?? 0,
  }));

  const baseMetrics = calculateMetrics(tradeShape, equityCurve, config.initialBudget);

  const totalDays = tradingDays.length;
  const assetParticipation: Record<string, number> = {};
  for (const [t, d] of assetDays) {
    assetParticipation[t] = totalDays > 0 ? d / totalDays : 0;
  }

  const switchCount = rebalances.filter((r) => r.switched).length;

  const metrics: DualMomentumPerformanceMetrics = {
    ...baseMetrics,
    assetParticipation,
    rebalanceCount: rebalances.length,
    switchCount,
    riskOffDays,
  };

  return { config, positions, rebalances, equityCurve, metrics };
}
