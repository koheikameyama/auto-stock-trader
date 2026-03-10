/**
 * リスク管理モジュール
 *
 * ポジションサイズ制限・日次損失制限・取引可否判定を行う
 */

import { prisma } from "../lib/prisma";
import { getStartOfDayJST, getEndOfDayJST } from "../lib/date-utils";
import { UNIT_SHARES, STOP_LOSS, POSITION_SIZING } from "../lib/constants";
import { canAddToSector } from "./sector-analyzer";
import { calculateDrawdownStatus } from "./drawdown-manager";

/**
 * 新規ポジションを建てられるかチェックする
 *
 * 以下の条件をすべて満たす場合に allowed: true を返す:
 * 1. 取引が有効（isActive）
 * 2. オープンポジション数が maxPositions 未満
 * 3. 現金残高が必要額以上
 * 4. 1銘柄あたりの投資比率が maxPositionPct 以下
 * 5. 日次損失が制限内
 */
export async function canOpenPosition(
  stockId: string,
  quantity: number,
  price: number,
): Promise<{ allowed: boolean; reason: string }> {
  const config = await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!config) {
    return { allowed: false, reason: "TradingConfig が設定されていません" };
  }

  if (!config.isActive) {
    return { allowed: false, reason: "取引が無効化されています" };
  }

  const totalBudget = Number(config.totalBudget);
  const maxPositions = config.maxPositions;
  const maxPositionPct = Number(config.maxPositionPct);
  const requiredAmount = price * quantity;

  // 1. オープンポジション数チェック
  const openPositionCount = await prisma.tradingPosition.count({
    where: { status: "open" },
  });

  if (openPositionCount >= maxPositions) {
    return {
      allowed: false,
      reason: `最大同時保有数（${maxPositions}）に達しています（現在: ${openPositionCount}）`,
    };
  }

  // 2. 現金残高チェック
  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: "open" },
  });
  const investedAmount = openPositions.reduce((sum, pos) => {
    return sum + Number(pos.entryPrice) * pos.quantity;
  }, 0);

  const cashBalance = totalBudget - investedAmount;

  if (requiredAmount > cashBalance) {
    return {
      allowed: false,
      reason: `現金残高不足（残高: ${cashBalance.toFixed(0)}円、必要額: ${requiredAmount.toFixed(0)}円）`,
    };
  }

  // 3. 1銘柄あたり最大比率チェック（同一銘柄の既存ポジションも合算）
  const existingAmountForStock = openPositions
    .filter((pos) => pos.stockId === stockId)
    .reduce((sum, pos) => sum + Number(pos.entryPrice) * pos.quantity, 0);

  const totalAmountForStock = existingAmountForStock + requiredAmount;
  const positionPct = (totalAmountForStock / totalBudget) * 100;

  if (positionPct > maxPositionPct) {
    return {
      allowed: false,
      reason: `1銘柄あたりの投資比率上限（${maxPositionPct}%）を超えます（${positionPct.toFixed(1)}%）`,
    };
  }

  // 4. 日次損失制限チェック
  const isLossLimitHit = await checkDailyLossLimit();
  if (isLossLimitHit) {
    return {
      allowed: false,
      reason: "日次損失制限に達しています。本日の新規取引は停止中です",
    };
  }

  // 5. セクター集中チェック
  const sectorCheck = await canAddToSector(stockId);
  if (!sectorCheck.allowed) {
    return { allowed: false, reason: sectorCheck.reason };
  }

  // 6. ドローダウンチェック
  const drawdown = await calculateDrawdownStatus();
  if (drawdown.shouldHaltTrading) {
    return {
      allowed: false,
      reason: `ドローダウン停止: ${drawdown.reason}`,
    };
  }

  // 7. クールダウンによるポジション数制限
  if (drawdown.maxPositionsOverride !== null) {
    if (openPositionCount >= drawdown.maxPositionsOverride) {
      return {
        allowed: false,
        reason: `クールダウン中: 最大${drawdown.maxPositionsOverride}ポジションに制限（${drawdown.reason}）`,
      };
    }
  }

  return { allowed: true, reason: "OK" };
}

/**
 * 日次損失制限に達しているかチェックする
 */
export async function checkDailyLossLimit(): Promise<boolean> {
  const config = await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!config) {
    return true; // 設定がない場合は安全側に倒して取引停止
  }

  const totalBudget = Number(config.totalBudget);
  const maxDailyLossPct = Number(config.maxDailyLossPct);
  const maxDailyLoss = totalBudget * (maxDailyLossPct / 100);

  const todayPnl = await getDailyPnl();

  return todayPnl < 0 && Math.abs(todayPnl) >= maxDailyLoss;
}

/**
 * 指定日の確定損益を計算する
 */
export async function getDailyPnl(date?: Date): Promise<number> {
  const startOfDay = getStartOfDayJST(date);
  const endOfDay = getEndOfDayJST(date);

  const closedPositions = await prisma.tradingPosition.findMany({
    where: {
      status: "closed",
      exitedAt: {
        gte: startOfDay,
        lte: endOfDay,
      },
    },
  });

  return closedPositions.reduce((sum, pos) => {
    return sum + (pos.realizedPnl ? Number(pos.realizedPnl) : 0);
  }, 0);
}

/**
 * ポジションサイズを計算する
 *
 * リスクベースと予算ベースの両方で算出し、厳しい方を採用する。
 * - リスクベース: 1トレードの最大損失額 / 1株あたりリスク（= エントリー価格 - 損切り価格）
 * - 予算ベース: 利用可能予算 × 最大比率 / エントリー価格
 * 日本株は単元株制度（100株単位）のため、UNIT_SHARES の倍数に切り捨てる。
 */
export function calculatePositionSize(
  price: number,
  budget: number,
  maxPositionPct: number,
  stopLossPrice?: number,
): number {
  if (price <= 0 || budget <= 0 || maxPositionPct <= 0) {
    return 0;
  }

  // 予算ベース: 従来の計算
  const maxAmount = budget * (maxPositionPct / 100);
  const budgetBasedShares = Math.floor(maxAmount / price);

  // リスクベース: 損切り幅に基づく計算
  let riskBasedShares = budgetBasedShares; // デフォルトは予算ベースと同じ
  if (stopLossPrice != null && stopLossPrice > 0 && stopLossPrice < price) {
    const riskPerShare = price - stopLossPrice;
    const riskAmount = budget * (POSITION_SIZING.RISK_PER_TRADE_PCT / 100);
    riskBasedShares = Math.floor(riskAmount / riskPerShare);
  }

  // 両方のminを取り、100株単位に切捨て
  const shares = Math.min(budgetBasedShares, riskBasedShares);
  return Math.floor(shares / UNIT_SHARES) * UNIT_SHARES;
}

// ========================================
// 損切り検証
// ========================================

export interface StopLossValidation {
  originalPrice: number;
  validatedPrice: number;
  wasOverridden: boolean;
  reason: string;
}

/**
 * 損切り価格を検証し、必要に応じてロジックで上書きする
 *
 * AIが決定した stopLossPrice をロジック側で検証し、
 * ルール違反がある場合は強制的に修正する。
 *
 * 検証ルール:
 * 1. 最大損失率 3% 超過 → 3% に強制設定
 * 2. ATR × 0.5 未満（近すぎる）→ ATR × 1.0 に引き上げ
 * 3. ATR × 2.0 超過（遠すぎる）→ ATR × 1.5 に引き下げ
 * 4. サポートライン考慮 → サポート - ATR × 0.3 に設定
 * 5. 最終チェック: 3% 超過していないか再確認
 */
export function validateStopLoss(
  entryPrice: number,
  proposedStopLoss: number,
  atr14: number | null,
  supports: number[],
): StopLossValidation {
  let validatedPrice = proposedStopLoss;
  let wasOverridden = false;
  let reason = "OK";

  const stopLossGap = entryPrice - proposedStopLoss;
  const stopLossGapPct = stopLossGap / entryPrice;

  // ルール1: 最大損失率チェック
  if (stopLossGapPct > STOP_LOSS.MAX_LOSS_PCT) {
    validatedPrice = entryPrice * (1 - STOP_LOSS.MAX_LOSS_PCT);
    wasOverridden = true;
    reason = `最大損失率(${STOP_LOSS.MAX_LOSS_PCT * 100}%)を超過。強制設定`;
  }

  if (atr14) {
    const gap = entryPrice - validatedPrice;

    // ルール2: ATR最小チェック（損切りが近すぎる）
    if (gap < atr14 * STOP_LOSS.ATR_MIN_MULTIPLIER) {
      validatedPrice = entryPrice - atr14 * STOP_LOSS.ATR_DEFAULT_MULTIPLIER;
      wasOverridden = true;
      reason = `損切りが近すぎる(ATR*${STOP_LOSS.ATR_MIN_MULTIPLIER}未満)。ATR*${STOP_LOSS.ATR_DEFAULT_MULTIPLIER}に引き上げ`;
    }

    // ルール3: ATR最大チェック（損切りが遠すぎる）
    if (gap > atr14 * STOP_LOSS.ATR_MAX_MULTIPLIER) {
      validatedPrice = entryPrice - atr14 * STOP_LOSS.ATR_ADJUSTED_MULTIPLIER;
      wasOverridden = true;
      reason = `損切りが遠すぎる(ATR*${STOP_LOSS.ATR_MAX_MULTIPLIER}超過)。ATR*${STOP_LOSS.ATR_ADJUSTED_MULTIPLIER}に引き下げ`;
    }

    // ルール4: サポートライン考慮
    if (supports.length > 0) {
      const nearestSupport = supports
        .filter((s) => s < entryPrice)
        .sort((a, b) => b - a)[0];

      if (nearestSupport) {
        const supportBasedStop =
          nearestSupport - atr14 * STOP_LOSS.SUPPORT_BUFFER_ATR;
        // サポートベースの損切りがより高い（タイトな）場合のみ採用
        if (supportBasedStop > validatedPrice) {
          validatedPrice = supportBasedStop;
          wasOverridden = true;
          reason = `サポートライン(${nearestSupport})考慮。サポート - ATR*${STOP_LOSS.SUPPORT_BUFFER_ATR}に設定`;
        }
      }
    }
  }

  // ルール5: 最終チェック（最大損失率を再確認）
  const finalGapPct = (entryPrice - validatedPrice) / entryPrice;
  if (finalGapPct > STOP_LOSS.MAX_LOSS_PCT) {
    validatedPrice = entryPrice * (1 - STOP_LOSS.MAX_LOSS_PCT);
    wasOverridden = true;
    reason = `最終チェック: 最大損失率(${STOP_LOSS.MAX_LOSS_PCT * 100}%)を超過。強制設定`;
  }

  validatedPrice = Math.round(validatedPrice * 100) / 100;

  return {
    originalPrice: proposedStopLoss,
    validatedPrice,
    wasOverridden,
    reason,
  };
}
