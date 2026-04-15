/**
 * リスク管理モジュール
 *
 * ポジションサイズ制限・日次損失制限・取引可否判定を行う
 */

import { prisma } from "../lib/prisma";
import { getStartOfDayJST, getEndOfDayJST } from "../lib/market-date";
import {
  UNIT_SHARES,
  STOP_LOSS,
  POSITION_SIZING,
  GAP_RISK,
  TRADING_DEFAULTS,
  LOSING_STREAK,
} from "../lib/constants";
import { canAddToSector, canAddToMacroFactor } from "./sector-analyzer";
import { calculateDrawdownStatus, getLosingStreak } from "./drawdown-manager";
import { fetchStockQuotesBatch } from "./market-data";
import { getEffectiveCapital, getPositionPnl } from "./position-manager";
import type { TradingConfig, TradingPosition } from "@prisma/client";

/** stock リレーション付きのオープンポジション */
type OpenPositionWithStock = TradingPosition & {
  stock: { id: string; jpxSectorName: string | null };
};

/** 事前取得データ（重複ク��リ削減用） */
export interface RiskCheckPrefetch {
  config?: TradingConfig;
  /** stock ���レーション付きのオープンポジション */
  openPositions?: OpenPositionWithStock[];
  effectiveCapital?: number;
  losingStreak?: number;
}

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
  prefetch?: RiskCheckPrefetch,
  strategy?: string,
): Promise<{ allowed: boolean; reason: string; retryable?: boolean }> {
  const config = prefetch?.config ?? await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!config) {
    return { allowed: false, reason: "TradingConfig が設定されていません", retryable: false };
  }

  if (!config.isActive) {
    return { allowed: false, reason: "取引が無効化されています", retryable: false };
  }

  const effectiveCap = prefetch?.effectiveCapital ?? await getEffectiveCapital(config);
  const maxPositionPct = getDynamicMaxPositionPct(effectiveCap, price);
  const requiredAmount = price * quantity;

  const openPositions = prefetch?.openPositions ?? await prisma.tradingPosition.findMany({
    where: { status: "open" },
    include: { stock: { select: { id: true, jpxSectorName: true } } },
  });

  // 1. オープンポジション数チェック（戦略別独立）
  const strategyKey =
    strategy === "gapup" ? "gapup"
    : strategy === "weekly-break" ? "weekly-break"
    : strategy === "post-surge-consolidation" ? "post-surge-consolidation"
    : "breakout";
  const maxPositions =
    strategyKey === "gapup" ? TRADING_DEFAULTS.MAX_POSITIONS_GU
    : strategyKey === "weekly-break" ? TRADING_DEFAULTS.MAX_POSITIONS_WB
    : strategyKey === "post-surge-consolidation" ? TRADING_DEFAULTS.MAX_POSITIONS_PSC
    : TRADING_DEFAULTS.MAX_POSITIONS_BO;
  const strategyPositions = openPositions.filter((p) => (p.strategy ?? "breakout") === strategyKey);
  if (strategyPositions.length >= maxPositions) {
    return {
      allowed: false,
      reason: `${strategyKey} 戦略の最大同時保有数（${maxPositions}）に達しています（現在: ${strategyPositions.length}）`,
      retryable: true,
    };
  }

  // 2. 現金残高チェック
  const investedAmount = openPositions.reduce((sum, pos) => {
    return sum + Number(pos.entryPrice) * pos.quantity;
  }, 0);

  const cashBalance = effectiveCap - investedAmount;

  if (requiredAmount > cashBalance) {
    return {
      allowed: false,
      reason: `現金残高不足（残高: ${cashBalance.toFixed(0)}円、必要額: ${requiredAmount.toFixed(0)}円）`,
      retryable: true,
    };
  }

  // 3. 1銘柄あたり最大比率チェック（同一銘柄の既存ポジションも合算）
  const existingAmountForStock = openPositions
    .filter((pos) => pos.stockId === stockId)
    .reduce((sum, pos) => sum + Number(pos.entryPrice) * pos.quantity, 0);

  const totalAmountForStock = existingAmountForStock + requiredAmount;
  const positionPct = (totalAmountForStock / effectiveCap) * 100;

  if (positionPct > maxPositionPct) {
    return {
      allowed: false,
      reason: `1銘柄あたりの投資比率上限（${maxPositionPct}%）を超えます（${positionPct.toFixed(1)}%）`,
      retryable: true,
    };
  }

  // 4. 日次損失制限チェック
  const isLossLimitHit = await checkDailyLossLimit({ config, effectiveCapital: effectiveCap });
  if (isLossLimitHit) {
    return {
      allowed: false,
      reason: "日次損失制限に達しています。本日の新規取引は停止中です",
      retryable: false,
    };
  }

  // 5. セクター集中チェック
  const sectorCheck = await canAddToSector(stockId, { openPositions });
  if (!sectorCheck.allowed) {
    return { allowed: false, reason: sectorCheck.reason, retryable: true };
  }

  // 5.5. マクロファクター集中チェック
  const macroCheck = await canAddToMacroFactor(stockId, { openPositions });
  if (!macroCheck.allowed) {
    return { allowed: false, reason: macroCheck.reason, retryable: true };
  }

  // 6. ドローダウンチェック
  const drawdown = await calculateDrawdownStatus({ config, effectiveCapital: effectiveCap });
  if (drawdown.shouldHaltTrading) {
    return {
      allowed: false,
      reason: `ドローダウン停止: ${drawdown.reason}`,
      retryable: false,
    };
  }

  // 7. 連敗クールダウンチェック
  const streak = prefetch?.losingStreak ?? await getLosingStreak();
  if (streak >= LOSING_STREAK.HALT_TRIGGER) {
    return {
      allowed: false,
      reason: `${streak}連敗のため取引停止中`,
      retryable: false,
    };
  }
  if (streak >= LOSING_STREAK.SCALE_TRIGGER && openPositions.length >= LOSING_STREAK.MAX_POSITIONS_COOLDOWN) {
    return {
      allowed: false,
      reason: `${streak}連敗クールダウン中: 最大${LOSING_STREAK.MAX_POSITIONS_COOLDOWN}ポジション制限（現在: ${openPositions.length}）`,
      retryable: true,
    };
  }

  return { allowed: true, reason: "OK" };
}

/**
 * 日次損失制限に達しているかチェックする
 *
 * 確定損益 + 含み損益の合計で判定する。
 * 含み損が大きい状態で新規ポジションを建てることを防ぐ。
 */
export async function checkDailyLossLimit(
  prefetch?: { config?: TradingConfig; effectiveCapital?: number },
): Promise<boolean> {
  const config = prefetch?.config ?? await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!config) {
    return true; // 設定がない場合は安全側に倒して取引停止
  }

  const effectiveCap = prefetch?.effectiveCapital ?? await getEffectiveCapital(config);
  const maxDailyLossPct = TRADING_DEFAULTS.MAX_DAILY_LOSS_PCT;
  const maxDailyLoss = effectiveCap * (maxDailyLossPct / 100);

  const todayPnl = await getDailyPnl(undefined, { includeUnrealized: true });

  return todayPnl < 0 && Math.abs(todayPnl) >= maxDailyLoss;
}

/**
 * 指定日の損益を計算する
 *
 * @param date - 対象日（デフォルト: 今日）
 * @param options.includeUnrealized - 含み損益を含めるか（デフォルト: false）
 */
export async function getDailyPnl(
  date?: Date,
  options?: { includeUnrealized?: boolean },
): Promise<number> {
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

  const realizedPnl = closedPositions.reduce((sum, pos) => {
    return sum + getPositionPnl(pos);
  }, 0);

  if (!options?.includeUnrealized) {
    return realizedPnl;
  }

  const unrealizedPnl = await getUnrealizedPnlTotal();
  return realizedPnl + unrealizedPnl;
}

/**
 * オープン中の全ポジションの含み損益合計を計算する
 *
 * 最新の株価をバッチ取得し、エントリー価格との差分を算出する。
 * 株価取得に失敗した銘柄はエントリー価格で評価（含み損益 = 0）。
 */
async function getUnrealizedPnlTotal(): Promise<number> {
  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: "open" },
    include: { stock: true },
  });

  if (openPositions.length === 0) {
    return 0;
  }

  const tickerCodes = openPositions.map((pos) => pos.stock.tickerCode);
  const quotes = await fetchStockQuotesBatch(tickerCodes);

  return openPositions.reduce((sum, pos) => {
    const quote = quotes.get(pos.stock.tickerCode);
    if (!quote) {
      return sum; // 株価取得失敗時は含み損益0として扱う
    }
    const entryPrice = Number(pos.entryPrice);
    return sum + (quote.price - entryPrice) * pos.quantity;
  }, 0);
}

/**
 * ギャップリスク（最大想定ギャップダウン率）を推定する
 *
 * 過去データから最大の翌日始値ギャップダウンを計算し、
 * ATRベースの最低値でフロアする。
 *
 * @param historicalData - OHLCVデータ（新しい順）
 * @param atr14 - ATR(14)
 * @param currentPrice - 現在価格（ATRの%変換用）
 * @returns ギャップリスク率（0.04 = 4%）
 */
export function estimateGapRisk(
  historicalData: Array<{ open: number; close: number }>,
  atr14: number | null,
  currentPrice: number,
): number {
  // 1. 過去データから最大ギャップダウンを算出
  const lookback = Math.min(
    historicalData.length - 1,
    GAP_RISK.LOOKBACK_DAYS,
  );
  let maxGapDownPct = 0;

  for (let i = 0; i < lookback; i++) {
    const todayOpen = historicalData[i].open;
    const prevClose = historicalData[i + 1].close;
    if (prevClose <= 0) continue;

    const gapPct = (prevClose - todayOpen) / prevClose; // 正 = ギャップダウン
    if (gapPct > maxGapDownPct) {
      maxGapDownPct = gapPct;
    }
  }

  // 2. ATRベースのフロア
  const atrFloorPct =
    atr14 && currentPrice > 0
      ? (atr14 * GAP_RISK.ATR_FLOOR_MULTIPLIER) / currentPrice
      : 0.03; // ATR不明時は3%をフォールバック

  // 3. ATRベースのキャップ
  const atrCapPct =
    atr14 && currentPrice > 0
      ? (atr14 * GAP_RISK.ATR_CAP_MULTIPLIER) / currentPrice
      : 0.08; // ATR不明時は8%をフォールバック

  // max(実績MAG, ATRフロア) を ATRキャップで上限
  return Math.min(Math.max(maxGapDownPct, atrFloorPct), atrCapPct);
}

/** getDynamicMaxPositionPct / getMaxBuyablePrice 共通の集中率上限（%） */
const CONCENTRATION_MAX_PCT = 50;

/**
 * 有効資本と購入株価に応じた1銘柄あたり最大投資比率（%）を動的に計算する
 *
 * 「実際の購入株価 × 100株 = 最低単元が常に買えること」を保証しつつ、
 * 上限50%・下限33%（均等割り）の範囲に収める。
 *
 * 例（¥491k）: ¥630株 → 33%, ¥1,964株 → 40%, ¥3,000株 → 61% → 上限50%でキャップ
 */
export function getDynamicMaxPositionPct(effectiveCapital: number, stockPrice: number): number {
  const minUnitCost = UNIT_SHARES * stockPrice;
  const MIN_PCT = 33; // 固定値（MAX_POSITIONSに依存しない）
  const minRequired = Math.ceil((minUnitCost / effectiveCapital) * 100);
  return Math.min(CONCENTRATION_MAX_PCT, Math.max(MIN_PCT, minRequired));
}

/**
 * 有効資本から購入可能な最大株価を計算する
 *
 * 集中率上限（CONCENTRATION_MAX_PCT）と単元株数（100株）から逆算し、
 * 「1単元は必ず買える」価格帯のみをユニバースに含める。
 *
 * 例: 50万 × 50% / 100株 = 2,500円
 *     100万 × 50% / 100株 = 5,000円
 */
export function getMaxBuyablePrice(effectiveCapital: number): number {
  return Math.floor((effectiveCapital * CONCENTRATION_MAX_PCT) / (100 * UNIT_SHARES));
}

/**
 * スコアに応じたリスク%を返す
 */
export function getRiskPctByScore(score?: number): number {
  if (score == null) return POSITION_SIZING.RISK_PER_TRADE_PCT;
  for (const tier of POSITION_SIZING.SCORE_RISK_TABLE) {
    if (score >= tier.minScore) return tier.riskPct;
  }
  return POSITION_SIZING.RISK_PER_TRADE_PCT;
}

/**
 * リスクリワード比に応じたリスク%を返す
 * RRが高いトレードほど期待値が高いため、ポジションを厚くする
 */
export function getRiskPctByRR(rr: number): number {
  for (const tier of POSITION_SIZING.RR_RISK_TABLE) {
    if (rr >= tier.minRR) return tier.riskPct;
  }
  return POSITION_SIZING.RISK_PER_TRADE_PCT;
}

/**
 * ポジションサイズを計算する
 *
 * リスクベースと予算ベースの両方で算出し、厳しい方を採用する。
 * - リスクベース: 1トレードの最大損失額 / 1株あたりリスク（= エントリー価格 - 損切り価格）
 * - 予算ベース: 利用可能予算 × 最大比率 / エントリー価格
 * 日本株は単元株制度（100株単位）のため、UNIT_SHARES の倍数に切り捨てる。
 *
 * @param gapRiskPct - ギャップリスク率（例: 0.05 = 5%）。指定時はSL距離との大きい方を使用
 * @param score - スコアリング結果の総合スコア。スコアに応じてリスク%を傾斜させる
 */
export function calculatePositionSize(
  price: number,
  budget: number,
  maxPositionPct: number,
  stopLossPrice?: number,
  gapRiskPct?: number,
  score?: number,
): number {
  if (price <= 0 || budget <= 0 || maxPositionPct <= 0) {
    return 0;
  }

  // 予算ベース: 従来の計算
  const maxAmount = budget * (maxPositionPct / 100);
  const budgetBasedShares = Math.floor(maxAmount / price);

  // リスクベース: 損切り幅に基づく計算（スコアでリスク%を傾斜）
  let riskBasedShares = budgetBasedShares; // デフォルトは予算ベースと同じ
  if (stopLossPrice != null && stopLossPrice > 0 && stopLossPrice < price) {
    const stopLossRisk = price - stopLossPrice;
    const gapRisk = gapRiskPct != null ? price * gapRiskPct : 0;
    const effectiveRiskPerShare = Math.max(stopLossRisk, gapRisk);
    const riskPct = getRiskPctByScore(score);
    const riskAmount = budget * (riskPct / 100);
    riskBasedShares = Math.floor(riskAmount / effectiveRiskPerShare);
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
  _supports: number[],
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

    // ルール4: サポートライン考慮（無効化）
    // サポートベースSLはタイトすぎてノイズで損切りされるため、
    // シンプルなATRベースSLの方がPF・勝率ともに優秀（バックテスト検証済み）
    // if (supports.length > 0) { ... }
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
