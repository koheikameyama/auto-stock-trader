/**
 * 米株 ETF (1547, 1545) 押し目（dip-buying / mean-reversion）戦略 BT — パイロット
 *
 * 目的:
 *   gap-momentum 型は本番稼働中だが「押し目型」は未検証。
 *   ETF は指数連動で平均回帰性があるため、小型株で死んだ RSI 逆張り (却下 #11) と違い
 *   dip-buying が機能する余地がある、という仮説を検証する。
 *
 * 設計:
 *   - 上昇トレンドゲート: close > SMA(trendPeriod)   ← トレンド中の押し目のみ拾う
 *   - dip トリガー (バリアントで切替): RSI(2)/RSI(14) 売られすぎ / 短期SMA割れ / 連続陰線
 *   - 反発確認 (任意): 当日陽線
 *   - 出口: mean-reversion (短期SMA回復 or RSI回復) + SL + 最大保有日数
 *   - breadth フィルター: 押し目型は「常時回すスリーブ」候補なので既定 OFF。ON/OFF 両方を出力して比較
 *
 * 一時利用 (`_` プレフィックス)。本番コードには一切触れない。
 *   例: npx tsx scripts/_us-etf-dip-backtest.ts --start 2018-01-01 --end 2026-05-21 --cost 0.2
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
  reason: "sl" | "time" | "meanrev" | "open";
}

type DipMode = "rsi2" | "rsi14" | "belowsma" | "ndown";
type ExitMode = "meanrev" | "timesl";

interface VariantConfig {
  label: string;
  trendPeriod: number; // 上昇トレンドゲート SMA (0 で無効)
  dipMode: DipMode;
  rsiMax: number; // rsi2/rsi14 用のしきい値
  dipSmaPeriod: number; // belowsma 用
  downDays: number; // ndown 用（連続陰線数）
  requireBounce: boolean; // 当日陽線を要求
  exitMode: ExitMode;
  exitSmaPeriod: number; // meanrev: close がこの SMA を上抜けで利確
  exitRsiPeriod: number; // meanrev: RSI がこの値以上で利確
  exitRsiLevel: number;
  slPct: number;
  maxHoldDays: number;
}

function _arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const TICKERS = (_arg("--tickers") ?? "1547,1545").split(",").map((t) => t.trim());
const START_DATE = _arg("--start") ?? "2018-01-01";
const END_DATE = _arg("--end") ?? "2026-05-21";
const ROUND_TRIP_COST = Number(_arg("--cost") ?? "0"); // 往復コスト%（各トレードから控除）
const SHOW_YEARS = process.argv.includes("--years");

async function fetchData(ticker: string): Promise<OHLCV[]> {
  const rows = await prisma.stockDailyBar.findMany({
    where: {
      tickerCode: ticker,
      date: { gte: new Date(`${START_DATE}T00:00:00Z`), lte: new Date(`${END_DATE}T00:00:00Z`) },
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

/** 単純移動平均（i 番目 = 直近 period 本の平均、未確定は null） */
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

/** Wilder の RSI（先読みなし、未確定は null） */
function wilderRsi(bars: OHLCV[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    if (ch >= 0) avgGain += ch;
    else avgLoss -= ch;
  }
  avgGain /= period;
  avgLoss /= period;
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

function runVariant(
  ticker: string,
  bars: OHLCV[],
  cfg: VariantConfig,
  breadthMap: Map<string, number> | null,
): Trade[] {
  const trades: Trade[] = [];
  const trendSma = cfg.trendPeriod > 0 ? sma(bars, cfg.trendPeriod) : null;
  const dipSma = sma(bars, cfg.dipSmaPeriod);
  const exitSma = sma(bars, cfg.exitSmaPeriod);
  const rsiEntry = cfg.dipMode === "rsi2" ? wilderRsi(bars, 2) : wilderRsi(bars, 14);
  const rsiExit = wilderRsi(bars, cfg.exitRsiPeriod);

  const warmup = Math.max(cfg.trendPeriod, cfg.dipSmaPeriod, cfg.exitSmaPeriod, 14, cfg.exitRsiPeriod) + 1;
  let position: { entryIdx: number; entryPrice: number } | null = null;

  const close = (idx: number, exitPrice: number, reason: Trade["reason"]) => {
    trades.push({
      ticker,
      entryDate: bars[position!.entryIdx].date,
      exitDate: bars[idx].date,
      pnlPct: ((exitPrice - position!.entryPrice) / position!.entryPrice) * 100 - ROUND_TRIP_COST,
      reason,
    });
    position = null;
  };

  for (let i = warmup; i < bars.length; i++) {
    const today = bars[i];

    // ---- 出口判定 ----
    if (position) {
      const slPrice = position.entryPrice * (1 - cfg.slPct);
      const daysHeld = i - position.entryIdx;
      if (today.low <= slPrice) {
        close(i, slPrice, "sl");
        continue;
      }
      if (cfg.exitMode === "meanrev") {
        const es = exitSma[i];
        const er = rsiExit[i];
        const recovered = (es != null && today.close > es) || (er != null && er >= cfg.exitRsiLevel);
        if (recovered) {
          close(i, today.close, "meanrev");
          continue;
        }
      }
      if (daysHeld >= cfg.maxHoldDays) {
        close(i, today.close, "time");
        continue;
      }
    }

    // ---- エントリー判定 ----
    if (!position) {
      // 上昇トレンドゲート
      if (trendSma) {
        const ts = trendSma[i];
        if (ts == null || today.close <= ts) continue;
      }
      // dip トリガー
      let isDip = false;
      if (cfg.dipMode === "rsi2" || cfg.dipMode === "rsi14") {
        const r = rsiEntry[i];
        isDip = r != null && r <= cfg.rsiMax;
      } else if (cfg.dipMode === "belowsma") {
        const ds = dipSma[i];
        isDip = ds != null && today.close < ds;
      } else if (cfg.dipMode === "ndown") {
        isDip = true;
        for (let k = 0; k < cfg.downDays; k++) {
          if (bars[i - k].close >= bars[i - k - 1].close) { isDip = false; break; }
        }
      }
      if (!isDip) continue;
      // 反発確認（当日陽線）
      if (cfg.requireBounce && today.close <= today.open) continue;
      // breadth フィルター（前日の日本株 breadth < 54%）
      if (breadthMap) {
        const b = breadthMap.get(bars[i - 1].date);
        if (b == null || b >= MARKET_BREADTH.THRESHOLD) continue;
      }
      position = { entryIdx: i, entryPrice: today.close };
    }
  }

  if (position) {
    const last = bars.length - 1;
    close(last, bars[last].close, "open");
  }
  return trades;
}

interface Summary {
  label: string;
  trades: number;
  winRate: number;
  pf: number;
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  totalPnl: number;
  maxDd: number;
  calmar: number;
  avgHold: number;
  trs: Trade[];
}

function summarize(label: string, trades: Trade[]): Summary {
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct < 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const gp = wins.reduce((s, t) => s + t.pnlPct, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const pf = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
  const avgWin = wins.length ? gp / wins.length : 0;
  const avgLoss = losses.length ? -gl / losses.length : 0;
  const expectancy = (winRate / 100) * avgWin + ((100 - winRate) / 100) * avgLoss;
  const totalPnl = trades.reduce((s, t) => s + t.pnlPct, 0);

  // 保有日数（営業日ベース、entry→exit の bar index 差を ticker ごとに逆引きするのは重いので日数近似）
  let holdSum = 0;
  for (const t of trades) holdSum += dayjs(t.exitDate).diff(dayjs(t.entryDate), "day");

  // 時系列に並べた累積での MaxDD（トレードを exitDate 順で並べる）
  const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  let cum = 0, peak = 0, dd = 0;
  for (const t of sorted) {
    cum += t.pnlPct;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }

  return {
    label,
    trades: trades.length,
    winRate,
    pf: pf === Infinity ? 999 : pf,
    expectancy,
    avgWin,
    avgLoss,
    totalPnl,
    maxDd: dd,
    calmar: dd > 0 ? totalPnl / dd : 0,
    avgHold: trades.length ? holdSum / trades.length : 0,
    trs: trades,
  };
}

function printYears(s: Summary) {
  const byYear = new Map<string, Trade[]>();
  for (const t of s.trs) {
    const y = t.entryDate.slice(0, 4);
    (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(t);
  }
  const parts: string[] = [];
  for (const y of [...byYear.keys()].sort()) {
    const arr = byYear.get(y)!;
    const pct = arr.reduce((a, t) => a + t.pnlPct, 0);
    parts.push(`${y}:${arr.length}件 ${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`);
  }
  console.log(`      年別: ${parts.join("  ")}`);
}

const VARIANTS: VariantConfig[] = [
  // Connors 系（トレンド中の RSI2 売られすぎ）
  { label: "RSI2<10 +陽線 (Connors)", trendPeriod: 50, dipMode: "rsi2", rsiMax: 10, dipSmaPeriod: 5, downDays: 3, requireBounce: true, exitMode: "meanrev", exitSmaPeriod: 5, exitRsiPeriod: 2, exitRsiLevel: 70, slPct: 0.03, maxHoldDays: 10 },
  { label: "RSI2<10 反発不問 (Connors原型)", trendPeriod: 50, dipMode: "rsi2", rsiMax: 10, dipSmaPeriod: 5, downDays: 3, requireBounce: false, exitMode: "meanrev", exitSmaPeriod: 5, exitRsiPeriod: 2, exitRsiLevel: 70, slPct: 0.03, maxHoldDays: 10 },
  { label: "RSI2<5 反発不問 (厳格)", trendPeriod: 50, dipMode: "rsi2", rsiMax: 5, dipSmaPeriod: 5, downDays: 3, requireBounce: false, exitMode: "meanrev", exitSmaPeriod: 5, exitRsiPeriod: 2, exitRsiLevel: 70, slPct: 0.03, maxHoldDays: 10 },
  { label: "RSI2<10 SMA200ゲート", trendPeriod: 200, dipMode: "rsi2", rsiMax: 10, dipSmaPeriod: 5, downDays: 3, requireBounce: false, exitMode: "meanrev", exitSmaPeriod: 5, exitRsiPeriod: 2, exitRsiLevel: 70, slPct: 0.03, maxHoldDays: 10 },
  // RSI14 系
  { label: "RSI14<30 +陽線", trendPeriod: 50, dipMode: "rsi14", rsiMax: 30, dipSmaPeriod: 5, downDays: 3, requireBounce: true, exitMode: "meanrev", exitSmaPeriod: 5, exitRsiPeriod: 14, exitRsiLevel: 50, slPct: 0.03, maxHoldDays: 10 },
  { label: "RSI14<40 +陽線", trendPeriod: 50, dipMode: "rsi14", rsiMax: 40, dipSmaPeriod: 5, downDays: 3, requireBounce: true, exitMode: "meanrev", exitSmaPeriod: 5, exitRsiPeriod: 14, exitRsiLevel: 50, slPct: 0.03, maxHoldDays: 10 },
  // 短期SMA割れ
  { label: "SMA5割れ +陽線", trendPeriod: 50, dipMode: "belowsma", rsiMax: 0, dipSmaPeriod: 5, downDays: 3, requireBounce: true, exitMode: "meanrev", exitSmaPeriod: 5, exitRsiPeriod: 14, exitRsiLevel: 50, slPct: 0.03, maxHoldDays: 10 },
  { label: "SMA10割れ +陽線", trendPeriod: 50, dipMode: "belowsma", rsiMax: 0, dipSmaPeriod: 10, downDays: 3, requireBounce: true, exitMode: "meanrev", exitSmaPeriod: 10, exitRsiPeriod: 14, exitRsiLevel: 50, slPct: 0.03, maxHoldDays: 10 },
  // 連続陰線
  { label: "3連続陰線 +反発陽線", trendPeriod: 50, dipMode: "ndown", rsiMax: 0, dipSmaPeriod: 5, downDays: 3, requireBounce: true, exitMode: "meanrev", exitSmaPeriod: 5, exitRsiPeriod: 14, exitRsiLevel: 50, slPct: 0.03, maxHoldDays: 10 },
  // 出口を time+sl に変えた対照（mean-rev 出口の効果を見る）
  { label: "RSI2<10 反発不問 / time+sl出口", trendPeriod: 50, dipMode: "rsi2", rsiMax: 10, dipSmaPeriod: 5, downDays: 3, requireBounce: false, exitMode: "timesl", exitSmaPeriod: 5, exitRsiPeriod: 2, exitRsiLevel: 70, slPct: 0.03, maxHoldDays: 5 },
];

function fmt(s: Summary): string {
  const pf = s.pf >= 999 ? "∞" : s.pf.toFixed(2);
  return [
    s.label.padEnd(30),
    `tr ${String(s.trades).padStart(3)}`,
    `WR ${s.winRate.toFixed(0).padStart(3)}%`,
    `PF ${pf.padStart(5)}`,
    `Exp ${(s.expectancy >= 0 ? "+" : "") + s.expectancy.toFixed(2)}%`,
    `Ret ${(s.totalPnl >= 0 ? "+" : "") + s.totalPnl.toFixed(0)}%`,
    `DD -${s.maxDd.toFixed(0)}%`,
    `Cal ${s.calmar.toFixed(2)}`,
    `hold ${s.avgHold.toFixed(1)}d`,
  ].join("  ");
}

async function main() {
  console.log("=".repeat(110));
  console.log(`米株ETF 押し目(dip)戦略 パイロット: ${TICKERS.join("/")}  ${START_DATE}〜${END_DATE}  往復コスト ${ROUND_TRIP_COST}%`);
  console.log("=".repeat(110));

  const breadthSeries = await fetchBreadthSeries({ lookbackDays: 2300 });
  const breadthMap = new Map<string, number>();
  for (const p of breadthSeries) breadthMap.set(dayjs(p.date).format("YYYY-MM-DD"), p.breadth);

  const allBars = new Map<string, OHLCV[]>();
  for (const t of TICKERS) allBars.set(t, await fetchData(t));

  for (const useBreadth of [false, true]) {
    console.log(`\n${"─".repeat(110)}`);
    console.log(`■ breadth フィルター: ${useBreadth ? "ON (idle帯 <54% のみ)" : "OFF (常時)"}`);
    console.log("─".repeat(110));
    const summaries: Summary[] = [];
    for (const cfg of VARIANTS) {
      const trades: Trade[] = [];
      for (const t of TICKERS) {
        trades.push(...runVariant(t, allBars.get(t)!, cfg, useBreadth ? breadthMap : null));
      }
      summaries.push(summarize(cfg.label, trades));
    }
    summaries.sort((a, b) => b.calmar - a.calmar);
    for (const s of summaries) {
      console.log("  " + fmt(s));
      if (SHOW_YEARS && s.trades > 0) printYears(s);
    }
  }

  console.log(`\n${"=".repeat(110)}`);
  console.log("判定ゲート: PF≥1.3 かつ Calmar≥3.0 かつ trades 十分。gap-momentum本番値: PF1.83/Calmar5.24(idle帯)");
  console.log("=".repeat(110));

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
