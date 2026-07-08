/**
 * 統合バックテスト（GapUp + PSC 共有資金プール）
 *
 * Usage:
 *   npm run backtest:combined
 *   npm run backtest:combined -- --start 2025-04-01 --end 2026-03-25
 *   npm run backtest:combined -- --budget 1000000
 *   npm run backtest:combined -- --verbose
 *   npm run backtest:combined -- --compare-slippage
 *   npm run backtest:combined -- --compare-positions
 *   npm run backtest:combined -- --compare-split-positions
 *   npm run backtest:combined -- --compare-breadth
 *   npm run backtest:combined -- --compare-breadth-modes --start 2024-03-01
 *   npm run backtest:combined -- --compare-breadth-zoom --start 2024-03-01
 *   npm run backtest:combined -- --compare-strategy-mix --start 2024-03-01
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { GAPUP_BACKTEST_DEFAULTS } from "./gapup-config";
import { PSC_BACKTEST_DEFAULTS, PSC_PRODUCTION_PARAMS } from "./post-surge-consolidation-config";
import { getMaxBuyablePrice } from "../core/risk-manager";
import {
  precomputeSimData,
} from "./breakout-simulation";
import { precomputeGapUpDailySignals } from "./gapup-simulation";
import { precomputePSCDailySignals } from "./post-surge-consolidation-simulation";
import { precomputeMomentumSignals } from "./momentum-simulation";
import { MOMENTUM_BACKTEST_DEFAULTS, MOMENTUM_LARGECAP_PARAMS } from "./momentum-config";
import { precomputeWeeklyBreakSignals } from "./weekly-break-simulation";
import { WEEKLY_BREAK_BACKTEST_DEFAULTS, WEEKLY_BREAK_LARGECAP_PARAMS } from "./weekly-break-config";
import { precomputeUSEtfSignals, type PrecomputedUSEtfSignals } from "./us-etf-simulation";
import { precomputeUSEtfDipSignals, US_ETF_DIP_PARAMS } from "./us-etf-dip-simulation";
import { US_ETF_DEFAULT_CONFIG, US_ETF_DIP_DEFAULT_CONFIG, type USEtfBacktestConfig } from "./us-etf-config";
import { precomputeBuybackSignals, buildBuybackEventMap } from "./buyback-simulation";
import { BUYBACK_DEFAULT_CONFIG } from "./buyback-config";
import * as fs from "node:fs";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "./data-fetcher";
import { calculateCapitalUtilization, calculateMetrics } from "./metrics";
import { runCombinedSimulation, type PositionLimits, type BreadthMode } from "./combined-simulation";
import { MARKET_BREADTH, VIX_THRESHOLDS } from "../lib/constants";
import type {
  GapUpBacktestConfig,
  PostSurgeConsolidationBacktestConfig,
  MomentumBacktestConfig,
  WeeklyBreakBacktestConfig,
  PerformanceMetrics,
  SimulatedPosition,
  DailyEquity,
} from "./types";
import type { PrecomputedMomentumSignal } from "./momentum-simulation";
import type { PrecomputedWeeklyBreakSignals } from "./weekly-break-simulation";

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function printMetrics(m: PerformanceMetrics, label: string): void {
  console.log(`\n[${label}]`);
  console.log(`  トレード数: ${m.totalTrades} (勝${m.wins} / 負${m.losses} / 未決済${m.stillOpen})`);
  console.log(`  勝率: ${m.winRate.toFixed(1)}%`);
  console.log(`  PF: ${m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)}`);
  console.log(`  期待値: ${m.expectancy >= 0 ? "+" : ""}${m.expectancy.toFixed(2)}%`);
  console.log(`  RR比: ${m.riskRewardRatio.toFixed(2)}`);
  console.log(`  最大DD: ${m.maxDrawdown.toFixed(1)}%`);
  console.log(`  平均保有日数: ${m.avgHoldingDays.toFixed(1)}`);
  console.log(`  総損益: ¥${m.totalPnl.toLocaleString()} (${m.totalReturnPct.toFixed(1)}%)`);
  if (m.totalCommission > 0) {
    console.log(`  手数料: ¥${m.totalCommission.toLocaleString()}  税金: ¥${m.totalTax.toLocaleString()}`);
    console.log(`  純損益: ¥${m.totalNetPnl.toLocaleString()} (${m.netReturnPct.toFixed(1)}%)`);
  }
}

function printMonthlyEquitySummary(
  equityCurve: import("./types").DailyEquity[],
  totalCapitalAdded: number,
  initialBudget: number,
): void {
  // 月末エクイティを抽出
  const monthlyData: { month: string; equity: number; cumulativeAdded: number }[] = [];
  let cumulativeAdded = initialBudget;

  for (let i = 0; i < equityCurve.length; i++) {
    const day = equityCurve[i];
    if (day.capitalAdded) {
      cumulativeAdded += day.capitalAdded;
    }
    const isLastDayOfMonth =
      i === equityCurve.length - 1 ||
      equityCurve[i + 1].date.substring(0, 7) !== day.date.substring(0, 7);
    if (isLastDayOfMonth) {
      monthlyData.push({
        month: day.date.substring(0, 7),
        equity: day.totalEquity,
        cumulativeAdded,
      });
    }
  }

  console.log("\n[月次エクイティ推移]");
  console.log(
    `  ${"月".padEnd(9)} | ${"累計入金".padStart(11)} | ${"月末エクイティ".padStart(12)} | ${"損益".padStart(12)} | ${"損益率".padStart(7)}`,
  );
  console.log("  " + "-".repeat(65));

  for (const row of monthlyData) {
    const pnl = row.equity - row.cumulativeAdded;
    const pnlPct = row.cumulativeAdded > 0 ? (pnl / row.cumulativeAdded) * 100 : 0;
    const sign = pnl >= 0 ? "+" : "";
    console.log(
      `  ${row.month.padEnd(9)} | ¥${row.cumulativeAdded.toLocaleString().padStart(10)} | ¥${row.equity.toLocaleString().padStart(11)} | ${sign}¥${pnl.toLocaleString().padStart(10)} | ${sign}${pnlPct.toFixed(1)}%`,
    );
  }

  // 最終サマリー
  const finalEquity = equityCurve[equityCurve.length - 1]?.totalEquity ?? 0;
  const netProfit = finalEquity - totalCapitalAdded;
  const growthPct = totalCapitalAdded > 0 ? (netProfit / totalCapitalAdded) * 100 : 0;
  const sign = netProfit >= 0 ? "+" : "";

  console.log("\n[資金追加サマリー]");
  console.log(`  累計入金額: ¥${totalCapitalAdded.toLocaleString()}`);
  console.log(`  最終エクイティ: ¥${finalEquity.toLocaleString()}`);
  console.log(`  純利益: ${sign}¥${netProfit.toLocaleString()}`);
  console.log(`  資金増加率: ${sign}${growthPct.toFixed(1)}%`);
}

function buildDailyPnlSeries(trades: SimulatedPosition[]): Map<string, number> {
  const series = new Map<string, number>();
  for (const t of trades) {
    if (!t.exitDate || t.netPnl == null) continue;
    series.set(t.exitDate, (series.get(t.exitDate) ?? 0) + t.netPnl);
  }
  return series;
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

/**
 * 共通市場フィルター発火による「両戦略同時halt」を 1日 1原因で分類する。
 * GU/PSC は marketTrendFilter / indexTrendFilter / VIX crisis を全て共有しているため、
 * いずれかが発火すると両戦略のエントリーが停止する＝構造的な共相関源。
 *
 * 優先度（重複日は最も "強い" 原因にカウント）:
 *   vix_crisis > index_below_sma > breadth_lower > breadth_upper > none
 */
type HaltReason = "vix_crisis" | "index_below_sma" | "breadth_lower" | "breadth_upper" | "none";

function classifyDayHalt(
  date: string,
  dailyBreadth: Map<string, number>,
  dailyIndexAboveSma: Map<string, boolean>,
  vixData: Map<string, number> | undefined,
): HaltReason {
  const vix = vixData?.get(date);
  if (vix != null && vix > VIX_THRESHOLDS.HIGH) return "vix_crisis";
  // dailyIndexAboveSma が空 = フィルターOFFで計算されていない。空の場合は判定不可とする。
  if (dailyIndexAboveSma.size > 0 && dailyIndexAboveSma.get(date) === false) return "index_below_sma";
  const breadth = dailyBreadth.get(date);
  if (breadth != null) {
    if (breadth < MARKET_BREADTH.THRESHOLD) return "breadth_lower";
    if (breadth > MARKET_BREADTH.UPPER_CAP) return "breadth_upper";
  }
  return "none";
}

function printCorrelationReport(
  guTrades: SimulatedPosition[],
  pscTrades: SimulatedPosition[],
  startDate: string,
  endDate: string,
  tradingDays: string[],
  dailyBreadth: Map<string, number>,
  dailyIndexAboveSma: Map<string, boolean>,
  vixData: Map<string, number> | undefined,
): void {
  const guByDate = buildDailyPnlSeries(guTrades);
  const pscByDate = buildDailyPnlSeries(pscTrades);

  // ───── 戦略間相関（2系統） ─────
  // (A) 両アクティブ日のみ: GU決済日 ∩ PSC決済日 → "両戦略が動いた日の" 相関
  const bothActiveDates: string[] = [];
  for (const d of guByDate.keys()) {
    if (pscByDate.has(d)) bothActiveDates.push(d);
  }
  bothActiveDates.sort();
  const guActive = bothActiveDates.map((d) => guByDate.get(d) ?? 0);
  const pscActive = bothActiveDates.map((d) => pscByDate.get(d) ?? 0);
  const bothActiveCorr = pearsonCorrelation(guActive, pscActive);

  // (B) 全営業日ベース: 営業日全てを 0 埋めで含める → "ポートフォリオ全体の" 実態相関
  // halt日や両idle日も "両方0" として参加するため、共通フィルター起因の同期も反映される
  const guAllDays = tradingDays.map((d) => guByDate.get(d) ?? 0);
  const pscAllDays = tradingDays.map((d) => pscByDate.get(d) ?? 0);
  const fullDayCorr = pearsonCorrelation(guAllDays, pscAllDays);

  // (C) union (旧実装互換): GU決済日 ∪ PSC決済日 — 比較用に残す
  const unionDates = new Set<string>([...guByDate.keys(), ...pscByDate.keys()]);
  const unionSorted = [...unionDates].sort();
  const guUnion = unionSorted.map((d) => guByDate.get(d) ?? 0);
  const pscUnion = unionSorted.map((d) => pscByDate.get(d) ?? 0);
  const unionCorr = pearsonCorrelation(guUnion, pscUnion);

  // ───── 同日決済の勝敗内訳 ─────
  let bothLossDays = 0;
  let bothWinDays = 0;
  let oppositeDirDays = 0;
  for (const d of bothActiveDates) {
    const g = guByDate.get(d)!;
    const p = pscByDate.get(d)!;
    if (g < 0 && p < 0) bothLossDays++;
    else if (g > 0 && p > 0) bothWinDays++;
    else if ((g < 0 && p > 0) || (g > 0 && p < 0)) oppositeDirDays++;
  }

  // ───── 全営業日カバレッジ ─────
  // 各営業日を以下に分類:
  //   both-active   : GU決済 AND PSC決済（既存と同じ）
  //   one-active    : 片方のみ決済
  //   both-halt-*   : 共通フィルター発火で両戦略がエントリー不可だった日
  //   both-idle     : フィルターは通過したが決済発生なし（純粋な無シグナル日）
  const totalDays = tradingDays.length;
  let bothActiveDays = 0;
  let oneActiveDays = 0;
  let bothIdleActiveDays = 0; // フィルター通過だが両戦略無決済
  const haltCounts: Record<HaltReason, number> = {
    vix_crisis: 0,
    index_below_sma: 0,
    breadth_lower: 0,
    breadth_upper: 0,
    none: 0,
  };
  for (const d of tradingDays) {
    const haltReason = classifyDayHalt(d, dailyBreadth, dailyIndexAboveSma, vixData);
    if (haltReason !== "none") {
      haltCounts[haltReason]++;
      continue;
    }
    const guHas = guByDate.has(d);
    const pscHas = pscByDate.has(d);
    if (guHas && pscHas) bothActiveDays++;
    else if (guHas || pscHas) oneActiveDays++;
    else bothIdleActiveDays++;
  }
  const totalHaltDays = haltCounts.vix_crisis + haltCounts.index_below_sma + haltCounts.breadth_lower + haltCounts.breadth_upper;

  // ───── 月次相関（営業日ベース、N≥10で参考値） ─────
  const monthlyMap = new Map<string, { guVals: number[]; pscVals: number[] }>();
  for (const d of tradingDays) {
    const month = d.substring(0, 7);
    const entry = monthlyMap.get(month) ?? { guVals: [], pscVals: [] };
    entry.guVals.push(guByDate.get(d) ?? 0);
    entry.pscVals.push(pscByDate.get(d) ?? 0);
    monthlyMap.set(month, entry);
  }
  const monthlyCorrs: { month: string; corr: number; n: number; reliable: boolean }[] = [];
  for (const [month, { guVals, pscVals }] of monthlyMap) {
    const c = pearsonCorrelation(guVals, pscVals);
    // n は "両アクティブだった日数" を別途集計（信頼性指標）
    let activeN = 0;
    for (let i = 0; i < guVals.length; i++) {
      if (guVals[i] !== 0 && pscVals[i] !== 0) activeN++;
    }
    monthlyCorrs.push({ month, corr: c, n: activeN, reliable: activeN >= 10 });
  }
  monthlyCorrs.sort((a, b) => a.month.localeCompare(b.month));

  // ───── 出力 ─────
  const pct = (n: number, total: number) => total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "-";

  console.log("=".repeat(60));
  console.log("GU/PSC Daily PnL Correlation Report");
  console.log("=".repeat(60));
  console.log(`期間: ${startDate} → ${endDate}`);
  console.log(`営業日数: ${totalDays}日`);
  console.log(`GU決済日数: ${guByDate.size} / PSC決済日数: ${pscByDate.size}`);
  console.log("");

  console.log("[戦略間相関]");
  console.log(`  両アクティブ日のみ (n=${bothActiveDates.length}): ${bothActiveCorr.toFixed(3)}`);
  console.log(`  全営業日ベース   (n=${totalDays}, halt/idle日を0埋め): ${fullDayCorr.toFixed(3)}`);
  console.log(`  union(参考・旧実装) (n=${unionSorted.length}): ${unionCorr.toFixed(3)}`);
  console.log("");

  console.log("[同日決済の内訳]");
  console.log(`  両戦略同日決済: ${bothActiveDates.length}日`);
  console.log(`    両方プラス: ${bothWinDays}日`);
  console.log(`    両方マイナス(共倒れ): ${bothLossDays}日`);
  console.log(`    逆方向(片勝ち片負け): ${oppositeDirDays}日`);
  console.log("");

  console.log(`[全営業日カバレッジ] ${totalDays}日`);
  console.log(`  両戦略同日決済: ${bothActiveDays}日 (${pct(bothActiveDays, totalDays)})`);
  console.log(`  片戦略のみ決済: ${oneActiveDays}日 (${pct(oneActiveDays, totalDays)})`);
  console.log(`  両戦略アクティブ可・無決済: ${bothIdleActiveDays}日 (${pct(bothIdleActiveDays, totalDays)})`);
  console.log(`  両戦略halt(共通フィルター発火): ${totalHaltDays}日 (${pct(totalHaltDays, totalDays)})`);
  console.log(`    └ breadth < ${(MARKET_BREADTH.THRESHOLD * 100).toFixed(0)}% (下限veto): ${haltCounts.breadth_lower}日 (${pct(haltCounts.breadth_lower, totalDays)})`);
  console.log(`    └ breadth > ${(MARKET_BREADTH.UPPER_CAP * 100).toFixed(0)}% (上限veto): ${haltCounts.breadth_upper}日 (${pct(haltCounts.breadth_upper, totalDays)})`);
  console.log(`    └ 日経 < SMA50: ${haltCounts.index_below_sma}日 (${pct(haltCounts.index_below_sma, totalDays)})`);
  console.log(`    └ VIX > ${VIX_THRESHOLDS.HIGH} (crisis): ${haltCounts.vix_crisis}日 (${pct(haltCounts.vix_crisis, totalDays)})`);
  console.log(`    ※ 重複日は優先度順(VIX>SMA>breadth下限>breadth上限)で1日1原因にカウント`);
  console.log("");

  console.log("[月次相関] ※ n は両アクティブ日数。n<10 は参考値 (✓=n≥10)");
  console.log(`  ${"月".padEnd(8)} | ${"相関(全営業日)".padStart(13)} | ${"両Active日".padStart(10)} | 信頼性`);
  console.log("  " + "-".repeat(50));
  for (const m of monthlyCorrs) {
    const corrStr = m.corr.toFixed(3).padStart(6);
    const flag = m.reliable ? "✓" : " ";
    console.log(`  ${m.month.padEnd(8)} | ${corrStr.padStart(13)} | ${m.n.toString().padStart(10)} | ${flag}`);
  }

  // ───── アラート判定 ─────
  const ALERT_FULLDAY_CORR = 0.5;
  const ALERT_HALT_RATIO = 0.4; // 営業日の40%以上がhalt → 稼働率懸念
  const reliableRecent = monthlyCorrs.slice(-3).filter((m) => m.reliable);
  const recentHighCorrCount = reliableRecent.filter((m) => m.corr > ALERT_FULLDAY_CORR).length;
  console.log("");
  console.log("[判定]");
  const corrJudge = fullDayCorr > ALERT_FULLDAY_CORR ? "✗ 警告(>0.5: 戦略間で独立性が低い)" : "✓ 健全(独立性確保)";
  console.log(`  全営業日相関 ${fullDayCorr.toFixed(3)} ${corrJudge}`);
  if (reliableRecent.length === 0) {
    console.log(`  直近3ヶ月の相関安定性: 信頼サンプル(n≥10)なし`);
  } else if (recentHighCorrCount >= 2) {
    console.log(`  直近3ヶ月のうち${recentHighCorrCount}/${reliableRecent.length}ヶ月で相関>0.5 ✗ 警告`);
  } else {
    console.log(`  直近3ヶ月の相関安定性 ✓ (信頼サンプル ${reliableRecent.length}/3)`);
  }
  const haltRatio = totalDays > 0 ? totalHaltDays / totalDays : 0;
  if (haltRatio > ALERT_HALT_RATIO) {
    console.log(`  halt比率 ${(haltRatio * 100).toFixed(1)}% (>${(ALERT_HALT_RATIO * 100).toFixed(0)}%) ✗ 警告(共通フィルターで稼働率が低い)`);
  } else {
    console.log(`  halt比率 ${(haltRatio * 100).toFixed(1)}% ✓ (稼働率許容範囲)`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const endDate = getArg(args, "--end") ?? dayjs().format("YYYY-MM-DD");
  const startDate = getArg(args, "--start") ?? dayjs(endDate).subtract(12, "month").format("YYYY-MM-DD");
  const budget = Number(getArg(args, "--budget") ?? 500_000);
  const monthlyAddAmount = Number(getArg(args, "--monthly-add") ?? 0);
  const maxPriceOverride = getArg(args, "--max-price");
  const verbose = args.includes("--verbose");
  const comparePositions = args.includes("--compare-positions");
  const compareSplitPositions = args.includes("--compare-split-positions");
  const compareEquityFilter = args.includes("--compare-equity-filter");
  const compareBudget = args.includes("--budget-compare");
  const compareTurnover = args.includes("--compare-turnover");
  const comparePrice = args.includes("--compare-price");
  const comparePriceTurnover = args.includes("--compare-price-turnover");
  const minPriceOverride = getArg(args, "--min-price");
  const minTurnoverOverride = getArg(args, "--min-turnover");
  const compareEfficiency = args.includes("--compare-efficiency");
  const compareBreadth = args.includes("--compare-breadth");
  const compareBreadthModes = args.includes("--compare-breadth-modes");
  const compareBreadthZoom = args.includes("--compare-breadth-zoom");
  // --compare-breadth-split: 分割点 T の全体最適 sweep。
  // T ごとに GU/PSC の band lower・ETF breadthMax・buyback breadthMax を同時に T へ動かし、
  // portfolio 全体の Calmar が最大になる「active⇔idle帯」の境界を探す (KOH-514)。
  const compareBreadthSplit = args.includes("--compare-breadth-split");
  const compareMaxPrice = args.includes("--compare-max-price");
  const enableMomentum = args.includes("--enable-momentum");
  const momMaxArg = getArg(args, "--mom-max");
  const enableWbLargecap = args.includes("--enable-wb-largecap");
  const wbMaxArg = getArg(args, "--wb-max");
  const enableEtf = args.includes("--enable-etf");
  const etfMaxArg = getArg(args, "--etf-max");
  // --enable-etf-dip: ETF 押し目(RSI2 mean-reversion)を ETF スロットで動かす（--enable-etf と排他）
  const enableEtfDip = args.includes("--enable-etf-dip");
  const etfDipMaxArg = getArg(args, "--etf-dip-max");
  // --etf-dip-idle: ETF押し目を idle帯(breadth<54%)限定で発火（GU/PSCと資金競合させない補完設計）
  const etfDipIdle = args.includes("--etf-dip-idle");
  // --enable-buyback: 自社株買いカタリスト (KOH-502) を第6戦略として idle帯で動かす
  const enableBuyback = args.includes("--enable-buyback");
  const buybackMaxArg = getArg(args, "--buyback-max");
  const buybackJsonPath = getArg(args, "--buyback-json");
  const buybackRiskArg = getArg(args, "--buyback-risk");
  // --buyback-regime-exit: breadth が band(≥54%)に戻ったら買いを全決済（GU/PSCと食い合わせない）
  const buybackRegimeExit = args.includes("--buyback-regime-exit");
  // --enable-panic: パニック底反発 (KOH-531) — 指数ETFイベント(外部JSON)をETFレッグに注入して検証
  const enablePanic = args.includes("--enable-panic");
  const panicJsonPath = getArg(args, "--panic-json");
  const panicMaxArg = getArg(args, "--panic-max");
  const maxPerSectorArg = getArg(args, "--max-per-sector");
  const compareSector = args.includes("--compare-sector");
  const compareSectorRotation = args.includes("--compare-sector-rotation");
  const compareVixRisk = args.includes("--compare-vix-risk");
  const compareStreak = args.includes("--compare-streak");
  const compareCooldown = args.includes("--compare-cooldown");
  const compareDailyEntries = args.includes("--compare-daily-entries");
  const comparePscTrail = args.includes("--compare-psc-trail");
  const compareGuGapvol = args.includes("--compare-gu-gapvol");
  const wfMiniGuGapvol = args.includes("--wf-mini-gu-gapvol");
  const wfMiniSectorRotation = args.includes("--wf-mini-sector-rotation");
  const compareBreadthSectorTradeoff = args.includes("--compare-breadth-sector-tradeoff");
  const compareConditionalRotation = args.includes("--compare-conditional-rotation");
  const compareSectorLeaders = args.includes("--compare-sector-leaders");
  const compareSlippage = args.includes("--compare-slippage");
  const compareStrategyMix = args.includes("--compare-strategy-mix");
  const compareNikkeiDrop = args.includes("--compare-nikkei-drop");
  const compareDetectionGranularity = args.includes("--compare-detection-granularity");
  const compareBe = args.includes("--compare-be");
  const corrReport = args.includes("--corr-report");

  const quietMode = comparePositions || compareSplitPositions || compareEquityFilter || compareBudget || compareTurnover || comparePrice || comparePriceTurnover || compareEfficiency || compareBreadth || compareBreadthModes || compareBreadthZoom || compareBreadthSplit || compareMaxPrice || compareSector || compareSectorRotation || compareVixRisk || compareStreak || compareCooldown || compareDailyEntries || comparePscTrail || compareGuGapvol || wfMiniGuGapvol || wfMiniSectorRotation || compareBreadthSectorTradeoff || compareConditionalRotation || compareSectorLeaders || compareSlippage || compareStrategyMix || compareNikkeiDrop || compareDetectionGranularity || compareBe || corrReport;
  const dynamicMaxPrice = getMaxBuyablePrice(budget);
  const guConfig: GapUpBacktestConfig = { ...GAPUP_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, maxPrice: dynamicMaxPrice, verbose: !quietMode && verbose };
  const pscConfig: PostSurgeConsolidationBacktestConfig = {
    ...PSC_BACKTEST_DEFAULTS,
    startDate, endDate, initialBudget: budget, maxPrice: dynamicMaxPrice,
    verbose: !quietMode && verbose,
    // WF最適パラメータ（config/production-params から参照）
    ...PSC_PRODUCTION_PARAMS,
  };
  if (maxPriceOverride) {
    guConfig.maxPrice = Number(maxPriceOverride);
    pscConfig.maxPrice = Number(maxPriceOverride);
  }
  if (minPriceOverride !== undefined) {
    guConfig.minPrice = Number(minPriceOverride);
    pscConfig.minPrice = Number(minPriceOverride);
  }
  if (minTurnoverOverride !== undefined) {
    guConfig.minTurnover = Number(minTurnoverOverride);
    pscConfig.minTurnover = Number(minTurnoverOverride);
  }

  console.log("=".repeat(60));
  console.log("統合バックテスト（GapUp + PSC）");
  console.log("=".repeat(60));
  console.log(`期間: ${startDate} → ${endDate}`);
  console.log(`初期資金: ¥${budget.toLocaleString()}`);
  if (monthlyAddAmount > 0) {
    console.log(`月次追加: ¥${monthlyAddAmount.toLocaleString()}`);
  }

  // データ取得（Stockテーブルが空の場合はStockDailyBarから直接取得）
  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  let tickerCodes: string[];
  if (stocks.length > 0) {
    tickerCodes = stocks.map((s) => s.tickerCode);
  } else {
    const distinctTickers = await prisma.stockDailyBar.findMany({
      where: { market: "JP" },
      distinct: ["tickerCode"],
      select: { tickerCode: true },
    });
    tickerCodes = distinctTickers.map((s) => s.tickerCode);
  }
  console.log(`[data] ${tickerCodes.length}銘柄のデータ取得中...`);

  const rawData = await fetchHistoricalFromDB(tickerCodes, startDate, endDate);
  const vixData = await fetchVixFromDB(startDate, endDate);
  const indexData = await fetchIndexFromDB("^N225", startDate, endDate);

  // budget-compare時はグリッド最大予算(20M)で銘柄をロード、max-price比較時はグリッド最大値で銘柄をロード
  // --enable-momentum / --enable-wb-largecap / --compare-strategy-mix 時は大型株を含むため maxPriceForData を広げる
  const maxPriceForData = compareBudget
    ? getMaxBuyablePrice(20_000_000)
    : compareMaxPrice
    ? 50_000
    : (enableMomentum || enableWbLargecap || compareStrategyMix)
    ? 100_000
    : guConfig.maxPrice;
  const allData = new Map<string, import("../core/technical-analysis").OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPriceForData && b.close > 0)) {
      allData.set(ticker, bars);
    }
  }
  console.log(`[data] ${allData.size}銘柄（フィルタ後）, VIX ${vixData.size}日, N225 ${indexData.size}日`);

  const precomputed = precomputeSimData(
    startDate, endDate, allData,
    true, true,
    guConfig.indexTrendSmaPeriod ?? 50,
    indexData.size > 0 ? indexData : undefined,
    false, 60,
    guConfig.indexTrendOffBufferPct ?? 0,
    guConfig.indexTrendOnBufferPct ?? 0,
  );

  const gapupSignals = precomputeGapUpDailySignals(guConfig, allData, precomputed);
  const pscSignals = precomputePSCDailySignals(pscConfig, allData, precomputed);

  // セクターマップをロード（--max-per-sector / --compare-sector で使用）
  let tickerSectorMap: Map<string, string> | undefined;
  if (maxPerSectorArg !== undefined || compareSector || compareSectorRotation || wfMiniSectorRotation || compareBreadthSectorTradeoff || compareConditionalRotation || compareSectorLeaders) {
    const stocksWithSector = await prisma.stock.findMany({
      where: { isDelisted: false, isActive: true, isRestricted: false, sector: { not: null } },
      select: { tickerCode: true, sector: true },
    });
    tickerSectorMap = new Map();
    for (const s of stocksWithSector) {
      if (s.sector) tickerSectorMap.set(s.tickerCode, s.sector);
    }
    console.log(`[data] sectorマップ: ${tickerSectorMap.size}銘柄`);
  }

  // --enable-wb-largecap / --compare-strategy-mix: 大型株WB戦略のシグナル計算
  let wbConfig: WeeklyBreakBacktestConfig | undefined;
  let weeklyBreakSignals: PrecomputedWeeklyBreakSignals | undefined;
  if (enableWbLargecap || compareStrategyMix) {
    wbConfig = {
      ...WEEKLY_BREAK_BACKTEST_DEFAULTS,
      ...WEEKLY_BREAK_LARGECAP_PARAMS,
      startDate,
      endDate,
      initialBudget: budget,
      verbose: !quietMode && verbose,
    };

    const wbLargecapStocks = await prisma.stock.findMany({
      where: {
        isDelisted: false,
        isActive: true,
        isRestricted: false,
        marketCap: { gte: wbConfig.minMarketCap! },
      },
      select: { tickerCode: true },
    });
    const wbLargecapTickers = new Set(wbLargecapStocks.map((s) => s.tickerCode));
    console.log(`[data] WB大型株universe: ${wbLargecapTickers.size}銘柄 (時価総額 >= ¥${(wbConfig.minMarketCap! / 1_000_000_000).toLocaleString()}B)`);

    const allDataForWb = new Map<string, import("../core/technical-analysis").OHLCVData[]>();
    for (const [ticker, bars] of allData) {
      if (wbLargecapTickers.has(ticker)) allDataForWb.set(ticker, bars);
    }
    weeklyBreakSignals = precomputeWeeklyBreakSignals(wbConfig, allDataForWb, precomputed);
  }

  // --enable-momentum / --compare-strategy-mix: 大型株モメンタム戦略のシグナル計算
  let momConfig: MomentumBacktestConfig | undefined;
  let momSignals: Map<string, PrecomputedMomentumSignal[]> | undefined;
  if (enableMomentum || compareStrategyMix) {
    momConfig = {
      ...MOMENTUM_BACKTEST_DEFAULTS,
      ...MOMENTUM_LARGECAP_PARAMS,
      startDate,
      endDate,
      initialBudget: budget,
      verbose: !quietMode && verbose,
    };

    // 大型株tickerをDBからロード
    const largecapStocks = await prisma.stock.findMany({
      where: {
        isDelisted: false,
        isActive: true,
        isRestricted: false,
        marketCap: { gte: momConfig.minMarketCap! },
      },
      select: { tickerCode: true },
    });
    const largecapTickers = new Set(largecapStocks.map((s) => s.tickerCode));
    console.log(`[data] momentum大型株universe: ${largecapTickers.size}銘柄 (時価総額 >= ¥${(momConfig.minMarketCap! / 1_000_000_000).toLocaleString()}B)`);

    // precompute前に大型株だけの allData を作って渡す（top N選択が小型株に取られないように）
    const allDataForMom = new Map<string, import("../core/technical-analysis").OHLCVData[]>();
    for (const [ticker, bars] of allData) {
      if (largecapTickers.has(ticker)) allDataForMom.set(ticker, bars);
    }
    momSignals = precomputeMomentumSignals(momConfig, allDataForMom, precomputed);
  }

  // --enable-etf: 米株ETF (1547/1545) のシグナル precompute + allData にマージ
  let etfConfig: USEtfBacktestConfig | undefined;
  let etfSignals: PrecomputedUSEtfSignals | undefined;
  if (enableEtf) {
    etfConfig = { ...US_ETF_DEFAULT_CONFIG };
    const etfRawData = await fetchHistoricalFromDB(etfConfig.tickers, startDate, endDate);
    const etfDataMap = new Map<string, import("../core/technical-analysis").OHLCVData[]>();
    let totalBars = 0;
    for (const ticker of etfConfig.tickers) {
      const bars = etfRawData.get(ticker);
      if (bars && bars.length > 0) {
        etfDataMap.set(ticker, bars);
        totalBars += bars.length;
        // ETF を allData にもマージ（exit/equity計算で dateIndexMap 経由のアクセスが必要）
        allData.set(ticker, bars);
      }
    }
    console.log(`[data] US ETF universe: ${etfConfig.tickers.join(", ")} (${totalBars}本)`);
    etfSignals = precomputeUSEtfSignals(etfDataMap, precomputed.dailyBreadth, etfConfig);
    const sigDays = etfSignals.size;
    let sigTotal = 0;
    for (const arr of etfSignals.values()) sigTotal += arr.length;
    console.log(`[data] US ETF シグナル: ${sigTotal}件 / ${sigDays}日 (idle帯 breadth<${(etfConfig.breadthMax * 100).toFixed(0)}%)`);

    // precomputed.dateIndexMap に ETF 銘柄を追加（既存ロジックでは銘柄ユニバースに含まれないため必須）
    for (const [ticker, bars] of etfDataMap) {
      const map = new Map<string, number>();
      bars.forEach((b, idx) => map.set(dayjs(b.date).format("YYYY-MM-DD"), idx));
      precomputed.dateIndexMap.set(ticker, map);
    }
  }

  // --enable-etf-dip: ETF 押し目シグナル precompute + allData マージ（ETFスロットを使用、--enable-etf と排他）
  if (enableEtfDip) {
    if (enableEtf) throw new Error("--enable-etf と --enable-etf-dip は同時指定できません");
    etfConfig = { ...US_ETF_DIP_DEFAULT_CONFIG, breadthMax: etfDipIdle ? MARKET_BREADTH.THRESHOLD : 1.0 };
    const etfRawData = await fetchHistoricalFromDB(etfConfig.tickers, startDate, endDate);
    const etfDataMap = new Map<string, import("../core/technical-analysis").OHLCVData[]>();
    let totalBars = 0;
    for (const ticker of etfConfig.tickers) {
      const bars = etfRawData.get(ticker);
      if (bars && bars.length > 0) {
        etfDataMap.set(ticker, bars);
        totalBars += bars.length;
        allData.set(ticker, bars);
      }
    }
    console.log(`[data] ETF押し目 universe: ${etfConfig.tickers.join(", ")} (${totalBars}本)`);
    etfSignals = precomputeUSEtfDipSignals(etfDataMap, etfConfig, US_ETF_DIP_PARAMS, precomputed.dailyBreadth);
    let sigTotal = 0;
    for (const arr of etfSignals.values()) sigTotal += arr.length;
    console.log(`[data] ETF押し目 シグナル: ${sigTotal}件 / ${etfSignals.size}日 (RSI2<=${US_ETF_DIP_PARAMS.rsiMax} + SMA${US_ETF_DIP_PARAMS.trendPeriod}, ${etfDipIdle ? `idle帯 breadth<${(MARKET_BREADTH.THRESHOLD * 100).toFixed(0)}%` : "breadthフィルタなし"})`);
    for (const [ticker, bars] of etfDataMap) {
      const map = new Map<string, number>();
      bars.forEach((b, idx) => map.set(dayjs(b.date).format("YYYY-MM-DD"), idx));
      precomputed.dateIndexMap.set(ticker, map);
    }
  }

  // --enable-panic: パニック底反発 (KOH-531) — 指数ETFイベントを ETF レッグに注入して precompute。
  // シグナル(breadth<40% & N225連続下落>=3)は外部JSON(イベント日=エントリー日=当日引け)で注入。
  // 出口は buyback と同型 (-12%SL + 20日TS)、ETFなので unitShares=1。VIX crisis ガードは
  // バイパスする(パニック戦略は定義上 crisis 中に買うため。SimContext.etfCrisisBypass 参照)。
  if (enablePanic) {
    if (enableEtf || enableEtfDip) throw new Error("--enable-panic は --enable-etf / --enable-etf-dip と同時指定できません");
    if (!panicJsonPath) throw new Error("--enable-panic には --panic-json <path> が必須です");
    const raw = JSON.parse(fs.readFileSync(panicJsonPath, "utf-8")) as { events: { ticker: string; date: string }[] };
    const panicTickers = [...new Set((raw.events ?? []).map((e) => e.ticker))];
    etfConfig = { ...BUYBACK_DEFAULT_CONFIG, tickers: panicTickers, unitShares: 1 };
    const panicRawData = await fetchHistoricalFromDB(panicTickers, startDate, endDate);
    let totalBars = 0;
    for (const ticker of panicTickers) {
      const bars = panicRawData.get(ticker);
      if (bars && bars.length > 0) {
        allData.set(ticker, bars);
        totalBars += bars.length;
        const map = new Map<string, number>();
        bars.forEach((b, idx) => map.set(dayjs(b.date).format("YYYY-MM-DD"), idx));
        precomputed.dateIndexMap.set(ticker, map);
      }
    }
    console.log(`[data] パニック底反発 universe: ${panicTickers.join(", ")} (${totalBars}本)`);
    etfSignals = precomputeBuybackSignals(buildBuybackEventMap(raw.events ?? []), allData, precomputed.dateIndexMap, precomputed.dailyBreadth, etfConfig);
    let sigTotal = 0;
    for (const arr of etfSignals.values()) sigTotal += arr.length;
    console.log(`[data] パニック底反発 シグナル: ${sigTotal}件 / ${etfSignals.size}日 (イベント${raw.events?.length ?? 0}件中, idle帯 breadth<${(etfConfig.breadthMax * 100).toFixed(0)}%, SL-${(etfConfig.slPct * 100).toFixed(0)}% / ${etfConfig.timeStopDays}d, crisisバイパス)`);
  }

  // --enable-buyback: 自社株買いカタリスト シグナルを外部JSONから注入して precompute
  // 銘柄は既存ユニバース(allData)内なので追加データマージ不要。idle帯フィルタは precompute 側。
  let buybackConfig: USEtfBacktestConfig | undefined;
  let buybackSignals: PrecomputedUSEtfSignals | undefined;
  if (enableBuyback) {
    if (!buybackJsonPath) throw new Error("--enable-buyback には --buyback-json <path> が必須です");
    buybackConfig = { ...BUYBACK_DEFAULT_CONFIG, ...(buybackRiskArg ? { riskPct: Number(buybackRiskArg) } : {}) };
    const raw = JSON.parse(fs.readFileSync(buybackJsonPath, "utf-8")) as { events: { ticker: string; date: string }[] };
    const eventMap = buildBuybackEventMap(raw.events ?? []);
    buybackSignals = precomputeBuybackSignals(eventMap, allData, precomputed.dateIndexMap, precomputed.dailyBreadth, buybackConfig);
    let sigTotal = 0;
    for (const arr of buybackSignals.values()) sigTotal += arr.length;
    console.log(`[data] 買いカタリスト シグナル: ${sigTotal}件 / ${buybackSignals.size}日 (idle帯 breadth<${(buybackConfig.breadthMax * 100).toFixed(0)}%, SL-${(buybackConfig.slPct * 100).toFixed(0)}% / ${buybackConfig.timeStopDays}d, 開示${raw.events?.length ?? 0}件中)`);
  }

  const ctx = {
    guConfig,
    pscConfig,
    pscSignals,
    wbConfig,
    weeklyBreakSignals,
    momConfig,
    momSignals,
    etfConfig,
    etfSignals,
    buybackConfig,
    buybackSignals,
    buybackRegimeExit,
    ...(enablePanic ? { etfCrisisBypass: true } : {}),
    budget,
    verbose: !quietMode && verbose,
    allData,
    precomputed,
    gapupSignals,
    vixData: vixData.size > 0 ? vixData : undefined,
    monthlyAddAmount,
    // equity SMA filter は Phase 0 の検証(2026-04-22)で全戦略に逆効果と判明したため既定は無効(0)
    // --compare-equity-filter モードでのみ値を上書きして検証する
    equityCurveSmaPeriod: 0,
    tickerSectorMap,
    indexData: indexData.size > 0 ? indexData : undefined,
  };

  const defaultLimits: PositionLimits = {
    boMax: 0,
    guMax: 3,
    pscMax: 2,
    ...(enableMomentum ? { momMax: Number(momMaxArg ?? 2) } : {}),
    ...(enableWbLargecap ? { wbMax: Number(wbMaxArg ?? 2) } : {}),
    ...(enableEtf ? { etfMax: Number(etfMaxArg ?? 2) } : {}),
    ...(enableEtfDip ? { etfMax: Number(etfDipMaxArg ?? 2) } : {}),
    ...(enablePanic ? { etfMax: Number(panicMaxArg ?? 1) } : {}),
    ...(enableBuyback ? { buybackMax: Number(buybackMaxArg ?? 2) } : {}),
    ...(maxPerSectorArg !== undefined ? { maxPerSector: Number(maxPerSectorArg) } : {}),
  };

  // 資金比較モード
  if (compareBudget) {
    const budgetGrid = [
      { label: "500K (現状)", budget: 500_000 },
      { label: "750K", budget: 750_000 },
      { label: "1M", budget: 1_000_000 },
      { label: "1.5M", budget: 1_500_000 },
      { label: "2M", budget: 2_000_000 },
      { label: "3M", budget: 3_000_000 },
      { label: "5M", budget: 5_000_000 },
      { label: "7.5M", budget: 7_500_000 },
      { label: "10M", budget: 10_000_000 },
      { label: "15M", budget: 15_000_000 },
      { label: "20M", budget: 20_000_000 },
    ];

    console.log("\n=== 資金規模比較 ===");
    console.log(
      `${"資金".padEnd(14)}| ${"maxP".padStart(5)} | ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(95));

    for (const row of budgetGrid) {
      const mp = maxPriceOverride ? Number(maxPriceOverride) : getMaxBuyablePrice(row.budget);
      const gc: GapUpBacktestConfig = { ...guConfig, initialBudget: row.budget, maxPrice: mp };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, initialBudget: row.budget, maxPrice: mp };
      const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
      const pSig = precomputePSCDailySignals(pc, allData, precomputed);
      const result = runCombinedSimulation(
        { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig, budget: row.budget },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      console.log(
        `${row.label.padEnd(14)}| ${String(mp).padStart(5)} | ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // maxPrice比較モード（大型株を含めるとエッジが残るか）
  if (compareMaxPrice) {
    const maxPriceGrid: { label: string; value: number }[] = [
      { label: "≤2,500 (現状/小中型)", value: 2_500 },
      { label: "≤5,000", value: 5_000 },
      { label: "≤10,000", value: 10_000 },
      { label: "≤20,000", value: 20_000 },
      { label: "≤50,000 (実質無制限)", value: 50_000 },
    ];

    // 価格帯別内訳用のバケット
    const priceBuckets: { label: string; min: number; max: number }[] = [
      { label: "¥0-2,500", min: 0, max: 2_500 },
      { label: "¥2,500-5,000", min: 2_500, max: 5_000 },
      { label: "¥5,000-10,000", min: 5_000, max: 10_000 },
      { label: "¥10,000-20,000", min: 10_000, max: 20_000 },
      { label: "¥20,000+", min: 20_000, max: Infinity },
    ];

    console.log(`\n=== maxPrice比較（大型株追加でエッジが残るか） ===`);
    console.log(`予算: ¥${budget.toLocaleString()}, 期間: ${startDate} → ${endDate}`);
    console.log(
      `${"maxPrice".padEnd(22)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(100));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; maxPrice: number; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of maxPriceGrid) {
      const gc: GapUpBacktestConfig = { ...guConfig, maxPrice: row.value };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, maxPrice: row.value };
      const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
      const pSig = precomputePSCDailySignals(pc, allData, precomputed);
      const result = runCombinedSimulation(
        { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(22)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, maxPrice: row.value, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // エントリー価格帯別内訳（新帯域の玉にエッジがあるか検証）
    console.log(`\n=== エントリー価格帯別内訳 (maxPrice=${maxPriceGrid[maxPriceGrid.length - 1].value.toLocaleString()} のBTから分割) ===`);
    const lastResult = overallResults[overallResults.length - 1];
    console.log(
      `${"価格帯".padEnd(18)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"AvgPnL%".padStart(7)} | ${"NetPnL".padStart(12)}`,
    );
    console.log("-".repeat(82));

    for (const bucket of priceBuckets) {
      const inBucket = lastResult.allTrades.filter(
        (t) => t.entryPrice >= bucket.min && t.entryPrice < bucket.max,
      );
      if (inBucket.length === 0) {
        console.log(`${bucket.label.padEnd(18)}| ${"0".padStart(6)} | ${"-".padStart(5)} | ${"-".padStart(5)} | ${"-".padStart(7)} | ${"-".padStart(7)} | ${"¥0".padStart(12)}`);
        continue;
      }
      const sub = calculateMetrics(inBucket, lastResult.equityCurve, budget);
      const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
      const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
      const avgPnlPct = inBucket.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0) / inBucket.length;
      const avgPnlStr = (avgPnlPct >= 0 ? "+" : "") + avgPnlPct.toFixed(2) + "%";
      const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
      console.log(
        `${bucket.label.padEnd(18)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${avgPnlStr.padStart(7)} | ${netPnlStr.padStart(12)}`,
      );
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // suspended戦略の本番投入候補比較モード
  // baseline (GU3+PSC2) vs +WB / +MOM / +WB+MOM の Calmar 比較
  // 月次 strategy-health workflow から呼ばれる
  if (compareStrategyMix) {
    const grid: { label: string; mode: "baseline" | "wb" | "mom" | "wb+mom" }[] = [
      { label: "baseline (GU3+PSC2)", mode: "baseline" },
      { label: "+WB largecap", mode: "wb" },
      { label: "+MOM largecap", mode: "mom" },
      { label: "+WB+MOM", mode: "wb+mom" },
    ];

    const wbMax = Number(wbMaxArg ?? 2);
    const momMax = Number(momMaxArg ?? 3);

    console.log("\n=== Strategy Mix 比較（suspended戦略の本番投入候補） ===");
    console.log(`期間: ${startDate} → ${endDate} / 初期資金: ¥${budget.toLocaleString()}`);
    console.log(`WB枠: ${wbMax} / MOM枠: ${momMax}`);
    console.log(
      `${"構成".padEnd(22)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(96));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const rowResults: { label: string; mode: string; calmar: number; netRet: number; maxDd: number; pf: number }[] = [];

    for (const row of grid) {
      const useWb = row.mode === "wb" || row.mode === "wb+mom";
      const useMom = row.mode === "mom" || row.mode === "wb+mom";
      const limits: PositionLimits = {
        boMax: 0,
        guMax: 3,
        pscMax: 2,
        ...(useMom ? { momMax } : {}),
        ...(useWb ? { wbMax } : {}),
      };
      const rowCtx = {
        ...ctx,
        wbConfig: useWb ? wbConfig : undefined,
        weeklyBreakSignals: useWb ? weeklyBreakSignals : undefined,
        momConfig: useMom ? momConfig : undefined,
        momSignals: useMom ? momSignals : undefined,
      };
      const result = runCombinedSimulation(rowCtx, limits);
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(22)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      rowResults.push({
        label: row.label,
        mode: row.mode,
        calmar,
        netRet: m.netReturnPct,
        maxDd: m.maxDrawdown,
        pf: m.profitFactor === Infinity ? 999 : m.profitFactor,
      });
    }

    // 結果サマリー（python側でパースして revival検討の判断に使う）
    const baseline = rowResults.find((r) => r.mode === "baseline");
    if (baseline) {
      console.log("\n[baseline比較サマリー]");
      console.log(
        `${"構成".padEnd(22)}| ${"Calmar差分".padStart(11)} | ${"NetRet差分".padStart(11)} | ${"MaxDD差分".padStart(10)}`,
      );
      console.log("-".repeat(60));
      for (const r of rowResults) {
        if (r.mode === "baseline") continue;
        const calmarDiff = r.calmar - baseline.calmar;
        const netRetDiff = r.netRet - baseline.netRet;
        const maxDdDiff = r.maxDd - baseline.maxDd;
        const calmarSign = calmarDiff >= 0 ? "+" : "";
        const netRetSign = netRetDiff >= 0 ? "+" : "";
        const maxDdSign = maxDdDiff >= 0 ? "+" : "";
        console.log(
          `${r.label.padEnd(22)}| ${(calmarSign + calmarDiff.toFixed(2)).padStart(11)} | ${(netRetSign + netRetDiff.toFixed(1) + "%").padStart(11)} | ${(maxDdSign + maxDdDiff.toFixed(1) + "%").padStart(10)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 資金効率比較モード（T+2 / リスク% / 信用金利）
  if (compareEfficiency) {
    const grid: { label: string; settlementDays: number; riskPct: number | undefined; marginInterestRate: number }[] = [
      { label: "現物T+2,2%", settlementDays: 2, riskPct: undefined, marginInterestRate: 0 },
      { label: "T+0,2%,金利0%", settlementDays: 0, riskPct: undefined, marginInterestRate: 0 },
      { label: "T+0,2%,金利2.5%", settlementDays: 0, riskPct: undefined, marginInterestRate: 0.025 },
      { label: "T+0,2%,金利3.0%", settlementDays: 0, riskPct: undefined, marginInterestRate: 0.030 },
      { label: "T+0,2%,金利3.5%", settlementDays: 0, riskPct: undefined, marginInterestRate: 0.035 },
      { label: "T+0,3%,金利3.0%", settlementDays: 0, riskPct: 3, marginInterestRate: 0.030 },
      { label: "T+0,4%,金利3.0%", settlementDays: 0, riskPct: 4, marginInterestRate: 0.030 },
    ];

    console.log("\n=== 資金効率比較（受渡日数 × リスク% × 信用金利） ===");
    console.log(
      `${"条件".padEnd(20)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(96));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;

    for (const row of grid) {
      const result = runCombinedSimulation(
        {
          ...ctx,
          settlementDays: row.settlementDays,
          riskPctOverride: row.riskPct,
          marginInterestRate: row.marginInterestRate,
        },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(20)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // breadthフィルター比較モード
  if (compareBreadth) {
    const grid: { label: string; threshold: number; filterOn: boolean }[] = [
      { label: "OFF (0%)", threshold: 0, filterOn: false },
      { label: "40%", threshold: 0.4, filterOn: true },
      { label: "50%", threshold: 0.5, filterOn: true },
      { label: "60% (現状)", threshold: 0.6, filterOn: true },
      { label: "70%", threshold: 0.7, filterOn: true },
      { label: "80%", threshold: 0.8, filterOn: true },
    ];

    console.log("\n=== breadthフィルター比較 ===");
    console.log(
      `${"閾値".padEnd(16)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(82));

    for (const row of grid) {
      const gc: GapUpBacktestConfig = { ...guConfig, marketTrendFilter: row.filterOn, marketTrendThreshold: row.threshold };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, marketTrendFilter: row.filterOn, marketTrendThreshold: row.threshold };
      const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
      const pSig = precomputePSCDailySignals(pc, allData, precomputed);
      const result = runCombinedSimulation(
        { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      console.log(
        `${row.label.padEnd(16)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      // 戦略別内訳
      const gm = result.guMetrics;
      const pm = result.pscMetrics;
      console.log(
        `${"  GU".padEnd(16)}| ${String(gm.totalTrades).padStart(6)} | ${gm.winRate.toFixed(1).padStart(6)}% | ${(gm.profitFactor === Infinity ? "∞" : gm.profitFactor.toFixed(2)).padStart(5)} | ${((gm.expectancy >= 0 ? "+" : "") + gm.expectancy.toFixed(2) + "%").padStart(8)}`,
      );
      console.log(
        `${"  PSC".padEnd(16)}| ${String(pm.totalTrades).padStart(6)} | ${pm.winRate.toFixed(1).padStart(6)}% | ${(pm.profitFactor === Infinity ? "∞" : pm.profitFactor.toFixed(2)).padStart(5)} | ${((pm.expectancy >= 0 ? "+" : "") + pm.expectancy.toFixed(2) + "%").padStart(8)}`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // breadthゲーティング方式の比較
  if (compareBreadthModes) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    type ModeSpec = { label: string; mode?: BreadthMode; modeGu?: BreadthMode; modePsc?: BreadthMode };
    const modes: ModeSpec[] = [
      // === ベースライン（前回の上位勢） ===
      { label: "現状 hard 55%", mode: { type: "hard", threshold: 0.55 } },
      { label: "hard 60%", mode: { type: "hard", threshold: 0.60 } },
      { label: "velocity 10d+55%", mode: { type: "velocity", window: 10, minLevel: 0.55 } },

      // === 異端1: Bullish band（過熱もveto） ===
      { label: "band 55-80%", mode: { type: "band", lower: 0.55, upper: 0.80 } },
      { label: "band 60-80%", mode: { type: "band", lower: 0.60, upper: 0.80 } },
      { label: "band 60-75%", mode: { type: "band", lower: 0.60, upper: 0.75 } },

      // === 異端2: 戦略別 threshold ===
      // GU は個別momentum、PSCは broad strength要求 → PSC厳しめ
      { label: "split GU50/PSC65",
        modeGu: { type: "hard", threshold: 0.50 },
        modePsc: { type: "hard", threshold: 0.65 } },
      { label: "split GU55/PSC65",
        modeGu: { type: "hard", threshold: 0.55 },
        modePsc: { type: "hard", threshold: 0.65 } },
      { label: "split GU50/PSC70",
        modeGu: { type: "hard", threshold: 0.50 },
        modePsc: { type: "hard", threshold: 0.70 } },

      // === 異端3: Z-score（regime-adaptive） ===
      { label: "zscore 60d -1σ", mode: { type: "zscore", window: 60, sigmaBelow: 1.0 } },
      { label: "zscore 60d -0.5σ", mode: { type: "zscore", window: 60, sigmaBelow: 0.5 } },
      { label: "zscore 30d -1σ", mode: { type: "zscore", window: 30, sigmaBelow: 1.0 } },

      // === 異端4: hard 60% + velocity 10d AND ===
      { label: "hard60 AND vel10",
        mode: { type: "and", modes: [
          { type: "hard", threshold: 0.60 },
          { type: "velocity", window: 10 },
        ] } },
      { label: "hard55 AND vel10",
        mode: { type: "and", modes: [
          { type: "hard", threshold: 0.55 },
          { type: "velocity", window: 10 },
        ] } },
      // 戦略別 + AND の合体技
      { label: "split GU55/PSC60+vel",
        modeGu: { type: "hard", threshold: 0.55 },
        modePsc: { type: "and", modes: [
          { type: "hard", threshold: 0.60 },
          { type: "velocity", window: 10 },
        ] } },

      // === 最終決戦: split + band の複合 ===
      // band 55-80(Calmar 9.38) と split GU55/PSC65(NetRet 222%) の長所合わせ
      { label: "split-band 55-80/65-80",
        modeGu: { type: "band", lower: 0.55, upper: 0.80 },
        modePsc: { type: "band", lower: 0.65, upper: 0.80 } },
      { label: "split-band 50-80/65-80",
        modeGu: { type: "band", lower: 0.50, upper: 0.80 },
        modePsc: { type: "band", lower: 0.65, upper: 0.80 } },
      { label: "split-band 55-80/60-80",
        modeGu: { type: "band", lower: 0.55, upper: 0.80 },
        modePsc: { type: "band", lower: 0.60, upper: 0.80 } },
    ];

    // 比較時は precompute 側のbreadthフィルターを切り、simulation側で判定
    const guCfgNoFilter: GapUpBacktestConfig = { ...guConfig, marketTrendFilter: false };
    const pscCfgNoFilter: PostSurgeConsolidationBacktestConfig = { ...pscConfig, marketTrendFilter: false };
    const guSigOpen = precomputeGapUpDailySignals(guCfgNoFilter, allData, precomputed);
    const pSigOpen = precomputePSCDailySignals(pscCfgNoFilter, allData, precomputed);

    console.log("\n=== breadthゲーティング方式の比較 ===");
    console.log(`期間: ${startDate} → ${endDate}`);
    console.log(
      `${"モード".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(102));

    const overallResults: { label: string; metrics: PerformanceMetrics; util: number; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const { label, mode, modeGu, modePsc } of modes) {
      const result = runCombinedSimulation(
        { ...ctx, guConfig: guCfgNoFilter, pscConfig: pscCfgNoFilter, gapupSignals: guSigOpen, pscSignals: pSigOpen, breadthMode: mode, breadthModeGu: modeGu, breadthModePsc: modePsc },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      // 年換算リターン = NetRet / (期間年数) で割ってからMaxDDで割る
      const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${label.padEnd(24)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label, metrics: m, util: util.capitalUtilizationPct, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳（トレードベース）
    console.log("\n=== レジーム別トレード指標 (entryDateで分割) ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"モード".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(10)}`,
      );
      console.log("  " + "-".repeat(76));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(24)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(10)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // breadth 下限ゾーンの個別BT（52-55% 帯の個別調査 + 下限を段階的に緩和した版）
  if (compareBreadthZoom) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    type ZoomSpec = { label: string; mode: BreadthMode };
    const modes: ZoomSpec[] = [
      // === sub-threshold 帯だけエントリー（今日のようなケースの過去版を直接見る） ===
      { label: "band 50-55% only", mode: { type: "band", lower: 0.50, upper: 0.55 } },
      { label: "band 52-55% only", mode: { type: "band", lower: 0.52, upper: 0.55 } },
      { label: "band 53-55% only", mode: { type: "band", lower: 0.53, upper: 0.55 } },
      { label: "band 54-55% only", mode: { type: "band", lower: 0.54, upper: 0.55 } },

      // === 下限を段階的に緩和（現在 55-80% と比較） ===
      { label: "band 50-80%", mode: { type: "band", lower: 0.50, upper: 0.80 } },
      { label: "band 52-80%", mode: { type: "band", lower: 0.52, upper: 0.80 } },
      { label: "band 53-80%", mode: { type: "band", lower: 0.53, upper: 0.80 } },
      { label: "band 54-80%", mode: { type: "band", lower: 0.54, upper: 0.80 } },
      { label: "band 55-80% (現状)", mode: { type: "band", lower: 0.55, upper: 0.80 } },
    ];

    // 比較時は precompute 側のbreadthフィルターを切り、simulation側で判定
    const guCfgNoFilter: GapUpBacktestConfig = { ...guConfig, marketTrendFilter: false };
    const pscCfgNoFilter: PostSurgeConsolidationBacktestConfig = { ...pscConfig, marketTrendFilter: false };
    const guSigOpen = precomputeGapUpDailySignals(guCfgNoFilter, allData, precomputed);
    const pSigOpen = precomputePSCDailySignals(pscCfgNoFilter, allData, precomputed);

    console.log("\n=== breadth 下限ゾーンの個別BT ===");
    console.log(`期間: ${startDate} → ${endDate}`);
    console.log(
      `${"モード".padEnd(22)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(100));

    const overallResults: { label: string; metrics: PerformanceMetrics; guMetrics: PerformanceMetrics; pscMetrics: PerformanceMetrics; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];
    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;

    for (const { label, mode } of modes) {
      const result = runCombinedSimulation(
        { ...ctx, guConfig: guCfgNoFilter, pscConfig: pscCfgNoFilter, gapupSignals: guSigOpen, pscSignals: pSigOpen, breadthMode: mode },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${label.padEnd(22)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label, metrics: m, guMetrics: result.guMetrics, pscMetrics: result.pscMetrics, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // 戦略別内訳（GU vs PSC で挙動が違うので分離）
    console.log("\n=== 戦略別内訳 (GU / PSC) ===");
    console.log(
      `${"モード".padEnd(22)}| ${"GU Trd".padStart(6)} | ${"GU PF".padStart(5)} | ${"GU Exp".padStart(7)} | ${"PSC Trd".padStart(7)} | ${"PSC PF".padStart(6)} | ${"PSC Exp".padStart(8)}`,
    );
    console.log("-".repeat(88));
    for (const r of overallResults) {
      const gm = r.guMetrics;
      const pm = r.pscMetrics;
      const gPf = gm.profitFactor === Infinity ? "∞" : gm.profitFactor.toFixed(2);
      const pPf = pm.profitFactor === Infinity ? "∞" : pm.profitFactor.toFixed(2);
      const gExp = (gm.expectancy >= 0 ? "+" : "") + gm.expectancy.toFixed(2) + "%";
      const pExp = (pm.expectancy >= 0 ? "+" : "") + pm.expectancy.toFixed(2) + "%";
      console.log(
        `${r.label.padEnd(22)}| ${String(gm.totalTrades).padStart(6)} | ${gPf.padStart(5)} | ${gExp.padStart(7)} | ${String(pm.totalTrades).padStart(7)} | ${pPf.padStart(6)} | ${pExp.padStart(8)}`,
      );
    }

    // レジーム別内訳（A: 平穏ボックスで破綻していないか特に注意）
    console.log("\n=== レジーム別トレード指標 (entryDateで分割) ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"モード".padEnd(22)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(10)}`,
      );
      console.log("  " + "-".repeat(74));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(22)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(10)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // ── 分割点 T の全体最適 sweep（KOH-514） ──
  // 「GU/PSC active(≥T) ⇔ 補完戦略 idle帯(<T)」の境界 T を動かし、portfolio 全体の Calmar 最大点を探す。
  // T ごとに (1) GU/PSC の band lower=T, (2) ETF breadthMax=T, (3) buyback breadthMax=T を同時に動かす。
  // ETF/buyback の idle帯フィルタは precompute 時に適用されるため、T ごとにシグナルを再 precompute する。
  if (compareBreadthSplit) {
    const UPPER = MARKET_BREADTH.UPPER_CAP; // 0.80 固定（過熱veto、今回は下限のみ sweep）
    const Ts = [0.46, 0.48, 0.5, 0.52, 0.54, 0.56, 0.58, 0.6];

    // GU/PSC: precompute 側 filter を切り、band を simulation 側で T ごとに適用
    const guCfgNoFilter: GapUpBacktestConfig = { ...guConfig, marketTrendFilter: false };
    const pscCfgNoFilter: PostSurgeConsolidationBacktestConfig = { ...pscConfig, marketTrendFilter: false };
    const guSigOpen = precomputeGapUpDailySignals(guCfgNoFilter, allData, precomputed);
    const pSigOpen = precomputePSCDailySignals(pscCfgNoFilter, allData, precomputed);

    // ETF データを再取得（T ごとに breadthMax=T で再 precompute するため）
    let etfDataMapLocal: Map<string, import("../core/technical-analysis").OHLCVData[]> | undefined;
    if (enableEtf && etfConfig) {
      const etfRaw = await fetchHistoricalFromDB(etfConfig.tickers, startDate, endDate);
      etfDataMapLocal = new Map();
      for (const t of etfConfig.tickers) {
        const b = etfRaw.get(t);
        if (b && b.length > 0) etfDataMapLocal.set(t, b);
      }
    }

    // buyback イベントマップを再構築（T ごとに breadthMax=T で再 precompute するため）
    let buybackEventMapLocal: ReturnType<typeof buildBuybackEventMap> | undefined;
    if (enableBuyback && buybackConfig && buybackJsonPath) {
      const raw = JSON.parse(fs.readFileSync(buybackJsonPath, "utf-8")) as { events: { ticker: string; date: string }[] };
      buybackEventMapLocal = buildBuybackEventMap(raw.events ?? []);
    }

    const complements: string[] = [];
    if (enableEtf) complements.push("ETF");
    if (enableBuyback) complements.push("buyback");

    console.log("\n=== 分割点 T の全体最適 sweep（GU/PSC active(≥T) ⇔ 補完 idle帯(<T)） ===");
    console.log(`期間: ${startDate} → ${endDate} / 予算: ¥${budget.toLocaleString()} / 補完: ${complements.length ? complements.join("+") : "なし(GU/PSCのみ)"}`);
    console.log(`upper cap: ${(UPPER * 100).toFixed(0)}% 固定`);
    console.log(
      `${"T (下限)".padEnd(10)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(8)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(84));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const rows: { T: number; total: PerformanceMetrics; gu: PerformanceMetrics; psc: PerformanceMetrics; etf: PerformanceMetrics; buyback: PerformanceMetrics }[] = [];

    for (const T of Ts) {
      const mode: BreadthMode = { type: "band", lower: T, upper: UPPER };

      // 補完戦略を breadthMax=T で再 precompute
      let etfCfgT = etfConfig;
      let etfSigT = etfSignals;
      if (etfDataMapLocal && etfConfig) {
        etfCfgT = { ...etfConfig, breadthMax: T };
        etfSigT = precomputeUSEtfSignals(etfDataMapLocal, precomputed.dailyBreadth, etfCfgT);
      }
      let bbCfgT = buybackConfig;
      let bbSigT = buybackSignals;
      if (buybackEventMapLocal && buybackConfig) {
        bbCfgT = { ...buybackConfig, breadthMax: T };
        bbSigT = precomputeBuybackSignals(buybackEventMapLocal, allData, precomputed.dateIndexMap, precomputed.dailyBreadth, bbCfgT);
      }

      const result = runCombinedSimulation(
        {
          ...ctx,
          guConfig: guCfgNoFilter,
          pscConfig: pscCfgNoFilter,
          gapupSignals: guSigOpen,
          pscSignals: pSigOpen,
          breadthMode: mode,
          etfConfig: etfCfgT,
          etfSignals: etfSigT,
          buybackConfig: bbCfgT,
          buybackSignals: bbSigT,
        },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      const label = `${(T * 100).toFixed(0)}%${Math.abs(T - MARKET_BREADTH.THRESHOLD) < 1e-6 ? "★" : ""}`;
      console.log(
        `${label.padEnd(10)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      rows.push({ T, total: m, gu: result.guMetrics, psc: result.pscMetrics, etf: result.etfMetrics, buyback: result.buybackMetrics });
    }

    // 戦略別内訳（Trades / PF / NetPnL）
    console.log("\n=== 戦略別内訳（GU / PSC / ETF / buyback） ===");
    console.log(
      `${"T".padEnd(6)}| ${"GU Trd".padStart(6)} ${"GU PF".padStart(6)} | ${"PSC Trd".padStart(7)} ${"PSC PF".padStart(6)} | ${"ETF Trd".padStart(7)} ${"ETF PF".padStart(6)} | ${"BB Trd".padStart(6)} ${"BB PF".padStart(6)}`,
    );
    console.log("-".repeat(92));
    const pf = (x: PerformanceMetrics) => (x.profitFactor === Infinity ? "∞" : x.profitFactor.toFixed(2));
    for (const r of rows) {
      const label = `${(r.T * 100).toFixed(0)}%${Math.abs(r.T - MARKET_BREADTH.THRESHOLD) < 1e-6 ? "★" : ""}`;
      console.log(
        `${label.padEnd(6)}| ${String(r.gu.totalTrades).padStart(6)} ${pf(r.gu).padStart(6)} | ${String(r.psc.totalTrades).padStart(7)} ${pf(r.psc).padStart(6)} | ${String(r.etf.totalTrades).padStart(7)} ${pf(r.etf).padStart(6)} | ${String(r.buyback.totalTrades).padStart(6)} ${pf(r.buyback).padStart(6)}`,
      );
    }
    console.log("\n★ = 現行本番値 (54%)");

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // ポジション比較モード
  if (comparePositions) {
    const grid = [
      { maxPos: 2, label: "2枠" },
      { maxPos: 3, label: "3枠（現状）" },
      { maxPos: 5, label: "5枠" },
      { maxPos: 10, label: "10枠" },
    ];

    console.log("\n=== ポジション枠比較（全戦略合計） ===");
    console.log(
      `${"枠数".padEnd(14)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(78));

    for (const row of grid) {
      const limits: PositionLimits = { boMax: 0, guMax: row.maxPos, pscMax: row.maxPos };
      const result = runCombinedSimulation(ctx, limits);
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      console.log(
        `${row.label.padEnd(14)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 戦略別ポジション分離比較モード
  if (compareSplitPositions) {
    const grid: { label: string; limits: PositionLimits }[] = [
      { label: "GU3+PSC2（現状）",     limits: { boMax: 0, guMax: 3, pscMax: 2 } },
      { label: "GU3+PSC3",            limits: { boMax: 0, guMax: 3, pscMax: 3 } },
      { label: "GU5+PSC3",            limits: { boMax: 0, guMax: 5, pscMax: 3 } },
      { label: "GU5+PSC5",            limits: { boMax: 0, guMax: 5, pscMax: 5 } },
    ];

    console.log("\n=== 戦略別ポジション分離比較 ===");
    console.log(
      `${"パターン".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(92));

    for (const row of grid) {
      const result = runCombinedSimulation(ctx, row.limits);
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const gm = result.guMetrics;
      const pm = result.pscMetrics;
      console.log(
        `${row.label.padEnd(24)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      console.log(
        `${"  GU".padEnd(24)}| ${String(gm.totalTrades).padStart(6)} | ${gm.winRate.toFixed(1).padStart(6)}% | ${(gm.profitFactor === Infinity ? "∞" : gm.profitFactor.toFixed(2)).padStart(5)} | ${((gm.expectancy >= 0 ? "+" : "") + gm.expectancy.toFixed(2) + "%").padStart(8)}`,
      );
      console.log(
        `${"  PSC".padEnd(24)}| ${String(pm.totalTrades).padStart(6)} | ${pm.winRate.toFixed(1).padStart(6)}% | ${(pm.profitFactor === Infinity ? "∞" : pm.profitFactor.toFixed(2)).padStart(5)} | ${((pm.expectancy >= 0 ? "+" : "") + pm.expectancy.toFixed(2) + "%").padStart(8)}`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // エクイティカーブフィルター比較モード
  if (compareEquityFilter) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    const grid = [0, 10, 20, 40, 60];

    console.log("\n=== エクイティカーブフィルター比較（全戦略に適用） ===");
    console.log(`期間: ${startDate} → ${endDate}`);
    console.log(
      `${"SMA期間".padEnd(10)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"ハルト日".padStart(7)}`,
    );
    console.log("-".repeat(96));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const sma of grid) {
      const result = runCombinedSimulation(
        { ...ctx, equityCurveSmaPeriod: sma },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      const label = sma === 0 ? "なし" : `SMA${sma}`;
      console.log(
        `${label.padEnd(10)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${String(result.haltDays).padStart(7)}`,
      );
      overallResults.push({ label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳（A期DD縮小 vs D期NetRet低下のトレードオフ確認）
    console.log("\n=== レジーム別トレード指標 (entryDateで分割) ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"SMA期間".padEnd(10)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(10)}`,
      );
      console.log("  " + "-".repeat(62));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(10)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(10)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // セクター分散上限比較モード
  if (compareSector) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    const grid: { label: string; limit: number | undefined }[] = [
      { label: "制限なし (現状)", limit: undefined },
      { label: "3件/セクター", limit: 3 },
      { label: "2件/セクター", limit: 2 },
      { label: "1件/セクター", limit: 1 },
    ];

    console.log("\n=== セクター分散上限比較 ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      `${"上限".padEnd(18)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(96));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const limits: PositionLimits = {
        ...defaultLimits,
        ...(row.limit !== undefined ? { maxPerSector: row.limit } : { maxPerSector: undefined }),
      };
      const result = runCombinedSimulation(ctx, limits);
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(18)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳
    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"上限".padEnd(18)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(10)}`,
      );
      console.log("  " + "-".repeat(68));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(18)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(10)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // セクター・ローテーション比較モード
  if (compareSectorRotation) {
    const { precomputeSectorMomentum } = await import("./sector-rotation");
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    if (!tickerSectorMap) {
      console.error("tickerSectorMap が必要です");
      await prisma.$disconnect();
      return;
    }

    console.log("\n=== セクター・モメンタム precompute (lookback=20日) ===");
    const momentumMap = precomputeSectorMomentum(allData, tickerSectorMap, 20);
    console.log(`  ${momentumMap.size}営業日分のセクター momentum を計算`);

    const grid: { label: string; topPct: number | undefined }[] = [
      { label: "なし (現状)", topPct: undefined },
      { label: "Top 50% (16/33)", topPct: 0.5 },
      { label: "Top 30% (10/33)", topPct: 0.3 },
      { label: "Top 20% (7/33)", topPct: 0.2 },
      { label: "Top 10% (4/33)", topPct: 0.1 },
    ];

    console.log("\n=== セクター・ローテーション比較 ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      `${"設定".padEnd(20)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(100));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const ctxRow = row.topPct != null
        ? { ...ctx, sectorRotation: { momentumMap, topPct: row.topPct } }
        : ctx;
      const result = runCombinedSimulation(ctxRow, defaultLimits);
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(20)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"設定".padEnd(20)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(10)}`,
      );
      console.log("  " + "-".repeat(72));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(20)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(10)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // breadth × sector rotation トレードオフ比較
  if (compareBreadthSectorTradeoff) {
    const { precomputeSectorMomentum } = await import("./sector-rotation");
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    if (!tickerSectorMap) {
      console.error("tickerSectorMap が必要です");
      await prisma.$disconnect();
      return;
    }

    console.log("\n=== セクター・モメンタム precompute (lookback=20日) ===");
    const momentumMap = precomputeSectorMomentum(allData, tickerSectorMap, 20);
    console.log(`  ${momentumMap.size}営業日分`);

    type BreadthMode = { type: "band"; lower: number; upper: number } | { type: "none" };
    const grid: { label: string; breadth: BreadthMode; rotTopPct: number | undefined }[] = [
      { label: "現状 (54-80%, no-rot)", breadth: { type: "band", lower: 0.54, upper: 0.80 }, rotTopPct: undefined },
      { label: "54-80% + Top50%", breadth: { type: "band", lower: 0.54, upper: 0.80 }, rotTopPct: 0.5 },
      { label: "50-80% + Top50%", breadth: { type: "band", lower: 0.50, upper: 0.80 }, rotTopPct: 0.5 },
      { label: "40-80% + Top50%", breadth: { type: "band", lower: 0.40, upper: 0.80 }, rotTopPct: 0.5 },
      { label: "40-80% + Top30%", breadth: { type: "band", lower: 0.40, upper: 0.80 }, rotTopPct: 0.3 },
      { label: "30-80% + Top30%", breadth: { type: "band", lower: 0.30, upper: 0.80 }, rotTopPct: 0.3 },
      { label: "30-80% + Top20%", breadth: { type: "band", lower: 0.30, upper: 0.80 }, rotTopPct: 0.2 },
      { label: "no-filter + Top20%", breadth: { type: "none" }, rotTopPct: 0.2 },
      { label: "no-filter + Top10%", breadth: { type: "none" }, rotTopPct: 0.1 },
    ];

    // 比較時は precompute 側の breadthフィルターを切る
    const guCfgNoFilter: GapUpBacktestConfig = { ...guConfig, marketTrendFilter: false };
    const pscCfgNoFilter: PostSurgeConsolidationBacktestConfig = { ...pscConfig, marketTrendFilter: false };
    const guSigOpen = precomputeGapUpDailySignals(guCfgNoFilter, allData, precomputed);
    const pSigOpen = precomputePSCDailySignals(pscCfgNoFilter, allData, precomputed);

    console.log("\n=== breadth × sector rotation トレードオフ比較 ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      `${"設定".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(104));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const breadthMode = row.breadth.type === "band" ? { type: "band" as const, lower: row.breadth.lower, upper: row.breadth.upper } : undefined;
      const ctxRow: typeof ctx = {
        ...ctx,
        guConfig: guCfgNoFilter, pscConfig: pscCfgNoFilter,
        gapupSignals: guSigOpen, pscSignals: pSigOpen,
        breadthMode,
        ...(row.rotTopPct != null ? { sectorRotation: { momentumMap, topPct: row.rotTopPct } } : {}),
      };
      const result = runCombinedSimulation(ctxRow, defaultLimits);
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(24)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"設定".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(10)}`,
      );
      console.log("  " + "-".repeat(76));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(24)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(10)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 条件付き sector rotation 比較（breadth 帯ごとに発動条件を変える）
  // 既存 GU/PSC を維持しつつ、breadth が緩めた帯にいる時のみ sector filter で品質補完
  if (compareConditionalRotation) {
    const { precomputeSectorMomentum } = await import("./sector-rotation");
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    if (!tickerSectorMap) {
      console.error("tickerSectorMap が必要です");
      await prisma.$disconnect();
      return;
    }

    console.log("\n=== セクター・モメンタム precompute (lookback=20日) ===");
    const momentumMap = precomputeSectorMomentum(allData, tickerSectorMap, 20);
    console.log(`  ${momentumMap.size}営業日分`);

    type Pattern = {
      label: string;
      breadthLower: number;
      breadthUpper: number;
      rotTopPct?: number;
      condBelow?: number;
    };
    // 各パターンは「breadth filter 範囲」+「条件付き sector rotation の発動条件」
    const grid: Pattern[] = [
      { label: "現状 (54-80%, no-rot)", breadthLower: 0.54, breadthUpper: 0.80 },
      // breadth filter を緩めるだけ (sector rotation なし) — 控群
      { label: "40-80%, no-rot", breadthLower: 0.40, breadthUpper: 0.80 },
      // 条件付き発動: breadth < 54% の時のみ Top X% sector
      { label: "40-80% +cond<54% Top50%", breadthLower: 0.40, breadthUpper: 0.80, rotTopPct: 0.5, condBelow: 0.54 },
      { label: "40-80% +cond<54% Top30%", breadthLower: 0.40, breadthUpper: 0.80, rotTopPct: 0.3, condBelow: 0.54 },
      { label: "40-80% +cond<54% Top20%", breadthLower: 0.40, breadthUpper: 0.80, rotTopPct: 0.2, condBelow: 0.54 },
      { label: "30-80% +cond<54% Top30%", breadthLower: 0.30, breadthUpper: 0.80, rotTopPct: 0.3, condBelow: 0.54 },
      { label: "30-80% +cond<54% Top20%", breadthLower: 0.30, breadthUpper: 0.80, rotTopPct: 0.2, condBelow: 0.54 },
    ];

    // breadthMode=band 系を有効化するために precompute 側 filter は off にする
    const guCfgNoFilter: GapUpBacktestConfig = { ...guConfig, marketTrendFilter: false };
    const pscCfgNoFilter: PostSurgeConsolidationBacktestConfig = { ...pscConfig, marketTrendFilter: false };
    const guSigOpen = precomputeGapUpDailySignals(guCfgNoFilter, allData, precomputed);
    const pSigOpen = precomputePSCDailySignals(pscCfgNoFilter, allData, precomputed);

    console.log("\n=== 条件付き sector rotation 比較 ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(`仕様: breadth 帯ごとに sector filter 発動。breadth >= condBelow ではフィルターなし`);
    console.log(
      `${"設定".padEnd(28)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(108));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const breadthMode = { type: "band" as const, lower: row.breadthLower, upper: row.breadthUpper };
      const ctxRow: typeof ctx = {
        ...ctx,
        guConfig: guCfgNoFilter, pscConfig: pscCfgNoFilter,
        gapupSignals: guSigOpen, pscSignals: pSigOpen,
        breadthMode,
        ...(row.rotTopPct != null
          ? { sectorRotation: { momentumMap, topPct: row.rotTopPct, applyOnlyWhenBreadthBelow: row.condBelow } }
          : {}),
      };
      const result = runCombinedSimulation(ctxRow, defaultLimits);
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(28)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"設定".padEnd(28)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(10)}`,
      );
      console.log("  " + "-".repeat(80));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(28)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(10)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // セクター内リーダー戦略比較（各セクター内の N日 return 上位 N銘柄のみ通過）
  if (compareSectorLeaders) {
    const { precomputeSectorLeaders } = await import("./sector-rotation");
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    if (!tickerSectorMap) {
      console.error("tickerSectorMap が必要です");
      await prisma.$disconnect();
      return;
    }

    type Setting = { label: string; topPerSector?: number; lookback: number };
    const grid: Setting[] = [
      { label: "現状 (no-leader)", lookback: 20 }, // topPerSector 省略 = filter なし
      { label: "leader top1, 5d", topPerSector: 1, lookback: 5 },
      { label: "leader top1, 20d", topPerSector: 1, lookback: 20 },
      { label: "leader top2, 5d", topPerSector: 2, lookback: 5 },
      { label: "leader top2, 20d", topPerSector: 2, lookback: 20 },
      { label: "leader top3, 20d", topPerSector: 3, lookback: 20 },
    ];

    console.log("\n=== セクター内リーダー precompute ===");
    // 各設定について leaderSet を計算（topPerSector 設定があるもののみ）
    const leaderSets = new Map<string, Map<string, Set<string>>>();
    for (const s of grid) {
      if (s.topPerSector == null) continue;
      const key = `${s.topPerSector}_${s.lookback}`;
      if (leaderSets.has(key)) continue;
      const ls = precomputeSectorLeaders(allData, tickerSectorMap, s.lookback, s.topPerSector);
      leaderSets.set(key, ls);
      console.log(`  ${key}: ${ls.size}日分の leaderSet`);
    }

    console.log("\n=== セクター内リーダー戦略比較 ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      `${"設定".padEnd(22)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(102));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const s of grid) {
      const key = s.topPerSector != null ? `${s.topPerSector}_${s.lookback}` : null;
      const leaderSet = key ? leaderSets.get(key) : undefined;
      const ctxRow = leaderSet
        ? { ...ctx, sectorRotation: { momentumMap: new Map(), topPct: 1.0, leaderSet } }
        : ctx;
      const result = runCombinedSimulation(ctxRow, defaultLimits);
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${s.label.padEnd(22)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: s.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"設定".padEnd(22)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(10)}`,
      );
      console.log("  " + "-".repeat(76));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(22)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(10)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // VIXレジーム別リスク%比較モード
  if (compareVixRisk) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    type RegimeScaleSpec = { label: string; scale: Partial<Record<import("./types").RegimeLevel, number>> | undefined };
    const grid: RegimeScaleSpec[] = [
      { label: "規定(0.5/0.25)", scale: undefined },
      { label: "旧規定(0.5/1.0)", scale: { elevated: 0.5, high: 1.0 } },
      { label: "厳格(0.25/0.125)", scale: { elevated: 0.25, high: 0.125 } },
      { label: "緩和(0.75/0.5)", scale: { elevated: 0.75, high: 0.5 } },
      { label: "一定(0.5/0.5)", scale: { elevated: 0.5, high: 0.5 } },
    ];

    console.log("\n=== VIXレジーム別リスク%比較 ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      `${"パターン".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(102));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const result = runCombinedSimulation(
        { ...ctx, riskScaleByRegime: row.scale },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(24)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳
    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"パターン".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(12)}`,
      );
      console.log("  " + "-".repeat(76));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(24)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(12)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 連敗スロットル比較モード
  if (compareStreak) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    type StreakSpec = {
      label: string;
      cfg: { window: number; threshold: number; scale: number; minSample: number } | undefined;
    };
    const grid: StreakSpec[] = [
      { label: "OFF (現状)", cfg: undefined },
      { label: "w20 t40% s0.5", cfg: { window: 20, threshold: 0.40, scale: 0.5, minSample: 10 } },
      { label: "w30 t40% s0.5", cfg: { window: 30, threshold: 0.40, scale: 0.5, minSample: 10 } },
      { label: "w20 t40% s0.25", cfg: { window: 20, threshold: 0.40, scale: 0.25, minSample: 10 } },
      { label: "w20 t45% s0.5", cfg: { window: 20, threshold: 0.45, scale: 0.5, minSample: 10 } },
      { label: "w20 t35% s0.5", cfg: { window: 20, threshold: 0.35, scale: 0.5, minSample: 10 } },
    ];

    console.log("\n=== 連敗スロットル比較 (直近N件の全戦略WinRate<閾値でサイズ縮小) ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      `${"設定".padEnd(20)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(98));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const result = runCombinedSimulation(
        { ...ctx, loseStreakScaling: row.cfg },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(20)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳
    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"設定".padEnd(20)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(12)}`,
      );
      console.log("  " + "-".repeat(72));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(20)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(12)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // cooldownDays 比較モード (GU + PSC 同値で振る)
  if (compareCooldown) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    const grid: { label: string; days: number }[] = [
      { label: "0日 (クールダウン無し)", days: 0 },
      { label: "3日 (現状)", days: 3 },
      { label: "5日", days: 5 },
      { label: "10日", days: 10 },
      { label: "20日 (月1回まで)", days: 20 },
    ];

    console.log("\n=== cooldownDays 比較 (GU + PSC 同値) ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      `${"設定".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(102));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const gc: GapUpBacktestConfig = { ...guConfig, cooldownDays: row.days };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, cooldownDays: row.days };
      const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
      const pSig = precomputePSCDailySignals(pc, allData, precomputed);
      const result = runCombinedSimulation(
        { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(24)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳
    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"設定".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(12)}`,
      );
      console.log("  " + "-".repeat(76));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(24)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(12)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // --compare-be: BE発動倍率 × 建値フロアmode のスイープ（GU+PSC 共通）。
  // be/floor は exit のみに影響しシグナルは不変なので precompute は1回で使い回す。
  if (compareBe) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    type BeFloor = "entry" | "entry_plus_cost" | "none";
    const grid: { label: string; be: number | null; floor: BeFloor | undefined }[] = [
      { label: "be=0.1 / floor=entry", be: 0.1, floor: "entry" },
      { label: "be=0.2 / floor=entry", be: 0.2, floor: "entry" },
      { label: "baseline (be=0.3/floor=entry)", be: null, floor: undefined },
      { label: "be=0.5 / floor=entry", be: 0.5, floor: "entry" },
      { label: "be=0.8 / floor=entry", be: 0.8, floor: "entry" },
      { label: "be=1.2 / floor=entry", be: 1.2, floor: "entry" },
      { label: "be既定 / floor=none", be: null, floor: "none" },
      { label: "be既定 / floor=+cost", be: null, floor: "entry_plus_cost" },
    ];

    console.log("\n=== BE発動倍率 × 建値フロア 比較 (GU + PSC 共通) ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      `${"設定".padEnd(28)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(106));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const guSig = precomputeGapUpDailySignals(guConfig, allData, precomputed);
    const pSig = precomputePSCDailySignals(pscConfig, allData, precomputed);
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const gc: GapUpBacktestConfig =
        row.be != null ? { ...guConfig, beActivationMultiplier: row.be } : { ...guConfig };
      const pc: PostSurgeConsolidationBacktestConfig =
        row.be != null ? { ...pscConfig, beActivationMultiplier: row.be } : { ...pscConfig };
      const result = runCombinedSimulation(
        {
          ...ctx,
          guConfig: gc,
          pscConfig: pc,
          gapupSignals: guSig,
          pscSignals: pSig,
          breakEvenFloor: row.floor,
        },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(28)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳
    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"設定".padEnd(28)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(12)}`,
      );
      console.log("  " + "-".repeat(80));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(28)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(12)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // --compare-detection-granularity: BE/トレール発動の「検知粒度」を上限(日中高値=無限頻度)と
  // 下限(終値のみ=1回/日)で挟み、position-monitor の頻度アップで得られる価値の最大幅を測る。
  // high と close の Calmar 差が「頻度をいくら上げても超えられない価値の天井」。
  // 差が小さければ頻度アップは無意味、大きければ現状5回/日が取りこぼしている。
  if (compareDetectionGranularity) {
    const grid: { label: string; source: "high" | "openclose" | "close" }[] = [
      { label: "high 検知 (日中高値=無限頻度・上限=現BT)", source: "high" },
      { label: "openclose 検知 (始値+終値=2回/日相当・中間)", source: "openclose" },
      { label: "close 検知 (終値のみ=1回/日・下限)", source: "close" },
    ];

    console.log("\n=== BE/トレール検知粒度 比較（頻度の価値幅ブラケット） ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      "上限=high(完璧検知) と 下限=close(1回/日) の差が、position-monitor 頻度アップで得られる価値の最大幅",
    );
    console.log(
      `${"設定".padEnd(40)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)}`,
    );
    console.log("-".repeat(110));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const rows: {
      label: string;
      trades: SimulatedPosition[];
      calmar: number;
      maxDD: number;
      netRet: number;
    }[] = [];

    for (const row of grid) {
      const result = runCombinedSimulation(
        { ...ctx, beTrailDetectionSource: row.source },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(40)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)}`,
      );
      rows.push({ label: row.label, trades: result.allTrades, calmar, maxDD: m.maxDrawdown, netRet: m.netReturnPct });
    }

    // 出口理由の内訳（あなたの仮説の核心: high検知だと負け(stop_loss)が建値/トレール撤退に置き換わるはず）
    console.log("\n=== 出口理由の内訳（件数 / 平均pnl% / 合計netPnl） ===");
    const REASONS: SimulatedPosition["exitReason"][] = [
      "stop_loss",
      "trailing_profit",
      "take_profit",
      "time_stop",
    ];
    for (const r of rows) {
      console.log(`\n[${r.label}]`);
      const losers = r.trades.filter((t) => (t.netPnl ?? 0) < 0);
      const totalLoss = losers.reduce((s, t) => s + (t.netPnl ?? 0), 0);
      console.log(
        `  負けトレード: ${losers.length}件 / 合計 ¥${totalLoss.toLocaleString()}`,
      );
      for (const reason of REASONS) {
        const sub = r.trades.filter((t) => t.exitReason === reason);
        if (sub.length === 0) continue;
        const avgPct =
          sub.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / sub.length;
        const sumPnl = sub.reduce((s, t) => s + (t.netPnl ?? 0), 0);
        console.log(
          `  ${String(reason).padEnd(16)}: ${String(sub.length).padStart(4)}件 | 平均 ${(avgPct >= 0 ? "+" : "") + avgPct.toFixed(2)}% | 合計 ¥${sumPnl.toLocaleString()}`,
        );
      }
    }

    // 差分サマリー（頻度の価値幅）
    if (rows.length >= 2) {
      const hi = rows[0];
      const lo = rows[rows.length - 1];
      console.log("\n=== 頻度の価値幅（上限high − 下限close） ===");
      console.log(
        `  Calmar: ${lo.calmar.toFixed(2)} → ${hi.calmar.toFixed(2)}  (幅 ${(hi.calmar - lo.calmar >= 0 ? "+" : "") + (hi.calmar - lo.calmar).toFixed(2)})`,
      );
      console.log(
        `  MaxDD : ${lo.maxDD.toFixed(1)}% → ${hi.maxDD.toFixed(1)}%  (幅 ${(hi.maxDD - lo.maxDD >= 0 ? "+" : "") + (hi.maxDD - lo.maxDD).toFixed(1)}pp)`,
      );
      console.log(
        `  NetRet: ${lo.netRet.toFixed(1)}% → ${hi.netRet.toFixed(1)}%  (幅 ${(hi.netRet - lo.netRet >= 0 ? "+" : "") + (hi.netRet - lo.netRet).toFixed(1)}pp)`,
      );
      console.log(
        "  → この幅が『頻度をいくら上げても超えられない価値の天井』。実際の5回/日はこの間のどこか。",
      );
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // --compare-daily-entries: GU/PSC の「1日の最大エントリー数」を比較（本番 slice(0,1)=1件 vs BT既定の枠まで複数）
  if (compareDailyEntries) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    const grid: { label: string; gu?: number; psc?: number }[] = [
      { label: "複数 (BT既定/枠まで)", gu: undefined, psc: undefined },
      { label: "GU=1/PSC=1 (本番現状)", gu: 1, psc: 1 },
      { label: "GU=2/PSC=2", gu: 2, psc: 2 },
      { label: "GU=1/PSC=複数", gu: 1, psc: undefined },
      { label: "GU=複数/PSC=1", gu: undefined, psc: 1 },
    ];

    console.log("\n=== 1日あたり最大エントリー数 比較 (GU/PSC) ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      `${"設定".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(102));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const result = runCombinedSimulation(
        { ...ctx, guMaxDailyEntries: row.gu, pscMaxDailyEntries: row.psc },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(24)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳
    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"設定".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(12)}`,
      );
      console.log("  " + "-".repeat(76));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(24)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(12)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // --compare-nikkei-drop: 日経キルスイッチ（当日 ≤ -N% で全戦略エントリー停止）の効果を検証
  if (compareNikkeiDrop) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    // veto 閾値を振る。null = キルスイッチ無効（現状ベースライン）
    const grid: { label: string; threshold: number | null }[] = [
      { label: "OFF (現状)", threshold: null },
      { label: "当日 ≤ -2%", threshold: -2 },
      { label: "当日 ≤ -3%", threshold: -3 },
      { label: "当日 ≤ -4%", threshold: -4 },
      { label: "当日 ≤ -5%", threshold: -5 },
    ];

    console.log("\n=== 日経キルスイッチ（当日下落 veto）比較 ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}, N225 ${indexData.size}日`);
    console.log(
      `${"設定".padEnd(16)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(94));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const result = runCombinedSimulation(
        { ...ctx, nikkeiDropVetoPct: row.threshold ?? undefined },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(16)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳
    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"設定".padEnd(16)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(12)}`,
      );
      console.log("  " + "-".repeat(68));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(16)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(12)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // --compare-psc-trail: PSC trailMultiplier の感応度を全期間+レジーム別で再検証
  if (comparePscTrail) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    // 現状の PSC: atr=0.8, be=0.3, trail=0.5
    // BE発動後のトレール幅のみを変化させる
    const grid: { label: string; trail: number }[] = [
      { label: "trail=0.3 (タイト)", trail: 0.3 },
      { label: "trail=0.5 (現状)", trail: 0.5 },
      { label: "trail=0.8 (ゆるめ)", trail: 0.8 },
      { label: "trail=1.0 (大幅ゆるめ)", trail: 1.0 },
      { label: "trail=1.5 (極ゆるめ)", trail: 1.5 },
    ];

    console.log("\n=== PSC trailMultiplier 感応度検証 ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(`他PSCパラメータは現状固定 (atr=${pscConfig.atrMultiplier}, be=${pscConfig.beActivationMultiplier})`);
    console.log(
      `${"設定".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(102));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; pscTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, trailMultiplier: row.trail };
      // trailMultiplier はシグナル発火に影響しないので signals は再計算不要
      const result = runCombinedSimulation(
        { ...ctx, pscConfig: pc },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(24)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, pscTrades: result.pscTrades, equityCurve: result.equityCurve });
    }

    // PSC 単独寄与
    console.log("\n=== PSC単独寄与 (in combined) ===");
    console.log(
      `${"設定".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(12)} | ${"AvgHold".padStart(7)}`,
    );
    console.log("-".repeat(86));
    for (const r of overallResults) {
      const sub = calculateMetrics(r.pscTrades, r.equityCurve, budget);
      const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
      const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
      const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
      console.log(
        `${r.label.padEnd(24)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(12)} | ${sub.avgHoldingDays.toFixed(1).padStart(6)}d`,
      );
    }

    // レジーム別内訳
    console.log("\n=== レジーム別トレード指標 (combined全体) ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"設定".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(12)}`,
      );
      console.log("  " + "-".repeat(76));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(24)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(12)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // --compare-gu-gapvol: GU gapMinPct × volSurgeRatio の感応度を全期間+レジーム別で再検証
  if (compareGuGapvol) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    // 現状: gap=0.03 (3%), vol=1.5
    const gapGrid = [0.025, 0.03, 0.04, 0.05];
    const volGrid = [1.3, 1.5, 1.8, 2.5];

    console.log("\n=== GU gapMinPct × volSurgeRatio 感応度検証 ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(`他GUパラメータは現状固定 (atr=${guConfig.atrMultiplier}, be=${guConfig.beActivationMultiplier}, trail=${guConfig.trailMultiplier})`);
    console.log(
      `${"設定".padEnd(28)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(106));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; gap: number; vol: number; allTrades: SimulatedPosition[]; guTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const gap of gapGrid) {
      for (const vol of volGrid) {
        const isCurrent = gap === 0.03 && vol === 1.5;
        const label = isCurrent
          ? `gap=${(gap * 100).toFixed(1)}% vol=${vol} (現状)`
          : `gap=${(gap * 100).toFixed(1)}% vol=${vol}`;
        const gc: GapUpBacktestConfig = { ...guConfig, gapMinPct: gap, volSurgeRatio: vol };
        // gap/vol はシグナル発火に影響するので signals を再計算
        const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
        const result = runCombinedSimulation(
          { ...ctx, guConfig: gc, gapupSignals: guSig },
          defaultLimits,
        );
        const m = result.totalMetrics;
        const util = calculateCapitalUtilization(result.equityCurve);
        const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
        const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
        const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
        const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
        console.log(
          `${label.padEnd(28)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
        );
        overallResults.push({ label, gap, vol, allTrades: result.allTrades, guTrades: result.guTrades, equityCurve: result.equityCurve });
      }
      console.log("  " + "-".repeat(102));
    }

    // GU 単独寄与
    console.log("\n=== GU単独寄与 (in combined) ===");
    console.log(
      `${"設定".padEnd(28)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(12)} | ${"AvgHold".padStart(7)}`,
    );
    console.log("-".repeat(90));
    for (const r of overallResults) {
      const sub = calculateMetrics(r.guTrades, r.equityCurve, budget);
      const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
      const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
      const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
      console.log(
        `${r.label.padEnd(28)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(12)} | ${sub.avgHoldingDays.toFixed(1).padStart(6)}d`,
      );
    }

    // Calmar 上位5件のサマリー
    console.log("\n=== Calmar 上位5件 ===");
    const sorted = [...overallResults]
      .map(r => {
        const m = calculateMetrics(r.allTrades, r.equityCurve, budget);
        const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
        const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
        return { ...r, calmar, m };
      })
      .sort((a, b) => b.calmar - a.calmar)
      .slice(0, 5);
    console.log(
      `${"順位".padStart(2)} | ${"設定".padEnd(28)}| ${"Calmar".padStart(6)} | ${"PF".padStart(5)} | ${"NetRet".padStart(7)} | ${"MaxDD".padStart(6)}`,
    );
    sorted.forEach((r, i) => {
      console.log(
        `${String(i + 1).padStart(2)} | ${r.label.padEnd(28)}| ${r.calmar.toFixed(2).padStart(6)} | ${r.m.profitFactor.toFixed(2).padStart(5)} | ${r.m.netReturnPct.toFixed(1).padStart(6)}% | ${r.m.maxDrawdown.toFixed(1).padStart(5)}%`,
      );
    });

    // レジーム別内訳（Calmar上位3件のみ + 現状）
    const regimeTargets = [
      ...sorted.slice(0, 3).map(r => r.label),
      ...overallResults.filter(r => r.gap === 0.03 && r.vol === 1.5 && !sorted.slice(0, 3).map(s => s.label).includes(r.label)).map(r => r.label),
    ];
    console.log("\n=== レジーム別 (Calmar上位3件 + 現状) ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"設定".padEnd(28)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(12)}`,
      );
      console.log("  " + "-".repeat(80));

      for (const target of regimeTargets) {
        const r = overallResults.find(x => x.label === target);
        if (!r) continue;
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(28)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(12)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // --wf-mini-gu-gapvol: GU gap=2.5%×vol=1.5 候補が WF OOS で現状を超えるか確認
  // 7窓 × 2パターン (現状 vs 候補) を OOS 期間 (3ヶ月) で比較
  if (wfMiniGuGapvol) {
    const IS_MONTHS = 6;
    const OOS_MONTHS = 3;
    const SLIDE_MONTHS = 3;
    const NUM_WINDOWS = 7;
    const TOTAL_MONTHS = IS_MONTHS + OOS_MONTHS + SLIDE_MONTHS * (NUM_WINDOWS - 1);

    const wfEndDate = dayjs().format("YYYY-MM-DD");
    const wfStartDate = dayjs(wfEndDate).subtract(TOTAL_MONTHS, "month").format("YYYY-MM-DD");

    console.log("\n=== WF mini: GU gap=2.5% vol=1.5 vs 現状(gap=3.0% vol=1.5) ===");
    console.log(`分析期間: ${wfStartDate} → ${wfEndDate} (${TOTAL_MONTHS}ヶ月)`);
    console.log(`OOS: ${OOS_MONTHS}ヶ月 / スライド: ${SLIDE_MONTHS}ヶ月 / ウィンドウ: ${NUM_WINDOWS}`);
    console.log("");

    const settings = [
      { label: "現状", gap: 0.03, vol: 1.5 },
      { label: "候補", gap: 0.025, vol: 1.5 },
    ];

    interface MiniWindowResult {
      windowIdx: number;
      oosStart: string;
      oosEnd: string;
      results: Map<string, { trades: number; pf: number; netRet: number; maxDD: number; calmar: number; netPnl: number }>;
    }

    const miniResults: MiniWindowResult[] = [];

    for (let w = 0; w < NUM_WINDOWS; w++) {
      const isStart = dayjs(wfStartDate).add(w * SLIDE_MONTHS, "month").format("YYYY-MM-DD");
      const isEnd = dayjs(isStart).add(IS_MONTHS, "month").subtract(1, "day").format("YYYY-MM-DD");
      const oosStart = dayjs(isEnd).add(1, "day").format("YYYY-MM-DD");
      const oosEnd = dayjs(oosStart).add(OOS_MONTHS, "month").subtract(1, "day").format("YYYY-MM-DD");

      console.log(`━━━ Window ${w + 1}/${NUM_WINDOWS} OOS: ${oosStart} → ${oosEnd} ━━━`);

      const oosPrecomputed = precomputeSimData(
        oosStart, oosEnd, allData,
        true, true,
        guConfig.indexTrendSmaPeriod ?? 50,
        indexData.size > 0 ? indexData : undefined,
        false, 60,
        guConfig.indexTrendOffBufferPct ?? 0,
        guConfig.indexTrendOnBufferPct ?? 0,
      );

      const winResults = new Map<string, { trades: number; pf: number; netRet: number; maxDD: number; calmar: number; netPnl: number }>();

      for (const setting of settings) {
        const gc: GapUpBacktestConfig = {
          ...guConfig,
          startDate: oosStart, endDate: oosEnd,
          gapMinPct: setting.gap,
          volSurgeRatio: setting.vol,
        };
        const pc: PostSurgeConsolidationBacktestConfig = {
          ...pscConfig,
          startDate: oosStart, endDate: oosEnd,
        };

        const guSig = precomputeGapUpDailySignals(gc, allData, oosPrecomputed);
        const pSig = precomputePSCDailySignals(pc, allData, oosPrecomputed);

        const result = runCombinedSimulation(
          { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig, precomputed: oosPrecomputed },
          defaultLimits,
        );

        const m = result.totalMetrics;
        const years = dayjs(oosEnd).diff(dayjs(oosStart), "day") / 365;
        const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
        const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;

        winResults.set(setting.label, {
          trades: m.totalTrades,
          pf: m.profitFactor,
          netRet: m.netReturnPct,
          maxDD: m.maxDrawdown,
          calmar,
          netPnl: m.totalNetPnl,
        });

        const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
        console.log(
          `  [${setting.label.padEnd(2)}] gap=${(setting.gap * 100).toFixed(1)}% vol=${setting.vol} | tr=${String(m.totalTrades).padStart(3)} | PF=${pfStr.padStart(5)} | NetRet=${m.netReturnPct.toFixed(1).padStart(6)}% | MaxDD=${m.maxDrawdown.toFixed(1).padStart(4)}% | Calmar=${calmar.toFixed(2).padStart(6)} | NetPnL=${(m.totalNetPnl >= 0 ? "+" : "") + "¥" + m.totalNetPnl.toLocaleString()}`,
        );
      }

      miniResults.push({ windowIdx: w, oosStart, oosEnd, results: winResults });
      console.log("");
    }

    // サマリー
    console.log("=".repeat(82));
    console.log("WF mini サマリー");
    console.log("=".repeat(82));
    console.log("");
    console.log("Window | OOS期間              | 現状Calmar | 候補Calmar |    差分 | 勝者");
    console.log("-".repeat(82));

    let candidateWins = 0;
    let currentWins = 0;
    let totalCurrentNetPnl = 0;
    let totalCandidateNetPnl = 0;

    for (const r of miniResults) {
      const cur = r.results.get("現状")!;
      const cand = r.results.get("候補")!;
      const diff = cand.calmar - cur.calmar;
      const winner = diff > 0 ? "候補 ✓" : diff < 0 ? "現状" : "tie";
      if (diff > 0) candidateWins++;
      else if (diff < 0) currentWins++;

      totalCurrentNetPnl += cur.netPnl;
      totalCandidateNetPnl += cand.netPnl;

      console.log(
        `  ${String(r.windowIdx + 1).padStart(2)}   | ${r.oosStart} → ${r.oosEnd} | ${cur.calmar.toFixed(2).padStart(9)} | ${cand.calmar.toFixed(2).padStart(9)} | ${(diff >= 0 ? "+" : "") + diff.toFixed(2).padStart(6)} | ${winner}`,
      );
    }

    console.log("");
    console.log(`勝率: 候補 ${candidateWins}/${NUM_WINDOWS} 窓、現状 ${currentWins}/${NUM_WINDOWS} 窓`);
    console.log(`累計NetPnL: 現状 ¥${totalCurrentNetPnl.toLocaleString()} / 候補 ¥${totalCandidateNetPnl.toLocaleString()}`);
    console.log(`差分: ${totalCandidateNetPnl >= totalCurrentNetPnl ? "+" : ""}¥${(totalCandidateNetPnl - totalCurrentNetPnl).toLocaleString()}`);
    console.log("");

    console.log("━".repeat(40));
    if (candidateWins >= 4) {
      console.log("判定: 候補が過半数で勝利 → 本番反映を検討");
    } else if (candidateWins === currentWins) {
      console.log("判定: 引き分け → 現状維持（変更しない理由）");
    } else {
      console.log("判定: 現状が過半数で勝利 → 候補は単発BTのノイズ、現状維持");
    }
    console.log("━".repeat(40));
    console.log("");

    await prisma.$disconnect();
    return;
  }

  // --wf-mini-sector-rotation: sector rotation Top 50% が WF OOS で現状を超えるか確認
  // 7窓 × 2パターン (現状 vs Top 50%) を OOS 期間 (3ヶ月) で比較
  if (wfMiniSectorRotation) {
    const { precomputeSectorMomentum } = await import("./sector-rotation");
    const IS_MONTHS = 6;
    const OOS_MONTHS = 3;
    const SLIDE_MONTHS = 3;
    const NUM_WINDOWS = 7;
    const TOTAL_MONTHS = IS_MONTHS + OOS_MONTHS + SLIDE_MONTHS * (NUM_WINDOWS - 1);

    const wfEndDate = dayjs().format("YYYY-MM-DD");
    const wfStartDate = dayjs(wfEndDate).subtract(TOTAL_MONTHS, "month").format("YYYY-MM-DD");

    if (!tickerSectorMap) {
      console.error("tickerSectorMap が必要です");
      await prisma.$disconnect();
      return;
    }

    console.log("\n=== WF mini: sector rotation Top 50% vs 現状(rotation なし) ===");
    console.log(`分析期間: ${wfStartDate} → ${wfEndDate} (${TOTAL_MONTHS}ヶ月)`);
    console.log(`OOS: ${OOS_MONTHS}ヶ月 / スライド: ${SLIDE_MONTHS}ヶ月 / ウィンドウ: ${NUM_WINDOWS}`);
    console.log("");

    console.log("セクター・モメンタム precompute (lookback=20日, 全期間)...");
    const momentumMap = precomputeSectorMomentum(allData, tickerSectorMap, 20);
    console.log(`  ${momentumMap.size}営業日分`);
    console.log("");

    const settings = [
      { label: "現状", topPct: undefined as number | undefined },
      { label: "候補", topPct: 0.5 },
    ];

    interface MiniWindowResult {
      windowIdx: number;
      oosStart: string;
      oosEnd: string;
      results: Map<string, { trades: number; pf: number; netRet: number; maxDD: number; calmar: number; netPnl: number }>;
    }

    const miniResults: MiniWindowResult[] = [];

    for (let w = 0; w < NUM_WINDOWS; w++) {
      const isStart = dayjs(wfStartDate).add(w * SLIDE_MONTHS, "month").format("YYYY-MM-DD");
      const isEnd = dayjs(isStart).add(IS_MONTHS, "month").subtract(1, "day").format("YYYY-MM-DD");
      const oosStart = dayjs(isEnd).add(1, "day").format("YYYY-MM-DD");
      const oosEnd = dayjs(oosStart).add(OOS_MONTHS, "month").subtract(1, "day").format("YYYY-MM-DD");

      console.log(`━━━ Window ${w + 1}/${NUM_WINDOWS} OOS: ${oosStart} → ${oosEnd} ━━━`);

      const oosPrecomputed = precomputeSimData(
        oosStart, oosEnd, allData,
        true, true,
        guConfig.indexTrendSmaPeriod ?? 50,
        indexData.size > 0 ? indexData : undefined,
        false, 60,
        guConfig.indexTrendOffBufferPct ?? 0,
        guConfig.indexTrendOnBufferPct ?? 0,
      );

      const winResults = new Map<string, { trades: number; pf: number; netRet: number; maxDD: number; calmar: number; netPnl: number }>();

      for (const setting of settings) {
        const gc: GapUpBacktestConfig = { ...guConfig, startDate: oosStart, endDate: oosEnd };
        const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, startDate: oosStart, endDate: oosEnd };
        const guSig = precomputeGapUpDailySignals(gc, allData, oosPrecomputed);
        const pSig = precomputePSCDailySignals(pc, allData, oosPrecomputed);

        const ctxForWindow = setting.topPct != null
          ? { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig, precomputed: oosPrecomputed, sectorRotation: { momentumMap, topPct: setting.topPct } }
          : { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig, precomputed: oosPrecomputed };

        const result = runCombinedSimulation(ctxForWindow, defaultLimits);
        const m = result.totalMetrics;
        const years = dayjs(oosEnd).diff(dayjs(oosStart), "day") / 365;
        const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
        const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;

        winResults.set(setting.label, {
          trades: m.totalTrades, pf: m.profitFactor, netRet: m.netReturnPct,
          maxDD: m.maxDrawdown, calmar, netPnl: m.totalNetPnl,
        });

        const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
        const topLabel = setting.topPct != null ? `top${(setting.topPct * 100).toFixed(0)}%` : "no-rot ";
        console.log(
          `  [${setting.label.padEnd(2)}] ${topLabel.padEnd(8)} | tr=${String(m.totalTrades).padStart(3)} | PF=${pfStr.padStart(5)} | NetRet=${m.netReturnPct.toFixed(1).padStart(6)}% | MaxDD=${m.maxDrawdown.toFixed(1).padStart(4)}% | Calmar=${calmar.toFixed(2).padStart(6)} | NetPnL=${(m.totalNetPnl >= 0 ? "+" : "") + "¥" + m.totalNetPnl.toLocaleString()}`,
        );
      }

      miniResults.push({ windowIdx: w, oosStart, oosEnd, results: winResults });
      console.log("");
    }

    console.log("=".repeat(82));
    console.log("WF mini サマリー (sector rotation Top 50%)");
    console.log("=".repeat(82));
    console.log("Window | OOS期間              | 現状Calmar | 候補Calmar |    差分 | 勝者");
    console.log("-".repeat(82));

    let candidateWins = 0;
    let currentWins = 0;
    let totalCurrentNetPnl = 0;
    let totalCandidateNetPnl = 0;

    for (const r of miniResults) {
      const cur = r.results.get("現状")!;
      const cand = r.results.get("候補")!;
      const diff = cand.calmar - cur.calmar;
      const winner = diff > 0 ? "候補 ✓" : diff < 0 ? "現状" : "tie";
      if (diff > 0) candidateWins++;
      else if (diff < 0) currentWins++;

      totalCurrentNetPnl += cur.netPnl;
      totalCandidateNetPnl += cand.netPnl;

      console.log(
        `  ${String(r.windowIdx + 1).padStart(2)}   | ${r.oosStart} → ${r.oosEnd} | ${cur.calmar.toFixed(2).padStart(9)} | ${cand.calmar.toFixed(2).padStart(9)} | ${(diff >= 0 ? "+" : "") + diff.toFixed(2).padStart(6)} | ${winner}`,
      );
    }

    console.log("");
    console.log(`勝率: 候補 ${candidateWins}/${NUM_WINDOWS} 窓、現状 ${currentWins}/${NUM_WINDOWS} 窓`);
    console.log(`累計NetPnL: 現状 ¥${totalCurrentNetPnl.toLocaleString()} / 候補 ¥${totalCandidateNetPnl.toLocaleString()}`);
    console.log(`差分: ${totalCandidateNetPnl >= totalCurrentNetPnl ? "+" : ""}¥${(totalCandidateNetPnl - totalCurrentNetPnl).toLocaleString()}`);
    console.log("");

    console.log("━".repeat(40));
    if (candidateWins >= 5) {
      console.log("判定: 候補が圧倒的勝利 → 本番反映を強く推奨");
    } else if (candidateWins >= 4) {
      console.log("判定: 候補が過半数で勝利 → 本番反映を検討");
    } else if (candidateWins === currentWins) {
      console.log("判定: 引き分け → 現状維持");
    } else {
      console.log("判定: 現状が過半数で勝利 → 候補は単発BTのノイズ、現状維持");
    }
    console.log("━".repeat(40));
    console.log("");

    await prisma.$disconnect();
    return;
  }

  // --compare-slippage: スリッページプロファイルの影響を定量化 (KOH-428 Phase B)
  if (compareSlippage) {
    const grid: { label: string; profile: "none" | "light" | "standard" | "heavy" }[] = [
      { label: "none (現状 BT)", profile: "none" },
      { label: "light (5/5/10bps)", profile: "light" },
      { label: "standard (10/10/20bps)", profile: "standard" },
      { label: "heavy (25/25/50bps)", profile: "heavy" },
    ];

    console.log("\n=== スリッページプロファイル比較 ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log("bps表記: entry_market / exit_market / exit_stop");
    console.log(
      `${"プロファイル".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)}`,
    );
    console.log("-".repeat(96));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;

    for (const row of grid) {
      const result = runCombinedSimulation(
        { ...ctx, slippageProfile: row.profile },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(24)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)}`,
      );
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 売買代金フィルター比較モード
  if (compareTurnover) {
    const turnoverGrid = [
      { label: "なし (0)", value: 0 },
      { label: "3000万円", value: 30_000_000 },
      { label: "5000万円 (現状)", value: 50_000_000 },
      { label: "1億円", value: 100_000_000 },
      { label: "2億円", value: 200_000_000 },
    ];

    console.log("\n=== 売買代金フィルター比較 ===");
    console.log(
      `${"売買代金下限".padEnd(18)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(84));

    for (const row of turnoverGrid) {
      const gc: GapUpBacktestConfig = { ...guConfig, minTurnover: row.value };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, minTurnover: row.value };
      const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
      const pSig = precomputePSCDailySignals(pc, allData, precomputed);
      const result = runCombinedSimulation(
        { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const utilResult = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      console.log(
        `${row.label.padEnd(18)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${utilResult.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 最低株価フィルター比較モード
  if (comparePrice) {
    const priceGrid = [
      { label: "なし (0)", value: 0 },
      { label: "100円", value: 100 },
      { label: "200円", value: 200 },
      { label: "300円 (現状)", value: 300 },
      { label: "500円", value: 500 },
      { label: "1000円", value: 1_000 },
    ];

    console.log("\n=== 最低株価フィルター比較 ===");
    console.log(
      `${"最低株価".padEnd(18)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(84));

    for (const row of priceGrid) {
      const gc: GapUpBacktestConfig = { ...guConfig, minPrice: row.value };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, minPrice: row.value };
      const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
      const pSig = precomputePSCDailySignals(pc, allData, precomputed);
      const result = runCombinedSimulation(
        { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const utilResult = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      console.log(
        `${row.label.padEnd(18)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${utilResult.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 最低株価 × 売買代金 組み合わせ比較モード
  if (comparePriceTurnover) {
    const priceRows = [
      { label: "0円", value: 0 },
      { label: "100円", value: 100 },
      { label: "300円(現状)", value: 300 },
    ];
    const turnoverCols = [
      { label: "5000万(現状)", value: 50_000_000 },
      { label: "1億円", value: 100_000_000 },
      { label: "2億円", value: 200_000_000 },
    ];

    console.log("\n=== 最低株価 × 売買代金 組み合わせ比較 ===");
    const header = `${"最低株価".padEnd(14)}` + turnoverCols.map((c) => ` | ${c.label.padStart(18)}`).join("");
    console.log(header);
    console.log("-".repeat(14 + turnoverCols.length * 21));

    for (const pr of priceRows) {
      const cols: string[] = [];
      for (const tr of turnoverCols) {
        const gc: GapUpBacktestConfig = { ...guConfig, minPrice: pr.value, minTurnover: tr.value };
        const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, minPrice: pr.value, minTurnover: tr.value };
        const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
        const pSig = precomputePSCDailySignals(pc, allData, precomputed);
        const result = runCombinedSimulation(
          { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig },
          defaultLimits,
        );
        const m = result.totalMetrics;
        const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
        const retStr = (m.netReturnPct >= 0 ? "+" : "") + m.netReturnPct.toFixed(1) + "%";
        cols.push(`PF${pfStr} Ret${retStr} (${m.totalTrades}件)`.padStart(18));
      }
      console.log(`${pr.label.padEnd(14)}` + cols.map((c) => ` | ${c}`).join(""));
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // GU/PSC 相関レポート
  if (corrReport) {
    const result = runCombinedSimulation(ctx, defaultLimits);
    printCorrelationReport(
      result.guTrades,
      result.pscTrades,
      startDate,
      endDate,
      precomputed.tradingDays,
      precomputed.dailyBreadth,
      precomputed.dailyIndexAboveSma,
      vixData,
    );
    await prisma.$disconnect();
    return;
  }

  // 通常実行
  const slotsParts = [`GU${defaultLimits.guMax}`, `PSC${defaultLimits.pscMax ?? 0}`];
  if (enableWbLargecap) slotsParts.push(`WB${defaultLimits.wbMax ?? 0}`);
  if (enableMomentum) slotsParts.push(`MOM${defaultLimits.momMax ?? 0}`);
  if (enableEtf) slotsParts.push(`ETF${defaultLimits.etfMax ?? 0}`);
  if (enableEtfDip) slotsParts.push(`ETFdip${defaultLimits.etfMax ?? 0}`);
  if (enablePanic) slotsParts.push(`PANIC${defaultLimits.etfMax ?? 0}`);
  if (enableBuyback) slotsParts.push(`BUYBACK${defaultLimits.buybackMax ?? 0}`);
  console.log(`ポジション枠: ${slotsParts.join(" + ")}`);
  const result = runCombinedSimulation(ctx, defaultLimits);

  // --dump-equity <path>: 日次エクイティカーブ + breadth + N225 を JSON 出力（グラフ用）
  const dumpEquityPath = getArg(args, "--dump-equity");
  if (dumpEquityPath) {
    const rows = result.equityCurve.map((e) => ({
      date: e.date,
      totalEquity: Math.round(e.totalEquity),
      openPositionCount: e.openPositionCount,
      breadth: precomputed.dailyBreadth.get(e.date) ?? null,
      n225: indexData.get(e.date) ?? null,
    }));
    fs.writeFileSync(
      dumpEquityPath,
      JSON.stringify(
        { startDate, endDate, budget, totalCapitalAdded: result.totalCapitalAdded, rows },
        null,
        2,
      ),
    );
    console.log(`\n📈 エクイティカーブを出力: ${dumpEquityPath} (${rows.length}日)`);
  }

  // --dump-trades <path>: 全トレード明細を戦略ラベル付きで JSON 出力（要因分析用）
  const dumpTradesPath = getArg(args, "--dump-trades");
  if (dumpTradesPath) {
    const label = (t: SimulatedPosition, s: string) => ({
      strategy: s,
      ticker: t.ticker,
      entryDate: t.entryDate,
      exitDate: t.exitDate,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      quantity: t.quantity,
      exitReason: t.exitReason,
      pnl: t.pnl == null ? null : Math.round(t.pnl),
      pnlPct: t.pnlPct,
      holdingDays: t.holdingDays,
    });
    const rows = [
      ...result.guTrades.map((t) => label(t, "GU")),
      ...result.pscTrades.map((t) => label(t, "PSC")),
      ...result.boTrades.map((t) => label(t, "BO")),
      ...result.wbTrades.map((t) => label(t, "WB")),
      ...result.momTrades.map((t) => label(t, "MOM")),
      ...result.etfTrades.map((t) => label(t, "ETF")),
      ...result.buybackTrades.map((t) => label(t, "BUYBACK")),
    ].sort((a, b) => (a.exitDate ?? "9999").localeCompare(b.exitDate ?? "9999"));
    fs.writeFileSync(dumpTradesPath, JSON.stringify({ startDate, endDate, budget, rows }, null, 2));
    console.log(`📋 トレード明細を出力: ${dumpTradesPath} (${rows.length}件)`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("統合バックテスト結果");
  console.log("=".repeat(60));

  printMetrics(result.totalMetrics, "全体");

  const util = calculateCapitalUtilization(result.equityCurve);
  console.log(`\n  平均同時ポジション: ${util.avgConcurrentPositions}`);
  console.log(`  資金稼働率: ${util.capitalUtilizationPct.toFixed(1)}%`);

  printMetrics(result.guMetrics, "GapUp");
  printMetrics(result.pscMetrics, "PostSurgeConsolidation");
  if (enableWbLargecap) {
    printMetrics(result.wbMetrics, "WeeklyBreak (大型株)");
  }
  if (enableMomentum) {
    printMetrics(result.momMetrics, "Momentum (大型株)");
  }
  if (enableEtf) {
    printMetrics(result.etfMetrics, "US ETF (1547/1545, idle帯)");
  }
  if (enableEtfDip) {
    printMetrics(result.etfMetrics, "ETF押し目 (RSI2 mean-rev, 常時)");
  }
  if (enablePanic) {
    printMetrics(result.etfMetrics, "パニック底反発 (br<40%×連続下落, idle帯)");
  }
  if (enableBuyback) {
    printMetrics(result.buybackMetrics, "自社株買い (取得決定, idle帯)");
  }

  const exitReasons = new Map<string, number>();
  for (const t of result.allTrades) {
    if (t.exitReason && t.exitReason !== "still_open") {
      exitReasons.set(t.exitReason, (exitReasons.get(t.exitReason) ?? 0) + 1);
    }
  }
  console.log("\n[出口理由]");
  for (const [reason, count] of exitReasons) {
    console.log(`  ${reason}: ${count}`);
  }

  const totalDays = result.equityCurve.length;
  console.log(`\n[ドローダウンハルト]`);
  console.log(`  ハルト日数: ${result.haltDays} / ${totalDays}営業日 (${totalDays > 0 ? ((result.haltDays / totalDays) * 100).toFixed(1) : "0.0"}%)`);

  console.log("\n" + "=".repeat(60));
  const pfOk = result.totalMetrics.profitFactor >= 1.3;
  const expOk = result.totalMetrics.expectancy > 0;
  const rrOk = result.totalMetrics.riskRewardRatio >= 1.5;
  console.log(`判定: PF >= 1.3 ${pfOk ? "✓" : "✗"} / 期待値 > 0 ${expOk ? "✓" : "✗"} / RR >= 1.5 ${rrOk ? "✓" : "✗"}`);

  // 月次エクイティサマリー（月次追加時のみ）
  if (monthlyAddAmount > 0) {
    printMonthlyEquitySummary(result.equityCurve, result.totalCapitalAdded, budget);
  }


  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("統合BTエラー:", err);
  process.exit(1);
});
