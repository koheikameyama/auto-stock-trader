/**
 * 全銘柄 breadth と大型株 (時価総額 ≥ ¥100B) breadth の divergence を比較
 * 中小型株の独自の弱さ (仮説3) を検証する
 *
 * 一時利用スクリプト。確認後に削除する。
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import { jstDateAsUTC } from "../src/lib/market-date";

const LARGECAP_THRESHOLD = 100_000_000_000; // ¥100B (1,000億円)

interface BreadthByDate {
  date: Date;
  all: { above: number; total: number };
  largecap: { above: number; total: number };
}

async function main() {
  // marketCap 分布を確認
  const dist = await prisma.$queryRaw<
    { count: bigint; min: number; max: number; median: number; p90: number; p99: number }[]
  >`
    SELECT
      COUNT(*) as count,
      MIN("marketCap")::float as min,
      MAX("marketCap")::float as max,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "marketCap")::float as median,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY "marketCap")::float as p90,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY "marketCap")::float as p99
    FROM "Stock"
    WHERE market = 'JP' AND "marketCap" IS NOT NULL
  `;
  console.log("==== marketCap 分布（JP, NOT NULL）====");
  console.log(dist[0]);

  // 大型株の ticker リストを取得
  const largecaps = await prisma.stock.findMany({
    where: {
      market: "JP",
      marketCap: { gte: LARGECAP_THRESHOLD },
    },
    select: { tickerCode: true, marketCap: true },
  });
  console.log(`\n大型株 (時価総額 ≥ ¥${LARGECAP_THRESHOLD.toExponential()}): ${largecaps.length}銘柄`);

  if (largecaps.length === 0) {
    console.log("大型株が0件のため、別閾値を試行（median + p90 + p99 を見て手動調整推奨）");
    return;
  }

  // 集計範囲
  const endDate = new Date();
  const fromDate = jstDateAsUTC(dayjs(endDate).utc().subtract(900, "day"));
  const calcStart = jstDateAsUTC(dayjs(endDate).utc().subtract(800, "day"));

  // 全銘柄 + 大型株フラグ付きで SQL 一発計算
  const rows = await prisma.$queryRaw<
    { date: Date; above_all: number; total_all: number; above_lc: number; total_lc: number }[]
  >`
    WITH lc AS (
      SELECT "tickerCode"
      FROM "Stock"
      WHERE market = 'JP' AND "marketCap" >= ${LARGECAP_THRESHOLD}
    ),
    windowed AS (
      SELECT
        sdb."tickerCode",
        sdb.date,
        sdb.close,
        AVG(sdb.close) OVER (
          PARTITION BY sdb."tickerCode"
          ORDER BY sdb.date
          ROWS 24 PRECEDING
        ) as sma25,
        COUNT(*) OVER (
          PARTITION BY sdb."tickerCode"
          ORDER BY sdb.date
          ROWS 24 PRECEDING
        ) as window_count,
        CASE WHEN lc."tickerCode" IS NOT NULL THEN true ELSE false END as is_largecap
      FROM "StockDailyBar" sdb
      LEFT JOIN lc ON lc."tickerCode" = sdb."tickerCode"
      WHERE sdb.market = 'JP'
        AND sdb.date >= ${fromDate}
        AND sdb.date <= ${endDate}
    )
    SELECT
      date,
      COUNT(*) FILTER (WHERE close > sma25)::int as above_all,
      COUNT(*)::int as total_all,
      COUNT(*) FILTER (WHERE close > sma25 AND is_largecap)::int as above_lc,
      COUNT(*) FILTER (WHERE is_largecap)::int as total_lc
    FROM windowed
    WHERE window_count >= 25
      AND date >= ${calcStart}
    GROUP BY date
    ORDER BY date ASC
  `;

  const series: BreadthByDate[] = rows
    .filter((r) => r.total_all > 0 && r.total_lc > 0)
    .map((r) => ({
      date: r.date,
      all: { above: r.above_all, total: r.total_all },
      largecap: { above: r.above_lc, total: r.total_lc },
    }));

  console.log(
    `期間: ${dayjs(series[0]?.date).format("YYYY-MM-DD")} 〜 ${dayjs(series[series.length - 1]?.date).format("YYYY-MM-DD")} (${series.length} 営業日)`,
  );

  // 直近20日の比較テーブル
  console.log("\n==== 直近20営業日: 全銘柄 vs 大型株 ====");
  console.log("日付          全銘柄    大型株    乖離");
  console.log("─".repeat(50));
  const last20 = series.slice(-20);
  for (const p of last20) {
    const allPct = (p.all.above / p.all.total) * 100;
    const lcPct = (p.largecap.above / p.largecap.total) * 100;
    const div = lcPct - allPct;
    const sign = div >= 0 ? "+" : "";
    console.log(
      `${dayjs(p.date).format("YYYY-MM-DD")}  ${allPct.toFixed(1).padStart(5)}%   ${lcPct.toFixed(1).padStart(5)}%   ${sign}${div.toFixed(1)}pp`,
    );
  }

  // 期間別サマリー
  console.log("\n==== 期間別サマリー ====");
  const regimes = [
    { label: "全期間", from: series[0].date, to: series[series.length - 1].date },
    { label: "D期: 大強気 (25/05-26/02)", from: dayjs("2025-05-01").toDate(), to: dayjs("2026-02-28").toDate() },
    { label: "E期: 直近急落 (26/03-04)", from: dayjs("2026-03-01").toDate(), to: dayjs("2026-04-30").toDate() },
    { label: "F期: 現在進行中 (26/05-)", from: dayjs("2026-05-01").toDate(), to: dayjs("2026-12-31").toDate() },
  ];

  for (const r of regimes) {
    const segment = series.filter((p) => p.date >= r.from && p.date <= r.to);
    if (segment.length === 0) continue;
    const allAvg =
      segment.reduce((sum, p) => sum + p.all.above / p.all.total, 0) / segment.length;
    const lcAvg =
      segment.reduce((sum, p) => sum + p.largecap.above / p.largecap.total, 0) / segment.length;
    const div = lcAvg - allAvg;
    const sign = div >= 0 ? "+" : "";
    console.log(
      `${r.label.padEnd(34)} 全銘柄 ${(allAvg * 100).toFixed(1)}% / 大型株 ${(lcAvg * 100).toFixed(1)}% (乖離 ${sign}${(div * 100).toFixed(1)}pp)`,
    );
  }

  // divergence が最大のタイミング Top10
  console.log("\n==== 乖離 TOP10 (大型株が全銘柄を上回った日) ====");
  const divs = series.map((p) => ({
    date: p.date,
    allPct: (p.all.above / p.all.total) * 100,
    lcPct: (p.largecap.above / p.largecap.total) * 100,
    div: (p.largecap.above / p.largecap.total) * 100 - (p.all.above / p.all.total) * 100,
  }));
  divs.sort((a, b) => b.div - a.div);
  for (let i = 0; i < 10; i++) {
    const d = divs[i];
    console.log(
      `  ${dayjs(d.date).format("YYYY-MM-DD")}: 大型 ${d.lcPct.toFixed(1)}% - 全 ${d.allPct.toFixed(1)}% = +${d.div.toFixed(1)}pp`,
    );
  }

  console.log("\n==== 逆方向: 大型株が全銘柄を下回った日 BOTTOM10 ====");
  divs.sort((a, b) => a.div - b.div);
  for (let i = 0; i < 10; i++) {
    const d = divs[i];
    console.log(
      `  ${dayjs(d.date).format("YYYY-MM-DD")}: 大型 ${d.lcPct.toFixed(1)}% - 全 ${d.allPct.toFixed(1)}% = ${d.div.toFixed(1)}pp`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
