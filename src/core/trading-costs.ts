/**
 * 取引コスト算出モジュール
 *
 * 手数料・税金を算出する純関数モジュール。
 * バックテストとライブ取引の両方で使用する。
 */

import { TRADING_COSTS } from "../lib/constants/trading-costs";

export interface TradeCosts {
  entryCommission: number;
  exitCommission: number;
  totalCommission: number;
  tax: number;
  grossPnl: number;
  netPnl: number;
}

// ========================================
// スリッページモデル (KOH-428 Phase B)
// ========================================

export type SlippageProfile = "none" | "light" | "standard" | "heavy";

/** 約定種別: 引け成行エントリー/出口成行/SL・トレーリング発動成行/指値 */
export type SlippageContext =
  | "entry_market"
  | "exit_market"
  | "exit_stop"
  | "limit";

interface SlippageRates {
  entryMarketBps: number;
  exitMarketBps: number;
  exitStopBps: number;
  limitBps: number;
}

/**
 * スリッページプロファイル（bps）
 *
 * 初期値は保守的推定。Phase A の実績キャリブレーション後に再調整する。
 * - light: 流動性の高い銘柄を中心に取引する想定
 * - standard: 中小型株中心の現行運用の推定値
 * - heavy: ストレス市況 / 厚みの薄い板を想定した上限
 */
export const SLIPPAGE_PROFILES: Record<SlippageProfile, SlippageRates> = {
  none:     { entryMarketBps:  0, exitMarketBps:  0, exitStopBps:  0, limitBps: 0 },
  light:    { entryMarketBps:  5, exitMarketBps:  5, exitStopBps: 10, limitBps: 0 },
  standard: { entryMarketBps: 10, exitMarketBps: 10, exitStopBps: 20, limitBps: 0 },
  heavy:    { entryMarketBps: 25, exitMarketBps: 25, exitStopBps: 50, limitBps: 0 },
};

/**
 * 価格にスリッページを適用する
 *
 * buy 側: 価格が bps 分だけ上振れ（不利な方向）
 * sell 側: 価格が bps 分だけ下振れ（不利な方向）
 *
 * @param price 基準価格（シグナル価格 / SL価格 / 引け値など）
 * @param side  "buy" = エントリー / "sell" = 決済
 * @param context 約定種別
 * @param profile プロファイル名
 */
export function applySlippage(
  price: number,
  side: "buy" | "sell",
  context: SlippageContext,
  profile: SlippageProfile = "none",
): number {
  if (profile === "none" || price <= 0) return price;
  const rates = SLIPPAGE_PROFILES[profile];
  const bps =
    context === "entry_market" ? rates.entryMarketBps
    : context === "exit_market" ? rates.exitMarketBps
    : context === "exit_stop"   ? rates.exitStopBps
    : rates.limitBps;
  if (bps === 0) return price;
  const sign = side === "buy" ? 1 : -1;
  return price * (1 + (sign * bps) / 10000);
}

/**
 * 約定代金から手数料を算出（立花証券 e-Supportプラン）
 */
export function calculateCommission(tradeValue: number): number {
  for (const tier of TRADING_COSTS.COMMISSION_TIERS) {
    if (tradeValue <= tier.maxTradeValue) {
      if ("commission" in tier) {
        return tier.commission;
      }
      const calculated = Math.round(tradeValue * tier.rate);
      return tier.maxCommission
        ? Math.min(calculated, tier.maxCommission)
        : calculated;
    }
  }
  // フォールバック（到達しないはず）
  const lastTier =
    TRADING_COSTS.COMMISSION_TIERS[TRADING_COSTS.COMMISSION_TIERS.length - 1];
  if ("rate" in lastTier) {
    const calculated = Math.round(tradeValue * lastTier.rate);
    return lastTier.maxCommission
      ? Math.min(calculated, lastTier.maxCommission)
      : calculated;
  }
  return 0;
}

/**
 * 粗損益から税額を算出（利益時のみ課税）
 */
export function calculateTax(grossPnl: number, totalCost: number): number {
  const taxableProfit = grossPnl - totalCost;
  if (taxableProfit <= 0) return 0;
  return Math.round(taxableProfit * TRADING_COSTS.TAX.RATE);
}

/**
 * 信用取引の金利コストを算出
 *
 * 建玉金額 × 年率金利 × (保有営業日数 / 365)
 * - 制度信用の一般的な金利: 年率2.5〜3.5%
 * - 保有中は日割りで発生
 * - 現物取引(settlementDays >= 1 想定)では 0 を返す想定
 *
 * @param positionValue エントリー時の建玉金額（entryPrice × quantity）
 * @param holdingDays 保有営業日数
 * @param annualRate 年率金利（0.03 = 3%）
 */
export function calculateMarginInterest(
  positionValue: number,
  holdingDays: number,
  annualRate: number,
): number {
  if (annualRate <= 0 || holdingDays <= 0 || positionValue <= 0) return 0;
  return Math.round((positionValue * annualRate * holdingDays) / 365);
}

/**
 * 1トレードの全コストを算出
 */
export function calculateTradeCosts(
  entryPrice: number,
  exitPrice: number,
  quantity: number,
): TradeCosts {
  const entryValue = entryPrice * quantity;
  const exitValue = exitPrice * quantity;

  const entryCommission = calculateCommission(entryValue);
  const exitCommission = calculateCommission(exitValue);
  const totalCommission = entryCommission + exitCommission;

  const grossPnl = (exitPrice - entryPrice) * quantity;
  const tax = calculateTax(grossPnl, totalCommission);
  const netPnl = grossPnl - totalCommission - tax;

  return {
    entryCommission,
    exitCommission,
    totalCommission,
    tax,
    grossPnl: Math.round(grossPnl),
    netPnl: Math.round(netPnl),
  };
}
