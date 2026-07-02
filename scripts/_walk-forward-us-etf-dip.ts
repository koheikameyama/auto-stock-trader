/**
 * 米株 ETF (1547, 1545) 押し目(dip / mean-reversion)戦略の Walk-Forward 検証
 *
 * パイロット (_us-etf-dip-backtest.ts) で RSI(2)<10 の Connors 型押し目が
 * 8.5年 PF 2.0 / Calmar 5.2 (コスト0.2%込み) と単発ゲートを通過。
 * 却下リスト鉄則「単発BTがゲートを超えても WF で過半数の窓で安定するまで本番反映しない」
 * に従い、パラメータの過学習を検証する。
 *
 * 構造は勝ち筋に固定:
 *   - 上昇トレンドゲート: close > SMA50
 *   - dip トリガー: RSI(2) <= rsiMax
 *   - 反発確認: なし (Connors 原型)
 *   - 出口: mean-reversion (close>SMA5 or RSI2>=70) + SL + 最大保有日数  (--exit-mode timesl で time+sl に切替)
 *
 * グリッド (27通り、エントリー深さ×リスクのみ):
 *   rsiMax [5,10,15] × slPct [0.02,0.03,0.05] × maxHoldDays [7,10,15]
 *
 * 一時利用 (`_` プレフィックス)。本番コードには一切触れない。
 *   例: npx tsx scripts/_walk-forward-us-etf-dip.ts --cost 0.2            # breadth OFF (常時)
 *       npx tsx scripts/_walk-forward-us-etf-dip.ts --cost 0.2 --filter  # breadth ON (idle帯)
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import { fetchBreadthSeries } from "../src/core/breadth-history";
import { MARKET_BREADTH } from "../src/lib/constants/trading";

interface OHLCV { date: string; open: number; high: number; low: number; close: number; volume: number; }
interface Params { rsiMax: number; slPct: number; maxHoldDays: number; }
interface Trade { ticker: string; entryDate: string; exitDate: string; pnlPct: number; }
interface Metrics { trades: number; winRate: number; pf: number; expectancy: number; totalReturn: number; maxDD: number; }

function _arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const TICKERS = (_arg("--tickers") ?? "1547,1545").split(",").map((t) => t.trim());
const START_DATE = _arg("--start") ?? "2018-01-01";
const END_DATE = _arg("--end") ?? "2026-05-21";
const USE_BREADTH_FILTER = process.argv.includes("--filter"); // 既定 OFF (押し目は常時スリーブ候補)
const ROUND_TRIP_COST = Number(_arg("--cost") ?? "0");
const EXIT_MODE = (_arg("--exit-mode") ?? "meanrev") as "meanrev" | "timesl";
const TREND_PERIOD = 50;
const EXIT_SMA_PERIOD = 5;
const EXIT_RSI_LEVEL = 70;
const IS_MONTHS = 12;
const OOS_MONTHS = 6;
const SLIDE_MONTHS = 6;

const PARAM_GRID: Params[] = [];
for (const rsiMax of [5, 10, 15]) {
  for (const slPct of [0.02, 0.03, 0.05]) {
    for (const maxHoldDays of [7, 10, 15]) {
      PARAM_GRID.push({ rsiMax, slPct, maxHoldDays });
    }
  }
}

async function fetchData(ticker: string): Promise<OHLCV[]> {
  const rows = await prisma.stockDailyBar.findMany({
    where: { tickerCode: ticker, date: { gte: new Date(`${START_DATE}T00:00:00Z`), lte: new Date(`${END_DATE}T00:00:00Z`) } },
    orderBy: { date: "asc" },
    select: { date: true, open: true, high: true, low: true, close: true, volume: true },
  });
  return rows.map((r) => ({
    date: dayjs(r.date).format("YYYY-MM-DD"),
    open: r.open, high: r.high, low: r.low, close: r.close, volume: Number(r.volume),
  }));
}

function sma(bars: OHLCV[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function wilderRsi(bars: OHLCV[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    if (ch >= 0) avgGain += ch; else avgLoss -= ch;
  }
  avgGain /= period; avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < bars.length; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    const gain = ch >= 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ticker ごとの指標をキャッシュ（窓・パラメータをまたいで再利用）
interface Indicators { trendSma: (number | null)[]; exitSma: (number | null)[]; rsi2: (number | null)[]; }
const indicatorCache = new Map<string, Indicators>();
function getIndicators(ticker: string, bars: OHLCV[]): Indicators {
  let ind = indicatorCache.get(ticker);
  if (!ind) {
    ind = { trendSma: sma(bars, TREND_PERIOD), exitSma: sma(bars, EXIT_SMA_PERIOD), rsi2: wilderRsi(bars, 2) };
    indicatorCache.set(ticker, ind);
  }
  return ind;
}

function runStrategy(ticker: string, bars: OHLCV[], start: string, end: string, p: Params, breadthMap: Map<string, number>): Trade[] {
  const trades: Trade[] = [];
  const inWindow = (d: string) => d >= start && d <= end;
  const { trendSma, exitSma, rsi2 } = getIndicators(ticker, bars);
  const warmup = TREND_PERIOD + 1;
  let position: { entryIdx: number; entryPrice: number } | null = null;

  for (let i = warmup; i < bars.length; i++) {
    const today = bars[i];

    if (position) {
      const slPrice = position.entryPrice * (1 - p.slPct);
      const daysHeld = i - position.entryIdx;
      if (today.low <= slPrice) {
        trades.push({ ticker, entryDate: bars[position.entryIdx].date, exitDate: today.date, pnlPct: ((slPrice - position.entryPrice) / position.entryPrice) * 100 - ROUND_TRIP_COST });
        position = null; continue;
      }
      if (EXIT_MODE === "meanrev") {
        const es = exitSma[i]; const er = rsi2[i];
        if ((es != null && today.close > es) || (er != null && er >= EXIT_RSI_LEVEL)) {
          trades.push({ ticker, entryDate: bars[position.entryIdx].date, exitDate: today.date, pnlPct: ((today.close - position.entryPrice) / position.entryPrice) * 100 - ROUND_TRIP_COST });
          position = null; continue;
        }
      }
      if (daysHeld >= p.maxHoldDays) {
        trades.push({ ticker, entryDate: bars[position.entryIdx].date, exitDate: today.date, pnlPct: ((today.close - position.entryPrice) / position.entryPrice) * 100 - ROUND_TRIP_COST });
        position = null; continue;
      }
    }

    if (!position && inWindow(today.date)) {
      const ts = trendSma[i];
      if (ts == null || today.close <= ts) continue; // 上昇トレンドゲート
      const r = rsi2[i];
      if (r == null || r > p.rsiMax) continue; // dip トリガー
      if (USE_BREADTH_FILTER) {
        const b = breadthMap.get(bars[i - 1].date);
        if (b == null || b >= MARKET_BREADTH.THRESHOLD) continue;
      }
      position = { entryIdx: i, entryPrice: today.close };
    }
  }
  return trades;
}

function computeMetrics(trades: Trade[]): Metrics {
  if (trades.length === 0) return { trades: 0, winRate: 0, pf: 0, expectancy: 0, totalReturn: 0, maxDD: 0 };
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
  let cum = 0, peak = 0, dd = 0;
  for (const t of trades) { cum += t.pnlPct; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }
  return { trades: trades.length, winRate, pf, expectancy, totalReturn, maxDD: dd };
}

function runAll(allBars: Map<string, OHLCV[]>, start: string, end: string, p: Params, breadthMap: Map<string, number>): Trade[] {
  const all: Trade[] = [];
  for (const t of TICKERS) all.push(...runStrategy(t, allBars.get(t)!, start, end, p, breadthMap));
  return all;
}

async function main() {
  console.log("=".repeat(80));
  console.log("米株 ETF 押し目(dip) Walk-Forward 検証");
  console.log("=".repeat(80));

  const allBars = new Map<string, OHLCV[]>();
  for (const t of TICKERS) allBars.set(t, await fetchData(t));

  const breadthSeries = await fetchBreadthSeries({ lookbackDays: 2300 });
  const breadthMap = new Map<string, number>();
  for (const p of breadthSeries) breadthMap.set(dayjs(p.date).format("YYYY-MM-DD"), p.breadth);

  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log(`期間: ${START_DATE} 〜 ${END_DATE}  往復コスト ${ROUND_TRIP_COST}%`);
  console.log(`構造: SMA${TREND_PERIOD}ゲート + RSI2<=rsiMax + ${EXIT_MODE}出口`);
  console.log(`breadth フィルター: ${USE_BREADTH_FILTER ? "ON (<54% idle帯)" : "OFF (常時)"}`);
  console.log(`IS ${IS_MONTHS}m / OOS ${OOS_MONTHS}m / slide ${SLIDE_MONTHS}m / グリッド ${PARAM_GRID.length}通り\n`);

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

  const wfResults: { window: Window; bestParams: Params; isMetrics: Metrics; oosMetrics: Metrics }[] = [];

  for (const w of windows) {
    const isResults = PARAM_GRID.map((p) => ({ params: p, metrics: computeMetrics(runAll(allBars, w.isStart, w.isEnd, p, breadthMap)) }));
    const candidates = isResults.filter((r) => r.metrics.trades >= 3);
    if (candidates.length === 0) {
      console.log(`Window ${w.idx} (IS ${w.isStart}〜${w.isEnd}): IS トレード <3 で休止`);
      continue;
    }
    // IS選択は期待値最大（PF最大だと無敗=∞が同点になりグリッド順を拾う退化を起こすため）。
    // 同点は trades 多い方を優先。
    const best = candidates.reduce((a, b) => {
      if (b.metrics.expectancy !== a.metrics.expectancy) return b.metrics.expectancy > a.metrics.expectancy ? b : a;
      return b.metrics.trades > a.metrics.trades ? b : a;
    });
    const oosMetrics = computeMetrics(runAll(allBars, w.oosStart, w.oosEnd, best.params, breadthMap));
    wfResults.push({ window: w, bestParams: best.params, isMetrics: best.metrics, oosMetrics });
    console.log(`Window ${String(w.idx).padStart(2)} | IS ${w.isStart}〜${w.isEnd} | OOS ${w.oosStart}〜${w.oosEnd}`);
    console.log(`   IS:  PF ${best.metrics.pf.toFixed(2)}, tr ${best.metrics.trades}, ret ${best.metrics.totalReturn.toFixed(1)}%`);
    console.log(`   OOS: PF ${oosMetrics.pf.toFixed(2)}, tr ${oosMetrics.trades}, ret ${oosMetrics.totalReturn.toFixed(1)}%`);
    console.log(`   best: rsiMax=${best.params.rsiMax}, SL=${(best.params.slPct * 100).toFixed(0)}%, hold=${best.params.maxHoldDays}d\n`);
  }

  console.log("=".repeat(80));
  console.log("Walk-Forward サマリー");
  console.log("=".repeat(80));

  // 集計は「窓ごとの選択パラメータで回した IS/OOS トレードをプール」して1つのPFに（∞平均を回避）
  const allISTrades: Trade[] = [];
  const allOOSTrades: Trade[] = [];
  for (const r of wfResults) {
    allISTrades.push(...runAll(allBars, r.window.isStart, r.window.isEnd, r.bestParams, breadthMap));
    allOOSTrades.push(...runAll(allBars, r.window.oosStart, r.window.oosEnd, r.bestParams, breadthMap));
  }
  const isSummary = computeMetrics(allISTrades);
  const oosSummary = computeMetrics(allOOSTrades);
  const ratio = oosSummary.pf > 0 && Number.isFinite(oosSummary.pf) ? isSummary.pf / oosSummary.pf : Infinity;
  const oosWinWindows = wfResults.filter((r) => r.oosMetrics.pf >= 1.0).length;

  console.log(`アクティブウィンドウ: ${wfResults.length}/${windows.length}`);
  console.log(`OOS勝ち越し窓 (PF≥1.0): ${oosWinWindows}/${wfResults.length}`);
  console.log(`OOS集計: PF ${oosSummary.pf.toFixed(2)}, tr ${oosSummary.trades}, WR ${oosSummary.winRate.toFixed(1)}%, ret ${oosSummary.totalReturn.toFixed(1)}%, maxDD -${oosSummary.maxDD.toFixed(1)}%`);
  console.log(`プールIS PF ${isSummary.pf.toFixed(2)} / プールOOS PF ${oosSummary.pf.toFixed(2)} / IS/OOS比 ${Number.isFinite(ratio) ? ratio.toFixed(2) : "∞"}`);

  // 判定: OOS集計PF + IS/OOS比 + 窓の過半数プラス を総合
  const majority = oosWinWindows / Math.max(1, wfResults.length) >= 0.6;
  let verdict = "";
  if (oosSummary.pf >= 1.3 && ratio <= 2.0 && majority) verdict = "堅牢 ✓";
  else if (oosSummary.pf >= 1.0 && ratio <= 3.0) verdict = "要注意 △";
  else verdict = "過学習 ✗";
  console.log(`\n判定: ${verdict}`);

  console.log("\nパラメータ安定性:");
  const c = { rsiMax: new Map<number, number>(), slPct: new Map<number, number>(), maxHoldDays: new Map<number, number>() };
  for (const r of wfResults) {
    c.rsiMax.set(r.bestParams.rsiMax, (c.rsiMax.get(r.bestParams.rsiMax) ?? 0) + 1);
    c.slPct.set(r.bestParams.slPct, (c.slPct.get(r.bestParams.slPct) ?? 0) + 1);
    c.maxHoldDays.set(r.bestParams.maxHoldDays, (c.maxHoldDays.get(r.bestParams.maxHoldDays) ?? 0) + 1);
  }
  const fmt = (m: Map<number, number>) => [...m.entries()].sort(([, a], [, b]) => b - a).map(([v, n]) => `${v}(${n})`).join(", ");
  console.log(`  rsiMax: ${fmt(c.rsiMax)}`);
  console.log(`  SL    : ${fmt(c.slPct)}`);
  console.log(`  hold  : ${fmt(c.maxHoldDays)}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
