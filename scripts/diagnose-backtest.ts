/**
 * バックテスト診断スクリプト
 * スコア分布・トレード結果・出口理由を分析して問題の原因を特定する
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import { DAILY_BACKTEST, SCREENING, hasParamOverride, hasMultiOverride } from "../src/lib/constants";
import { fetchMultipleBacktestData, fetchVixData } from "../src/backtest/data-fetcher";
import { runBacktest } from "../src/backtest/simulation-engine";
import {
  buildCandidateMapOnTheFly,
  scoreDayForAllStocks,
  extractTradingDays,
  type StockFundamentals,
} from "../src/backtest/on-the-fly-scorer";
import type { BacktestConfig } from "../src/backtest/types";
import { getSectorGroup } from "../src/lib/constants";

async function main() {
  console.log("=== バックテスト診断 ===\n");

  const endDate = dayjs().format("YYYY-MM-DD");
  const startDate = dayjs().subtract(12, "month").format("YYYY-MM-DD");

  // 1. 銘柄取得
  const stocks = await prisma.stock.findMany({
    where: {
      isDelisted: false,
      isActive: true,
      isRestricted: false,
      latestPrice: { not: null, gte: SCREENING.MIN_PRICE },
      latestVolume: { not: null, gte: SCREENING.MIN_DAILY_VOLUME },
    },
    orderBy: { latestVolume: "desc" },
    take: 500,
    select: {
      tickerCode: true,
      jpxSectorName: true,
      latestPrice: true,
      latestVolume: true,
      volatility: true,
      per: true,
      pbr: true,
      eps: true,
      marketCap: true,
      nextEarningsDate: true,
      exDividendDate: true,
    },
  });

  console.log(`対象銘柄: ${stocks.length}件 (出来高上位500)`);

  // 2. データ取得
  const stockTickers = stocks.map((s) => s.tickerCode);
  const [allData, vixData] = await Promise.all([
    fetchMultipleBacktestData(stockTickers, startDate, endDate, 200),
    fetchVixData(startDate, endDate).catch(() => new Map<string, number>()),
  ]);

  console.log(`データ: ${allData.size}銘柄, VIX${vixData.size}件\n`);

  // 3. スコア分布分析（直近の1日分だけ）
  const fundamentalsMap = new Map<string, StockFundamentals>();
  for (const s of stocks) {
    fundamentalsMap.set(s.tickerCode, {
      per: s.per ? Number(s.per) : null,
      pbr: s.pbr ? Number(s.pbr) : null,
      eps: s.eps ? Number(s.eps) : null,
      marketCap: s.marketCap ? Number(s.marketCap) : null,
      latestPrice: s.latestPrice ? Number(s.latestPrice) : 0,
      volatility: s.volatility ? Number(s.volatility) : null,
      nextEarningsDate: s.nextEarningsDate,
      exDividendDate: s.exDividendDate,
      latestVolume: s.latestVolume ? Number(s.latestVolume) : 0,
      jpxSectorName: s.jpxSectorName,
    });
  }

  // 直近10営業日のスコア分布を分析
  const tradingDays = extractTradingDays(allData, startDate, endDate);
  const recentDays = tradingDays.slice(-10);

  console.log("=== スコア分布（直近10営業日） ===");
  const allScores: number[] = [];
  const rankCounts: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  const disqualified = { count: 0, reasons: {} as Record<string, number> };
  const categoryTotals = { trend: 0, entry: 0, risk: 0, count: 0 };

  for (const day of recentDays) {
    const records = scoreDayForAllStocks(day, allData, fundamentalsMap, stocks);
    for (const r of records) {
      if (r.isDisqualified) {
        disqualified.count++;
        const reason = r.disqualifyReason ?? "unknown";
        disqualified.reasons[reason] = (disqualified.reasons[reason] ?? 0) + 1;
      } else {
        allScores.push(r.totalScore);
        rankCounts[r.rank] = (rankCounts[r.rank] ?? 0) + 1;
        categoryTotals.trend += r.trendQualityScore;
        categoryTotals.entry += r.entryTimingScore;
        categoryTotals.risk += r.riskQualityScore;
        categoryTotals.count++;
      }
    }
  }

  allScores.sort((a, b) => a - b);
  const p25 = allScores[Math.floor(allScores.length * 0.25)];
  const p50 = allScores[Math.floor(allScores.length * 0.5)];
  const p75 = allScores[Math.floor(allScores.length * 0.75)];
  const p90 = allScores[Math.floor(allScores.length * 0.9)];
  const avg = allScores.reduce((a, b) => a + b, 0) / allScores.length;

  console.log(`  パス済み: ${allScores.length}件, 失格: ${disqualified.count}件`);
  console.log(`  失格理由: ${JSON.stringify(disqualified.reasons)}`);
  console.log(`  スコア: avg=${avg.toFixed(1)} p25=${p25} p50=${p50} p75=${p75} p90=${p90}`);
  console.log(`  ランク: S=${rankCounts.S} A=${rankCounts.A} B=${rankCounts.B} C=${rankCounts.C} D=${rankCounts.D}`);
  console.log(`  カテゴリ平均: トレンド=${(categoryTotals.trend / categoryTotals.count).toFixed(1)}/40 エントリー=${(categoryTotals.entry / categoryTotals.count).toFixed(1)}/35 リスク=${(categoryTotals.risk / categoryTotals.count).toFixed(1)}/25`);

  // 4. ベースラインバックテストのトレード詳細分析
  console.log("\n=== ベースラインのトレード詳細 ===");

  // candidateMap構築
  const { TARGET_RANKS, FALLBACK_RANKS, MIN_TICKERS } = DAILY_BACKTEST.TICKER_SELECTION;
  const { candidateMap, allTickers } = buildCandidateMapOnTheFly(
    allData, fundamentalsMap, stocks, startDate, endDate,
    TARGET_RANKS, FALLBACK_RANKS, MIN_TICKERS,
  );

  const sectorMap = new Map<string, string>();
  for (const s of stocks) {
    sectorMap.set(s.tickerCode, getSectorGroup(s.jpxSectorName) ?? "その他");
  }

  const { DEFAULT_PARAMS, FIXED_BUDGET } = DAILY_BACKTEST;
  const config: BacktestConfig = {
    tickers: allTickers,
    startDate,
    endDate,
    initialBudget: FIXED_BUDGET.budget,
    maxPositions: FIXED_BUDGET.maxPositions,
    maxPrice: FIXED_BUDGET.maxPrice,
    scoreThreshold: DEFAULT_PARAMS.scoreThreshold,
    takeProfitRatio: DEFAULT_PARAMS.takeProfitRatio,
    stopLossRatio: DEFAULT_PARAMS.stopLossRatio,
    atrMultiplier: DEFAULT_PARAMS.atrMultiplier,
    trailingActivationMultiplier: DEFAULT_PARAMS.trailingActivationMultiplier,
    trailMultiplier: DEFAULT_PARAMS.trailMultiplier,
    strategy: DEFAULT_PARAMS.strategy,
    costModelEnabled: true,
    cooldownDays: DEFAULT_PARAMS.cooldownDays,
    overrideTpSl: DEFAULT_PARAMS.overrideTpSl,
    priceLimitEnabled: true,
    gapRiskEnabled: true,
    trendFilterEnabled: true,
    pullbackFilterEnabled: false,
    volatilityFilterEnabled: true,
    rsFilterEnabled: false,
    verbose: false,
  };

  const result = runBacktest(config, allData, vixData, candidateMap, sectorMap);
  const trades = result.trades.filter(t => t.exitReason !== "still_open");

  // 出口理由の分布
  const exitReasons: Record<string, { count: number; totalPnl: number; avgPnl: number }> = {};
  for (const t of trades) {
    const reason = t.exitReason ?? "unknown";
    if (!exitReasons[reason]) exitReasons[reason] = { count: 0, totalPnl: 0, avgPnl: 0 };
    exitReasons[reason].count++;
    exitReasons[reason].totalPnl += t.pnlPct ?? 0;
  }
  for (const [reason, data] of Object.entries(exitReasons)) {
    data.avgPnl = data.count > 0 ? data.totalPnl / data.count : 0;
  }

  console.log(`  トレード数: ${trades.length}`);
  console.log("  出口理由:");
  for (const [reason, data] of Object.entries(exitReasons).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`    ${reason}: ${data.count}件 平均P&L=${data.avgPnl.toFixed(2)}%`);
  }

  // 勝ち/負けの分析
  const wins = trades.filter(t => (t.pnlPct ?? 0) > 0);
  const losses = trades.filter(t => (t.pnlPct ?? 0) <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / losses.length : 0;

  console.log(`  勝ち: ${wins.length}件 平均+${avgWin.toFixed(2)}%`);
  console.log(`  負け: ${losses.length}件 平均${avgLoss.toFixed(2)}%`);
  console.log(`  RR比: ${avgLoss !== 0 ? (avgWin / Math.abs(avgLoss)).toFixed(2) : "N/A"}`);

  // 保有日数の分布
  const holdingDays = trades.map(t => t.holdingDays ?? 0);
  const avgHolding = holdingDays.reduce((s, d) => s + d, 0) / holdingDays.length;
  console.log(`  平均保有日数: ${avgHolding.toFixed(1)}日`);

  // ランク別の成績
  console.log("  ランク別:");
  const rankPerf: Record<string, { count: number; wins: number; totalPnl: number }> = {};
  for (const t of trades) {
    const r = t.rank;
    if (!rankPerf[r]) rankPerf[r] = { count: 0, wins: 0, totalPnl: 0 };
    rankPerf[r].count++;
    if ((t.pnlPct ?? 0) > 0) rankPerf[r].wins++;
    rankPerf[r].totalPnl += t.pnlPct ?? 0;
  }
  for (const [rank, perf] of Object.entries(rankPerf).sort((a, b) => a[0].localeCompare(b[0]))) {
    const wr = perf.count > 0 ? (perf.wins / perf.count * 100).toFixed(1) : "0";
    const avgP = perf.count > 0 ? (perf.totalPnl / perf.count).toFixed(2) : "0";
    console.log(`    ${rank}: ${perf.count}件 勝率${wr}% 平均${avgP}%`);
  }

  // スコア帯別の成績
  console.log("  スコア帯別:");
  const scoreBands = [
    { min: 80, max: 100, label: "80-100 (S)" },
    { min: 65, max: 79, label: "65-79 (A)" },
    { min: 50, max: 64, label: "50-64 (B)" },
  ];
  for (const band of scoreBands) {
    const bandTrades = trades.filter(t => t.score >= band.min && t.score <= band.max);
    if (bandTrades.length === 0) continue;
    const bandWins = bandTrades.filter(t => (t.pnlPct ?? 0) > 0).length;
    const bandAvgPnl = bandTrades.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / bandTrades.length;
    console.log(`    ${band.label}: ${bandTrades.length}件 勝率${(bandWins / bandTrades.length * 100).toFixed(1)}% 平均${bandAvgPnl.toFixed(2)}%`);
  }

  // 月別の成績
  console.log("  月別:");
  const monthlyPerf = new Map<string, { count: number; wins: number; totalPnl: number }>();
  for (const t of trades) {
    const month = t.entryDate.slice(0, 7);
    if (!monthlyPerf.has(month)) monthlyPerf.set(month, { count: 0, wins: 0, totalPnl: 0 });
    const mp = monthlyPerf.get(month)!;
    mp.count++;
    if ((t.pnlPct ?? 0) > 0) mp.wins++;
    mp.totalPnl += t.pnlPct ?? 0;
  }
  for (const [month, perf] of [...monthlyPerf].sort()) {
    const wr = perf.count > 0 ? (perf.wins / perf.count * 100).toFixed(0) : "0";
    console.log(`    ${month}: ${perf.count}件 勝率${wr}% 合計${perf.totalPnl.toFixed(1)}%`);
  }

  // レジーム別の成績
  console.log("  レジーム別:");
  const regimePerf: Record<string, { count: number; wins: number; totalPnl: number }> = {};
  for (const t of trades) {
    const r = t.regime ?? "normal";
    if (!regimePerf[r]) regimePerf[r] = { count: 0, wins: 0, totalPnl: 0 };
    regimePerf[r].count++;
    if ((t.pnlPct ?? 0) > 0) regimePerf[r].wins++;
    regimePerf[r].totalPnl += t.pnlPct ?? 0;
  }
  for (const [regime, perf] of Object.entries(regimePerf).sort((a, b) => a[0].localeCompare(b[0]))) {
    const wr = perf.count > 0 ? (perf.wins / perf.count * 100).toFixed(1) : "0";
    const avgP = perf.count > 0 ? (perf.totalPnl / perf.count).toFixed(2) : "0";
    console.log(`    ${regime}: ${perf.count}件 勝率${wr}% 平均${avgP}%`);
  }

  // VIX推移
  console.log("  VIXサマリー:");
  const vixValues = [...vixData.values()];
  if (vixValues.length > 0) {
    const vixMin = Math.min(...vixValues);
    const vixMax = Math.max(...vixValues);
    const vixAvg = vixValues.reduce((s, v) => s + v, 0) / vixValues.length;
    const highDays = vixValues.filter(v => v >= 25).length;
    const crisisDays = vixValues.filter(v => v >= 30).length;
    console.log(`    min=${vixMin.toFixed(1)} avg=${vixAvg.toFixed(1)} max=${vixMax.toFixed(1)}`);
    console.log(`    VIX>=25(high): ${highDays}日, VIX>=30(crisis): ${crisisDays}日`);
  }

  // 個別トレード一覧（先頭20件）
  console.log("\n  直近トレード（最新20件）:");
  const recentTrades = trades.slice(-20);
  for (const t of recentTrades) {
    const sign = (t.pnlPct ?? 0) >= 0 ? "+" : "";
    console.log(
      `    ${t.entryDate}→${t.exitDate} ${t.ticker} ${t.rank}:${t.score}pt ¥${t.entryPrice}→¥${t.exitPrice} ${sign}${t.pnlPct}% (${t.exitReason}, ${t.holdingDays}日, ${t.regime})`
    );
  }

  // === 全条件サマリー ===
  console.log("\n=== 全条件サマリー ===");
  const conditions = DAILY_BACKTEST.PARAMETER_CONDITIONS;
  for (const condition of conditions) {
    const condConfig: BacktestConfig = { ...config };
    if (hasParamOverride(condition)) {
      if (condition.param === "trailMultiplier") {
        condConfig.trailMultiplier = condition.value;
      } else {
        (condConfig as unknown as Record<string, unknown>)[condition.param] = condition.value;
      }
      if (condition.overrideTpSl) condConfig.overrideTpSl = true;
    } else if (hasMultiOverride(condition)) {
      for (const [key, val] of Object.entries(condition.overrides)) {
        (condConfig as unknown as Record<string, unknown>)[key] = val;
      }
    }
    const condResult = runBacktest(condConfig, allData, vixData, candidateMap, sectorMap);
    const m = condResult.metrics;
    const sign2 = m.totalReturnPct >= 0 ? "+" : "";
    console.log(
      `  ${condition.label.padEnd(12)} | ${m.totalTrades}件 勝率${String(m.winRate).padStart(5)}% PF${String(m.profitFactor).padStart(5)} ${sign2}${m.totalReturnPct}% maxDD-${m.maxDrawdown}%`
    );
  }

  // === 組み合わせテスト ===
  console.log("\n=== 組み合わせテスト ===");
  const comboTests: { label: string; overrides: Partial<BacktestConfig> }[] = [
    { label: "トレンドF+スコア70", overrides: { trendFilterEnabled: true, scoreThreshold: 70 } },
    { label: "トレンドF+PB", overrides: { trendFilterEnabled: true, pullbackFilterEnabled: true } },
    { label: "トレンドF+PB+スコア70", overrides: { trendFilterEnabled: true, pullbackFilterEnabled: true, scoreThreshold: 70 } },
    { label: "トレンドF+RS", overrides: { trendFilterEnabled: true, rsFilterEnabled: true } },
    { label: "トレンドF+保有15日", overrides: { trendFilterEnabled: true, maxHoldingDays: 15 } },
    { label: "トレンドF+保有20日", overrides: { trendFilterEnabled: true, maxHoldingDays: 20 } },
    { label: "スコア70+保有15日", overrides: { scoreThreshold: 70, maxHoldingDays: 15 } },
    { label: "トレンドF+スコア70+保有15", overrides: { trendFilterEnabled: true, scoreThreshold: 70, maxHoldingDays: 15 } },
    { label: "TS起動1.5", overrides: { trailingActivationMultiplier: 1.5 } },
    { label: "TS起動1.5+トレール1.5", overrides: { trailingActivationMultiplier: 1.5, trailMultiplier: 1.5 } },
    { label: "トレンドF+TS1.5+トレール1.5", overrides: { trendFilterEnabled: true, trailingActivationMultiplier: 1.5, trailMultiplier: 1.5 } },
  ];
  for (const combo of comboTests) {
    const comboConfig: BacktestConfig = { ...config, ...(combo.overrides as Partial<BacktestConfig>) };
    const comboResult = runBacktest(comboConfig, allData, vixData, candidateMap, sectorMap);
    const m = comboResult.metrics;
    const sign2 = m.totalReturnPct >= 0 ? "+" : "";
    console.log(
      `  ${combo.label.padEnd(20)} | ${m.totalTrades}件 勝率${String(m.winRate).padStart(5)}% PF${String(m.profitFactor).padStart(5)} ${sign2}${m.totalReturnPct}% maxDD-${m.maxDrawdown}%`
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
