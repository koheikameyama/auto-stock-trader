/**
 * 翌日エントリー可否通知（今日の終値ベースのbreadth）
 *
 * backfill-stock-data で当日バーが StockDailyBar に投入された後に実行する。
 * scheduled_backfill-prices.yml の stock-data ジョブ完了後（17:05 JST 頃）に走る想定。
 *
 * asOfDate は getTodayForDB() を明示的に渡す。今日バーが入っていなければ throw し、
 * Slack にも通知しない（backfill 失敗の検知を兼ねる）。
 */

import dayjs from "dayjs";
import { calculateMarketBreadth } from "../core/market-breadth";
import { forecastBreadthAll, summarizeForecast } from "../core/breadth-forecast";
import { buildBreadthEnrichment, formatEnrichment } from "../core/breadth-history";
import { MARKET_BREADTH } from "../lib/constants/trading";
import { notifySlack } from "../lib/slack";
import { getTodayForDB } from "../lib/market-date";
import { prisma } from "../lib/prisma";

async function main() {
  // 手動試運転用: BREADTH_AS_OF_DATE=2026-05-21 で過去日付で実行可能
  const overrideDate = process.env.BREADTH_AS_OF_DATE;
  const today = overrideDate
    ? new Date(`${overrideDate}T00:00:00Z`)
    : getTodayForDB();
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

  // 下限割れ時のみ復帰見通しを本文に追加
  // 上限超過は「過熱の調整待ち」で別物（点推定や過去類似ケースの統計が下限割れ前提）
  const isBelowThreshold = breadth.breadth < MARKET_BREADTH.THRESHOLD;

  let forecastSummary: string | null = null;
  let enrichmentBlock: string | null = null;

  if (isBelowThreshold) {
    try {
      const fc = await forecastBreadthAll({ days: 20, target: MARKET_BREADTH.THRESHOLD });
      forecastSummary = summarizeForecast(fc, MARKET_BREADTH.THRESHOLD);
      console.log(`[breadth-forecast] ${forecastSummary}`);
    } catch (e) {
      console.warn(`[breadth-forecast] 予測スキップ: ${e instanceof Error ? e.message : e}`);
    }

    try {
      const enrichment = await buildBreadthEnrichment({
        currentBreadth: breadth.breadth,
        target: MARKET_BREADTH.THRESHOLD,
        asOfDate: breadth.asOfDate,
      });
      enrichmentBlock = formatEnrichment(enrichment, MARKET_BREADTH.THRESHOLD);
      if (enrichmentBlock) {
        console.log(`[breadth-enrichment]\n${enrichmentBlock}`);
      }
    } catch (e) {
      console.warn(`[breadth-enrichment] スキップ: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 翌営業日 ETF 発注予定サマリー
  // entry-executor が処理対象とするのと同じ条件で UsEtfSignal を集計
  const etfCutoff = dayjs(today).subtract(3, "day").toDate();
  const pendingEtfSignals = await prisma.usEtfSignal.findMany({
    where: {
      executed: false,
      detectedDate: { gte: etfCutoff },
      skipReason: null,
    },
    orderBy: { detectedDate: "desc" },
  });
  let etfSummary: string;
  if (pendingEtfSignals.length === 0) {
    etfSummary = "📉 翌営業日 ETF 発注予定: なし";
  } else {
    const lines = pendingEtfSignals.map((s) => {
      const days = dayjs(today).diff(dayjs(s.detectedDate), "day");
      const dayLabel = days === 0 ? "今日検出" : `${days}日前`;
      return `  ${s.ticker} (${dayLabel})`;
    });
    etfSummary = `📈 翌営業日 ETF 発注予定: ${pendingEtfSignals.length}件\n${lines.join("\n")}`;
  }

  const parts: string[] = [reason];
  if (enrichmentBlock) parts.push(enrichmentBlock);
  if (forecastSummary) parts.push(`[シナリオ] ${forecastSummary}`);
  parts.push(etfSummary);
  const message = parts.join("\n\n");

  await notifySlack({
    title: isEntryOk
      ? `🟢 明日エントリー可: Breadth ${pct}%`
      : `🔴 明日エントリーNG: Breadth ${pct}%`,
    message,
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
