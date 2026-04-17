/**
 * ブレイクアウト戦略のエントリーエグゼキューター
 *
 * ブレイクアウトトリガーを受け取り、以下のフローを実行する:
 * 1. 今日のMarketAssessmentでshouldTradeを確認
 * 2. 買い余力チェック（ローカル計算）
 * 3. SL価格 = currentPrice - ATR(14) × 1.0（最大3%）
 * 4. ポジションサイズ = リスク金額（資金のRISK_PER_TRADE_PCT%） / (currentPrice - SL)��100株単位切捨て
 * 5. TradingOrderをDBに作成
 * 6. submitBrokerOrder()でブローカー発注
 * 7. Slack通知
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { prisma } from "../../lib/prisma";
import { getTodayForDB, adjustToTradingDay } from "../../lib/market-date";
import { getCashBalance, getEffectiveCapital } from "../position-manager";
import { canOpenPosition, getDynamicMaxPositionPct } from "../risk-manager";
import { submitOrder as submitBrokerOrder } from "../broker-orders";
import { notifyOrderPlaced, notifySlack } from "../../lib/slack";
import { STOP_LOSS, UNIT_SHARES, POSITION_SIZING, LOSING_STREAK } from "../../lib/constants";
import { getLosingStreak } from "../drawdown-manager";
import { checkLiquidity } from "../market-data";
import { TIMEZONE } from "../../lib/constants/timezone";
import { GAPUP } from "../../lib/constants/gapup";
import { WEEKLY_BREAK } from "../../lib/constants/weekly-break";
import { POST_SURGE_CONSOLIDATION } from "../../lib/constants/post-surge-consolidation";
import { TACHIBANA_ORDER } from "../../lib/constants/broker";
import { ORDER_EXPIRY } from "../../lib/constants/jobs";
import type { GapUpTrigger } from "../gapup/gapup-scanner";
import type { WeeklyBreakTrigger } from "../weekly-break/weekly-break-scanner";
import type { PostSurgeConsolidationTrigger } from "../post-surge-consolidation/psc-scanner";

dayjs.extend(utc);
dayjs.extend(timezone);

/** スキップ理由を追跡対象ラベルに変換する。null = 追跡しない */
function getRejectedLabel(reason: string): string | null {
  if (/予算不足|残高不足|現金残高不足/.test(reason)) return "残高不足";
  if (/集中率上限|投資比率上限/.test(reason)) return "集中率上限";
  if (/最大同時保有数/.test(reason)) return "ポジション数上限";
  if (/流動性/.test(reason)) return "流動性不足";
  if (/セクター/.test(reason)) return "セクター集中";
  if (/連敗クールダウン/.test(reason)) return "連敗クールダウン";
  return null;
}

/** RejectedSignal を非同期で保存（エラーは握りつぶしてメイン処理を止めない） */
async function saveRejectedSignal(params: {
  ticker: string;
  strategy: string;
  reason: string;
  reasonLabel: string;
  entryPrice: number;
}): Promise<void> {
  try {
    await prisma.rejectedSignal.create({
      data: {
        ticker: params.ticker,
        strategy: params.strategy,
        rejectedAt: new Date(),
        reason: params.reason,
        reasonLabel: params.reasonLabel,
        entryPrice: params.entryPrice,
      },
    });
  } catch (err) {
    console.error("[entry-executor] RejectedSignal 保存失敗:", err);
  }
}

export interface ExecutionResult {
  success: boolean;
  orderId?: string;
  reason?: string;
  /** true の場合、同じ銘柄の再トリガーを許可する（一時的な理由での却下） */
  retryable?: boolean;
}

/**
 * トリガーのエントリー実行（gapup / weekly-break）
 *
 * @param trigger トリガーイベント
 * @param strategy 戦略種別
 */
export async function executeEntry(
  trigger: GapUpTrigger | WeeklyBreakTrigger | PostSurgeConsolidationTrigger,
  strategy: "gapup" | "weekly-break" | "post-surge-consolidation" = "gapup",
): Promise<ExecutionResult> {
  const { ticker, currentPrice, atr14 } = trigger;

  // 0. 共有データを並列で一括取得（重複クエリ削減）
  const [todayAssessment, stock, cashBalance, effectiveCapital, config, openPositions, losingStreak] =
    await Promise.all([
      prisma.marketAssessment.findUnique({ where: { date: getTodayForDB() } }),
      prisma.stock.findUnique({ where: { tickerCode: ticker } }),
      getCashBalance(),
      getEffectiveCapital(),
      prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } }),
      prisma.tradingPosition.findMany({
        where: { status: "open" },
        include: { stock: { select: { id: true, jpxSectorName: true, tickerCode: true } } },
      }),
      getLosingStreak(),
    ]);

  // 1. shouldTrade確認
  if (!todayAssessment || !todayAssessment.shouldTrade) {
    const reason = !todayAssessment
      ? "今日のMarketAssessmentがありません"
      : "今日は取引見送り（shouldTrade=false）";
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    return { success: false, reason, retryable: false };
  }

  // 2. 銘柄マスタ確認
  if (!stock) {
    const reason = `銘柄マスタに存在しません: ${ticker}`;
    console.log(`[entry-executor] ${reason}`);
    return { success: false, reason, retryable: false };
  }

  // 3. SL価格 = currentPrice - ATR × multiplier（最大3%に制限）
  const slAtrMultiplier =
    strategy === "gapup" ? GAPUP.STOP_LOSS.ATR_MULTIPLIER
    : strategy === "weekly-break" ? WEEKLY_BREAK.STOP_LOSS.ATR_MULTIPLIER
    : POST_SURGE_CONSOLIDATION.STOP_LOSS.ATR_MULTIPLIER;
  const rawStopLoss = currentPrice - atr14 * slAtrMultiplier;
  const maxStopLoss = currentPrice * (1 - STOP_LOSS.MAX_LOSS_PCT);
  const stopLossPrice = Math.round(Math.max(rawStopLoss, maxStopLoss));

  const isSLClamped = rawStopLoss < maxStopLoss;
  if (isSLClamped) {
    const reason = `SLがATRベース（¥${Math.round(rawStopLoss)}）より3%上限（¥${stopLossPrice}）でクランプされました — ノイズに狩られるリスクが高いためスキップ`;
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    return { success: false, reason, retryable: false };
  }

  // 4. ポジションサイズ計算（RRに応じたリスク%傾斜）
  const riskPerShare = currentPrice - stopLossPrice;

  if (riskPerShare <= 0) {
    const reason = `SLがエントリー価格以上のため数量計算不可（SL: ¥${stopLossPrice}, entry: ¥${currentPrice}）`;
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    return { success: false, reason, retryable: false };
  }

  // 利確参考値: ATR × 5.0（トレーリングストップが実際の利確を担う、サイジングには使わない）
  const takeProfitPrice = Math.round(currentPrice + atr14 * 5.0);

  // リスク%: フラット2%（SL/TPが共にATRベースのためRR傾斜は常に固定値になり無意味）
  // 連敗時はスケールダウンして損失を抑える
  const baseRiskPct = POSITION_SIZING.RISK_PER_TRADE_PCT;
  const riskPct = losingStreak >= LOSING_STREAK.SCALE_TRIGGER
    ? baseRiskPct * LOSING_STREAK.SCALE_FACTOR
    : baseRiskPct;
  const riskAmount = effectiveCapital * (riskPct / 100);

  const rawQuantity = Math.floor(riskAmount / riskPerShare);
  let quantity = Math.floor(rawQuantity / UNIT_SHARES) * UNIT_SHARES;

  if (quantity === 0) {
    const reason = `予算不足でポジションサイズが0（余力: ¥${cashBalance.toLocaleString()}, リスク額: ¥${riskAmount.toLocaleString()}, リスク%: ${riskPct}%）`;
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    const label = getRejectedLabel(reason);
    if (label) {
      await saveRejectedSignal({ ticker, strategy, reason, reasonLabel: label, entryPrice: currentPrice });
    }
    return { success: false, reason, retryable: true };
  }

  // 残高上限で切り下げ: 買える最大100株単位に縮小
  const maxByBalance = Math.floor(cashBalance / currentPrice / UNIT_SHARES) * UNIT_SHARES;
  if (quantity > maxByBalance) {
    if (maxByBalance === 0) {
      const reason = `残高不足（必要: ¥${(currentPrice * quantity).toLocaleString()}, 残高: ¥${cashBalance.toLocaleString()}）`;
      console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
      const label = getRejectedLabel(reason);
      if (label) {
        await saveRejectedSignal({ ticker, strategy, reason, reasonLabel: label, entryPrice: currentPrice });
      }
      return { success: false, reason, retryable: true };
    }
    console.log(`[entry-executor] ${ticker} 残高上限で縮小: ${quantity}株 → ${maxByBalance}株（残高: ¥${cashBalance.toLocaleString()}）`);
    quantity = maxByBalance;
  }

  // 集中率上限で切り下げ: maxPositionPct 以内に収まる最大100株単位に縮小
  const maxPositionPct = getDynamicMaxPositionPct(effectiveCapital, currentPrice);
  const existingAmountForStock = openPositions
    .filter((pos) => pos.stockId === stock.id)
    .reduce((sum, pos) => sum + Number(pos.entryPrice) * pos.quantity, 0);
  const maxAmountByConcentration = (effectiveCapital * maxPositionPct) / 100 - existingAmountForStock;
  const maxByConcentration = Math.floor(maxAmountByConcentration / currentPrice / UNIT_SHARES) * UNIT_SHARES;
  if (quantity > maxByConcentration) {
    if (maxByConcentration <= 0) {
      const reason = `集中率上限（${maxPositionPct}%）を超えるためスキップ（既存投資額: ¥${existingAmountForStock.toLocaleString()}）`;
      console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
      const label = getRejectedLabel(reason);
      if (label) {
        await saveRejectedSignal({ ticker, strategy, reason, reasonLabel: label, entryPrice: currentPrice });
      }
      return { success: false, reason, retryable: false };
    }
    console.log(`[entry-executor] ${ticker} 集中率上限で縮小: ${quantity}株 → ${maxByConcentration}株（上限: ${maxPositionPct}%）`);
    quantity = maxByConcentration;
  }

  // 5. canOpenPosition でセクター集中・ドローダウン・ポジション数を確認（プリフェッチデータを渡す）
  const riskCheck = await canOpenPosition(
    stock.id,
    quantity,
    currentPrice,
    {
      config: config ?? undefined,
      openPositions,
      effectiveCapital,
      losingStreak,
    },
    strategy,
  );
  if (!riskCheck.allowed) {
    console.log(`[entry-executor] ${ticker} リスクチェック不可: ${riskCheck.reason}`);
    const label = getRejectedLabel(riskCheck.reason);
    if (label) {
      await saveRejectedSignal({ ticker, strategy, reason: riskCheck.reason, reasonLabel: label, entryPrice: currentPrice });
    }
    return { success: false, reason: riskCheck.reason, retryable: riskCheck.retryable ?? false };
  }

  // 5.5 流動性チェック（板情報フィルター）
  // monitor がバッチ取得済みの板情報をトリガー経由で受け取り、追加API呼び出しなしで検証する
  const liquidityCheck = checkLiquidity(
    { price: currentPrice, askPrice: trigger.askPrice, bidPrice: trigger.bidPrice, askSize: trigger.askSize, bidSize: trigger.bidSize },
    quantity,
  );
  if (!liquidityCheck.isLiquid) {
    const liquidityReason = liquidityCheck.reason ?? "流動性不足";
    console.log(`[entry-executor] ${ticker} 流動性不足: ${liquidityReason}`);
    const label = getRejectedLabel(liquidityReason);
    if (label) {
      await saveRejectedSignal({ ticker, strategy, reason: liquidityReason, reasonLabel: label, entryPrice: currentPrice });
    }
    return { success: false, reason: liquidityReason, retryable: true };
  }
  if (liquidityCheck.riskFlags.length > 0) {
    console.log(
      `[entry-executor] ${ticker} 流動性リスクフラグ: ${liquidityCheck.riskFlags.join(", ")}（スプレッド: ${liquidityCheck.spreadPct?.toFixed(2) ?? "-"}%）`,
    );
  }

  // 6. 変数の準備
  const isGapUp = strategy === "gapup";
  const isWeeklyBreak = strategy === "weekly-break";
  const isPSC = strategy === "post-surge-consolidation";
  const isCloseOrder = isGapUp || isWeeklyBreak || isPSC;
  const expiresAt = isCloseOrder
    ? dayjs().tz(TIMEZONE).hour(15).minute(30).second(0).toDate()
    : dayjs().tz(TIMEZONE).add(ORDER_EXPIRY.SWING_DAYS, "day").hour(15).minute(0).second(0).toDate();
  const reasoning = isWeeklyBreak
    ? `週足ブレイクトリガー: ${'weeklyHigh' in trigger ? trigger.weeklyHigh : 0}円を上抜け, 出来高サージ ${trigger.volumeSurgeRatio.toFixed(2)}x`
    : isPSC
    ? `PSCトリガー: モメンタム ${(('momentumReturn' in trigger ? trigger.momentumReturn : 0) * 100).toFixed(1)}%, 出来高サージ ${trigger.volumeSurgeRatio.toFixed(2)}x`
    : `GUトリガー: 出来高サージ比率 ${trigger.volumeSurgeRatio.toFixed(2)}x, ギャップ3%以上`;

  // 7. ブローカー発注（DB保存前に実行）
  let brokerResult;
  try {
    brokerResult = await submitBrokerOrder({
      ticker,
      side: "buy",
      quantity,
      limitPrice: isCloseOrder ? null : currentPrice,
      condition: isCloseOrder ? TACHIBANA_ORDER.CONDITION.CLOSE : undefined,
      expireDay: isCloseOrder ? undefined : dayjs(adjustToTradingDay(expiresAt)).tz(TIMEZONE).format("YYYYMMDD"),
    });
  } catch (brokerErr) {
    console.error(`[entry-executor] ブローカーエラー ${ticker}:`, brokerErr);
    const errorMsg = brokerErr instanceof Error ? brokerErr.message : String(brokerErr);
    await notifySlack({
      title: `ブローカー発注失敗: ${ticker}（リトライ待機）`,
      message: errorMsg,
      color: "warning",
    });
    // 例外（ネットワーク/セッション障害など）はリトライ可能とする
    return { success: false, reason: errorMsg, retryable: true };
  }

  if (!brokerResult.success || !brokerResult.orderNumber) {
    const errorMsg = brokerResult.success
      ? "注文番号が取得できませんでした"
      : (brokerResult.error ?? "Unknown error");
    // サブコード（"[sub:"プレフィックス）は業務ロジック上のリジェクト（資金不足、口座種別不一致など） → 非リトライ
    // それ以外（sResultCode エラー、注文番号未返却）はトランスポート/セッション起因 → リトライ可能
    const isBusinessRejection = errorMsg.startsWith("[sub:");
    const retryable = !isBusinessRejection;
    console.warn(
      `[entry-executor] ブローカー発注失敗: ${ticker}: ${errorMsg} (retryable=${retryable})`,
    );
    await notifySlack({
      title: `ブローカー発注失敗: ${ticker}${retryable ? "（リトライ待機）" : ""}`,
      message: errorMsg,
      color: retryable ? "warning" : "danger",
    });
    return { success: false, reason: errorMsg, retryable };
  }

  console.log(
    `[entry-executor] ${ticker} ブローカー発注成功: orderNumber=${brokerResult.orderNumber}`,
  );

  // 6. TradingOrderをDBに作成（発注成功後）
  const newOrder = await prisma.tradingOrder.create({
    data: {
      updatedAt: new Date(),
      stockId: stock.id,
      side: "buy",
      orderType: isCloseOrder ? "market" : "limit",
      strategy,
      // 引け成行はlimitPriceを持たない。スナップショット価格はentrySnapshot.trigger.currentPriceで参照可能。
      limitPrice: isCloseOrder ? null : currentPrice,
      takeProfitPrice,
      stopLossPrice,
      quantity,
      status: "pending",
      expiresAt,
      reasoning,
      brokerOrderId: brokerResult.orderNumber,
      brokerBusinessDay: brokerResult.businessDay,
      entrySnapshot: {
        trigger: {
          ticker: trigger.ticker,
          currentPrice: trigger.currentPrice,
          volumeSurgeRatio: trigger.volumeSurgeRatio,
          ...('weeklyHigh' in trigger ? { weeklyHigh: (trigger as WeeklyBreakTrigger).weeklyHigh } : {}),
          ...('momentumReturn' in trigger ? { momentumReturn: (trigger as PostSurgeConsolidationTrigger).momentumReturn } : {}),
          atr14: trigger.atr14,
          triggeredAt: trigger.triggeredAt.toISOString(),
        },
        slClamped: isSLClamped,
        riskPct,
        ...(losingStreak > 0 ? { losingStreak } : {}),
        ...(trigger.askPrice ? {
          liquidity: {
            askPrice: trigger.askPrice,
            bidPrice: trigger.bidPrice,
            askSize: trigger.askSize,
            bidSize: trigger.bidSize,
            spreadPct: liquidityCheck.spreadPct,
          },
        } : {}),
      },
    },
  });

  console.log(
    `[entry-executor] ${ticker} 注文作成: id=${newOrder.id}, 指値=¥${currentPrice}, SL=¥${stopLossPrice}, TP=¥${takeProfitPrice}, 数量=${quantity}株, リスク%=${riskPct}%${losingStreak >= LOSING_STREAK.SCALE_TRIGGER ? `, 連敗${losingStreak}（縮小中）` : ""}`,
  );

  // 8. Slack通知
  const slackReasoning = isWeeklyBreak
    ? `週足ブレイクトリガー: ${'weeklyHigh' in trigger ? trigger.weeklyHigh : 0}円上抜け / 出来高サージ ${trigger.volumeSurgeRatio.toFixed(2)}x`
    : isPSC
    ? `PSCトリガー: モメンタム ${(('momentumReturn' in trigger ? trigger.momentumReturn : 0) * 100).toFixed(1)}% / 出来高サージ ${trigger.volumeSurgeRatio.toFixed(2)}x`
    : `GUトリガー: 出来高サージ ${trigger.volumeSurgeRatio.toFixed(2)}x / ギャップ3%以上`;
  await notifyOrderPlaced({
    tickerCode: ticker,
    name: stock.name,
    side: "buy",
    strategy,
    limitPrice: currentPrice,
    takeProfitPrice,
    stopLossPrice,
    quantity,
    reasoning: slackReasoning,
  });

  return { success: true, orderId: newOrder.id };
}
