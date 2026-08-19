/**
 * PSC が「GU が撃たない場所」で価値を持つかの足切り調査（却下 #58 の GU候補ゼロゲート調査と同型）
 *
 * 問い: PSC を条件付きで復活させる余地はあるか。
 *   PSC のマーケットゲートは GU と完全に同一（breadth band + N225 SMA50）なので、
 *   レジーム軸では補完になり得ない。残る唯一の非競合スライスが
 *   「同じ稼働窓の中で GU 候補が居ない日」なので、そこに PSC のシグナルが
 *   どれだけ在り、どういう質かを先に測る。ここが薄ければ combined BT に進む価値はない。
 *
 * 先読みなし: シグナルは本番と同じ precompute（当日終値まで）、
 *             トレード成績は PSC 単独BTの出口ロジック（コスト込み）。
 *
 * 資金制約は意図的に外している（budget を巨大にし枠を広げる）。
 * 「共有プールで食い合うか」ではなく「そもそも撃つ弾があるか・質はあるか」を見る足切りのため。
 *
 * Usage:
 *   npx tsx scripts/_psc-gu-zero-gate-study.ts --start 2018-04-01 --end 2026-07-31
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "../src/backtest/data-fetcher";
import { precomputeSimData } from "../src/backtest/breakout-simulation";
import { precomputeGapUpDailySignals } from "../src/backtest/gapup-simulation";
import { precomputePSCDailySignals, runPSCBacktest } from "../src/backtest/post-surge-consolidation-simulation";
import { GAPUP_BACKTEST_DEFAULTS } from "../src/backtest/gapup-config";
import { PSC_BACKTEST_DEFAULTS } from "../src/backtest/post-surge-consolidation-config";
import { MARKET_BREADTH } from "../src/lib/constants";
import type { OHLCVData } from "../src/core/technical-analysis";
import type { SimulatedPosition } from "../src/backtest/types";

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/** 等ウェイトの成績（サイズ差でPFが歪まないよう net% で集計） */
function stats(trades: { netPct: number; holdingDays: number }[]) {
  const n = trades.length;
  if (n === 0) return null;
  const wins = trades.filter((t) => t.netPct > 0);
  const losses = trades.filter((t) => t.netPct <= 0);
  const gp = wins.reduce((s, t) => s + t.netPct, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.netPct, 0));
  return {
    n,
    winRate: (wins.length / n) * 100,
    pf: gl > 0 ? gp / gl : Infinity,
    expectancy: trades.reduce((s, t) => s + t.netPct, 0) / n,
    avgWin: wins.length > 0 ? gp / wins.length : 0,
    avgLoss: losses.length > 0 ? -gl / losses.length : 0,
    cum: trades.reduce((s, t) => s + t.netPct, 0),
    avgHold: trades.reduce((s, t) => s + t.holdingDays, 0) / n,
  };
}

function fmt(label: string, s: ReturnType<typeof stats>): string {
  if (!s) return `${label.padEnd(22)} —`;
  return (
    `${label.padEnd(22)} ${String(s.n).padStart(5)}件  ` +
    `勝率 ${s.winRate.toFixed(1).padStart(5)}%  ` +
    `PF ${(s.pf === Infinity ? "∞" : s.pf.toFixed(2)).padStart(6)}  ` +
    `期待値 ${(s.expectancy >= 0 ? "+" : "") + s.expectancy.toFixed(2)}%  ` +
    `平均勝 +${s.avgWin.toFixed(2)}% / 平均負 ${s.avgLoss.toFixed(2)}%  ` +
    `累計 ${(s.cum >= 0 ? "+" : "") + s.cum.toFixed(0)}%  ` +
    `保有 ${s.avgHold.toFixed(1)}日`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const startDate = getArg(args, "--start") ?? "2018-04-01";
  const endDate = getArg(args, "--end") ?? "2026-07-31";
  const maxPrice = Number(getArg(args, "--max-price") ?? 2500);
  // 資金制約を外すための巨大予算（足切り調査なので共有プールの食い合いは見ない）
  const budget = Number(getArg(args, "--budget") ?? 1_000_000_000);

  console.log("=".repeat(100));
  console.log("PSC「GU が撃たない場所」足切り調査");
  console.log("=".repeat(100));
  console.log(`期間: ${startDate} → ${endDate}  maxPrice: ¥${maxPrice.toLocaleString()}`);
  console.log(`品質測定用予算: ¥${budget.toLocaleString()}（資金制約を外すため）`);

  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  const tickerCodes = stocks.map((s) => s.tickerCode);
  console.log(`\n[data] ${tickerCodes.length}銘柄のデータ取得中...`);

  const rawData = await fetchHistoricalFromDB(tickerCodes, startDate, endDate);
  const vixData = await fetchVixFromDB(startDate, endDate);
  const indexData = await fetchIndexFromDB("^N225", startDate, endDate);
  console.log(`[data] ${rawData.size}銘柄, VIX ${vixData.size}日, N225 ${indexData.size}日`);

  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPrice && b.close > 0)) allData.set(ticker, bars);
  }
  console.log(`[data] ${allData.size}銘柄（maxPrice フィルタ後）`);

  console.log("\n[precompute] 共通データ...");
  const precomputed = precomputeSimData(
    startDate, endDate, allData,
    true,  // marketTrendFilter
    true,  // indexTrendFilter
    50,
    indexData.size > 0 ? indexData : undefined,
    undefined, undefined, 0, 0,
  );
  console.log(`[precompute] 営業日 ${precomputed.tradingDays.length}日`);

  const guConfig = { ...GAPUP_BACKTEST_DEFAULTS, maxPrice };
  const pscConfig = { ...PSC_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, maxPrice };

  console.log("[precompute] GU シグナル...");
  const guSignals = precomputeGapUpDailySignals(guConfig, allData, precomputed);
  console.log("[precompute] PSC シグナル...");
  const pscSignals = precomputePSCDailySignals(pscConfig, allData, precomputed);

  // ---- 日次クロス集計 -------------------------------------------------------
  const { tradingDays, dailyBreadth, dailyIndexAboveSma } = precomputed;
  const guCountByDay = new Map<string, number>();
  let activeDays = 0;
  let guZeroDays = 0;
  let guZeroPscDays = 0;
  let guZeroPscSignals = 0;
  let guPosDays = 0;
  let guPosPscSignals = 0;
  let totalPscSignals = 0;

  for (const day of tradingDays) {
    const b = dailyBreadth.get(day) ?? 0;
    const inBand = b >= MARKET_BREADTH.THRESHOLD && b <= MARKET_BREADTH.UPPER_CAP;
    const idxOk = dailyIndexAboveSma.get(day) === true;
    const active = inBand && idxOk;
    const gu = guSignals.get(day)?.length ?? 0;
    const psc = pscSignals.get(day)?.length ?? 0;
    guCountByDay.set(day, gu);
    if (!active) continue;
    activeDays++;
    totalPscSignals += psc;
    if (gu === 0) {
      guZeroDays++;
      if (psc > 0) guZeroPscDays++;
      guZeroPscSignals += psc;
    } else {
      guPosDays++;
      guPosPscSignals += psc;
    }
  }

  console.log("\n" + "=".repeat(100));
  console.log("【1】日次クロス集計（GU/PSC 共通の稼働日 = breadth band 内 かつ N225 > SMA50）");
  console.log("=".repeat(100));
  console.log(`全営業日:               ${tradingDays.length}日`);
  console.log(`稼働日（両戦略ON）:     ${activeDays}日 (${((activeDays / tradingDays.length) * 100).toFixed(1)}%)`);
  console.log(`  ├ GU候補あり:         ${guPosDays}日  → PSCシグナル ${guPosPscSignals}件`);
  console.log(`  └ GU候補ゼロ:         ${guZeroDays}日  → PSCシグナル ${guZeroPscSignals}件 (発火日 ${guZeroPscDays}日)`);
  console.log(`PSCシグナル総数:        ${totalPscSignals}件`);
  console.log(
    `→ GU不在の日に出る PSC シグナルは全体の ` +
    `${totalPscSignals > 0 ? ((guZeroPscSignals / totalPscSignals) * 100).toFixed(1) : "0"}%`,
  );

  // ---- PSC トレード品質 -----------------------------------------------------
  console.log("\n[sim] PSC 単独BT（資金制約なし）実行中...");
  const pscResult = runPSCBacktest(
    { ...pscConfig, maxPositions: 99 },
    allData,
    vixData.size > 0 ? vixData : undefined,
    indexData.size > 0 ? indexData : undefined,
    precomputed,
    pscSignals,
  );

  const closed = pscResult.trades.filter(
    (t: SimulatedPosition) => t.exitDate != null && t.netPnl != null && t.quantity > 0,
  );
  const enriched = closed.map((t: SimulatedPosition) => ({
    ticker: t.ticker,
    entryDate: t.entryDate,
    netPct: (t.netPnl! / (t.entryPrice * t.quantity)) * 100,
    holdingDays: t.holdingDays ?? 0,
    gu: guCountByDay.get(t.entryDate) ?? 0,
    breadth: dailyBreadth.get(t.entryDate) ?? 0,
  }));

  console.log(`[sim] 約定 ${closed.length}件 / PSCシグナル ${totalPscSignals}件`);

  console.log("\n" + "=".repeat(100));
  console.log("【2】PSCトレード品質 × 同日の GU候補数");
  console.log("=".repeat(100));
  console.log(fmt("全体", stats(enriched)));
  console.log(fmt("GU候補 = 0（非競合）", stats(enriched.filter((t) => t.gu === 0))));
  console.log(fmt("GU候補 1-2（枠に余り）", stats(enriched.filter((t) => t.gu >= 1 && t.gu <= 2))));
  console.log(fmt("GU候補 >= 3（枠が埋まる）", stats(enriched.filter((t) => t.gu >= 3))));

  console.log("\n" + "=".repeat(100));
  console.log("【3】PSCトレード品質 × breadth 帯");
  console.log("=".repeat(100));
  console.log(fmt("54-60%", stats(enriched.filter((t) => t.breadth < 0.60))));
  console.log(fmt("60-70%", stats(enriched.filter((t) => t.breadth >= 0.60 && t.breadth < 0.70))));
  console.log(fmt("70-80%", stats(enriched.filter((t) => t.breadth >= 0.70))));

  console.log("\n" + "=".repeat(100));
  console.log("【4】年代別（却下#57 と同じ3分割） × GU候補ゼロ");
  console.log("=".repeat(100));
  const eras: [string, string, string][] = [
    ["2018-2020", "2018-01-01", "2020-12-31"],
    ["2021-2023", "2021-01-01", "2023-12-31"],
    ["2024-2026", "2024-01-01", "2026-12-31"],
  ];
  for (const [label, s, e] of eras) {
    const inEra = enriched.filter((t) => t.entryDate >= s && t.entryDate <= e);
    console.log(fmt(`${label} 全体`, stats(inEra)));
    console.log(fmt(`${label} GU=0`, stats(inEra.filter((t) => t.gu === 0))));
  }

  // 参考: GU 側の分布（PSC と同条件の等ウェイトではないが日次分布の把握用）
  console.log("\n" + "=".repeat(100));
  console.log("【5】参考: 稼働日あたりの候補数分布");
  console.log("=".repeat(100));
  const guCounts = tradingDays
    .filter((d) => {
      const b = dailyBreadth.get(d) ?? 0;
      return b >= MARKET_BREADTH.THRESHOLD && b <= MARKET_BREADTH.UPPER_CAP && dailyIndexAboveSma.get(d) === true;
    })
    .map((d) => guSignals.get(d)?.length ?? 0);
  const buckets = [0, 1, 2, 3, 5, 10];
  for (let i = 0; i < buckets.length; i++) {
    const lo = buckets[i];
    const hi = i + 1 < buckets.length ? buckets[i + 1] : Infinity;
    const days = guCounts.filter((c) => c >= lo && c < hi).length;
    const label = hi === Infinity ? `GU候補 ${lo}件以上` : lo === hi - 1 ? `GU候補 ${lo}件` : `GU候補 ${lo}-${hi - 1}件`;
    console.log(`${label.padEnd(22)} ${String(days).padStart(5)}日`);
  }

  console.log(`\n実行: ${dayjs().format("YYYY-MM-DD HH:mm:ss")}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("エラー:", err);
  await prisma.$disconnect();
  process.exit(1);
});
