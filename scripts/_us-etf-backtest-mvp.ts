/**
 * 米株 ETF (1547, 1545) シンプル gap-up 戦略 BT
 *
 * 設計 (A-3a 結合効果検証で確定):
 *   - breadth フィルター: 日本株 breadth < 54% の日のみエントリー (idle 帯補完)
 *   - 既存戦略と機会を取り合わずに ETF 単独で動く
 *
 * 出力:
 *   - フィルターなし (旧 MVP) と フィルター付き (改良版) を並列で出力 → 比較
 *
 * 一時利用
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

interface Trade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  pnlPct: number;
  reason: "sl" | "time" | "open";
}

// CLI 上書き可（後方互換: 未指定なら米株ETF既定）
//   例: npx tsx scripts/_us-etf-backtest-mvp.ts --tickers 1326.T,1540.T --start 2018-01-01 --end 2026-06-30
function _arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const TICKERS = (_arg("--tickers") ?? "1547,1545").split(",").map((t) => t.trim());
const START_DATE = _arg("--start") ?? "2018-01-01";
const END_DATE = _arg("--end") ?? "2026-04-30";
const GAP_MIN_PCT = 0.005;
const VOLUME_SURGE_RATIO = 1.5;
const SL_PCT = 0.02;
const TIME_STOP_DAYS = 5;
const VOL_LOOKBACK = 25;
const ROUND_TRIP_COST = Number(_arg("--cost") ?? "0"); // 往復コスト%（各トレードから控除）

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
  opts: { breadthFilter?: Map<string, number> | null } = {},
): Trade[] {
  const trades: Trade[] = [];
  let position: { entryIdx: number; entryPrice: number } | null = null;

  for (let i = VOL_LOOKBACK; i < bars.length; i++) {
    const today = bars[i];
    const prev = bars[i - 1];

    // 出口判定
    if (position) {
      const slPrice = position.entryPrice * (1 - SL_PCT);
      const daysHeld = i - position.entryIdx;

      if (today.low <= slPrice) {
        trades.push({
          ticker,
          entryDate: bars[position.entryIdx].date,
          exitDate: today.date,
          pnlPct: ((slPrice - position.entryPrice) / position.entryPrice) * 100 - ROUND_TRIP_COST,
          reason: "sl",
        });
        position = null;
        continue;
      }
      if (daysHeld >= TIME_STOP_DAYS) {
        trades.push({
          ticker,
          entryDate: bars[position.entryIdx].date,
          exitDate: today.date,
          pnlPct: ((today.close - position.entryPrice) / position.entryPrice) * 100 - ROUND_TRIP_COST,
          reason: "time",
        });
        position = null;
        continue;
      }
    }

    // エントリー判定
    if (!position) {
      const gap = (today.open - prev.close) / prev.close;
      const isUpDay = today.close > today.open;
      const avgVol =
        bars.slice(i - VOL_LOOKBACK, i).reduce((s, b) => s + b.volume, 0) / VOL_LOOKBACK;
      const volSurge = today.volume / avgVol;

      if (gap >= GAP_MIN_PCT && isUpDay && volSurge >= VOLUME_SURGE_RATIO) {
        // breadth フィルター: 前日の日本株 breadth < 54% (idle 帯) のみ
        if (opts.breadthFilter) {
          const breadth = opts.breadthFilter.get(prev.date);
          if (breadth == null || breadth >= MARKET_BREADTH.THRESHOLD) {
            continue;
          }
        }
        position = { entryIdx: i, entryPrice: today.close };
      }
    }
  }

  if (position) {
    const last = bars[bars.length - 1];
    trades.push({
      ticker,
      entryDate: bars[position.entryIdx].date,
      exitDate: last.date,
      pnlPct: ((last.close - position.entryPrice) / position.entryPrice) * 100 - ROUND_TRIP_COST,
      reason: "open",
    });
  }

  return trades;
}

function summarize(label: string, trades: Trade[]) {
  if (trades.length === 0) {
    console.log(`\n[${label}] トレードなし`);
    return;
  }
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct < 0);
  const winRate = (wins.length / trades.length) * 100;
  const gp = wins.reduce((s, t) => s + t.pnlPct, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const pf = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
  const avgWin = wins.length > 0 ? gp / wins.length : 0;
  const avgLoss = losses.length > 0 ? -gl / losses.length : 0;
  const expectancy = (winRate / 100) * avgWin + ((100 - winRate) / 100) * avgLoss;
  const totalPnl = trades.reduce((s, t) => s + t.pnlPct, 0);

  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of trades) {
    cum += t.pnlPct;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }

  console.log(`\n[${label}]`);
  console.log(`  トレード数: ${trades.length} (勝${wins.length} / 負${losses.length})`);
  console.log(`  勝率: ${winRate.toFixed(1)}%`);
  console.log(`  PF: ${pf === Infinity ? "∞" : pf.toFixed(2)}`);
  console.log(`  期待値: ${expectancy >= 0 ? "+" : ""}${expectancy.toFixed(2)}%`);
  console.log(`  平均勝: +${avgWin.toFixed(2)}% / 平均負: ${avgLoss.toFixed(2)}%`);
  console.log(`  累計リターン: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}%`);
  console.log(`  MaxDD: -${dd.toFixed(2)}%`);
  console.log(`  Calmar (totalReturn / MaxDD): ${dd > 0 ? (totalPnl / dd).toFixed(2) : "N/A"}`);

  // 年別
  const byYear = new Map<string, Trade[]>();
  for (const t of trades) {
    const y = t.entryDate.slice(0, 4);
    const arr = byYear.get(y) ?? [];
    arr.push(t);
    byYear.set(y, arr);
  }
  console.log(`  年別:`);
  for (const y of [...byYear.keys()].sort()) {
    const arr = byYear.get(y)!;
    const pct = arr.reduce((s, t) => s + t.pnlPct, 0);
    const w = arr.filter((t) => t.pnlPct > 0).length;
    console.log(`    ${y}: ${arr.length}件, 勝率${((w / arr.length) * 100).toFixed(0)}%, ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`);
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log(`米株 ETF BT: ${START_DATE} 〜 ${END_DATE}`);
  console.log(`gap >= ${(GAP_MIN_PCT * 100).toFixed(1)}%, vol >= ${VOLUME_SURGE_RATIO}x, SL -${SL_PCT * 100}%, time ${TIME_STOP_DAYS}d`);
  console.log("=".repeat(70));

  // 日本株 breadth を取得
  const breadthSeries = await fetchBreadthSeries({ lookbackDays: 2200 });
  const breadthMap = new Map<string, number>();
  for (const p of breadthSeries) {
    breadthMap.set(dayjs(p.date).format("YYYY-MM-DD"), p.breadth);
  }

  // 各 ticker のデータをキャッシュ
  const allBars = new Map<string, OHLCV[]>();
  for (const t of TICKERS) {
    allBars.set(t, await fetchData(t));
  }

  // フィルターなし
  const noFilterTrades: Trade[] = [];
  for (const t of TICKERS) {
    noFilterTrades.push(...runStrategy(t, allBars.get(t)!));
  }
  summarize("フィルターなし (旧 MVP)", noFilterTrades);

  // フィルター付き (breadth < 54%)
  const filteredTrades: Trade[] = [];
  for (const t of TICKERS) {
    filteredTrades.push(...runStrategy(t, allBars.get(t)!, { breadthFilter: breadthMap }));
  }
  summarize("フィルター付き (breadth < 54%)", filteredTrades);

  // 比較
  console.log("\n" + "=".repeat(70));
  console.log("比較");
  console.log("=".repeat(70));
  const total1 = noFilterTrades.reduce((s, t) => s + t.pnlPct, 0);
  const total2 = filteredTrades.reduce((s, t) => s + t.pnlPct, 0);
  console.log(`累計リターン: ${total1.toFixed(2)}% → ${total2.toFixed(2)}% (${(total2 - total1).toFixed(2)}pp)`);
  console.log(`トレード数: ${noFilterTrades.length} → ${filteredTrades.length}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
