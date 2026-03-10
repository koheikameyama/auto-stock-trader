/**
 * バックテスト・パフォーマンス指標算出
 */

import type {
  SimulatedPosition,
  DailyEquity,
  PerformanceMetrics,
  RankMetrics,
} from "./types";

export function calculateMetrics(
  trades: SimulatedPosition[],
  equityCurve: DailyEquity[],
  initialBudget: number,
): PerformanceMetrics {
  const closedTrades = trades.filter(
    (t) =>
      t.exitReason === "take_profit" ||
      t.exitReason === "stop_loss" ||
      t.exitReason === "trailing_profit",
  );
  const stillOpen = trades.filter((t) => t.exitReason === "still_open").length;

  const wins = closedTrades.filter((t) => t.pnl != null && t.pnl > 0);
  const losses = closedTrades.filter((t) => t.pnl != null && t.pnl <= 0);

  const winRate =
    closedTrades.length > 0
      ? (wins.length / closedTrades.length) * 100
      : 0;

  const avgWinPct =
    wins.length > 0
      ? wins.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / wins.length
      : 0;

  const avgLossPct =
    losses.length > 0
      ? losses.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / losses.length
      : 0;

  const grossProfit = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const totalReturnPct =
    initialBudget > 0 ? (totalPnl / initialBudget) * 100 : 0;

  // コスト関連集計
  const totalCommission = closedTrades.reduce(
    (s, t) => s + (t.totalCost ?? 0),
    0,
  );
  const totalTax = closedTrades.reduce((s, t) => s + (t.tax ?? 0), 0);
  const totalGrossPnl = closedTrades.reduce(
    (s, t) => s + (t.grossPnl ?? t.pnl ?? 0),
    0,
  );
  const totalNetPnl = closedTrades.reduce(
    (s, t) => s + (t.netPnl ?? t.pnl ?? 0),
    0,
  );
  const netReturnPct =
    initialBudget > 0 ? (totalNetPnl / initialBudget) * 100 : 0;
  const costImpactPct =
    initialBudget > 0
      ? ((totalGrossPnl - totalNetPnl) / initialBudget) * 100
      : 0;

  const avgHoldingDays =
    closedTrades.length > 0
      ? closedTrades.reduce((s, t) => s + (t.holdingDays ?? 0), 0) /
        closedTrades.length
      : 0;

  const { maxDrawdown, period: maxDrawdownPeriod } =
    calculateMaxDrawdown(equityCurve);
  const sharpeRatio = calculateSharpeRatio(equityCurve);
  const byRank = calculateByRank(closedTrades);
  const byRegime = calculateByRegime(closedTrades);

  return {
    totalTrades: closedTrades.length,
    wins: wins.length,
    losses: losses.length,
    stillOpen,
    winRate: round2(winRate),
    avgWinPct: round2(avgWinPct),
    avgLossPct: round2(avgLossPct),
    profitFactor: round2(profitFactor),
    maxDrawdown: round2(maxDrawdown),
    maxDrawdownPeriod,
    sharpeRatio: sharpeRatio != null ? round2(sharpeRatio) : null,
    avgHoldingDays: round2(avgHoldingDays),
    totalPnl: Math.round(totalPnl),
    totalReturnPct: round2(totalReturnPct),
    byRank,
    byRegime,
    totalCommission: Math.round(totalCommission),
    totalTax: Math.round(totalTax),
    totalGrossPnl: Math.round(totalGrossPnl),
    totalNetPnl: Math.round(totalNetPnl),
    netReturnPct: round2(netReturnPct),
    costImpactPct: round2(costImpactPct),
  };
}

function calculateMaxDrawdown(
  equityCurve: DailyEquity[],
): { maxDrawdown: number; period: { start: string; end: string } | null } {
  if (equityCurve.length === 0) {
    return { maxDrawdown: 0, period: null };
  }

  let peak = equityCurve[0].totalEquity;
  let peakDate = equityCurve[0].date;
  let maxDrawdown = 0;
  let ddStart = peakDate;
  let ddEnd = peakDate;

  for (const day of equityCurve) {
    if (day.totalEquity > peak) {
      peak = day.totalEquity;
      peakDate = day.date;
    }
    const dd = peak > 0 ? ((peak - day.totalEquity) / peak) * 100 : 0;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      ddStart = peakDate;
      ddEnd = day.date;
    }
  }

  return {
    maxDrawdown,
    period: maxDrawdown > 0 ? { start: ddStart, end: ddEnd } : null,
  };
}

function calculateSharpeRatio(equityCurve: DailyEquity[]): number | null {
  if (equityCurve.length < 30) return null;

  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].totalEquity;
    if (prev > 0) {
      dailyReturns.push(
        (equityCurve[i].totalEquity - prev) / prev,
      );
    }
  }

  if (dailyReturns.length < 10) return null;

  const mean =
    dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) /
    dailyReturns.length;
  const std = Math.sqrt(variance);

  if (std === 0) return null;

  return (mean / std) * Math.sqrt(252);
}

function calculateByRank(
  trades: SimulatedPosition[],
): Record<string, RankMetrics> {
  const ranks: Record<string, RankMetrics> = {};

  for (const trade of trades) {
    const rank = trade.rank;
    if (!ranks[rank]) {
      ranks[rank] = {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgPnlPct: 0,
      };
    }
    ranks[rank].totalTrades++;
    if (trade.pnl != null && trade.pnl > 0) {
      ranks[rank].wins++;
    } else {
      ranks[rank].losses++;
    }
  }

  for (const rank of Object.keys(ranks)) {
    const r = ranks[rank];
    r.winRate = r.totalTrades > 0 ? round2((r.wins / r.totalTrades) * 100) : 0;
    const rankTrades = trades.filter((t) => t.rank === rank);
    r.avgPnlPct =
      rankTrades.length > 0
        ? round2(
            rankTrades.reduce((s, t) => s + (t.pnlPct ?? 0), 0) /
              rankTrades.length,
          )
        : 0;
  }

  return ranks;
}

function calculateByRegime(
  trades: SimulatedPosition[],
): Record<string, RankMetrics> {
  const regimes: Record<string, RankMetrics> = {};

  for (const trade of trades) {
    const regime = trade.regime ?? "normal";
    if (!regimes[regime]) {
      regimes[regime] = {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgPnlPct: 0,
      };
    }
    regimes[regime].totalTrades++;
    if (trade.pnl != null && trade.pnl > 0) {
      regimes[regime].wins++;
    } else {
      regimes[regime].losses++;
    }
  }

  for (const regime of Object.keys(regimes)) {
    const r = regimes[regime];
    r.winRate = r.totalTrades > 0 ? round2((r.wins / r.totalTrades) * 100) : 0;
    const regimeTrades = trades.filter((t) => (t.regime ?? "normal") === regime);
    r.avgPnlPct =
      regimeTrades.length > 0
        ? round2(
            regimeTrades.reduce((s, t) => s + (t.pnlPct ?? 0), 0) /
              regimeTrades.length,
          )
        : 0;
  }

  return regimes;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
