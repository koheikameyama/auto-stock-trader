/**
 * 使い捨て: PSC トレードの「保有中の状態」で条件付けた結果分布を測る。
 *
 * 目的: オープンポジションと同じ状態にある過去の PSC トレードが、
 *       最終的にどう決済されたか（勝率・平均勝ち・平均負け・出口理由）。
 *
 * 方向予測ではなくペイオフ分布の測定（却下 #26 が認める用途）。
 * 先読みなし: 状態は day k までの情報だけで作り、結果は決済実績を見る。
 */
import { PrismaClient } from "@prisma/client";
import { ATR } from "technicalindicators";
import fs from "fs";

const prisma = new PrismaClient();

type Trade = {
  strategy: string;
  ticker: string;
  entryDate: string;
  exitDate: string | null;
  entryPrice: number;
  exitPrice: number | null;
  exitReason: string | null;
  pnlPct: number | null;
  holdingDays: number | null;
};

type Bar = { date: string; open: number; high: number; low: number; close: number };

// PSC 本番パラメータ
const BE_MULT = 0.3;

function pct(n: number, d: number) {
  return d === 0 ? "-" : `${((n / d) * 100).toFixed(1)}%`;
}

function describe(label: string, trades: Trade[]) {
  const n = trades.length;
  if (n === 0) {
    console.log(`\n${label}: サンプルなし`);
    return;
  }
  const pnls = trades.map((t) => t.pnlPct ?? 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const grossWin = wins.reduce((s, x) => s + x, 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x, 0));

  const sorted = [...pnls].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

  console.log(`\n${label}`);
  console.log(`  n=${n}  勝率 ${pct(wins.length, n)}`);
  console.log(
    `  平均勝ち +${avg(wins).toFixed(2)}%  /  平均負け ${avg(losses).toFixed(2)}%  /  期待値 ${avg(pnls) >= 0 ? "+" : ""}${avg(pnls).toFixed(2)}%`,
  );
  console.log(`  PF ${grossLoss === 0 ? "∞" : (grossWin / grossLoss).toFixed(2)}`);
  console.log(
    `  分布 p10 ${q(0.1).toFixed(2)}% / p25 ${q(0.25).toFixed(2)}% / 中央 ${q(0.5).toFixed(2)}% / p75 ${q(0.75).toFixed(2)}% / p90 ${q(0.9).toFixed(2)}%`,
  );

  const byReason = new Map<string, number[]>();
  for (const t of trades) {
    const r = t.exitReason ?? "unknown";
    if (!byReason.has(r)) byReason.set(r, []);
    byReason.get(r)!.push(t.pnlPct ?? 0);
  }
  const reasons = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`  出口内訳:`);
  for (const [r, ps] of reasons) {
    console.log(
      `    ${r.padEnd(18)} ${String(ps.length).padStart(4)}件 (${pct(ps.length, n).padStart(6)})  平均 ${avg(ps) >= 0 ? "+" : ""}${avg(ps).toFixed(2)}%`,
    );
  }
}

async function main() {
  const dumpPath = process.argv[2];
  const dump = JSON.parse(fs.readFileSync(dumpPath, "utf-8"));
  const all: Trade[] = dump.rows;
  const psc = all.filter((t) => t.strategy === "PSC" && t.exitDate && t.pnlPct != null);
  console.log(`PSC トレード: ${psc.length}件 (${dump.startDate} 〜 ${dump.endDate}, 予算 ¥${dump.budget.toLocaleString()})`);

  // 対象銘柄のバーを一括取得（N+1回避）
  const tickers = [...new Set(psc.map((t) => t.ticker))];
  const rows = await prisma.stockDailyBar.findMany({
    where: { tickerCode: { in: tickers } },
    select: { tickerCode: true, date: true, open: true, high: true, low: true, close: true },
    orderBy: [{ tickerCode: "asc" }, { date: "asc" }],
  });
  const barsByTicker = new Map<string, Bar[]>();
  for (const r of rows) {
    const d = r.date.toISOString().slice(0, 10);
    if (!barsByTicker.has(r.tickerCode)) barsByTicker.set(r.tickerCode, []);
    barsByTicker.get(r.tickerCode)!.push({ date: d, open: r.open, high: r.high, low: r.low, close: r.close });
  }
  console.log(`[data] ${barsByTicker.size}銘柄のバーを取得`);

  function atr14At(bars: Bar[], idx: number): number | null {
    const start = idx - 14 - 5;
    if (start < 0) return null;
    const w = bars.slice(start, idx + 1);
    const res = ATR.calculate({
      high: w.map((b) => b.high),
      low: w.map((b) => b.low),
      close: w.map((b) => b.close),
      period: 14,
    });
    if (!res.length) return null;
    return Math.round(res[res.length - 1] * 100) / 100;
  }

  // 各トレードに「保有 day k 時点の状態」を付ける
  type Enriched = Trade & {
    atr: number | null;
    beLine: number | null;
    day1Close: number | null;
    day1MaxHigh: number | null;
    day1Underwater: boolean | null;
    day1BeActivated: boolean | null;
  };

  const enriched: Enriched[] = [];
  for (const t of psc) {
    const bars = barsByTicker.get(t.ticker);
    if (!bars) continue;
    const ei = bars.findIndex((b) => b.date === t.entryDate);
    if (ei < 0) continue;
    const atr = atr14At(bars, ei);
    const beLine = atr == null ? null : t.entryPrice + BE_MULT * atr;

    // day1 = エントリー日の翌営業日（エントリーは引け約定なので当日の値動きは含めない）
    //
    // ★ day1 の引け時点で「まだ open だった」トレードだけを状態判定の対象にする。
    //    day1 中に決済されたトレード（exitDate == day1）を含めると、
    //    「day1 引けで含み損」の母集団に "day1 に SL で死んだ玉" が混ざり、
    //    SL率が構造的に水増しされる（= 生存バイアスの逆）。
    //    参照したいオープンポジションは day1 を生き残っているので、条件を揃える。
    const d1 = bars[ei + 1];
    let day1Close: number | null = null;
    let day1MaxHigh: number | null = null;
    if (d1 && t.exitDate && d1.date < t.exitDate) {
      day1Close = d1.close;
      day1MaxHigh = Math.max(t.entryPrice, d1.high);
    }

    enriched.push({
      ...t,
      atr,
      beLine,
      day1Close,
      day1MaxHigh,
      day1Underwater: day1Close == null ? null : day1Close < t.entryPrice,
      day1BeActivated:
        day1MaxHigh == null || beLine == null ? null : day1MaxHigh >= beLine,
    });
  }

  console.log(`[state] 状態を再現できたトレード: ${enriched.length}件`);

  console.log("\n" + "=".repeat(64));
  console.log("A) 母集団: 全 PSC トレード  ← 3276.T（本日エントリー・day0）の参照分布");
  console.log("=".repeat(64));
  describe("全 PSC", enriched);

  // 8698 の状態: day1 終了、BE未発動、含み損
  const alive = enriched.filter((e) => e.day1Close != null && e.day1BeActivated != null);
  console.log("\n" + "=".repeat(64));
  console.log("B) day1 の引けを open のまま迎えたトレードを状態で分割  ← 8698.T の参照分布");
  console.log("=".repeat(64));
  console.log(
    `day1 引け時点でまだ open だったトレード: ${alive.length}件 / 全${enriched.length}件` +
      `（残り ${enriched.length - alive.length}件は day1 までに決済済み = 8698 と状態が違うので除外）`,
  );
  const day1Exited = enriched.filter((e) => e.day1Close == null);
  describe("(参考) day1 までに決済されたトレード ← 8698 は該当しない", day1Exited);

  describe(
    "B-1) day1: BE未発動 かつ 含み損  ★8698.T の現状（close 763 < entry 768, maxHigh 772 < BE 773.4）",
    alive.filter((e) => !e.day1BeActivated && e.day1Underwater),
  );
  describe(
    "B-2) day1: BE未発動 かつ 含み益",
    alive.filter((e) => !e.day1BeActivated && !e.day1Underwater),
  );
  describe(
    "B-3) day1: BE発動済み（トレール起動）",
    alive.filter((e) => e.day1BeActivated),
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
