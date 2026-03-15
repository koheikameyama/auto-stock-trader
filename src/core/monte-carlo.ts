/**
 * モンテカルロシミュレーション — 破産確率の推定
 *
 * トレード単位ブートストラップ法で N 本のパスを生成し、
 * 破産確率・最終資産分布・最大ドローダウン分布を算出する。
 */

export interface MonteCarloConfig {
  tradeReturns: number[];
  initialBudget: number;
  numPaths: number;
  tradesPerPath: number;
  ruinThresholdPct: number;
  riskPerTradePct: number;
  avgStopLossPct: number;
}

interface Percentiles {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

interface DrawdownPercentiles {
  p5: number;
  p50: number;
  p95: number;
}

interface ThresholdBreachRates {
  dd10: number;
  dd20: number;
  dd30: number;
  dd50: number;
}

interface InputStats {
  totalTrades: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancy: number;
}

export interface MonteCarloResult {
  ruinProbability: number;
  totalPaths: number;
  ruinedPaths: number;
  finalEquityPercentiles: Percentiles;
  maxDrawdownPercentiles: DrawdownPercentiles;
  thresholdBreachRates: ThresholdBreachRates;
  equityCurves: {
    p5: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p95: number[];
  };
  inputStats: InputStats;
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeInputStats(tradeReturns: number[]): InputStats {
  const wins = tradeReturns.filter((r) => r > 0);
  const losses = tradeReturns.filter((r) => r <= 0);
  const winRate =
    tradeReturns.length > 0
      ? (wins.length / tradeReturns.length) * 100
      : 0;
  const avgWinPct =
    wins.length > 0 ? wins.reduce((s, v) => s + v, 0) / wins.length : 0;
  const avgLossPct =
    losses.length > 0
      ? losses.reduce((s, v) => s + v, 0) / losses.length
      : 0;
  const expectancy =
    tradeReturns.length > 0
      ? tradeReturns.reduce((s, v) => s + v, 0) / tradeReturns.length
      : 0;

  return {
    totalTrades: tradeReturns.length,
    winRate: Math.round(winRate * 100) / 100,
    avgWinPct: Math.round(avgWinPct * 100) / 100,
    avgLossPct: Math.round(avgLossPct * 100) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
  };
}

export function runMonteCarloSimulation(
  config: MonteCarloConfig,
): MonteCarloResult {
  const {
    tradeReturns,
    initialBudget,
    numPaths,
    tradesPerPath,
    ruinThresholdPct,
    riskPerTradePct,
    avgStopLossPct,
  } = config;

  if (tradeReturns.length === 0) {
    throw new Error("tradeReturns must not be empty");
  }
  if (avgStopLossPct === 0) {
    throw new Error("avgStopLossPct must not be zero");
  }

  const ruinLevel = initialBudget * (1 - ruinThresholdPct / 100);
  const riskFraction = riskPerTradePct / 100;

  const steps = tradesPerPath + 1;
  const equityAtStep: number[][] = Array.from({ length: steps }, () =>
    new Array(numPaths),
  );

  const finalEquities: number[] = new Array(numPaths);
  const maxDrawdowns: number[] = new Array(numPaths);
  let ruinedPaths = 0;

  let dd10Count = 0;
  let dd20Count = 0;
  let dd30Count = 0;
  let dd50Count = 0;

  const len = tradeReturns.length;

  for (let p = 0; p < numPaths; p++) {
    let equity = initialBudget;
    let peak = initialBudget;
    let maxDd = 0;
    let ruined = false;

    let hit10 = false;
    let hit20 = false;
    let hit30 = false;
    let hit50 = false;

    equityAtStep[0][p] = equity;

    for (let t = 1; t <= tradesPerPath; t++) {
      if (!ruined) {
        const sampledReturn =
          tradeReturns[Math.floor(Math.random() * len)];
        const riskAmount = equity * riskFraction;
        const pnl = riskAmount * (sampledReturn / avgStopLossPct);
        equity += pnl;

        if (equity > peak) peak = equity;
        const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
        if (dd > maxDd) maxDd = dd;

        if (!hit10 && dd >= 10) hit10 = true;
        if (!hit20 && dd >= 20) hit20 = true;
        if (!hit30 && dd >= 30) hit30 = true;
        if (!hit50 && dd >= 50) hit50 = true;

        if (equity <= ruinLevel) {
          ruined = true;
          equity = 0;
        }
      }

      equityAtStep[t][p] = equity;
    }

    finalEquities[p] = equity;
    maxDrawdowns[p] = maxDd;

    if (ruined) ruinedPaths++;
    if (hit10) dd10Count++;
    if (hit20) dd20Count++;
    if (hit30) dd30Count++;
    if (hit50) dd50Count++;
  }

  const sortedFinal = [...finalEquities].sort((a, b) => a - b);
  const sortedDd = [...maxDrawdowns].sort((a, b) => a - b);

  const maxPoints = 200;
  let sampleIndices: number[];
  if (steps <= maxPoints + 1) {
    sampleIndices = Array.from({ length: steps }, (_, i) => i);
  } else {
    sampleIndices = [0];
    for (let i = 1; i < maxPoints; i++) {
      sampleIndices.push(Math.round((i / maxPoints) * (steps - 1)));
    }
    sampleIndices.push(steps - 1);
    sampleIndices = [...new Set(sampleIndices)];
  }

  const curves = {
    p5: new Array(sampleIndices.length),
    p25: new Array(sampleIndices.length),
    p50: new Array(sampleIndices.length),
    p75: new Array(sampleIndices.length),
    p95: new Array(sampleIndices.length),
  };

  for (let si = 0; si < sampleIndices.length; si++) {
    const stepIdx = sampleIndices[si];
    const sorted = [...equityAtStep[stepIdx]].sort((a, b) => a - b);
    curves.p5[si] = Math.round(percentile(sorted, 5));
    curves.p25[si] = Math.round(percentile(sorted, 25));
    curves.p50[si] = Math.round(percentile(sorted, 50));
    curves.p75[si] = Math.round(percentile(sorted, 75));
    curves.p95[si] = Math.round(percentile(sorted, 95));
  }

  return {
    ruinProbability: ruinedPaths / numPaths,
    totalPaths: numPaths,
    ruinedPaths,
    finalEquityPercentiles: {
      p5: Math.round(percentile(sortedFinal, 5)),
      p25: Math.round(percentile(sortedFinal, 25)),
      p50: Math.round(percentile(sortedFinal, 50)),
      p75: Math.round(percentile(sortedFinal, 75)),
      p95: Math.round(percentile(sortedFinal, 95)),
    },
    maxDrawdownPercentiles: {
      p5: Math.round(percentile(sortedDd, 5) * 100) / 100,
      p50: Math.round(percentile(sortedDd, 50) * 100) / 100,
      p95: Math.round(percentile(sortedDd, 95) * 100) / 100,
    },
    thresholdBreachRates: {
      dd10: dd10Count / numPaths,
      dd20: dd20Count / numPaths,
      dd30: dd30Count / numPaths,
      dd50: dd50Count / numPaths,
    },
    equityCurves: curves,
    inputStats: computeInputStats(tradeReturns),
  };
}
