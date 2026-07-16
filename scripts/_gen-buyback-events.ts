/**
 * 自社株買いイベントの再生成（検証用・一時利用の `_` プレフィックス）
 *
 * ローカル `tdnet_archive` DB（やのしんTDnetのアーカイブ）から、**本番と同じ分類ロジック**
 * (`classifyBuybackTitle` / `normalizeBuybackCode` / `BUYBACK.POST_CLOSE_HOUR`) を import して
 * combined BT の `--enable-buyback --buyback-json` に食わせるイベントJSONを作る。
 *
 * なぜ残すか: buyback イベントは KOH-511 / KOH-531 の2回とも「scratchpad が消えていて再生成に
 * 時間を要した」（`_gen-panic-events.ts` が同じ理由で残置されているのと同じ）。決定論的なので
 * 再実行すれば同じ集合が出る。
 *
 * ⚠️ KOH-511 の注記どおり、この再生成物は KOH-502 のオリジナル（本番TS実装）より弱い。
 *    絶対値の比較には使えず、**同一セット内の相対比較にのみ**有効。
 *
 * ## live 再現モード (--breadth-lag, KOH-556)
 *
 * BT の precompute (`buyback-simulation.ts:57-58`) は **エントリー日当日の終値 breadth** で
 * idle帯を判定するが、本番にその情報は存在しない。15:24 に当日 breadth を得るには全3,000銘柄の
 * ライブ時価が要り立花の負荷ルール(8:00-15:30 は大量取得禁止)に反するため、ラグは技術的に
 * 消せない（`combined-run.ts:406-409` が panic 用に同じ先読みを「live 再現不能」と明記）。
 *
 * `--breadth-lag 1` を渡すと **生成側が**「エントリー前営業日の終値 breadth」で idle帯を絞る。
 * この時は combined-run に `--buyback-breadth-max 1` を渡して precompute 側の先読みを止める。
 *
 * Usage:
 *   # 現行（BT既定。生成側は素通し、precompute が idle帯フィルタ = 先読みあり）
 *   npx tsx scripts/_gen-buyback-events.ts /tmp/bb_lag0.json
 *
 *   # live 再現（生成側が idle帯フィルタ → precompute は無効化して渡す）
 *   npx tsx scripts/_gen-buyback-events.ts /tmp/bb_lag1.json \
 *     --start 2019-01-01 --end 2026-04-30 --breadth-lag 1 --breadth-universe daily --max-price 2500
 *   npx tsx src/backtest/combined-run.ts --enable-buyback --buyback-json /tmp/bb_lag1.json \
 *     --buyback-breadth-max 1 --start 2019-01-01 --end 2026-04-30 --budget 500000
 *
 * ⚠️ --start/--end は **BT の実行窓と一致させること**。BT のユニバースは
 *    `bars.some(b => b.close <= maxPrice)` = 窓依存なので、窓が違うと breadth も変わる。
 */
import { execFileSync } from "child_process";
import dayjs from "dayjs";
import fs from "fs";
import { classifyBuybackTitle, normalizeBuybackCode, BUYBACK } from "../src/lib/constants/buyback";
import { fetchHistoricalFromDB } from "../src/backtest/data-fetcher";
import { precomputeSimData } from "../src/backtest/breakout-simulation";
import { getMaxBuyablePrice } from "../src/core/risk-manager";
import { MARKET_BREADTH } from "../src/lib/constants";
import { prisma } from "../src/lib/prisma";
import type { OHLCVData } from "../src/core/technical-analysis";

const FLAGS_WITH_VALUE = ["--start", "--end", "--breadth-lag", "--breadth-universe", "--max-price", "--budget"];
const args = process.argv.slice(2);
/** フラグを除いた位置引数（--breadth-lag N 等が後ろに付いても OUT を壊さない） */
const positional = args.filter(
  (a, i) => !a.startsWith("--") && !(i > 0 && FLAGS_WITH_VALUE.includes(args[i - 1])),
);
const getArg = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const OUT = positional[0] ?? "/tmp/buyback_events.json";
const TDNET_DB = process.env.TDNET_ARCHIVE_URL ?? "postgresql://kouheikameyama@localhost:5432/tdnet_archive";

const START = getArg("--start") ?? "2019-01-01";
const END = getArg("--end") ?? "2026-04-30";
const BUDGET = Number(getArg("--budget") ?? 500_000);

/** 未指定 = 生成側で idle帯フィルタを掛けない（従来どおり precompute に任せる） */
const breadthLagRaw = getArg("--breadth-lag");
const BREADTH_LAG = breadthLagRaw != null ? Number(breadthLagRaw) : null;
if (BREADTH_LAG != null && (!Number.isInteger(BREADTH_LAG) || BREADTH_LAG < 0)) {
  console.error(`--breadth-lag は0以上の整数 (got: ${breadthLagRaw})`);
  process.exit(1);
}

/**
 * breadth の母集団 (KOH-554 と同じ軸):
 *   ever  … 期間中どこかで <=maxPrice を付けた銘柄（BT の既定。窓全体を見るので未来情報込み）
 *   daily … その日の終値が <=maxPrice の銘柄（**live で再現できる唯一の定義**）
 */
const BREADTH_UNIVERSE = getArg("--breadth-universe") ?? "ever";
if (!["ever", "daily"].includes(BREADTH_UNIVERSE)) {
  console.error(`--breadth-universe は ever|daily (got: ${BREADTH_UNIVERSE})`);
  process.exit(1);
}

/**
 * 指定すると「判定日の終値が <=MAX_PRICE の銘柄」だけを残す。
 * BT のユニバース (`bars.some(b => b.close <= maxPrice)`) は窓全体を見る未来情報込みの定義で、
 * live は「その日の終値」しか作れないため、その差を測るためのフラグ。
 */
const maxPriceRaw = getArg("--max-price");
const MAX_PRICE = maxPriceRaw != null ? Number(maxPriceRaw) : null;

/** 開示timestamp → 想定エントリー営業日。buyback-monitor.ts:32-38 の computeEntryDate と同一 */
function computeEntryDate(pubdate: string): string {
  let d = dayjs(pubdate);
  if (d.hour() >= BUYBACK.POST_CLOSE_HOUR) d = d.add(1, "day");
  // 週末は翌営業日へ（祝日は近似。本番の観察モードと同じ割り切り）
  while (d.day() === 0 || d.day() === 6) d = d.add(1, "day");
  return d.format("YYYY-MM-DD");
}

/** 終値 > 25日SMA の割合。`precomputeSimData` と同一定義（ever モードで一致を検算する） */
function computeBreadth(
  tickerCloses: Map<string, { di: Map<string, number>; closes: number[] }>,
  tradingDays: string[],
  mode: string,
  maxPrice: number,
): Map<string, number> {
  const SMA_LEN = 25;
  const breadth = new Map<string, number>();
  for (const day of tradingDays) {
    let above = 0;
    let total = 0;
    for (const [, d] of tickerCloses) {
      const idx = d.di.get(day);
      if (idx == null || idx < SMA_LEN - 1) continue;
      // daily: その日の終値が maxPrice 以下の銘柄だけを母集団にする
      if (mode === "daily" && !(d.closes[idx] <= maxPrice && d.closes[idx] > 0)) continue;
      let sum = 0;
      for (let j = idx - SMA_LEN + 1; j <= idx; j++) sum += d.closes[j];
      total++;
      if (d.closes[idx] > sum / SMA_LEN) above++;
    }
    breadth.set(day, total > 0 ? above / total : 0);
  }
  return breadth;
}

/** combined-run.ts:470-506 と同一手順でユニバースを組む（breadth を一致させるため） */
async function loadUniverse(maxPrice: number): Promise<Map<string, OHLCVData[]>> {
  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  let tickerCodes: string[];
  if (stocks.length > 0) {
    tickerCodes = stocks.map((s) => s.tickerCode);
  } else {
    const distinctTickers = await prisma.stockDailyBar.findMany({
      where: { market: "JP" },
      distinct: ["tickerCode"],
      select: { tickerCode: true },
    });
    tickerCodes = distinctTickers.map((s) => s.tickerCode);
  }
  const rawData = await fetchHistoricalFromDB(tickerCodes, START, END);
  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPrice && b.close > 0)) allData.set(ticker, bars);
  }
  return allData;
}

async function main() {
  // `pg` は依存に無い（本番は Prisma）ので psql の TSV 出力を読む
  const tsv = execFileSync(
    "psql",
    [
      TDNET_DB, "-At", "-F", "\t", "-c",
      "SELECT code, to_char(pubdate,'YYYY-MM-DD HH24:MI:SS'), title FROM disclosure WHERE title LIKE '%自己株式取得%' ORDER BY pubdate",
    ],
    { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
  );

  const rows = tsv.split("\n").filter((l) => l.trim() !== "").map((l) => l.split("\t"));
  const candidates: { ticker: string; date: string }[] = [];
  const seen = new Set<string>();
  let classified = 0;

  for (const [code, pubdate, title] of rows) {
    if (classifyBuybackTitle(title) !== "buyback_decision") continue;
    classified++;
    // BT の allData は通常銘柄を `.T` 付きで持つ（指数ETFのみ `.T` 無し。_gen-panic-events.ts:10 参照）
    const ticker = `${normalizeBuybackCode(code)}.T`;
    const date = computeEntryDate(pubdate);
    const key = `${ticker}:${date}`;
    if (seen.has(key)) continue; // 同一銘柄・同一エントリー日の重複を排除
    seen.add(key);
    candidates.push({ ticker, date });
  }

  console.log(`生開示("自己株式取得" を含む): ${rows.length}`);
  console.log(`classifyBuybackTitle 通過(訂正/処分/消却/進捗報告を除外): ${classified}`);
  console.log(`dedup後イベント: ${candidates.length}`);

  let events = candidates;

  if (BREADTH_LAG != null) {
    const maxPrice = getMaxBuyablePrice(BUDGET);
    console.log(`\n--- live 再現モード (breadth-lag=${BREADTH_LAG}, universe=${BREADTH_UNIVERSE}, maxPrice=${maxPrice}) ---`);
    const allData = await loadUniverse(maxPrice);
    // marketTrendFilter=true で dailyBreadth を作る（indexTrendFilter は breadth に無関係なので false）
    const precomputed = precomputeSimData(START, END, allData, true, false, 50);
    console.log(`ユニバース: ${allData.size}銘柄 / 営業日: ${precomputed.tradingDays.length}日`);

    const tickerCloses = new Map<string, { di: Map<string, number>; closes: number[] }>();
    for (const [t, bars] of allData) {
      const di = new Map<string, number>();
      for (let i = 0; i < bars.length; i++) di.set(bars[i].date, i);
      tickerCloses.set(t, { di, closes: bars.map((b) => b.close) });
    }

    // 自己検算: ever モードは BT 本体 (precomputeSimData) と1ビットも違ってはいけない。
    // ここがズレていると「live 再現」を測ったつもりで別物を測ることになる。
    const everCheck = computeBreadth(tickerCloses, precomputed.tradingDays, "ever", maxPrice);
    for (const [day, v] of precomputed.dailyBreadth) {
      if (Math.abs((everCheck.get(day) ?? -1) - v) > 1e-12) {
        throw new Error(`breadth 自己検算に失敗: ${day} 本体=${v} 生成側=${everCheck.get(day)}`);
      }
    }
    console.log(`✓ breadth 自己検算 OK (precomputeSimData と ${precomputed.dailyBreadth.size}日 完全一致)`);

    const breadth =
      BREADTH_UNIVERSE === "ever"
        ? precomputed.dailyBreadth
        : computeBreadth(tickerCloses, precomputed.tradingDays, "daily", maxPrice);

    const tradingDays = precomputed.tradingDays;
    /** date 未満の最後の営業日（lag>=1 用） */
    const lastTradingDayBefore = (date: string): string | null => {
      let lo = 0, hi = tradingDays.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (tradingDays[mid] < date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans >= 0 ? tradingDays[ans] : null;
    };
    const dayIdx = new Map(tradingDays.map((d, i) => [d, i]));
    /** 判定日 = エントリー日の BREADTH_LAG 営業日前（0 ならエントリー日当日 = BT既定の先読み） */
    const refDayFor = (entryDate: string): string | null => {
      if (BREADTH_LAG === 0) return dayIdx.has(entryDate) ? entryDate : null;
      let d: string | null = entryDate;
      for (let k = 0; k < BREADTH_LAG; k++) {
        d = lastTradingDayBefore(d!);
        if (d == null) return null;
      }
      return d;
    };

    const drop = { window: 0, universe: 0, refDay: 0, breadth: 0, price: 0 };
    const kept: { ticker: string; date: string }[] = [];
    for (const e of candidates) {
      if (e.date < START || e.date > END) { drop.window++; continue; }
      const d = tickerCloses.get(e.ticker);
      if (!d) { drop.universe++; continue; } // BT も precompute で落とす（universe外 → 取引不可）
      const refDay = refDayFor(e.date);
      if (refDay == null) { drop.refDay++; continue; } // 非営業日エントリー等。BT も落とす
      const b = breadth.get(refDay);
      if (b == null || b >= MARKET_BREADTH.THRESHOLD) { drop.breadth++; continue; }
      if (MAX_PRICE != null) {
        const idx = d.di.get(refDay);
        const c = idx != null ? d.closes[idx] : null;
        if (c == null || !(c <= MAX_PRICE && c > 0)) { drop.price++; continue; }
      }
      kept.push(e);
    }

    console.log(
      `除外: 窓外 ${drop.window} / universe外 ${drop.universe} / 判定日なし ${drop.refDay} / ` +
      `band帯 ${drop.breadth} / 判定日終値>${MAX_PRICE ?? "-"} ${drop.price}`,
    );
    console.log(`→ idle帯シグナル: ${kept.length}件`);
    events = kept;
  }

  const byYear = new Map<string, number>();
  for (const e of events) byYear.set(e.date.slice(0, 4), (byYear.get(e.date.slice(0, 4)) ?? 0) + 1);
  console.log("年別:", [...byYear.entries()].sort().map(([y, n]) => `${y}:${n}`).join(" "));

  fs.writeFileSync(OUT, JSON.stringify({ events }, null, 1));
  console.log(`\n→ ${OUT} に ${events.length} 件出力${BREADTH_LAG != null ? ` (breadth-lag=${BREADTH_LAG})` : ""}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
