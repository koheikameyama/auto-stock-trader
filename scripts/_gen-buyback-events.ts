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
 * Usage:
 *   npx tsx scripts/_gen-buyback-events.ts /tmp/buyback_events.json
 *   npx tsx src/backtest/combined-run.ts --enable-buyback --buyback-json /tmp/buyback_events.json \
 *     --start 2019-01-01 --end 2026-04-30 --budget 500000
 */
import { execFileSync } from "child_process";
import dayjs from "dayjs";
import fs from "fs";
import { classifyBuybackTitle, normalizeBuybackCode, BUYBACK } from "../src/lib/constants/buyback";

const OUT = process.argv[2] ?? "/tmp/buyback_events.json";
const TDNET_DB = process.env.TDNET_ARCHIVE_URL ?? "postgresql://kouheikameyama@localhost:5432/tdnet_archive";

/** 開示timestamp → 想定エントリー営業日。buyback-monitor.ts:32-38 の computeEntryDate と同一 */
function computeEntryDate(pubdate: string): string {
  let d = dayjs(pubdate);
  if (d.hour() >= BUYBACK.POST_CLOSE_HOUR) d = d.add(1, "day");
  // 週末は翌営業日へ（祝日は近似。本番の観察モードと同じ割り切り）
  while (d.day() === 0 || d.day() === 6) d = d.add(1, "day");
  return d.format("YYYY-MM-DD");
}

function main() {
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
  const events: { ticker: string; date: string }[] = [];
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
    events.push({ ticker, date });
  }

  console.log(`生開示("自己株式取得" を含む): ${rows.length}`);
  console.log(`classifyBuybackTitle 通過(訂正/処分/消却/進捗報告を除外): ${classified}`);
  console.log(`dedup後イベント: ${events.length}`);
  const byYear = new Map<string, number>();
  for (const e of events) byYear.set(e.date.slice(0, 4), (byYear.get(e.date.slice(0, 4)) ?? 0) + 1);
  console.log("年別:", [...byYear.entries()].sort().map(([y, n]) => `${y}:${n}`).join(" "));

  fs.writeFileSync(OUT, JSON.stringify({ events }, null, 1));
  console.log(`\n→ ${OUT} に ${events.length} 件出力`);
}

main();
