/**
 * 米株 ETF ポジションのタイムストップ exit 監視
 *
 * 引け前 (15:24 JST) に走る:
 *   1. strategy = "us_etf" の open ポジションを取得
 *   2. 保有営業日数を計算
 *   3. ≥ 5営業日経過なら引け成行売り発注 (立花API)
 *
 * SL は entry-executor で逆指値同時発注済 → 立花側で自動執行されるため、
 * このジョブは「タイムストップ」のみ監視。
 * 約定後の TradingPosition status 更新は既存 broker-fill-handler の event stream に任せる。
 */

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { prisma } from "../lib/prisma";
import { submitOrder } from "../core/broker-orders";
import { TACHIBANA_ORDER } from "../lib/constants/broker";
import { US_ETF_RISK_PARAMS } from "../core/us-etf/entry-conditions";
import { notifySlack } from "../lib/slack";

dayjs.extend(utc);
dayjs.extend(timezone);

const TIMEZONE = "Asia/Tokyo";

function computeHoldingBusinessDays(entryAt: Date, now: Date): number {
  const entryDate = dayjs(entryAt).tz(TIMEZONE);
  const today = dayjs(now).tz(TIMEZONE);
  let days = 0;
  let d = entryDate.add(1, "day");
  while (d.isBefore(today, "day") || d.isSame(today, "day")) {
    const dow = d.day();
    if (dow !== 0 && dow !== 6) days++;
    d = d.add(1, "day");
  }
  return days;
}

async function main() {
  const positions = await prisma.tradingPosition.findMany({
    where: { strategy: "us_etf", status: "open" },
    include: { stock: { select: { tickerCode: true, name: true } } },
  });

  console.log(`[us-etf-position-monitor] open ポジション: ${positions.length}件`);

  if (positions.length === 0) return;

  const now = new Date();
  const closed: { ticker: string; daysHeld: number; orderNumber?: string }[] = [];
  const errors: { ticker: string; reason: string }[] = [];

  for (const pos of positions) {
    const ticker = pos.stock.tickerCode;
    const daysHeld = computeHoldingBusinessDays(pos.createdAt, now);
    const limit = US_ETF_RISK_PARAMS.timeStopDays;

    if (daysHeld < limit) {
      console.log(`${ticker}: ${daysHeld}日経過 (< ${limit}日) → 継続保有`);
      continue;
    }

    console.log(`${ticker}: ${daysHeld}日経過 ≥ ${limit}日 → タイムストップ売り`);

    // 引け成行売り
    const result = await submitOrder({
      ticker,
      side: "sell",
      quantity: pos.quantity,
      limitPrice: null,
      condition: TACHIBANA_ORDER.CONDITION.CLOSE,
    });

    if (!result.success) {
      const reason = result.error ?? "unknown";
      console.error(`${ticker}: 売り発注失敗 ${reason}`);
      errors.push({ ticker, reason });
      continue;
    }

    closed.push({ ticker, daysHeld, orderNumber: result.orderNumber });
    console.log(`${ticker}: 売り発注成功 注文番号=${result.orderNumber}`);
  }

  if (closed.length > 0 || errors.length > 0) {
    const lines: string[] = [];
    if (closed.length > 0) {
      lines.push("*⏰ タイムストップ売り発注*");
      for (const c of closed) {
        lines.push(`  ${c.ticker}: ${c.daysHeld}営業日経過${c.orderNumber ? ` (注文番号=${c.orderNumber})` : ""}`);
      }
    }
    if (errors.length > 0) {
      lines.push("*⚠️ 売り発注失敗*");
      for (const e of errors) {
        lines.push(`  ${e.ticker}: ${e.reason}`);
      }
    }

    await notifySlack({
      title: `📤 ETF タイムストップ: ${closed.length}件売却`,
      message: lines.join("\n"),
      color: closed.length > 0 ? "warning" : "danger",
    });
  }
}

main().catch((e) => {
  console.error("us-etf-position-monitor failed:", e);
  process.exit(1);
});
