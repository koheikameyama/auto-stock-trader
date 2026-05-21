/**
 * 米株 ETF (1547, 1545) MVP 戦略の Walk-Forward 検証
 *
 * A-3: パラメータの過学習チェック
 * - IS 12ヶ月 / OOS 6ヶ月 / slide 6ヶ月
 * - パラメータグリッド: gap × vol × SL = 27通り
 *
 * 一時利用、A-3 検証完了後に削除
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import { fetchBreadthSeries } from "../src/core/breadth-history";
import { MARKET_BREADTH } from "../src/lib/constants/trading";

interface OHLCV {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Params {
  gapMinPct: number;
  volumeSurgeRatio: number;
  slPct: number;
}

interface Trade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  pnlPct: number;
}

interface Metrics {
  trades: number;
  winRate: number;
  pf: number;
  expectancy: number;
  totalReturn: number;
  maxDD: number;
}

const TICKERS = ["1547", "1545"];
const START_DATE = "2018-01-01";
const END_DATE = "2026-04-30";
const TIME_STOP_DAYS = 5;
const VOL_LOOKBACK = 25;
const IS_MONTHS = 12;
const OOS_MONTHS = 6;
const SLIDE_MONTHS = 6;

const PARAM_GRID: Params[] = [];
for (const gap of [0.003, 0.005, 0.008]) {
  for (const vol of [1.3, 1.5, 1.8]) {
    for (const sl of [0.015, 0.02, 0.03]) {
      PARAM_GRID.push({ gapMinPct: gap, volumeSurgeRatio: vol, slPct: sl });
    }
  }
}

async function fetchData(ticker: string): Promise<OHLCV[]> {
  const rows = await prisma.stockDailyBar.findMany({
    where: {
      tickerCode: ticker,
      date: {
        gte: new Date(`${START_DATE}T00:00:00Z`),
        lte: new Date(`${END_DATE}T00:00:00Z`),
      },
    },
    orderBy: { date: "asc" },
    select: { date: true, open: true, high: true, low: true, close: true, volume: true },
  });
  return rows.map((r) => ({
    date: dayjs(r.date).format("YYYY-MM-DD"),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: Number(r.volume),
  }));
}

function runStrategy(
  ticker: string,
  bars: OHLCV[],
  start: string,
  end: string,
  p: Params,
  breadthMap: Map<string, number>,
): Trade[] {
  const trades: Trade[] = [];
  const inWindow = (d: string) => d >= start && d <= end;
  let position: { entryIdx: number; entryPrice: number } | null = null;

  for (let i = VOL_LOOKBACK; i < bars.length; i++) {
    const today = bars[i];
    const prev = bars[i - 1];

    // ポジション中
    if (position) {
      const slPrice = position.entryPrice * (1 - p.slPct);
      const daysHeld = i - position.entryIdx;

      if (today.low <= slPrice) {
        trades.push({
          ticker,
          entryDate: bars[position.entryIdx].date,
          exitDate: today.date,
          pnlPct: ((slPrice - position.entryPrice) / position.entryPrice) * 100,
        });
        position = null;
        continue;
      }
      if (daysHeld >= TIME_STOP_DAYS) {
        trades.push({
          ticker,
          entryDate: bars[position.entryIdx].date,
          exitDate: today.date,
          pnlPct: ((today.close - position.entryPrice) / position.entryPrice) * 100,
        });
        position = null;
        continue;
      }
    }

    // エントリー判定 (ウィンドウ内のみ)
    if (!position && inWindow(today.date)) {
      const gap = (today.open - prev.close) / prev.close;
      const isUpDay = today.close > today.open;
      const avgVol = bars.slice(i - VOL_LOOKBACK, i).reduce((s, b) => s + b.volume, 0) / VOL_LOOKBACK;
      const volSurge = today.volume / avgVol;

      if (gap >= p.gapMinPct && isUpDay && volSurge >= p.volumeSurgeRatio) {
        // breadth フィルター: 前日の日本株 breadth < 54% (idle 帯) のみエントリー
        const breadth = breadthMap.get(prev.date);
        if (breadth == null || breadth >= MARKET_BREADTH.THRESHOLD) {
          continue;
        }
        position = { entryIdx: i, entryPrice: today.close };
      }
    }
  }

  return trades;
}

function computeMetrics(trades: Trade[]): Metrics {
  if (trades.length === 0) {
    return { trades: 0, winRate: 0, pf: 0, expectancy: 0, totalReturn: 0, maxDD: 0 };
  }
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct < 0);
  const gp = wins.reduce((s, t) => s + t.pnlPct, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const pf = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
  const totalReturn = trades.reduce((s, t) => s + t.pnlPct, 0);
  const winRate = (wins.length / trades.length) * 100;
  const avgWin = wins.length > 0 ? gp / wins.length : 0;
  const avgLoss = losses.length > 0 ? -gl / losses.length : 0;
  const expectancy = (winRate / 100) * avgWin + ((100 - winRate) / 100) * avgLoss;
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of trades) {
    cum += t.pnlPct;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }
  return { trades: trades.length, winRate, pf, expectancy, totalReturn, maxDD: dd };
}

function runAll(
  allBars: Map<string, OHLCV[]>,
  start: string,
  end: string,
  p: Params,
  breadthMap: Map<string, number>,
): Trade[] {
  const all: Trade[] = [];
  for (const t of TICKERS) {
    all.push(...runStrategy(t, allBars.get(t)!, start, end, p, breadthMap));
  }
  return all;
}

async function main() {
  console.log("=".repeat(80));
  console.log("米株 ETF MVP Walk-Forward 検証");
  console.log("=".repeat(80));

  const allBars = new Map<string, OHLCV[]>();
  for (const t of TICKERS) {
    allBars.set(t, await fetchData(t));
  }

  // 日本株 breadth (フィルター用)
  const breadthSeries = await fetchBreadthSeries({ lookbackDays: 2200 });
  const breadthMap = new Map<string, number>();
  for (const p of breadthSeries) {
    breadthMap.set(dayjs(p.date).format("YYYY-MM-DD"), p.breadth);
  }

  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log(`期間: ${START_DATE} 〜 ${END_DATE}`);
  console.log(`breadth フィルター: < 54% (idle 帯のみ)`);
  console.log(`IS ${IS_MONTHS}m / OOS ${OOS_MONTHS}m / slide ${SLIDE_MONTHS}m`);
  console.log(`パラメータグリッド: ${PARAM_GRID.length}通り\n`);

  // ウィンドウ生成
  type Window = { idx: number; isStart: string; isEnd: string; oosStart: string; oosEnd: string };
  const windows: Window[] = [];
  let cursor = dayjs(START_DATE);
  const endLimit = dayjs(END_DATE);
  let idx = 0;
  while (true) {
    const isStart = cursor.format("YYYY-MM-DD");
    const isEnd = cursor.add(IS_MONTHS, "month").subtract(1, "day").format("YYYY-MM-DD");
    const oosStart = cursor.add(IS_MONTHS, "month").format("YYYY-MM-DD");
    const oosEnd = cursor.add(IS_MONTHS + OOS_MONTHS, "month").subtract(1, "day").format("YYYY-MM-DD");
    if (dayjs(oosEnd).isAfter(endLimit)) break;
    windows.push({ idx: ++idx, isStart, isEnd, oosStart, oosEnd });
    cursor = cursor.add(SLIDE_MONTHS, "month");
  }
  console.log(`ウィンドウ数: ${windows.length}\n`);

  // 各ウィンドウで IS 最適化 → OOS 評価
  const wfResults: { window: Window; bestParams: Params; isMetrics: Metrics; oosMetrics: Metrics }[] = [];

  for (const w of windows) {
    const isResults = PARAM_GRID.map((p) => {
      const trades = runAll(allBars, w.isStart, w.isEnd, p, breadthMap);
      return { params: p, metrics: computeMetrics(trades) };
    });
    // PF 最大 (ただしトレード数 3以上)
    const candidates = isResults.filter((r) => r.metrics.trades >= 3);
    if (candidates.length === 0) {
      console.log(`Window ${w.idx} (IS ${w.isStart}〜${w.isEnd}): IS トレード <3 で休止`);
      continue;
    }
    const best = candidates.reduce((a, b) => (b.metrics.pf > a.metrics.pf ? b : a));
    const oosTrades = runAll(allBars, w.oosStart, w.oosEnd, best.params, breadthMap);
    const oosMetrics = computeMetrics(oosTrades);
    wfResults.push({ window: w, bestParams: best.params, isMetrics: best.metrics, oosMetrics });

    console.log(
      `Window ${String(w.idx).padStart(2)} | IS ${w.isStart}〜${w.isEnd} | OOS ${w.oosStart}〜${w.oosEnd}`,
    );
    console.log(
      `   IS:  PF ${best.metrics.pf.toFixed(2)}, trades ${best.metrics.trades}, return ${best.metrics.totalReturn.toFixed(2)}%`,
    );
    console.log(
      `   OOS: PF ${oosMetrics.pf.toFixed(2)}, trades ${oosMetrics.trades}, return ${oosMetrics.totalReturn.toFixed(2)}%`,
    );
    console.log(
      `   best: gap=${(best.params.gapMinPct * 100).toFixed(1)}%, vol=${best.params.volumeSurgeRatio}, SL=${(best.params.slPct * 100).toFixed(1)}%`,
    );
    console.log("");
  }

  // 集計
  console.log("=".repeat(80));
  console.log("Walk-Forward サマリー");
  console.log("=".repeat(80));

  const allOOSTrades: Trade[] = [];
  for (const r of wfResults) {
    const trades = runAll(allBars, r.window.oosStart, r.window.oosEnd, r.bestParams, breadthMap);
    allOOSTrades.push(...trades);
  }
  const oosSummary = computeMetrics(allOOSTrades);
  const isAvgPF =
    wfResults.reduce((s, r) => s + r.isMetrics.pf, 0) / Math.max(1, wfResults.length);
  const oosAvgPF =
    wfResults.reduce((s, r) => s + r.oosMetrics.pf, 0) / Math.max(1, wfResults.length);
  const ratio = oosAvgPF > 0 ? isAvgPF / oosAvgPF : Infinity;

  console.log(`アクティブウィンドウ: ${wfResults.length}/${windows.length}`);
  console.log(`OOS集計: PF ${oosSummary.pf.toFixed(2)}, trades ${oosSummary.trades}, winRate ${oosSummary.winRate.toFixed(1)}%`);
  console.log(`         totalReturn ${oosSummary.totalReturn.toFixed(2)}%, maxDD -${oosSummary.maxDD.toFixed(2)}%`);
  console.log(`IS平均PF: ${isAvgPF.toFixed(2)} / OOS平均PF: ${oosAvgPF.toFixed(2)} / IS/OOS比: ${ratio.toFixed(2)}`);

  // 過学習判定
  let verdict = "";
  if (oosSummary.pf >= 1.3 && ratio <= 2.0) verdict = "堅牢 ✓";
  else if (oosSummary.pf >= 1.0 && ratio <= 3.0) verdict = "要注意 △";
  else verdict = "過学習 ✗";
  console.log(`\n判定: ${verdict}`);

  // パラメータ安定性
  console.log("\nパラメータ安定性:");
  const gapCounts = new Map<number, number>();
  const volCounts = new Map<number, number>();
  const slCounts = new Map<number, number>();
  for (const r of wfResults) {
    gapCounts.set(r.bestParams.gapMinPct, (gapCounts.get(r.bestParams.gapMinPct) ?? 0) + 1);
    volCounts.set(r.bestParams.volumeSurgeRatio, (volCounts.get(r.bestParams.volumeSurgeRatio) ?? 0) + 1);
    slCounts.set(r.bestParams.slPct, (slCounts.get(r.bestParams.slPct) ?? 0) + 1);
  }
  const sortFmt = (m: Map<number, number>) =>
    [...m.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([v, c]) => `${v}(${c})`)
      .join(", ");
  console.log(`  gap: ${sortFmt(gapCounts)}`);
  console.log(`  vol: ${sortFmt(volCounts)}`);
  console.log(`  SL : ${sortFmt(slCounts)}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
