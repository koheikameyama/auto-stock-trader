/**
 * 翌日エントリー可否通知（今日の終値ベースのbreadth）
 *
 * backfill-stock-data で当日バーが StockDailyBar に投入された後に実行する。
 * scheduled_backfill-prices.yml の stock-data ジョブ完了後（17:05 JST 頃）に走る想定。
 *
 * asOfDate は getTodayForDB() を明示的に渡す。今日バーが入っていなければ throw し、
 * Slack にも通知しない（backfill 失敗の検知を兼ねる）。
 */

import { calculateMarketBreadth } from "../core/market-breadth";
import { MARKET_BREADTH } from "../lib/constants/trading";
import { notifySlack } from "../lib/slack";
import { getTodayForDB } from "../lib/market-date";

async function main() {
  const today = getTodayForDB();
  const breadth = await calculateMarketBreadth(today);

  const pct = (breadth.breadth * 100).toFixed(1);
  const asOf = breadth.asOfDate.toISOString().slice(0, 10);
  const isEntryOk =
    breadth.breadth >= MARKET_BREADTH.THRESHOLD &&
    breadth.breadth <= MARKET_BREADTH.UPPER_CAP;
  const reason =
    breadth.breadth < MARKET_BREADTH.THRESHOLD
      ? `${pct}% — ${(MARKET_BREADTH.THRESHOLD * 100).toFixed(0)}%未満につきスキップ`
      : breadth.breadth > MARKET_BREADTH.UPPER_CAP
        ? `${pct}% — ${(MARKET_BREADTH.UPPER_CAP * 100).toFixed(0)}%超過（過熱）につきスキップ`
        : `${pct}% — エントリーゾーン内`;

  await notifySlack({
    title: isEntryOk
      ? `🟢 明日エントリー可: Breadth ${pct}%`
      : `🔴 明日エントリーNG: Breadth ${pct}%`,
    message: reason,
    color: isEntryOk ? "good" : "warning",
    fields: [
      { title: "SMA25超え", value: `${breadth.above}/${breadth.total}銘柄`, short: true },
      { title: "基準日", value: asOf, short: true },
    ],
  });

  console.log(`Breadth: ${pct}% (${breadth.above}/${breadth.total}, asOf ${asOf})`);
}

main().catch((e) => {
  console.error("breadth-notify failed:", e);
  process.exit(1);
});
