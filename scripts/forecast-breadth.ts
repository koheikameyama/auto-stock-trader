/**
 * Breadth 予測スクリプト（CLI 表示版）
 *
 * 数学的に予測可能な SMA25 の roll効果を使い、今後 N営業日の breadth 推移を予測する。
 * 共通ロジックは src/core/breadth-forecast.ts に。
 *
 * Usage:
 *   npx tsx scripts/forecast-breadth.ts
 *   npx tsx scripts/forecast-breadth.ts --days=25
 *   npx tsx scripts/forecast-breadth.ts --target=0.54
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import { MARKET_BREADTH } from "../src/lib/constants";
import { forecastBreadthAll, summarizeForecast, DEFAULT_SCENARIOS } from "../src/core/breadth-forecast";

async function main() {
  const args = process.argv.slice(2);
  const daysArg = args.find((a) => a.startsWith("--days="));
  const days = daysArg ? parseInt(daysArg.split("=")[1], 10) : 20;
  const targetArg = args.find((a) => a.startsWith("--target="));
  const target = targetArg ? parseFloat(targetArg.split("=")[1]) : MARKET_BREADTH.THRESHOLD;
  const upperCap = MARKET_BREADTH.UPPER_CAP;

  console.log("=".repeat(78));
  console.log("Breadth 予測（SMA25 roll 効果 + 価格シナリオ）");
  console.log("=".repeat(78));

  const result = await forecastBreadthAll({ days, target });

  console.log(`基準日: ${dayjs(result.asOfDate).format("YYYY-MM-DD")}`);
  console.log(`銘柄数: ${result.totalTickers}`);
  console.log(`予測期間: ${days} 営業日`);
  console.log(`下限閾値: ${(target * 100).toFixed(1)}%、上限閾値: ${(upperCap * 100).toFixed(1)}%`);
  console.log(`基準日 breadth: ${(result.currentBreadth * 100).toFixed(1)}%`);
  console.log("");

  console.log("日数表（営業日後の breadth%、★ = 下限到達、▲ = 上限超過）");
  console.log("-".repeat(78));
  const header = ["Day", ...DEFAULT_SCENARIOS.map((s) => s.label.padStart(14))];
  console.log(header.join(" | "));
  console.log("-".repeat(78));

  for (let day = 0; day <= days; day++) {
    const row: string[] = [String(day).padStart(3)];
    for (const r of result.results) {
      const f = r.forecast[day];
      const pct = (f.breadth * 100).toFixed(1) + "%";
      let marker = "";
      if (f.breadth >= target && f.breadth <= upperCap) marker = "★";
      else if (f.breadth > upperCap) marker = "▲";
      row.push((marker + pct).padStart(14));
    }
    console.log(row.join(" | "));
  }
  console.log("");

  console.log("=".repeat(78));
  console.log(`下限 ${(target * 100).toFixed(1)}% 到達予測（=shouldTrade に戻る予想日）`);
  console.log("=".repeat(78));
  for (const r of result.results) {
    if (r.daysToTarget === null) {
      console.log(`  ${r.scenario.label.padEnd(18)} → ${days}日以内に到達せず`);
    } else {
      const crossDate = dayjs(result.asOfDate)
        .add(Math.ceil(r.daysToTarget * 1.4), "day")
        .format("YYYY-MM-DD");
      console.log(
        `  ${r.scenario.label.padEnd(18)} → ${String(r.daysToTarget).padStart(2)} 営業日後 (≈ ${crossDate})`,
      );
    }
  }
  console.log("");
  console.log("サマリー: " + summarizeForecast(result, target));
  console.log("");
  console.log("注意:");
  console.log("  - 全銘柄が一律 X%/日 で動く前提（実際は分散あり、これは保守的近似）");
  console.log("  - SMA25 ロール効果は数学的に正確、価格シナリオの妥当性は別問題");
  console.log("  - VIX急騰やキルスイッチ等の他フィルターは考慮しない");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
