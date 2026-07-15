/**
 * live 実装が BT と同じシグナルを出すかの照合（検証用・一時利用の `_` プレフィックス）
 *
 * `src/core/panic/market-state.ts` + `detectPanicSignal()`（= 本番が 15:24 に実行する経路そのもの）を
 * 過去の各営業日に対して回し、BT の `_gen-panic-events.ts --entry-lag 1 --breadth-universe daily`
 * が出したイベント集合と一致するかを突き合わせる。
 *
 * ここが一致しない = 「BT で検証済み」が嘘になるので、本番投入前に必ず通すこと。
 *
 * Usage:
 *   npx tsx scripts/_gen-panic-events.ts 2018-01-01 2026-07-15 /tmp/p.json --entry-lag 1 --breadth-universe daily
 *   npx tsx scripts/_verify-panic-parity.ts /tmp/p.json 2019-01-01 2026-07-15
 */
import dayjs from "dayjs";
import fs from "fs";
import { prisma } from "../src/lib/prisma";
import { getPanicMarketState } from "../src/core/panic/market-state";
import { detectPanicSignal } from "../src/core/panic/entry-conditions";

const EVENTS_JSON = process.argv[2] ?? "/tmp/panic_lag1_daily.json";
const START = process.argv[3] ?? "2019-01-01";
const END = process.argv[4] ?? "2026-07-15";

async function main() {
  const raw = JSON.parse(fs.readFileSync(EVENTS_JSON, "utf-8")) as { events: { date: string }[] };
  const btDates = new Set(
    raw.events.map((e) => e.date).filter((d) => d >= START && d <= END),
  );

  // 走査対象 = ^N225 のある営業日（BT の tradingDays と同じ）。
  // 全営業日を回すと breadth の窓関数SQLが1日3本 × 1,800日で現実的な時間に終わらないので、
  // **BTイベント日の前後 NEIGHBOR 営業日**に絞る。これで「正しい日に撃つ」と
  // 「隣の日には撃たない（= エピソード初日判定と閾値が効いている）」の両方を検証できる。
  const NEIGHBOR = 3;
  const allBars = await prisma.stockDailyBar.findMany({
    where: { tickerCode: "^N225", date: { gte: new Date(`${START}T00:00:00Z`), lte: new Date(`${END}T00:00:00Z`) } },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  const idxOf = new Map(allBars.map((b, i) => [dayjs(b.date).format("YYYY-MM-DD"), i]));
  const scanIdx = new Set<number>();
  for (const d of btDates) {
    const i = idxOf.get(d);
    if (i == null) {
      console.warn(`⚠️ BTイベント ${d} が ^N225 の営業日に無い`);
      continue;
    }
    for (let k = -NEIGHBOR; k <= NEIGHBOR; k++) {
      if (i + k >= 0 && i + k < allBars.length) scanIdx.add(i + k);
    }
  }
  const bars = [...scanIdx].sort((a, b) => a - b).map((i) => allBars[i]);

  const liveDates = new Set<string>();
  let evaluated = 0;
  let unavailable = 0;

  for (const b of bars) {
    // b.date を「エントリー日 D」とみなし、本番 15:24 と同じ経路で判定する
    const state = await getPanicMarketState(b.date);
    if ("unavailable" in state) {
      unavailable++;
      continue;
    }
    evaluated++;
    const signal = detectPanicSignal({
      prevVixClose: state.prevVixClose,
      breadth: state.breadth,
      nikkeiDownStreak: state.nikkeiDownStreak,
      prevDayConditionsMet: detectPanicSignal({
        prevVixClose: state.prevDayVixClose,
        breadth: state.prevDayBreadth,
        nikkeiDownStreak: state.prevDayNikkeiDownStreak,
        prevDayConditionsMet: false,
      }).conditionsMet,
    });
    if (signal.triggered) liveDates.add(dayjs(b.date).format("YYYY-MM-DD"));
  }

  console.log(`走査営業日: ${bars.length} (判定可 ${evaluated} / 判定不能 ${unavailable})`);
  console.log(`BT イベント: ${btDates.size}件`);
  console.log(`live シグナル: ${liveDates.size}件`);

  // 走査対象外の日は比較できないので、BT側も走査範囲に絞って突き合わせる
  const scanned = new Set(bars.map((b) => dayjs(b.date).format("YYYY-MM-DD")));
  const onlyBt = [...btDates].filter((d) => scanned.has(d) && !liveDates.has(d)).sort();
  const onlyLive = [...liveDates].filter((d) => !btDates.has(d)).sort();

  if (onlyBt.length === 0 && onlyLive.length === 0) {
    console.log("\n✅ 完全一致 — live 実装は BT と同じ日に発火する");
  } else {
    console.log(`\n❌ 不一致`);
    if (onlyBt.length) console.log(`  BT のみ (live が撃ち逃す): ${onlyBt.join(", ")}`);
    if (onlyLive.length) console.log(`  live のみ (BT に無い発火): ${onlyLive.join(", ")}`);
  }
  console.log(`\n発火日: ${[...liveDates].sort().join(", ")}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
