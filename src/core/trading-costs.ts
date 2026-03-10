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

/**
 * 約定代金から手数料を算出（立花証券 e-Supportプラン）
 */
export function calculateCommission(tradeValue: number): number {
  for (const tier of TRADING_COSTS.COMMISSION_TIERS) {
    if (tradeValue <= tier.maxTradeValue) {
      if ("commission" in tier) {
        return tier.commission;
      }
      return Math.round(tradeValue * tier.rate);
    }
  }
  // フォールバック（到達しないはず）
  const lastTier = TRADING_COSTS.COMMISSION_TIERS[TRADING_COSTS.COMMISSION_TIERS.length - 1];
  if ("rate" in lastTier) {
    return Math.round(tradeValue * lastTier.rate);
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
