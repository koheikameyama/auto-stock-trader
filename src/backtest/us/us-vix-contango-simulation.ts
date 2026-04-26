/**
 * VIX Contango バックテスト
 *
 * SVXY/SVIX 保有 + VIXレジームフィルター。
 * VIX低 → 保有（コンタンゴ収益）、VIX高 → flat（リスクオフ）。
 */

import { calculateMetrics } from "../metrics";
import type {
  USVixContangoBacktestConfig,
  USVixContangoBacktestResult,
  SimulatedVixPosition,
  VixContangoPerformanceMetrics,
} from "./us-vix-contango-types";
import type { OHLCVData } from "../../core/technical-analysis";
import type { SimulatedPosition, DailyEquity } from "../types";

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

export function runUSVixContangoBacktest(
  config: USVixContangoBacktestConfig,
  etfData: OHLCVData[], // SVXY or SVIX OHLCV
  vixData: Map<string, number>,
): USVixContangoBacktestResult {
  // 取引日リスト（ETF と VIX 両方ある日のみ）
  const tradingDays = etfData
    .filter((b) => b.date >= config.startDate && b.date <= config.endDate)
    .map((b) => b.date);
  const etfByDate = new Map<string, OHLCVData>();
  for (const b of etfData) etfByDate.set(b.date, b);

  // ── シミュレーション ──
  let cash = config.initialBudget;
  const positions: SimulatedVixPosition[] = [];
  const equityCurve: DailyEquity[] = [];
  let openPos: SimulatedVixPosition | null = null;
  let lastExitDate: string | null = null;
  let prevVix: number | null = null;

  for (const today of tradingDays) {
    const bar = etfByDate.get(today);
    const vix = vixData.get(today);
    if (!bar || vix == null) {
      if (equityCurve.length > 0) {
        equityCurve.push({ ...equityCurve[equityCurve.length - 1], date: today });
      }
      continue;
    }

    // ── 1. exit 判定 ──
    if (openPos) {
      let exitReason: SimulatedVixPosition["exitReason"] | null = null;
      const vixSpikePct = prevVix != null ? ((vix - prevVix) / prevVix) * 100 : 0;
      const currentPnlPct = ((bar.close - openPos.entryPrice) / openPos.entryPrice) * 100;

      if (vix > config.vixExitUpperBound) exitReason = "vix_cap";
      else if (vixSpikePct > config.vixSpikeThreshold) exitReason = "vix_spike";
      else if (config.stopLossPct > 0 && currentPnlPct <= -config.stopLossPct) exitReason = "stop_loss";

      if (exitReason) {
        const proceeds = openPos.shares * bar.close;
        const slippage = proceeds * (config.slippagePct / 100);
        const exitCost = config.commissionPerTrade + slippage;
        const grossPnl = (bar.close - openPos.entryPrice) * openPos.shares;
        const totalCommissions = (openPos.commissions ?? 0) + exitCost;

        cash += proceeds - exitCost;
        openPos.exitDate = today;
        openPos.exitPrice = bar.close;
        openPos.exitVix = vix;
        openPos.exitReason = exitReason;
        openPos.grossPnl = grossPnl;
        openPos.commissions = totalCommissions;
        openPos.netPnl = grossPnl - totalCommissions + (openPos.commissions ?? 0) - (openPos.commissions ?? 0); // entry+exit cost in commissions
        openPos.netPnl = grossPnl - totalCommissions;
        openPos.holdingDays = daysBetween(openPos.entryDate, today);

        positions.push(openPos);
        lastExitDate = today;
        openPos = null;
      }
    }

    // ── 2. entry 判定 ──
    if (!openPos) {
      const cooldownPassed = lastExitDate == null || daysBetween(lastExitDate, today) >= config.reentryCooldownDays;
      const vixOk = vix <= config.vixEntryUpperBound;
      // VIX急上昇直後はエントリーしない
      const vixSpikePct = prevVix != null ? ((vix - prevVix) / prevVix) * 100 : 0;
      const stableVix = vixSpikePct < config.vixSpikeThreshold;

      if (cooldownPassed && vixOk && stableVix) {
        const investAmount = cash * config.positionSizing;
        const slippage = investAmount * (config.slippagePct / 100);
        const entryCost = config.commissionPerTrade + slippage;
        const usableCash = investAmount - entryCost;
        const shares = Math.floor(usableCash / bar.close);

        if (shares > 0) {
          const actualCost = shares * bar.close + entryCost;
          cash -= actualCost;
          openPos = {
            ticker: config.underlyingTicker,
            entryDate: today,
            entryPrice: bar.close,
            entryVix: vix,
            shares,
            commissions: entryCost,
          };
        }
      }
    }

    // ── 3. equity curve ──
    const positionValue = openPos ? openPos.shares * bar.close : 0;
    equityCurve.push({
      date: today,
      cash,
      positionsValue: positionValue,
      totalEquity: cash + positionValue,
      openPositionCount: openPos ? 1 : 0,
    });

    prevVix = vix;
  }

  // 期末: open ポジションを still_open として記録
  if (openPos) {
    openPos.exitReason = "still_open";
    positions.push(openPos);
  }

  // ── メトリクス計算 ──
  const closedPositions = positions.filter((p) => p.exitReason !== "still_open");

  const mapExitReason = (r: SimulatedVixPosition["exitReason"]): SimulatedPosition["exitReason"] => {
    if (r === "vix_cap") return "defensive_exit";
    if (r === "vix_spike") return "defensive_exit";
    if (r === "stop_loss") return "stop_loss";
    return "still_open";
  };

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
    exitReason: mapExitReason(p.exitReason),
    pnl: p.netPnl ?? 0,
    pnlPct: p.exitPrice && p.entryPrice ? ((p.exitPrice - p.entryPrice) / p.entryPrice) * 100 : 0,
    holdingDays: p.holdingDays ?? 0,
    limitLockDays: 0,
    entryCommission: config.commissionPerTrade,
    exitCommission: config.commissionPerTrade,
    totalCost: p.commissions ?? 0,
    tax: 0,
    grossPnl: p.grossPnl ?? 0,
    netPnl: p.netPnl ?? 0,
  }));

  const baseMetrics = calculateMetrics(tradeShape, equityCurve, config.initialBudget);

  const totalDays = tradingDays.length;
  const inMarketDays = positions.reduce((s, p) => s + (p.holdingDays ?? 0), 0);
  const avgHolding = closedPositions.length > 0
    ? closedPositions.reduce((s, p) => s + (p.holdingDays ?? 0), 0) / closedPositions.length
    : 0;
  const avgEntryVix = closedPositions.length > 0
    ? closedPositions.reduce((s, p) => s + p.entryVix, 0) / closedPositions.length
    : 0;

  const metrics: VixContangoPerformanceMetrics = {
    ...baseMetrics,
    avgEntryVix,
    avgHoldingDays: avgHolding,
    vixCapExits: closedPositions.filter((p) => p.exitReason === "vix_cap").length,
    vixSpikeExits: closedPositions.filter((p) => p.exitReason === "vix_spike").length,
    stopLossExits: closedPositions.filter((p) => p.exitReason === "stop_loss").length,
    marketParticipationRate: totalDays > 0 ? inMarketDays / totalDays : 0,
  };

  return { config, positions, equityCurve, metrics };
}
