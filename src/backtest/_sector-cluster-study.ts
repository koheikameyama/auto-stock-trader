/**
 * 使い捨て検証スクリプト: 同日・同セクター クラスタリング event study
 *
 * 仮説 (CLAUDE.md 却下リスト #18-20 の "セクターで絞る" とは逆方向):
 *   同一営業日に同一セクターで GU/PSC が複数銘柄同時発火した時、それは
 *   「セクター発のカタリスト/テーマ」である確率が高く、孤立発火より follow-through が
 *   強いのではないか。→ 絞る(reject) のでなく "乗せる(boost)" 方向。
 *
 * 設計:
 *   - production config で GU/PSC の全 daily signals を precompute (シグナル定義を再実装しない)
 *   - 各日、同一セクターの distinct ticker 数で cluster(>=2) / isolated(==1) を分類
 *   - entry(当日終値) 起点の forward return を h=1/3/5/10/20 で計算
 *   - 生リターン と N225超過リターン の両方 (★対セクター超過は使わない: セクターテーマ自体を
 *     打ち消してしまい仮説を検証できなくなるため)
 *   - cluster vs isolated を Welch t検定で比較、cluster size (2 / 3+) でも層別、GU/PSC別も出す
 *
 * 先読みなし: entryPrice=close[t], forward=close[t+h]。cluster分類は同日シグナル(引けで既知)のみ。
 *             sector は静的 (Stock.sector)。
 * 本番影響なし: 検証専用、baseline エンジンを一切変更しない。
 *
 * 実行: npx tsx src/backtest/_sector-cluster-study.ts [--start 2018-01-01] [--end 2026-07-07] [--budget 500000]
 */
import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { GAPUP_BACKTEST_DEFAULTS } from "./gapup-config";
import { PSC_BACKTEST_DEFAULTS, PSC_PRODUCTION_PARAMS } from "./post-surge-consolidation-config";
import { getMaxBuyablePrice } from "../core/risk-manager";
import { precomputeSimData } from "./breakout-simulation";
import { precomputeGapUpDailySignals } from "./gapup-simulation";
import { precomputePSCDailySignals } from "./post-surge-consolidation-simulation";
import { fetchHistoricalFromDB, fetchIndexFromDB } from "./data-fetcher";
import type { OHLCVData } from "../core/technical-analysis";
import type {
  GapUpBacktestConfig,
  PostSurgeConsolidationBacktestConfig,
} from "./types";

const HORIZONS = [1, 3, 5, 10, 20] as const;

function getArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}
function pctPositive(xs: number[]): number {
  return xs.length ? (xs.filter((x) => x > 0).length / xs.length) * 100 : 0;
}
/** Welch t統計量 (group1 - group2)。等分散を仮定しない。 */
function welchT(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const se = Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  if (se === 0) return 0;
  return (mean(a) - mean(b)) / se;
}
/** 平均のt統計量 (H0: mean=0)。 */
function oneSampleT(xs: number[]): number {
  if (xs.length < 2) return 0;
  const se = Math.sqrt(variance(xs) / xs.length);
  if (se === 0) return 0;
  return mean(xs) / se;
}

interface Signal {
  date: string;
  ticker: string;
  entryPrice: number;
  sector: string;
  strat: "GU" | "PSC";
  clusterSize: number; // 同日・同セクターの distinct ticker 数
}

interface Bucket {
  raw: Record<number, number[]>;
  excess: Record<number, number[]>;
}
function emptyBucket(): Bucket {
  const raw: Record<number, number[]> = {};
  const excess: Record<number, number[]> = {};
  for (const h of HORIZONS) {
    raw[h] = [];
    excess[h] = [];
  }
  return { raw, excess };
}

async function main() {
  const args = process.argv.slice(2);
  const startDate = getArg(args, "--start") ?? "2018-01-01";
  const endDate = getArg(args, "--end") ?? dayjs().format("YYYY-MM-DD");
  const budget = Number(getArg(args, "--budget") ?? "500000");
  const dynamicMaxPrice = getMaxBuyablePrice(budget);

  console.log("=".repeat(72));
  console.log("同日・同セクター クラスタリング event study (GU/PSC × sector)");
  console.log("=".repeat(72));
  console.log(`期間: ${startDate} → ${endDate}, maxPrice ¥${dynamicMaxPrice.toLocaleString()}`);

  // sector マップ
  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true, sector: true },
  });
  const tickerCodes = stocks.map((s) => s.tickerCode);
  const sectorMap = new Map<string, string>();
  for (const s of stocks) sectorMap.set(s.tickerCode, s.sector ?? "UNKNOWN");

  const rawData = await fetchHistoricalFromDB(tickerCodes, startDate, endDate);
  const indexData = await fetchIndexFromDB("^N225", startDate, endDate);

  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= dynamicMaxPrice && b.close > 0)) {
      allData.set(ticker, bars);
    }
  }
  console.log(`[data] ${allData.size}銘柄, N225 ${indexData.size}日`);

  const guConfig: GapUpBacktestConfig = {
    ...GAPUP_BACKTEST_DEFAULTS,
    startDate, endDate, initialBudget: budget, maxPrice: dynamicMaxPrice, verbose: false,
  };
  const pscConfig: PostSurgeConsolidationBacktestConfig = {
    ...PSC_BACKTEST_DEFAULTS,
    startDate, endDate, initialBudget: budget, maxPrice: dynamicMaxPrice, verbose: false,
    ...PSC_PRODUCTION_PARAMS,
  };

  const precomputed = precomputeSimData(
    startDate, endDate, allData, true, true,
    guConfig.indexTrendSmaPeriod ?? 50,
    indexData.size > 0 ? indexData : undefined,
    false, 60,
    guConfig.indexTrendOffBufferPct ?? 0,
    guConfig.indexTrendOnBufferPct ?? 0,
  );

  const guSignals = precomputeGapUpDailySignals(guConfig, allData, precomputed);
  const pscSignals = precomputePSCDailySignals(pscConfig, allData, precomputed);

  const { tradingDays, tradingDayIndex, dateIndexMap } = precomputed;
  const idxClose = (date: string): number | null => indexData.get(date) ?? null;

  // date → { ticker → signal }。GU/PSC を統合（同一銘柄が両方発火したら1銘柄として扱う=GU優先）
  const byDate = new Map<string, Map<string, { entryPrice: number; strat: "GU" | "PSC" }>>();
  const addSig = (m: PrecomputedGapUpSignalsLike, strat: "GU" | "PSC") => {
    for (const [date, sigs] of m) {
      let day = byDate.get(date);
      if (!day) { day = new Map(); byDate.set(date, day); }
      for (const s of sigs) {
        if (!day.has(s.ticker)) day.set(s.ticker, { entryPrice: s.entryPrice, strat });
      }
    }
  };
  addSig(guSignals as unknown as PrecomputedGapUpSignalsLike, "GU");
  addSig(pscSignals as unknown as PrecomputedGapUpSignalsLike, "PSC");

  // cluster 分類してフラットな Signal[] を作る
  const signals: Signal[] = [];
  for (const [date, day] of byDate) {
    // セクター別 distinct ticker 数
    const sectorCount = new Map<string, number>();
    const perTicker: { ticker: string; entryPrice: number; strat: "GU" | "PSC"; sector: string }[] = [];
    for (const [ticker, info] of day) {
      const sector = sectorMap.get(ticker) ?? "UNKNOWN";
      sectorCount.set(sector, (sectorCount.get(sector) ?? 0) + 1);
      perTicker.push({ ticker, entryPrice: info.entryPrice, strat: info.strat, sector });
    }
    for (const t of perTicker) {
      signals.push({
        date, ticker: t.ticker, entryPrice: t.entryPrice, sector: t.sector, strat: t.strat,
        clusterSize: sectorCount.get(t.sector) ?? 1,
      });
    }
  }

  console.log(`[signals] 総 ${signals.length}件 (GU ${signals.filter(s => s.strat === "GU").length} / PSC ${signals.filter(s => s.strat === "PSC").length})`);
  const nIso = signals.filter(s => s.clusterSize === 1).length;
  const nCl2 = signals.filter(s => s.clusterSize === 2).length;
  const nCl3 = signals.filter(s => s.clusterSize >= 3).length;
  console.log(`[cluster] isolated(=1): ${nIso} / cluster2: ${nCl2} / cluster3+: ${nCl3}  (cluster合計 ${nCl2 + nCl3} = ${((nCl2 + nCl3) / signals.length * 100).toFixed(1)}%)`);

  // forward return を計算して bucket に振り分け
  function fwd(sig: Signal): { raw: Record<number, number | null>; excess: Record<number, number | null> } {
    const bars = allData.get(sig.ticker);
    const idxMap = dateIndexMap.get(sig.ticker);
    const raw: Record<number, number | null> = {};
    const excess: Record<number, number | null> = {};
    const dayIdx = tradingDayIndex.get(sig.date);
    const i = idxMap?.get(sig.date);
    for (const h of HORIZONS) {
      raw[h] = null; excess[h] = null;
      if (!bars || i == null) continue;
      const j = i + h;
      if (j >= bars.length) continue;
      const fc = bars[j]?.close;
      if (fc == null || sig.entryPrice <= 0) continue;
      const rawRet = ((fc - sig.entryPrice) / sig.entryPrice) * 100;
      raw[h] = rawRet;
      let ex = rawRet;
      if (dayIdx != null) {
        const futDate = tradingDays[dayIdx + h];
        const c0 = idxClose(sig.date);
        const c1 = futDate ? idxClose(futDate) : null;
        if (c0 != null && c1 != null && c0 > 0) ex = rawRet - ((c1 - c0) / c0) * 100;
      }
      excess[h] = ex;
    }
    return { raw, excess };
  }

  function collect(filter: (s: Signal) => boolean): Bucket {
    const b = emptyBucket();
    for (const s of signals) {
      if (!filter(s)) continue;
      const f = fwd(s);
      for (const h of HORIZONS) {
        if (f.raw[h] != null) b.raw[h].push(f.raw[h]!);
        if (f.excess[h] != null) b.excess[h].push(f.excess[h]!);
      }
    }
    return b;
  }

  function printBucket(label: string, b: Bucket) {
    const cells = HORIZONS.map((h) => {
      const rm = mean(b.raw[h]);
      const em = mean(b.excess[h]);
      const t = oneSampleT(b.excess[h]);
      const pp = pctPositive(b.excess[h]);
      return `${(rm >= 0 ? "+" : "") + rm.toFixed(2)}/${(em >= 0 ? "+" : "") + em.toFixed(2)}(t${t.toFixed(1)})/${pp.toFixed(0)}%`;
    });
    console.log(`${label.padEnd(16)}| n=${String(b.excess[5].length).padStart(5)} |` + cells.map(c => ` ${c.padStart(24)} |`).join(""));
  }

  const iso = collect((s) => s.clusterSize === 1);
  const cl = collect((s) => s.clusterSize >= 2);
  const cl2 = collect((s) => s.clusterSize === 2);
  const cl3 = collect((s) => s.clusterSize >= 3);

  const header = `${"層別".padEnd(16)}| ${"n".padStart(7)} |` + HORIZONS.map(h => ` ${("+" + h + "d 生/超過(t)/勝%").padStart(24)} |`).join("");
  console.log("\n【全体: cluster vs isolated】 セル = 生平均% / N225超過平均%(t) / 超過勝率%");
  console.log(header);
  console.log("-".repeat(header.length));
  printBucket("isolated(=1)", iso);
  printBucket("cluster(>=2)", cl);
  printBucket("  cluster2", cl2);
  printBucket("  cluster3+", cl3);

  console.log("\n【cluster - isolated の差 (Welch t)】 超過リターンの差; t>2 で cluster が有意に上");
  const diffCells = HORIZONS.map((h) => {
    const d = mean(cl.excess[h]) - mean(iso.excess[h]);
    const t = welchT(cl.excess[h], iso.excess[h]);
    return `${(d >= 0 ? "+" : "") + d.toFixed(2)}pp (t${t.toFixed(2)})`;
  });
  console.log(`${"cluster-iso".padEnd(16)}|` + diffCells.map(c => ` ${c.padStart(24)} |`).join(""));

  // GU / PSC 別
  for (const strat of ["GU", "PSC"] as const) {
    const i = collect((s) => s.clusterSize === 1 && s.strat === strat);
    const c = collect((s) => s.clusterSize >= 2 && s.strat === strat);
    console.log(`\n【${strat} のみ: cluster vs isolated】`);
    console.log(header);
    console.log("-".repeat(header.length));
    printBucket(`${strat} isolated`, i);
    console.log(`${(strat + " cluster").padEnd(16)}| n=${String(c.excess[5].length).padStart(5)} |` +
      HORIZONS.map((h) => {
        const rm = mean(c.raw[h]); const em = mean(c.excess[h]);
        const t = oneSampleT(c.excess[h]); const pp = pctPositive(c.excess[h]);
        const dt = welchT(c.excess[h], i.excess[h]);
        return ` ${`${(rm>=0?"+":"")+rm.toFixed(2)}/${(em>=0?"+":"")+em.toFixed(2)}(t${t.toFixed(1)})/${pp.toFixed(0)}% Δt${dt.toFixed(1)}`.padStart(24)} |`;
      }).join(""));
  }

  console.log("\n解釈ガイド:");
  console.log("  cluster-iso の差が +pp かつ Welch t>2 (特にH3-H5) → boost する価値のあるエッジ候補");
  console.log("  差が ~0 / − または t が有意でない → #18-20 と同じ結末 (セクター情報は上乗せ価値なし)");
  console.log("  ※次段階(combined でサイズ傾斜/枠追加)は、ここで cluster 優位が出た時のみ。DDが焦点。");

  await prisma.$disconnect();
}

// precompute の返り値2種を共通で回すための最小 structural 型
type PrecomputedGapUpSignalsLike = Map<string, { ticker: string; entryPrice: number }[]>;

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
