import { isMarketDay } from "../src/lib/market-date.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const marketDay = isMarketDay();

  if (!marketDay) {
    console.log("false");
    process.exit(0);
  }

  // 営業日なのに isActive=false ならエラー（Slack通知を飛ばす）
  const config = await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });
  const isActive = !config || config.isActive;

  if (!isActive) {
    console.error("ERROR: 営業日ですが TradingConfig.isActive=false のためスキップされます。意図的でない場合は isActive を true に戻してください。");
    process.exit(1);
  }

  console.log("true");
} finally {
  await prisma.$disconnect();
}
