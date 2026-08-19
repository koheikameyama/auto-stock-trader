/**
 * 使い捨て検証: 「GU候補が0の日に offseason 戦略(米株ETF)を撃つ」ゲート緩和の件数見積り
 *
 * 現行ゲート:  ETF は breadth(前日) < 54% (idle帯) の日だけ発火
 * 提案ゲート:  上記 OR 「その日の GU 候補が 0 件」
 *
 * 本スクリプトは combined BT を回さず、
 *   (1) 提案で新たに開く ETF シグナルが何件あるか
 *   (2) その内訳（なぜ GU が 0 だったか）
 *   (3) 単独モデル（資金制約なし）での成績が現行分と比べてどうか
 * だけを数える。件数が少なければ combined BT を回す意味がないので、その足切り用。
 *
 * ※ (3) は 1トレード=全額の pct モデルなので絶対値は使えない（却下#50 の警告）。
 *    「現行 idle帯分と比べて格が同等か」の相対比較にのみ使う。
 *
 * 実行: npx tsx src/backtest/_gu-zero-etf-gate-study.ts [--start 2018-04-01] [--end 2026-07-31]
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { GAPUP_BACKTEST_DEFAULTS } from "./gapup-config";
import { getMaxBuyablePrice } from "../core/risk-manager";
import { precomputeSimData } from "./breakout-simulation";
import { precomputeGapUpDailySignals } from "./gapup-simulation";
import { precomputeUSEtfSignals } from "./us-etf-simulation";
import { US_ETF_DEFAULT_CONFIG } from "./us-etf-config";
import { fetchHistoricalFromDB, fetchIndexFromDB } from "./data-fetcher";
import { MARKET_BREADTH } from "../lib/constants";
import type { OHLCVData } from "../core/technical-analysis";
import type { GapUpBacktestConfig } from "./types";

type Bucket =
  | "current_idle" // 現行で発火（breadth < 54%）
  | "new_overheat" // 新規: breadth > 80%（過熱でGU停止）
  | "new_index_below" // 新規: band帯だが N225 < SMA50 でGU停止
  | "new_empty" // 新規: band帯 + N225上 だが候補ゼロ
  | "blocked"; // 提案でも遮断（GU候補あり）

const BUCKET_LABEL: Record<Bucket, string> = {
  current_idle: "現行で発火 (breadth<54%)",
  new_overheat: "★新規: 過熱 (breadth>80%)",
  new_index_below: "★新規: band帯 + N225<SMA50",
  new_empty: "★新規: band帯 + N225上 + 候補0",
  blocked: "提案でも遮断 (GU候補あり)",
};

interface Row {
  date: string;
  ticker: string;
  bucket: Bucket;
  retPct: number; // 単独モデルの純リターン%（往復コスト控除後）
}

const COST_ROUND_TRIP = 0.002; // 往復0.2%（ETF単独BTと同じ想定）

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/** ETF単独の出口モデル: -2%固定SL / 5営業日タイムストップ（entry当日は評価しない） */
function simulateExit(bars: OHLCVData[], entryIdx: number, slPct: number, timeStopDays: number): number | null {
  const entry = bars[entryIdx].close;
  const sl = entry * (1 - slPct);
  for (let h = 1; h <= timeStopDays; h++) {
    const bar = bars[entryIdx + h];
    if (!bar) return null;
    if (bar.low <= sl) return (sl - entry) / entry - COST_ROUND_TRIP;
    if (h >= timeStopDays) return (bar.close - entry) / entry - COST_ROUND_TRIP;
  }
  return null;
}

function stats(rows: Row[]) {
  if (rows.length === 0) return { n: 0, win: 0, pf: 0, avg: 0, sum: 0 };
  const wins = rows.filter((r) => r.retPct > 0);
  const gp = wins.reduce((s, r) => s + r.retPct, 0);
  const gl = rows.filter((r) => r.retPct <= 0).reduce((s, r) => s + Math.abs(r.retPct), 0);
  return {
    n: rows.length,
    win: (wins.length / rows.length) * 100,
    pf: gl > 0 ? gp / gl : Infinity,
    avg: (rows.reduce((s, r) => s + r.retPct, 0) / rows.length) * 100,
    sum: rows.reduce((s, r) => s + r.retPct, 0) * 100,
  };
}

async function main() {
  const startDate = arg("--start", "2018-04-01");
  const endDate = arg("--end", "2026-07-31");
  const budget = Number(arg("--budget", "500000"));

  console.log("=".repeat(78));
  console.log("GU候補0 → offseason(米株ETF) ゲート緩和の件数見積り");
  console.log("=".repeat(78));
  console.log(`期間: ${startDate} → ${endDate} / 予算(ユニバース上限算出用): ¥${budget.toLocaleString()}`);

  const guConfig: GapUpBacktestConfig = {
    ...GAPUP_BACKTEST_DEFAULTS,
    startDate,
    endDate,
    initialBudget: budget,
    maxPrice: getMaxBuyablePrice(budget),
    verbose: false,
  };

  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  const tickerCodes = stocks.map((s) => s.tickerCode);
  console.log(`[data] ${tickerCodes.length}銘柄のデータ取得中...`);

  const rawData = await fetchHistoricalFromDB(tickerCodes, startDate, endDate);
  const indexData = await fetchIndexFromDB("^N225", startDate, endDate);

  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= guConfig.maxPrice && b.close > 0)) allData.set(ticker, bars);
  }
  console.log(`[data] ${allData.size}銘柄（フィルタ後）, N225 ${indexData.size}日`);

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
  console.log(`[data] GUシグナル日: ${gapupSignals.size}日 / 全営業日 ${precomputed.tradingDays.length}日`);

  // ETF: breadth フィルターを外して「生シグナル」を全部拾う
  const etfConfig = { ...US_ETF_DEFAULT_CONFIG, breadthMax: 1.0 };
  const etfRaw = await fetchHistoricalFromDB(etfConfig.tickers, startDate, endDate);
  const etfDataMap = new Map<string, OHLCVData[]>();
  for (const t of etfConfig.tickers) {
    const bars = etfRaw.get(t);
    if (bars && bars.length > 0) etfDataMap.set(t, bars);
  }
  if (etfDataMap.size === 0) {
    console.error("❌ ETFのバーが0件。ローカルDBに 1547/1545 が入っているか確認 (tickerCode は .T 無し)");
    process.exit(1);
  }
  const etfSignals = precomputeUSEtfSignals(etfDataMap, precomputed.dailyBreadth, etfConfig);

  const etfIdx = new Map<string, Map<string, number>>();
  for (const [t, bars] of etfDataMap) {
    const m = new Map<string, number>();
    bars.forEach((b, i) => m.set(dayjs(b.date).format("YYYY-MM-DD"), i));
    etfIdx.set(t, m);
  }

  const rows: Row[] = [];
  const upperCap = guConfig.marketTrendUpperCap ?? MARKET_BREADTH.UPPER_CAP;

  for (const [date, sigs] of etfSignals) {
    const guCount = gapupSignals.get(date)?.length ?? 0;
    const breadthToday = precomputed.dailyBreadth.get(date);
    const indexAbove = precomputed.dailyIndexAboveSma.get(date) ?? false;

    for (const s of sigs) {
      const prevBreadth = s.breadthAtEntry;
      let bucket: Bucket;
      if (prevBreadth < MARKET_BREADTH.THRESHOLD) {
        bucket = "current_idle";
      } else if (guCount > 0) {
        bucket = "blocked";
      } else if (breadthToday != null && breadthToday > upperCap) {
        bucket = "new_overheat";
      } else if (!indexAbove) {
        bucket = "new_index_below";
      } else {
        bucket = "new_empty";
      }

      const bars = etfDataMap.get(s.ticker)!;
      const i = etfIdx.get(s.ticker)!.get(date);
      if (i == null) continue;
      const ret = simulateExit(bars, i, US_ETF_DEFAULT_CONFIG.slPct, US_ETF_DEFAULT_CONFIG.timeStopDays);
      if (ret == null) continue;
      rows.push({ date, ticker: s.ticker, bucket, retPct: ret });
    }
  }

  const order: Bucket[] = ["current_idle", "new_overheat", "new_index_below", "new_empty", "blocked"];

  console.log("\n" + "=".repeat(78));
  console.log("シグナル分類（ETF生シグナル = gap≥0.5% + vol≥1.5x + 陽線）");
  console.log("=".repeat(78));
  console.log("分類".padEnd(34) + "件数".padStart(6) + "勝率".padStart(8) + "PF".padStart(8) + "平均%".padStart(9) + "累計%".padStart(10));
  for (const b of order) {
    const st = stats(rows.filter((r) => r.bucket === b));
    console.log(
      BUCKET_LABEL[b].padEnd(32) +
      String(st.n).padStart(6) +
      (st.n ? `${st.win.toFixed(1)}%`.padStart(8) : "-".padStart(8)) +
      (st.n ? (st.pf === Infinity ? "∞" : st.pf.toFixed(2)).padStart(8) : "-".padStart(8)) +
      (st.n ? `${st.avg >= 0 ? "+" : ""}${st.avg.toFixed(2)}`.padStart(9) : "-".padStart(9)) +
      (st.n ? `${st.sum >= 0 ? "+" : ""}${st.sum.toFixed(1)}`.padStart(10) : "-".padStart(10)),
    );
  }

  const newRows = rows.filter((r) => r.bucket.startsWith("new_"));
  const curRows = rows.filter((r) => r.bucket === "current_idle");
  console.log("-".repeat(78));
  const stNew = stats(newRows);
  const stCur = stats(curRows);
  console.log(
    "★新規合計".padEnd(32) +
    String(stNew.n).padStart(6) +
    (stNew.n ? `${stNew.win.toFixed(1)}%`.padStart(8) : "-".padStart(8)) +
    (stNew.n ? stNew.pf.toFixed(2).padStart(8) : "-".padStart(8)) +
    (stNew.n ? `${stNew.avg >= 0 ? "+" : ""}${stNew.avg.toFixed(2)}`.padStart(9) : "-".padStart(9)) +
    (stNew.n ? `${stNew.sum >= 0 ? "+" : ""}${stNew.sum.toFixed(1)}`.padStart(10) : "-".padStart(10)),
  );
  console.log(`\n現行 ${stCur.n}件 → 提案 ${stCur.n + stNew.n}件 (+${stNew.n}件, ${stCur.n ? ((stNew.n / stCur.n) * 100).toFixed(0) : "-"}%増)`);

  // 年代別
  console.log("\n" + "=".repeat(78));
  console.log("年代別（件数 / PF / 累計%）");
  console.log("=".repeat(78));
  const eras: [string, string, string][] = [
    ["2018-04〜2020-12", "2018-04-01", "2020-12-31"],
    ["2021-01〜2023-12", "2021-01-01", "2023-12-31"],
    ["2024-01〜2026-07", "2024-01-01", "2026-07-31"],
  ];
  console.log("期間".padEnd(20) + "現行(idle帯)".padStart(24) + "★新規分".padStart(24));
  for (const [label, s, e] of eras) {
    const inEra = (r: Row) => r.date >= s && r.date <= e;
    const c = stats(curRows.filter(inEra));
    const n = stats(newRows.filter(inEra));
    const fmt = (x: ReturnType<typeof stats>) =>
      x.n ? `${x.n}件 PF${x.pf === Infinity ? "∞" : x.pf.toFixed(2)} ${x.sum >= 0 ? "+" : ""}${x.sum.toFixed(1)}%` : "0件";
    console.log(label.padEnd(20) + fmt(c).padStart(24) + fmt(n).padStart(24));
  }

  // 新規分が発生した日の GU 状態サマリー
  console.log("\n" + "=".repeat(78));
  console.log("参考: 全営業日の内訳（GU候補の有無 × breadth帯）");
  console.log("=".repeat(78));
  let dIdle = 0, dOverheat = 0, dIndexBelow = 0, dEmpty = 0, dGuActive = 0;
  for (const day of precomputed.tradingDays) {
    const gu = gapupSignals.get(day)?.length ?? 0;
    const b = precomputed.dailyBreadth.get(day);
    const idxAbove = precomputed.dailyIndexAboveSma.get(day) ?? false;
    if (gu > 0) { dGuActive++; continue; }
    if (b == null || b < MARKET_BREADTH.THRESHOLD) dIdle++;
    else if (b > upperCap) dOverheat++;
    else if (!idxAbove) dIndexBelow++;
    else dEmpty++;
  }
  const tot = precomputed.tradingDays.length;
  const p = (x: number) => `${((x / tot) * 100).toFixed(1)}%`;
  console.log(`全営業日: ${tot}日`);
  console.log(`  GU候補あり:                       ${String(dGuActive).padStart(5)}日 (${p(dGuActive)})`);
  console.log(`  GU候補0 / breadth<54% (現行idle):  ${String(dIdle).padStart(5)}日 (${p(dIdle)})`);
  console.log(`  GU候補0 / breadth>80% (過熱):      ${String(dOverheat).padStart(5)}日 (${p(dOverheat)})`);
  console.log(`  GU候補0 / band帯 + N225<SMA50:     ${String(dIndexBelow).padStart(5)}日 (${p(dIndexBelow)})`);
  console.log(`  GU候補0 / band帯 + N225上 + 空:    ${String(dEmpty).padStart(5)}日 (${p(dEmpty)})`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
