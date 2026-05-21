/**
 * 米株 ETF (1547, 1545) シンプル gap-up 戦略 MVP バックテスト
 *
 * A-2 MVP: シグナル検証のための最小実装
 * - エントリー: 当日 gap >= 0.5% + 陽線 + 出来高 1.5x
 * - 損切り: -2% (固定)
 * - タイムストップ: 5営業日
 * - リスク管理: 簡略 (固定ロット ¥30万)
 *
 * 一時利用スクリプト
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";

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
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  reason: "sl" | "time" | "open";
  pnlPct: number;
}

const TICKERS = ["1547", "1545"];
const START_DATE = "2018-01-01";
const END_DATE = "2026-04-30";
const GAP_MIN_PCT = 0.005;
const VOLUME_SURGE_RATIO = 1.5;
const SL_PCT = 0.02;
const TIME_STOP_DAYS = 5;
const VOL_LOOKBACK = 25;

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

function runStrategy(ticker: string, bars: OHLCV[]): Trade[] {
  const trades: Trade[] = [];
  let position: { entryIdx: number; entryPrice: number } | null = null;

  for (let i = VOL_LOOKBACK; i < bars.length; i++) {
    const today = bars[i];
    const prev = bars[i - 1];

    // ポジション中の出口判定
    if (position) {
      const slPrice = position.entryPrice * (1 - SL_PCT);
      const daysHeld = i - position.entryIdx;

      // 当日安値が SL を割ったら SL
      if (today.low <= slPrice) {
        trades.push({
          ticker,
          entryDate: bars[position.entryIdx].date,
          entryPrice: position.entryPrice,
          exitDate: today.date,
          exitPrice: slPrice,
          reason: "sl",
          pnlPct: ((slPrice - position.entryPrice) / position.entryPrice) * 100,
        });
        position = null;
        continue;
      }

      // タイムストップ
      if (daysHeld >= TIME_STOP_DAYS) {
        trades.push({
          ticker,
          entryDate: bars[position.entryIdx].date,
          entryPrice: position.entryPrice,
          exitDate: today.date,
          exitPrice: today.close,
          reason: "time",
          pnlPct: ((today.close - position.entryPrice) / position.entryPrice) * 100,
        });
        position = null;
        continue;
      }
    }

    // エントリー判定 (ポジションないとき)
    if (!position) {
      const gap = (today.open - prev.close) / prev.close;
      const isUpDay = today.close > today.open;
      const avgVol25 = bars
        .slice(i - VOL_LOOKBACK, i)
        .reduce((s, b) => s + b.volume, 0) / VOL_LOOKBACK;
      const volSurge = today.volume / avgVol25;

      if (gap >= GAP_MIN_PCT && isUpDay && volSurge >= VOLUME_SURGE_RATIO) {
        position = { entryIdx: i, entryPrice: today.close };
      }
    }
  }

  // 最後のポジションを終値で決済 (open-ended)
  if (position) {
    const last = bars[bars.length - 1];
    trades.push({
      ticker,
      entryDate: bars[position.entryIdx].date,
      entryPrice: position.entryPrice,
      exitDate: last.date,
      exitPrice: last.close,
      reason: "open",
      pnlPct: ((last.close - position.entryPrice) / position.entryPrice) * 100,
    });
  }

  return trades;
}

function summarize(trades: Trade[]) {
  if (trades.length === 0) {
    console.log("  トレードなし");
    return;
  }
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct < 0);
  const winRate = (wins.length / trades.length) * 100;
  const grossProfit = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? -grossLoss / losses.length : 0;
  const expectancy =
    (winRate / 100) * avgWin + ((100 - winRate) / 100) * avgLoss;
  const totalPnlPct = trades.reduce((s, t) => s + t.pnlPct, 0);
  const maxDD = (() => {
    let peak = 0;
    let dd = 0;
    let cum = 0;
    for (const t of trades) {
      cum += t.pnlPct;
      if (cum > peak) peak = cum;
      const drawdown = peak - cum;
      if (drawdown > dd) dd = drawdown;
    }
    return dd;
  })();

  console.log(`  トレード数: ${trades.length} (勝${wins.length} / 負${losses.length})`);
  console.log(`  勝率: ${winRate.toFixed(1)}%`);
  console.log(`  PF: ${pf === Infinity ? "∞" : pf.toFixed(2)}`);
  console.log(`  期待値: ${expectancy >= 0 ? "+" : ""}${expectancy.toFixed(2)}%`);
  console.log(`  平均勝: +${avgWin.toFixed(2)}% / 平均負: ${avgLoss.toFixed(2)}%`);
  console.log(`  累計リターン: ${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}%`);
  console.log(`  MaxDD: -${maxDD.toFixed(2)}%`);
  console.log(`  出口別: sl=${trades.filter((t) => t.reason === "sl").length}, time=${trades.filter((t) => t.reason === "time").length}, open=${trades.filter((t) => t.reason === "open").length}`);
}

async function main() {
  console.log("=".repeat(60));
  console.log(`米株 ETF MVP BT: ${START_DATE} 〜 ${END_DATE}`);
  console.log(`gap >= ${(GAP_MIN_PCT * 100).toFixed(1)}%, vol >= ${VOLUME_SURGE_RATIO}x, SL -${SL_PCT * 100}%, time ${TIME_STOP_DAYS}d`);
  console.log("=".repeat(60));

  const allTrades: Trade[] = [];

  for (const ticker of TICKERS) {
    const bars = await fetchData(ticker);
    console.log(`\n[${ticker}] ${bars.length}本のバー`);
    const trades = runStrategy(ticker, bars);
    summarize(trades);
    allTrades.push(...trades);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("統合結果 (全 ETF)");
  console.log("=".repeat(60));
  summarize(allTrades);

  // 年別
  console.log("\n--- 年別 ---");
  const byYear = new Map<string, Trade[]>();
  for (const t of allTrades) {
    const y = t.entryDate.slice(0, 4);
    const arr = byYear.get(y) ?? [];
    arr.push(t);
    byYear.set(y, arr);
  }
  for (const y of [...byYear.keys()].sort()) {
    const arr = byYear.get(y)!;
    const totalPct = arr.reduce((s, t) => s + t.pnlPct, 0);
    const wins = arr.filter((t) => t.pnlPct > 0).length;
    const winRate = (wins / arr.length) * 100;
    console.log(`  ${y}: ${arr.length}件, 勝率${winRate.toFixed(0)}%, 累計${totalPct >= 0 ? "+" : ""}${totalPct.toFixed(2)}%`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
