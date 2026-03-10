/**
 * エントリー条件算出モジュール
 *
 * ロジックで指値・利確・損切り・数量を算出する。
 * AIに計算を任せず、テクニカル分析データから機械的に決定する。
 */

import type { TechnicalSummary } from "./technical-analysis";
import type { LogicScore } from "./technical-scorer";
import { validateStopLoss, calculatePositionSize } from "./risk-manager";
import { STOP_LOSS, POSITION_DEFAULTS } from "../lib/constants";

export interface EntryCondition {
  limitPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  quantity: number;
  riskRewardRatio: number;
  strategy: "day_trade" | "swing";
}

/**
 * エントリー条件を算出する
 *
 * @param currentPrice - 現在価格
 * @param summary - テクニカル分析サマリー
 * @param score - テクニカルスコア（未使用だが将来の拡張用）
 * @param strategy - 取引戦略
 * @param availableBudget - 利用可能予算
 * @param maxPositionPct - 1銘柄あたり最大投資比率（%）
 */
export function calculateEntryCondition(
  currentPrice: number,
  summary: TechnicalSummary,
  _score: LogicScore,
  strategy: "day_trade" | "swing",
  availableBudget: number,
  maxPositionPct: number,
): EntryCondition {
  // 1. 指値: サポートライン or BB下限の近い方（現在価格に近い方を採用）
  const bbLower = summary.bollingerBands.lower;
  const nearestSupport =
    summary.supports.length > 0
      ? summary.supports
          .filter((s) => s < currentPrice)
          .sort((a, b) => b - a)[0] ?? null
      : null;

  let limitPrice = currentPrice;
  if (nearestSupport && bbLower) {
    limitPrice = Math.max(nearestSupport, bbLower);
  } else if (nearestSupport) {
    limitPrice = nearestSupport;
  } else if (bbLower) {
    limitPrice = bbLower;
  }
  // 現在価格から最大3%以内に制限
  limitPrice = Math.max(limitPrice, currentPrice * 0.97);
  limitPrice = Math.round(limitPrice);

  // 2. 利確: レジスタンスライン or ATR×1.5（手前の方を採用）
  const nearestResistance =
    summary.resistances.length > 0
      ? summary.resistances
          .filter((r) => r > limitPrice)
          .sort((a, b) => a - b)[0] ?? null
      : null;
  const atrTarget = summary.atr14
    ? limitPrice + summary.atr14 * 1.5
    : limitPrice * POSITION_DEFAULTS.TAKE_PROFIT_RATIO;

  let takeProfitPrice = nearestResistance
    ? Math.min(nearestResistance, atrTarget)
    : atrTarget;
  // 最低利確: POSITION_DEFAULTS.TAKE_PROFIT_RATIO
  takeProfitPrice = Math.max(
    takeProfitPrice,
    limitPrice * POSITION_DEFAULTS.TAKE_PROFIT_RATIO,
  );
  takeProfitPrice = Math.round(takeProfitPrice);

  // 3. 損切り: ATR×1.0（validateStopLoss で検証）
  const rawStopLoss = summary.atr14
    ? limitPrice - summary.atr14 * STOP_LOSS.ATR_DEFAULT_MULTIPLIER
    : limitPrice * POSITION_DEFAULTS.STOP_LOSS_RATIO;

  const stopLossValidation = validateStopLoss(
    limitPrice,
    rawStopLoss,
    summary.atr14,
    summary.supports,
  );
  const stopLossPrice = Math.round(stopLossValidation.validatedPrice);

  // 4. 数量: リスクベース（損切り幅考慮）と予算の厳しい方
  const quantity = calculatePositionSize(
    limitPrice,
    availableBudget,
    maxPositionPct,
    stopLossPrice,
  );

  // 5. リスクリワード比
  const risk = limitPrice - stopLossPrice;
  const reward = takeProfitPrice - limitPrice;
  const riskRewardRatio =
    risk > 0 ? Math.round((reward / risk) * 100) / 100 : 0;

  return {
    limitPrice,
    takeProfitPrice,
    stopLossPrice,
    quantity,
    riskRewardRatio,
    strategy,
  };
}
