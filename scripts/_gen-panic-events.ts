/**
 * KOH-531 パニック底反発のシグナル生成（検証用・一時利用の `_` プレフィックス）
 *
 * Usage:
 *   npx tsx scripts/_gen-panic-events.ts 2018-01-01 2026-07-15 /tmp/panic_events.json
 *   npx tsx src/backtest/combined-run.ts --enable-panic --panic-json /tmp/panic_events.json \
 *     --compare-panic-exit --start 2019-01-01 --end 2026-04-30 --budget 500000
 *
 * ⚠️ 落とし穴（2026-07-15 に踏んだ）:
 *   - 指数ETFの tickerCode は **`.T` 無し**（`1321`）で保存されている（通常銘柄は `1301.T`）。
 *     `.T` を付けるとユニバース0本でシグナル0件になり、原因が分かりにくい。
 *   - 1321 等の指数ETFはローカルBT用DBに入っていないことがある。
 *     その場合は先に `python3 scripts/_backfill-index-etf-bars.py` を実行する。
 *
 * 条件（却下リスト記載の VIX>25 版）:
 *   - VIX(前日終値) > 25   ← 15:24 時点で既知の情報集合（米国市場は日中クローズ）
 *   - breadth < 40%        ← BT と同一定義（全ユニバースのうち終値>25日SMAの割合）
 *   - N225 が3営業日以上連続下落
 *   - エピソード初日のみ（連続する該当日は先頭だけ拾う）
 * エントリー: 当日引けで 1321（日経225ETF）
 */
import { fetchHistoricalFromDB, fetchIndexFromDB } from "../src/backtest/data-fetcher";
import { prisma } from "../src/lib/prisma";
import { getMaxBuyablePrice } from "../src/core/risk-manager";
import fs from "fs";

const START = process.argv[2] ?? "2018-01-01";
const END = process.argv[3] ?? "2026-07-15";
// 指数ETFは DB 上 `.T` 無しで保存されている（通常銘柄は `1301.T`）。
// `.T` を付けるとユニバース0本→シグナル0件になり原因が分かりにくいので定数側で吸収する。
const TICKER = "1321";

async function main() {
  // BT と同一のユニバース構築（combined-run.ts:470-495 と同じ手順）
  const distinct = await prisma.stockDailyBar.findMany({
    where: { market: "JP" }, distinct: ["tickerCode"], select: { tickerCode: true },
  });
  const rawData = await fetchHistoricalFromDB(distinct.map((d) => d.tickerCode), START, END);
  const maxPrice = getMaxBuyablePrice(500_000); // BT既定と同じ（¥500K → 2500）
  const allData = new Map<string, { date: string; close: number }[]>();
  for (const [t, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPrice && b.close > 0)) allData.set(t, bars);
  }
  console.log(`ユニバース: ${allData.size}銘柄 (maxPrice<=${maxPrice})`);
  const n225 = await fetchIndexFromDB("^N225", START, END);
  const vix = await fetchIndexFromDB("^VIX", START, END);

  // 取引日 = N225 のある日
  const tradingDays = [...n225.keys()].sort();

  // breadth（BT と同一定義: 終値 > 25日SMA の割合）
  const SMA_LEN = 25;
  const tickerCloses = new Map<string, { di: Map<string, number>; closes: number[] }>();
  for (const [t, bars] of allData) {
    if (t.startsWith("^")) continue;
    const di = new Map<string, number>();
    for (let i = 0; i < bars.length; i++) di.set(bars[i].date, i);
    tickerCloses.set(t, { di, closes: bars.map((b) => b.close) });
  }
  const breadth = new Map<string, number>();
  for (const day of tradingDays) {
    let above = 0, total = 0;
    for (const [, d] of tickerCloses) {
      const idx = d.di.get(day);
      if (idx == null || idx < SMA_LEN - 1) continue;
      let sum = 0;
      for (let j = idx - SMA_LEN + 1; j <= idx; j++) sum += d.closes[j];
      total++;
      if (d.closes[idx] > sum / SMA_LEN) above++;
    }
    if (total > 0) breadth.set(day, above / total);
  }

  // N225 連続下落日数
  const downStreak = new Map<string, number>();
  let streak = 0;
  for (let i = 1; i < tradingDays.length; i++) {
    const prev = n225.get(tradingDays[i - 1])!;
    const cur = n225.get(tradingDays[i])!;
    streak = cur < prev ? streak + 1 : 0;
    downStreak.set(tradingDays[i], streak);
  }

  // VIX は前日終値を使う（先読み防止）
  const vixDays = [...vix.keys()].sort();
  const prevVix = (day: string): number | null => {
    let lo = 0, hi = vixDays.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (vixDays[mid] < day) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? vix.get(vixDays[ans])! : null;
  };

  const hits: { date: string; breadth: number; streak: number; vix: number }[] = [];
  for (const day of tradingDays) {
    const b = breadth.get(day);
    const st = downStreak.get(day) ?? 0;
    const v = prevVix(day);
    if (b == null || v == null) continue;
    if (b < 0.4 && st >= 3 && v > 25) hits.push({ date: day, breadth: b, streak: st, vix: v });
  }

  // エピソード初日のみ（前営業日も該当なら除外）
  const hitSet = new Set(hits.map((h) => h.date));
  const dayIdx = new Map(tradingDays.map((d, i) => [d, i]));
  const firsts = hits.filter((h) => {
    const i = dayIdx.get(h.date)!;
    return i === 0 || !hitSet.has(tradingDays[i - 1]);
  });

  console.log(`該当日(全): ${hits.length} / エピソード初日: ${firsts.length}`);
  const byYear = new Map<string, number>();
  for (const f of firsts) byYear.set(f.date.slice(0, 4), (byYear.get(f.date.slice(0, 4)) ?? 0) + 1);
  console.log("年別:", [...byYear.entries()].sort().map(([y, n]) => `${y}:${n}`).join(" "));
  for (const f of firsts) {
    console.log(`  ${f.date} breadth=${(f.breadth * 100).toFixed(1)}% streak=${f.streak} vixPrev=${f.vix.toFixed(1)}`);
  }

  const out = { events: firsts.map((f) => ({ ticker: TICKER, date: f.date })) };
  const path = process.argv[4] ?? "/tmp/panic_events.json";
  fs.writeFileSync(path, JSON.stringify(out, null, 1));
  console.log(`\n→ ${path} に ${out.events.length} 件出力`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
