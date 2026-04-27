/**
 * 全銘柄breadth vs 小型株(≤¥2,500)breadth の相関・乖離計測
 *
 * 2024-03-01 〜 現在の日次2系列を算出し、以下を比較:
 * - ピアソン相関
 * - 平均乖離 / 最大乖離
 * - band 55-80% の veto判定一致率
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { prisma } from "../src/lib/prisma";

dayjs.extend(utc);

const START_DATE = new Date("2024-03-01T00:00:00Z");
const END_DATE = new Date();
const SMALL_CAP_MAX_PRICE = 2500;
const BAND_LOWER = 0.55;
const BAND_UPPER = 0.80;

interface DailyRow {
  date: Date;
  above: number;
  total: number;
  breadth: number;
}

async function fetchBreadthSeries(maxPrice: number | null): Promise<DailyRow[]> {
  const priceFilter = maxPrice !== null ? `AND close <= ${maxPrice}` : "";

  const result = await prisma.$queryRawUnsafe<
    { date: Date; above: number; total: number }[]
  >(`
    WITH windowed AS (
      SELECT
        "tickerCode",
        date,
        close,
        AVG(close) OVER (
          PARTITION BY "tickerCode"
          ORDER BY date
          ROWS 24 PRECEDING
        ) as sma25,
        COUNT(*) OVER (
          PARTITION BY "tickerCode"
          ORDER BY date
          ROWS 24 PRECEDING
        ) as window_count
      FROM "StockDailyBar"
      WHERE market = 'JP'
        AND date >= '${dayjs(START_DATE).subtract(60, "day").format("YYYY-MM-DD")}'
        AND date <= '${dayjs(END_DATE).format("YYYY-MM-DD")}'
    )
    SELECT
      date,
      COUNT(*) FILTER (WHERE close > sma25)::int as above,
      COUNT(*)::int as total
    FROM windowed
    WHERE window_count >= 25
      AND date >= '${dayjs(START_DATE).format("YYYY-MM-DD")}'
      ${priceFilter}
    GROUP BY date
    ORDER BY date ASC
  `);

  return result
    .filter((r) => r.total > 0)
    .map((r) => ({
      date: r.date,
      above: r.above,
      total: r.total,
      breadth: r.above / r.total,
    }));
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  return num / Math.sqrt(dx2 * dy2);
}

function pctInBand(b: number): boolean {
  return b >= BAND_LOWER && b <= BAND_UPPER;
}

async function main() {
  console.log("Fetching breadth series...");
  const [all, small] = await Promise.all([
    fetchBreadthSeries(null),
    fetchBreadthSeries(SMALL_CAP_MAX_PRICE),
  ]);

  const smallMap = new Map(small.map((r) => [r.date.toISOString(), r]));
  const aligned = all
    .map((a) => {
      const s = smallMap.get(a.date.toISOString());
      return s
        ? { date: a.date, all: a.breadth, small: s.breadth, allN: a.total, smallN: s.total }
        : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const n = aligned.length;
  const allVals = aligned.map((r) => r.all);
  const smallVals = aligned.map((r) => r.small);
  const diffs = aligned.map((r) => r.small - r.all);

  const corr = pearson(allVals, smallVals);
  const meanDiff = diffs.reduce((s, v) => s + v, 0) / n;
  const absDiff = diffs.map((v) => Math.abs(v));
  const meanAbsDiff = absDiff.reduce((s, v) => s + v, 0) / n;
  const maxAbsDiff = Math.max(...absDiff);
  const maxAbsIdx = absDiff.indexOf(maxAbsDiff);

  const sd = (xs: number[]) => {
    const m = xs.reduce((s, v) => s + v, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
  };

  let bothIn = 0;
  let bothOut = 0;
  let onlyAllIn = 0;
  let onlySmallIn = 0;
  for (const r of aligned) {
    const aIn = pctInBand(r.all);
    const sIn = pctInBand(r.small);
    if (aIn && sIn) bothIn++;
    else if (!aIn && !sIn) bothOut++;
    else if (aIn && !sIn) onlyAllIn++;
    else onlySmallIn++;
  }

  console.log("");
  console.log("=== Breadth Universe Comparison ===");
  console.log(
    `Period: ${dayjs(aligned[0].date).format("YYYY-MM-DD")} 〜 ${dayjs(aligned[n - 1].date).format("YYYY-MM-DD")}`,
  );
  console.log(`Days:   ${n}`);
  console.log(
    `All universe avg count:   ${Math.round(aligned.reduce((s, r) => s + r.allN, 0) / n)} 銘柄`,
  );
  console.log(
    `Small-cap avg count:      ${Math.round(aligned.reduce((s, r) => s + r.smallN, 0) / n)} 銘柄`,
  );
  console.log("");
  console.log("--- Statistics ---");
  console.log(
    `All   breadth: mean=${((allVals.reduce((s, v) => s + v, 0) / n) * 100).toFixed(1)}%  sd=${(sd(allVals) * 100).toFixed(1)}%`,
  );
  console.log(
    `Small breadth: mean=${((smallVals.reduce((s, v) => s + v, 0) / n) * 100).toFixed(1)}%  sd=${(sd(smallVals) * 100).toFixed(1)}%`,
  );
  console.log(`Correlation (Pearson): ${corr.toFixed(4)}`);
  console.log(`Mean diff (small - all):    ${(meanDiff * 100).toFixed(2)}%`);
  console.log(`Mean abs diff:              ${(meanAbsDiff * 100).toFixed(2)}%`);
  console.log(
    `Max abs diff:               ${(maxAbsDiff * 100).toFixed(2)}% on ${dayjs(aligned[maxAbsIdx].date).format("YYYY-MM-DD")}`,
  );
  console.log(
    `  All=${(aligned[maxAbsIdx].all * 100).toFixed(1)}%  Small=${(aligned[maxAbsIdx].small * 100).toFixed(1)}%`,
  );
  console.log("");
  console.log(`--- Band ${BAND_LOWER * 100}%〜${BAND_UPPER * 100}% Veto Agreement ---`);
  console.log(`Both IN  (trade OK):      ${bothIn} (${((bothIn / n) * 100).toFixed(1)}%)`);
  console.log(`Both OUT (veto):          ${bothOut} (${((bothOut / n) * 100).toFixed(1)}%)`);
  console.log(`Only All IN (small veto): ${onlyAllIn} (${((onlyAllIn / n) * 100).toFixed(1)}%)`);
  console.log(`Only Small IN (all veto): ${onlySmallIn} (${((onlySmallIn / n) * 100).toFixed(1)}%)`);
  console.log(`Agreement rate:           ${(((bothIn + bothOut) / n) * 100).toFixed(1)}%`);

  console.log("");
  console.log("--- Top 10 divergence days (|small - all|) ---");
  const sorted = [...aligned]
    .map((r) => ({ ...r, diff: Math.abs(r.small - r.all) }))
    .sort((a, b) => b.diff - a.diff)
    .slice(0, 10);
  for (const r of sorted) {
    console.log(
      `  ${dayjs(r.date).format("YYYY-MM-DD")}: all=${(r.all * 100).toFixed(1)}% small=${(r.small * 100).toFixed(1)}% diff=${((r.small - r.all) * 100).toFixed(1)}%`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
