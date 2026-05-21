/**
 * 米株 ETF (1547, 1545) のエントリー発注
 *
 * 朝寄付前 (8:30〜8:55 JST) に走る:
 *   1. 前営業日に UsEtfSignal に保存された未執行シグナルを取得
 *   2. ロット計算 (リスク 1.5%, 投資上限 40%)
 *   3. 立花API で 寄付成行 + SL逆指値 同時発注 (sGyakusasiOrderType=2)
 *   4. TradingPosition 作成、UsEtfSignal.executed=true 更新
 *   5. Slack 通知
 *
 * MVP: シンプルなロット計算のみ。残高は環境変数 ETF_TRADING_BUDGET、
 *      デフォルト ¥500K。連敗スロットル/集中度/VIX scale は適用しない (ETF は補完戦略)。
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { submitOrder } from "../core/broker-orders";
import { TACHIBANA_ORDER } from "../lib/constants/broker";
import { US_ETF_RISK_PARAMS } from "../core/us-etf/entry-conditions";
import { notifySlack } from "../lib/slack";

// `??` ではなく `||` で空文字列も fallback 対象にする
// (GitHub Actions の未設定 secret は "" になるため)
const BUDGET = parseInt(process.env.ETF_TRADING_BUDGET || "500000", 10);
const MAX_POSITION_PCT = 0.4; // 1ポジ最大40%

async function main() {
  // 直近2営業日以内の未執行シグナルを取得
  const cutoff = dayjs().subtract(3, "day").toDate();
  const signals = await prisma.usEtfSignal.findMany({
    where: { executed: false, detectedDate: { gte: cutoff } },
    orderBy: { detectedDate: "desc" },
  });

  console.log(`[us-etf-entry] 未執行シグナル: ${signals.length}件 (cutoff: ${dayjs(cutoff).format("YYYY-MM-DD")})`);

  if (signals.length === 0) {
    console.log("発注対象なし → 終了");
    return;
  }

  const executed: { ticker: string; qty: number; entryPrice: number; slPrice: number; orderNumber?: string }[] = [];
  const failed: { ticker: string; reason: string }[] = [];

  for (const sig of signals) {
    const ticker = sig.ticker;
    const todayClose = Number(sig.todayClose);
    const slPrice = Number(sig.slPrice);

    // ロット計算
    const riskAmount = BUDGET * US_ETF_RISK_PARAMS.riskPct;
    const slDistance = todayClose - slPrice;
    const qtyByRisk = slDistance > 0 ? Math.floor(riskAmount / slDistance) : 0;
    const qtyByBalance = Math.floor((BUDGET * MAX_POSITION_PCT) / todayClose);
    const qty = Math.max(0, Math.min(qtyByRisk, qtyByBalance));

    if (qty < 1) {
      const reason = `qty<1 (riskAmount=¥${riskAmount.toLocaleString()}, slDistance=¥${slDistance.toFixed(0)}, qtyByRisk=${qtyByRisk}, qtyByBalance=${qtyByBalance})`;
      console.log(`${ticker}: スキップ ${reason}`);
      await prisma.usEtfSignal.update({
        where: { id: sig.id },
        data: { skipReason: reason },
      });
      failed.push({ ticker, reason });
      continue;
    }

    // Stock 取得 (FK で必要)
    const stock = await prisma.stock.findUnique({
      where: { tickerCode: ticker },
      select: { id: true, name: true },
    });
    if (!stock) {
      const reason = `Stock テーブルに ${ticker} なし`;
      console.error(`${ticker}: ${reason}`);
      await prisma.usEtfSignal.update({
        where: { id: sig.id },
        data: { skipReason: reason },
      });
      failed.push({ ticker, reason });
      continue;
    }

    console.log(
      `${ticker} ${stock.name}: 数量 ${qty}株 (1株 ¥${todayClose}, SL ¥${slPrice.toFixed(0)} = -${(US_ETF_RISK_PARAMS.slPct * 100).toFixed(1)}%)`,
    );

    // 立花API 発注: 寄付成行 + SL逆指値同時 (NORMAL_AND_REVERSE)
    const result = await submitOrder({
      ticker,
      side: "buy",
      quantity: qty,
      limitPrice: null, // 寄付成行
      condition: TACHIBANA_ORDER.CONDITION.OPEN,
      stopTriggerPrice: Math.floor(slPrice), // 逆指値トリガー
      // stopOrderPrice 未指定 → 成行 SL
    });

    if (!result.success) {
      const reason = result.error ?? "unknown broker error";
      console.error(`${ticker}: 発注失敗 ${reason}`);
      await prisma.usEtfSignal.update({
        where: { id: sig.id },
        data: { skipReason: reason },
      });
      failed.push({ ticker, reason });
      continue;
    }

    // TradingPosition 作成
    const position = await prisma.tradingPosition.create({
      data: {
        stockId: stock.id,
        strategy: "us_etf",
        entryPrice: todayClose,
        quantity: qty,
        stopLossPrice: slPrice,
        status: "open",
        slBrokerOrderId: result.orderNumber,
        slBrokerBusinessDay: result.businessDay,
        appliedRiskPct: US_ETF_RISK_PARAMS.riskPct,
        entrySnapshot: {
          signalDetectedDate: dayjs(sig.detectedDate).format("YYYY-MM-DD"),
          gap: Number(sig.gap),
          volSurge: Number(sig.volSurge),
          japanBreadth: Number(sig.japanBreadth),
          timeStopDays: US_ETF_RISK_PARAMS.timeStopDays,
        },
      },
    });

    await prisma.usEtfSignal.update({
      where: { id: sig.id },
      data: {
        executed: true,
        executedAt: new Date(),
        brokerOrderNumber: result.orderNumber,
        positionId: position.id,
      },
    });

    executed.push({ ticker, qty, entryPrice: todayClose, slPrice, orderNumber: result.orderNumber });
    console.log(`${ticker}: 発注成功 注文番号=${result.orderNumber}`);
  }

  // Slack 通知
  if (executed.length > 0 || failed.length > 0) {
    const lines: string[] = [];
    if (executed.length > 0) {
      lines.push("*✅ 発注成功*");
      for (const e of executed) {
        lines.push(
          `  ${e.ticker}: ${e.qty}株 @ ¥${e.entryPrice.toLocaleString()} (SL ¥${e.slPrice.toFixed(0)})${e.orderNumber ? ` 注文番号=${e.orderNumber}` : ""}`,
        );
      }
    }
    if (failed.length > 0) {
      lines.push("*⚠️ 発注スキップ/失敗*");
      for (const f of failed) {
        lines.push(`  ${f.ticker}: ${f.reason}`);
      }
    }

    await notifySlack({
      title: `📈 ETF entry-executor: 成功${executed.length}件 / 失敗${failed.length}件`,
      message: lines.join("\n"),
      color: executed.length > 0 ? "good" : "warning",
    });
  }
}

main().catch((e) => {
  console.error("us-etf-entry-executor failed:", e);
  process.exit(1);
});
