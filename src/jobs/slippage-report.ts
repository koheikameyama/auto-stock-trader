/**
 * スリッページ実測レポート
 *
 * TradingOrder に記録済みの referencePrice / slippageBps（約定時に broker-fill-handler /
 * position-manager が自動記録）を集計し、「資金（ポジション金額）が増えるとスリッページが
 * 悪化するか＝実運用キャパシティ」を可視化する。
 *
 * BT は流動性・マーケットインパクトを未考慮なため、この実測値だけが「本当のキャパ」を
 * 教えてくれる。トレードが溜まるほど精度が上がるフォワード型モニタ。
 *
 * Usage:
 *   npm run slippage-report
 *   npm run slippage-report -- --days 180   # 直近180日に限定
 *   npm run slippage-report -- --slack       # Slack にも要約を送る
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { notifySlack } from "../lib/slack";
import {
  summarizeSlippage,
  type SlippageRecord,
  type SlippageStat,
} from "../core/slippage-analysis";

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function fmtStat(s: SlippageStat): string {
  if (s.n === 0) return `n=0`;
  return (
    `n=${String(s.n).padStart(4)}  ` +
    `avg=${s.avgCostBps >= 0 ? "+" : ""}${s.avgCostBps.toFixed(1)}bps  ` +
    `med=${s.medianCostBps >= 0 ? "+" : ""}${s.medianCostBps.toFixed(1)}bps  ` +
    `p90=${s.p90CostBps >= 0 ? "+" : ""}${s.p90CostBps.toFixed(1)}bps  ` +
    `平均金額=¥${Math.round(s.avgNotional).toLocaleString()}`
  );
}

async function main() {
  const days = getArg("--days") ? Number(getArg("--days")) : null;
  const toSlack = process.argv.includes("--slack");

  const where: Record<string, unknown> = {
    status: "filled",
    slippageBps: { not: null },
    filledPrice: { not: null },
    referencePrice: { not: null },
  };
  if (days) {
    where.filledAt = { gte: dayjs().subtract(days, "day").toDate() };
  }

  const orders = await prisma.tradingOrder.findMany({
    where,
    select: {
      side: true,
      strategy: true,
      slippageBps: true,
      filledPrice: true,
      quantity: true,
      filledAt: true,
    },
  });

  const records: SlippageRecord[] = orders
    .filter((o) => o.slippageBps != null && o.filledPrice != null && o.filledAt != null)
    .map((o) => ({
      side: o.side === "sell" ? "sell" : "buy",
      strategy: o.strategy,
      slippageBps: o.slippageBps!,
      notional: Number(o.filledPrice) * o.quantity,
      filledAt: o.filledAt!,
    }));

  console.log("=".repeat(70));
  console.log("スリッページ実測レポート（実約定 vs 基準価格）");
  console.log("=".repeat(70));
  console.log(`対象: ${days ? `直近${days}日` : "全期間"} / 有効約定 ${records.length}件`);
  console.log("符号: costBps 正 = 基準価格より不利に約定した執行コスト（買=高く買った/売=安く売った）\n");

  if (records.length === 0) {
    console.log(
      "スリッページ記録のある約定がまだありません。\n" +
        "→ 実トレードが約定するとデータが蓄積されます（本番DBで実行してください）。",
    );
    await prisma.$disconnect();
    return;
  }

  const sum = summarizeSlippage(records);

  console.log("── 全体 ──");
  console.log(`  ${fmtStat(sum.overall)}`);
  console.log("\n── 売買別 ──");
  console.log(`  買(エントリー): ${fmtStat(sum.byBuySell.buy)}`);
  console.log(`  売(エグジット): ${fmtStat(sum.byBuySell.sell)}`);

  console.log("\n── 戦略別 ──");
  for (const s of sum.byStrategy) console.log(`  ${s.key.padEnd(24)} ${fmtStat(s.stat)}`);

  console.log("\n── 買い × 約定金額帯（キャパシティ曲線：金額が上がるほど avg が悪化＝インパクト） ──");
  for (const b of sum.buyByNotional) console.log(`  ${b.label.padEnd(11)} ${fmtStat(b.stat)}`);

  console.log("\n── 月次（買い）──");
  for (const m of sum.byMonth) console.log(`  ${m.month}  ${fmtStat(m.buy)}`);

  console.log(
    "\n※ costBps 10bps = 0.10%。買いの avg が金額帯で右肩上がりなら「その規模で価格を動かし始めている」= キャパ接近。" +
      "\n※ BT はインパクト未考慮なので、この実測が拡大可能な資金上限の唯一の根拠。",
  );

  if (toSlack) {
    const b = sum.byBuySell.buy;
    const s = sum.byBuySell.sell;
    await notifySlack({
      title: "📊 スリッページ実測レポート",
      message:
        `対象 ${days ? `直近${days}日` : "全期間"} / ${records.length}件\n` +
        `買(エントリー): avg ${b.avgCostBps >= 0 ? "+" : ""}${b.avgCostBps.toFixed(1)}bps (n=${b.n})\n` +
        `売(エグジット): avg ${s.avgCostBps >= 0 ? "+" : ""}${s.avgCostBps.toFixed(1)}bps (n=${s.n})`,
      color: "good",
    }).catch(() => {});
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
