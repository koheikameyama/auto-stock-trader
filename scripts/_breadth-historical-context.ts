/**
 * 過去 N ヶ月の breadth 統計を出して、現在の状況を歴史的に位置付ける。
 * 一時利用スクリプト。確認後に削除する。
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import { fetchBreadthSeries } from "../src/core/breadth-history";
import { MARKET_BREADTH } from "../src/lib/constants/trading";

interface Episode {
  startDate: Date;
  endDate: Date;
  durationDays: number;
  minBreadth: number;
  meanBreadth: number;
}

function summarize(label: string, values: number[]) {
  if (values.length === 0) {
    console.log(`${label}: データなし`);
    return;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  const median = sorted[Math.floor(sorted.length * 0.5)];
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const p75 = sorted[Math.floor(sorted.length * 0.75)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  console.log(
    `${label} (N=${values.length}): 平均${(mean * 100).toFixed(1)}% / 中央値${(median * 100).toFixed(1)}% / 25-75%${(p25 * 100).toFixed(1)}-${(p75 * 100).toFixed(1)}% / 最小${(min * 100).toFixed(1)}% / 最大${(max * 100).toFixed(1)}%`,
  );
}

async function main() {
  // 過去 ~600 営業日 (約2.5年) を取得
  const series = await fetchBreadthSeries({ lookbackDays: 600 });

  console.log(`\n==== 過去 breadth 統計 ====`);
  console.log(
    `期間: ${dayjs(series[0]?.date).format("YYYY-MM-DD")} 〜 ${dayjs(series[series.length - 1]?.date).format("YYYY-MM-DD")} (${series.length} 営業日)`,
  );
  const latest = series[series.length - 1];
  console.log(`最新 breadth: ${(latest.breadth * 100).toFixed(1)}% (${dayjs(latest.date).format("YYYY-MM-DD")})`);
  console.log("");

  // === 全期間統計 ===
  console.log("==== 全期間サマリー ====");
  summarize("全営業日", series.map((p) => p.breadth));
  console.log("");

  // band 外日数
  const belowThreshold = series.filter((p) => p.breadth < MARKET_BREADTH.THRESHOLD).length;
  const aboveCap = series.filter((p) => p.breadth > MARKET_BREADTH.UPPER_CAP).length;
  const inBand = series.length - belowThreshold - aboveCap;
  console.log(
    `band 内 (54-80%): ${inBand}日 (${((inBand / series.length) * 100).toFixed(1)}%) / 下限割れ: ${belowThreshold}日 (${((belowThreshold / series.length) * 100).toFixed(1)}%) / 上限超過: ${aboveCap}日 (${((aboveCap / series.length) * 100).toFixed(1)}%)`,
  );

  // 現在(32.8%)以下の日数
  const currentLevel = latest.breadth;
  const belowCurrent = series.filter((p) => p.breadth <= currentLevel + 0.001).length;
  console.log(
    `現在 (${(currentLevel * 100).toFixed(1)}%) 以下の日数: ${belowCurrent}日 (${((belowCurrent / series.length) * 100).toFixed(1)}%)`,
  );
  console.log("");

  // === 年別統計 ===
  console.log("==== 年別 ====");
  const byYear = new Map<number, number[]>();
  for (const p of series) {
    const y = dayjs(p.date).year();
    const arr = byYear.get(y) ?? [];
    arr.push(p.breadth);
    byYear.set(y, arr);
  }
  for (const [year, values] of [...byYear.entries()].sort(([a], [b]) => a - b)) {
    summarize(`${year}年`, values);
  }
  console.log("");

  // === CLAUDE.md レジーム区分での比較 ===
  console.log("==== レジーム別 (CLAUDE.md 区分) ====");
  const regimes: { label: string; from: string; to: string }[] = [
    { label: "A: 平穏ボックス (24/03-07)", from: "2024-03-01", to: "2024-07-31" },
    { label: "B: ブラマン+余震 (24/08-12)", from: "2024-08-01", to: "2024-12-31" },
    { label: "C: 関税ショック (25/02-04)", from: "2025-02-01", to: "2025-04-30" },
    { label: "D: 大強気 (25/05-26/02)", from: "2025-05-01", to: "2026-02-28" },
    { label: "E: 直近急落 (26/03-04)", from: "2026-03-01", to: "2026-04-30" },
    { label: "F: 現在進行中 (26/04-)", from: "2026-05-01", to: "2026-12-31" },
  ];
  for (const r of regimes) {
    const fromD = dayjs(r.from).toDate();
    const toD = dayjs(r.to).toDate();
    const vals = series.filter((p) => p.date >= fromD && p.date <= toD).map((p) => p.breadth);
    summarize(`  ${r.label}`, vals);
  }
  console.log("");

  // === 弱気エピソード（連続 band 外）の抽出 ===
  console.log("==== 弱気エピソード（連続 5営業日以上 < 54%） ====");
  const episodes: Episode[] = [];
  let runStart = -1;
  let runValues: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const inSlump = series[i].breadth < MARKET_BREADTH.THRESHOLD;
    if (inSlump) {
      if (runStart === -1) {
        runStart = i;
        runValues = [];
      }
      runValues.push(series[i].breadth);
    } else if (runStart !== -1) {
      if (runValues.length >= 5) {
        episodes.push({
          startDate: series[runStart].date,
          endDate: series[i - 1].date,
          durationDays: runValues.length,
          minBreadth: Math.min(...runValues),
          meanBreadth: runValues.reduce((a, b) => a + b, 0) / runValues.length,
        });
      }
      runStart = -1;
      runValues = [];
    }
  }
  // 最後が slump で終わった場合
  if (runStart !== -1 && runValues.length >= 5) {
    episodes.push({
      startDate: series[runStart].date,
      endDate: series[series.length - 1].date,
      durationDays: runValues.length,
      minBreadth: Math.min(...runValues),
      meanBreadth: runValues.reduce((a, b) => a + b, 0) / runValues.length,
    });
  }

  episodes.sort((a, b) => b.durationDays - a.durationDays);
  console.log(`総エピソード数: ${episodes.length}\n`);
  console.log("継続日数 TOP10:");
  for (let i = 0; i < Math.min(10, episodes.length); i++) {
    const e = episodes[i];
    console.log(
      `  ${dayjs(e.startDate).format("YYYY-MM-DD")} 〜 ${dayjs(e.endDate).format("YYYY-MM-DD")}: ${e.durationDays}日 (最低${(e.minBreadth * 100).toFixed(1)}%, 平均${(e.meanBreadth * 100).toFixed(1)}%)`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
