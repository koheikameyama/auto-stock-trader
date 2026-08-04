/**
 * 使い捨て検証: 「PSC 条件を GU のエントリー品質オーバーレイとして使えるか」
 * (KOH-601 / 却下#59 の残り角度C)
 *
 * 問い: PSC を独立戦略として走らせるのは却下 (#59) だが、
 *       「GU候補のうち PSC 条件も満たす銘柄」がとくに強いなら、
 *       新規ポジションを増やさずに **GU の選別/順位付けを良くする** 使い道が残る。
 *
 * GU の条件は gap≥3% × vol≥1.5x × close≥open。PSC が上乗せしているのは実質:
 *   ① 直近20日で +15% 以上（既に急騰している）
 *   ② 20日高値の -5% 圏内（高値圏を維持）
 * なので「フル充足」だけでなく ①② を単体でも層別し、どの成分が効くかまで見る。
 *
 * 事前確率は低い: 却下#17-20 が「既存フィルターへの上乗せは冗長」を5回確認しており、
 * さらに #59 で「GU と PSC は日次レベルで相関する」と判明済み。足切りとして測る。
 *
 * 先読みなし: 層別に使う値は entryDate の終値まで（GU のエントリーも同日引け）。
 * baseline は GU3単独 / 総資産基準サイジング（2026-08-03〜04 の新 baseline）。
 * 本番影響なし: 検証専用、エンジン無改変。
 *
 * 実行: npx tsx src/backtest/_gu-psc-overlay-study.ts --start 2018-04-01 --end 2026-07-31
 */
import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { GAPUP_BACKTEST_DEFAULTS } from "./gapup-config";
import { PSC_BACKTEST_DEFAULTS, PSC_PRODUCTION_PARAMS } from "./post-surge-consolidation-config";
import { getMaxBuyablePrice } from "../core/risk-manager";
import { precomputeSimData } from "./breakout-simulation";
import { precomputeGapUpDailySignals } from "./gapup-simulation";
import { precomputePSCDailySignals } from "./post-surge-consolidation-simulation";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "./data-fetcher";
import { runCombinedSimulation, type PositionLimits } from "./combined-simulation";
import { POST_SURGE_CONSOLIDATION } from "../lib/constants/post-surge-consolidation";
import type { OHLCVData } from "../core/technical-analysis";
import type { GapUpBacktestConfig, PostSurgeConsolidationBacktestConfig } from "./types";

const LOOKBACK = POST_SURGE_CONSOLIDATION.ENTRY.MOMENTUM_LOOKBACK_DAYS; // 20
const MOM_MIN = POST_SURGE_CONSOLIDATION.ENTRY.MOMENTUM_MIN_RETURN;     // 0.15
const HIGH_DIST = POST_SURGE_CONSOLIDATION.ENTRY.MAX_HIGH_DISTANCE_PCT; // 0.05

function getArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

interface T {
  netPct: number;
  holdingDays: number;
  mom20: number | null;
  highDist: number | null;
  pscFull: boolean;
}

function stats(ts: T[]) {
  const n = ts.length;
  if (n === 0) return null;
  const wins = ts.filter((t) => t.netPct > 0);
  const losses = ts.filter((t) => t.netPct <= 0);
  const gp = wins.reduce((s, t) => s + t.netPct, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.netPct, 0));
  return {
    n,
    winRate: (wins.length / n) * 100,
    pf: gl > 0 ? gp / gl : Infinity,
    expectancy: ts.reduce((s, t) => s + t.netPct, 0) / n,
    avgWin: wins.length ? gp / wins.length : 0,
    avgLoss: losses.length ? -gl / losses.length : 0,
    cum: ts.reduce((s, t) => s + t.netPct, 0),
    avgHold: ts.reduce((s, t) => s + t.holdingDays, 0) / n,
  };
}
function fmt(label: string, s: ReturnType<typeof stats>): string {
  if (!s) return `${label.padEnd(30)} —`;
  return (
    `${label.padEnd(30)} ${String(s.n).padStart(5)}件  ` +
    `勝率 ${s.winRate.toFixed(1).padStart(5)}%  ` +
    `PF ${(s.pf === Infinity ? "∞" : s.pf.toFixed(2)).padStart(6)}  ` +
    `期待値 ${((s.expectancy >= 0 ? "+" : "") + s.expectancy.toFixed(2) + "%").padStart(7)}  ` +
    `平均勝 +${s.avgWin.toFixed(2)}% / 平均負 ${s.avgLoss.toFixed(2)}%  ` +
    `保有 ${s.avgHold.toFixed(1)}日`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const startDate = getArg(args, "--start") ?? "2018-04-01";
  const endDate = getArg(args, "--end") ?? "2026-07-31";
  const budget = Number(getArg(args, "--budget") ?? "500000");
  const maxPrice = Number(getArg(args, "--max-price") ?? getMaxBuyablePrice(budget));

  console.log("=".repeat(105));
  console.log("PSC 条件を GU のエントリー品質オーバーレイとして使えるか（角度C）");
  console.log("=".repeat(105));
  console.log(`期間: ${startDate} → ${endDate}  予算: ¥${budget.toLocaleString()}  maxPrice: ¥${maxPrice.toLocaleString()}`);
  console.log(`PSC の上乗せ条件: 20日騰落率 >= ${(MOM_MIN * 100).toFixed(0)}% かつ 20日高値の -${(HIGH_DIST * 100).toFixed(0)}% 圏内`);

  const guConfig: GapUpBacktestConfig = {
    ...GAPUP_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, maxPrice, verbose: false,
  };
  const pscConfigUngated: PostSurgeConsolidationBacktestConfig = {
    ...PSC_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, maxPrice, verbose: false,
    ...PSC_PRODUCTION_PARAMS, marketTrendFilter: false, indexTrendFilter: false,
  };

  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  const rawData = await fetchHistoricalFromDB(stocks.map((s) => s.tickerCode), startDate, endDate);
  const vixData = await fetchVixFromDB(startDate, endDate);
  const indexData = await fetchIndexFromDB("^N225", startDate, endDate);

  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPrice && b.close > 0)) allData.set(ticker, bars);
  }
  console.log(`[data] ${allData.size}銘柄, VIX ${vixData.size}日, N225 ${indexData.size}日`);

  const precomputed = precomputeSimData(
    startDate, endDate, allData, true, true,
    guConfig.indexTrendSmaPeriod ?? 50,
    indexData.size > 0 ? indexData : undefined,
    false, 60,
    guConfig.indexTrendOffBufferPct ?? 0, guConfig.indexTrendOnBufferPct ?? 0,
  );
  console.log(`[precompute] 営業日 ${precomputed.tradingDays.length}日`);

  console.log("[precompute] GU シグナル...");
  const gapupSignals = precomputeGapUpDailySignals(guConfig, allData, precomputed);
  console.log("[precompute] PSC シグナル（市場ゲートなし）...");
  const pscSignalsUngated = precomputePSCDailySignals(pscConfigUngated, allData, precomputed);

  const { dateIndexMap } = precomputed;

  // day → PSC シグナルの ticker 集合
  const pscByDay = new Map<string, Set<string>>();
  for (const [day, sigs] of pscSignalsUngated) {
    pscByDay.set(day, new Set(sigs.map((s) => s.ticker)));
  }

  /** entryDate 時点の 20日騰落率と 20日高値からの距離（当日終値まで＝先読みなし） */
  function overlayMetrics(ticker: string, date: string): { mom20: number | null; highDist: number | null } {
    const bars = allData.get(ticker);
    const idx = dateIndexMap.get(ticker)?.get(date);
    if (!bars || idx == null || idx < LOOKBACK) return { mom20: null, highDist: null };
    const c0 = bars[idx - LOOKBACK]?.close;
    const c = bars[idx]?.close;
    if (!c0 || !c || c0 <= 0) return { mom20: null, highDist: null };
    const recent = bars.slice(Math.max(0, idx - 19), idx + 1);
    const high20 = Math.max(...recent.map((b) => b.high));
    return {
      mom20: c / c0 - 1,
      highDist: high20 > 0 ? (high20 - c) / high20 : null,
    };
  }

  // ---- シグナル層: オーバーレイの絞り込み強度 -------------------------------
  let guSigTotal = 0;
  let guSigWithPsc = 0;
  for (const [day, sigs] of gapupSignals) {
    const pscSet = pscByDay.get(day);
    for (const s of sigs) {
      guSigTotal++;
      if (pscSet?.has(s.ticker)) guSigWithPsc++;
    }
  }
  console.log(
    `\n[シグナル層] GUシグナル ${guSigTotal}件 / うち PSC条件も充足 ${guSigWithPsc}件 ` +
    `(${((guSigWithPsc / guSigTotal) * 100).toFixed(1)}%)`,
  );

  // ---- baseline (GU3単独) -----------------------------------------------------
  const ctx = {
    guConfig, pscConfig: pscConfigUngated, pscSignals: pscSignalsUngated,
    budget, verbose: false, allData, precomputed, gapupSignals,
    vixData: vixData.size > 0 ? vixData : undefined,
    monthlyAddAmount: 0, equityCurveSmaPeriod: 0,
    indexData: indexData.size > 0 ? indexData : undefined,
  };
  const limits: PositionLimits = { boMax: 0, guMax: 3, pscMax: 0 };
  console.log("\n[sim] baseline (GU3単独) 実行中...");
  const result = runCombinedSimulation(ctx, limits);
  const m = result.totalMetrics;
  console.log(
    `[baseline] Trades ${m.totalTrades}, WinRate ${m.winRate.toFixed(1)}%, PF ${m.profitFactor.toFixed(2)}, ` +
    `NetRet ${m.netReturnPct.toFixed(1)}%, MaxDD ${m.maxDrawdown.toFixed(1)}%`,
  );

  const trades: T[] = [];
  for (const t of result.allTrades) {
    if (!t.exitDate || t.netPnl == null || t.quantity <= 0 || t.exitReason === "still_open") continue;
    const { mom20, highDist } = overlayMetrics(t.ticker, t.entryDate);
    trades.push({
      netPct: (t.netPnl / (t.entryPrice * t.quantity)) * 100,
      holdingDays: t.holdingDays ?? 0,
      mom20,
      highDist,
      pscFull: pscByDay.get(t.entryDate)?.has(t.ticker) === true,
    });
  }
  console.log(`[trades] 決済済み ${trades.length}件`);

  console.log("\n" + "=".repeat(105));
  console.log("【1】PSC条件フル充足で層別（オーバーレイをそのまま適用した場合）");
  console.log("=".repeat(105));
  console.log(fmt("全体（baseline GU）", stats(trades)));
  console.log(fmt("PSC条件も充足", stats(trades.filter((t) => t.pscFull))));
  console.log(fmt("PSC条件は不充足", stats(trades.filter((t) => !t.pscFull))));

  console.log("\n" + "=".repeat(105));
  console.log("【2】成分分解: 20日騰落率（PSC の①）");
  console.log("=".repeat(105));
  const withMom = trades.filter((t) => t.mom20 != null);
  const sortedMom = [...withMom].sort((a, b) => a.mom20! - b.mom20!);
  const t1 = sortedMom.slice(0, Math.floor(sortedMom.length / 3));
  const t2 = sortedMom.slice(Math.floor(sortedMom.length / 3), Math.floor((sortedMom.length * 2) / 3));
  const t3 = sortedMom.slice(Math.floor((sortedMom.length * 2) / 3));
  const bounds = (xs: T[]) =>
    xs.length ? `${(xs[0].mom20! * 100).toFixed(0)}%〜${(xs[xs.length - 1].mom20! * 100).toFixed(0)}%` : "";
  console.log(fmt(`下位1/3 (${bounds(t1)})`, stats(t1)));
  console.log(fmt(`中位1/3 (${bounds(t2)})`, stats(t2)));
  console.log(fmt(`上位1/3 (${bounds(t3)})`, stats(t3)));
  console.log(fmt(`★ mom20 >= ${(MOM_MIN * 100).toFixed(0)}%（PSC閾値）`, stats(withMom.filter((t) => t.mom20! >= MOM_MIN))));
  console.log(fmt(`   mom20 <  ${(MOM_MIN * 100).toFixed(0)}%`, stats(withMom.filter((t) => t.mom20! < MOM_MIN))));

  console.log("\n" + "=".repeat(105));
  console.log("【3】成分分解: 20日高値からの距離（PSC の②）");
  console.log("=".repeat(105));
  const withHd = trades.filter((t) => t.highDist != null);
  console.log(fmt(`★ 高値の -${(HIGH_DIST * 100).toFixed(0)}% 圏内（PSC閾値）`, stats(withHd.filter((t) => t.highDist! <= HIGH_DIST))));
  console.log(fmt(`   それ以外`, stats(withHd.filter((t) => t.highDist! > HIGH_DIST))));

  console.log("\n解釈:");
  console.log("  『PSC条件も充足』が全体を明確に上回る & 件数が実用的 → 選別/順位付けに使える → combined BT へ");
  console.log("  差がノイズ水準 or 件数が薄い → 却下#17-20『既存フィルターへの上乗せは冗長』が6度目の確認");
  console.log(`\n実行: ${dayjs().format("YYYY-MM-DD HH:mm:ss")}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("エラー:", err);
  await prisma.$disconnect();
  process.exit(1);
});
