/**
 * 米株 ETF と日本株 breadth の結合効果検証 MVP
 *
 * A-3a: 「ETF は日本株戦略 OFF (breadth < 54%) の日に機能するか」を直接確認
 *
 * ロジック:
 *   1. ETF MVP 戦略を 2018-2026 で動かす (既存 _us-etf-backtest-mvp と同じ)
 *   2. 各エントリー日の日本株 breadth を計算
 *   3. breadth レンジ別 (< 54%, 54-80%, > 80%) でトレード結果を分類
 *   4. 「日本株 idle 日 vs 強気日」での ETF 寄与を比較
 *
 * これで「結合効果 = 補完効果」が定量化できる:
 *   - idle 日に勝てれば、既存戦略の弱点をカバー (期待される結合効果)
 *   - 強気日にしか勝てなければ、既存戦略と機会を取り合うだけ (結合効果なし)
 *
 * 一時利用スクリプト
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
  breadthAtEntry: number | null;
  regime: "japan_idle" | "japan_band" | "japan_overheat" | "unknown";
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

function classifyRegime(breadth: number | null): Trade["regime"] {
  if (breadth === null) return "unknown";
  if (breadth < MARKET_BREADTH.THRESHOLD) return "japan_idle";
  if (breadth <= MARKET_BREADTH.UPPER_CAP) return "japan_band";
  return "japan_overheat";
}

function runStrategy(ticker: string, bars: OHLCV[], breadthByDate: Map<string, number>): Trade[] {
  const trades: Trade[] = [];
  let position: { entryIdx: number; entryPrice: number; breadthAtEntry: number | null } | null = null;

  for (let i = VOL_LOOKBACK; i < bars.length; i++) {
    const today = bars[i];
    const prev = bars[i - 1];

    if (position) {
      const slPrice = position.entryPrice * (1 - SL_PCT);
      const daysHeld = i - position.entryIdx;

      if (today.low <= slPrice) {
        trades.push({
          ticker,
          entryDate: bars[position.entryIdx].date,
          exitDate: today.date,
          pnlPct: ((slPrice - position.entryPrice) / position.entryPrice) * 100,
          breadthAtEntry: position.breadthAtEntry,
          regime: classifyRegime(position.breadthAtEntry),
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
          breadthAtEntry: position.breadthAtEntry,
          regime: classifyRegime(position.breadthAtEntry),
        });
        position = null;
        continue;
      }
    }

    if (!position) {
      const gap = (today.open - prev.close) / prev.close;
      const isUpDay = today.close > today.open;
      const avgVol =
        bars.slice(i - VOL_LOOKBACK, i).reduce((s, b) => s + b.volume, 0) / VOL_LOOKBACK;
      const volSurge = today.volume / avgVol;

      if (gap >= GAP_MIN_PCT && isUpDay && volSurge >= VOLUME_SURGE_RATIO) {
        // 前日の breadth をエントリー時点の状態として使う
        const breadthAtEntry = breadthByDate.get(prev.date) ?? null;
        position = { entryIdx: i, entryPrice: today.close, breadthAtEntry };
      }
    }
  }

  return trades;
}

function summarize(label: string, trades: Trade[]) {
  if (trades.length === 0) {
    console.log(`  ${label}: トレードなし`);
    return;
  }
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct < 0);
  const gp = wins.reduce((s, t) => s + t.pnlPct, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const pf = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
  const winRate = (wins.length / trades.length) * 100;
  const totalReturn = trades.reduce((s, t) => s + t.pnlPct, 0);
  const avgWin = wins.length > 0 ? gp / wins.length : 0;
  const avgLoss = losses.length > 0 ? -gl / losses.length : 0;
  const expectancy = (winRate / 100) * avgWin + ((100 - winRate) / 100) * avgLoss;

  console.log(
    `  ${label.padEnd(30)} | trades ${String(trades.length).padStart(3)} | 勝率 ${winRate.toFixed(0).padStart(2)}% | PF ${pf === Infinity ? "∞" : pf.toFixed(2)} | 期待値 ${expectancy >= 0 ? "+" : ""}${expectancy.toFixed(2)}% | 累計 ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(1)}%`,
  );
}

async function main() {
  console.log("=".repeat(110));
  console.log("ETF × 日本株 breadth 結合効果検証 MVP");
  console.log("=".repeat(110));

  // 日本株 breadth 履歴
  const breadthSeries = await fetchBreadthSeries({ lookbackDays: 2200 });
  const breadthByDate = new Map<string, number>();
  for (const p of breadthSeries) {
    breadthByDate.set(dayjs(p.date).format("YYYY-MM-DD"), p.breadth);
  }
  console.log(`日本株 breadth カバー期間: ${dayjs(breadthSeries[0].date).format("YYYY-MM-DD")} 〜 ${dayjs(breadthSeries[breadthSeries.length - 1].date).format("YYYY-MM-DD")}`);

  // ETF MVP 戦略を走らせる
  const allTrades: Trade[] = [];
  for (const ticker of TICKERS) {
    const bars = await fetchData(ticker);
    const trades = runStrategy(ticker, bars, breadthByDate);
    allTrades.push(...trades);
    console.log(`${ticker}: ${trades.length} trades`);
  }
  console.log("");

  // 全体集計
  console.log("=".repeat(110));
  console.log("全 ETF トレード結果 (regime 別内訳)");
  console.log("=".repeat(110));
  summarize("全体", allTrades);
  console.log("");

  const idle = allTrades.filter((t) => t.regime === "japan_idle");
  const band = allTrades.filter((t) => t.regime === "japan_band");
  const overheat = allTrades.filter((t) => t.regime === "japan_overheat");
  const unknown = allTrades.filter((t) => t.regime === "unknown");

  console.log("--- 日本株レジーム別 ---");
  summarize("japan_idle (<54%): 既存戦略OFF", idle);
  summarize("japan_band (54-80%): 既存戦略ON", band);
  summarize("japan_overheat (>80%): 過熱", overheat);
  summarize("unknown (breadth未計算)", unknown);
  console.log("");

  // 補完効果の評価
  console.log("=".repeat(110));
  console.log("結合効果の評価");
  console.log("=".repeat(110));

  const idleReturn = idle.reduce((s, t) => s + t.pnlPct, 0);
  const bandReturn = band.reduce((s, t) => s + t.pnlPct, 0);
  const idlePct = (idle.length / allTrades.length) * 100;

  console.log(`japan_idle 帯のトレード比率: ${idlePct.toFixed(1)}% (${idle.length}/${allTrades.length})`);
  console.log(`japan_idle 帯の累計リターン: ${idleReturn >= 0 ? "+" : ""}${idleReturn.toFixed(2)}%`);
  console.log(`japan_band 帯の累計リターン: ${bandReturn >= 0 ? "+" : ""}${bandReturn.toFixed(2)}%`);

  // 結論
  console.log("");
  if (idleReturn > 0 && idle.length >= 10) {
    const idlePF =
      idle.filter((t) => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0) /
      Math.abs(idle.filter((t) => t.pnlPct < 0).reduce((s, t) => s + t.pnlPct, 0) || 1);
    console.log(`✅ 補完効果あり: 日本株 idle 時に ETF が +${idleReturn.toFixed(1)}% / PF ${idlePF.toFixed(2)} で稼げている`);
  } else if (idleReturn < 0) {
    console.log(`⚠️ 補完効果なし: 日本株 idle 時に ETF も負け (${idleReturn.toFixed(2)}%) → ETF 単独で動かす意味薄い`);
  } else {
    console.log(`△ 微妙: idle 帯のトレード数が少ないか、リターンが flat`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
