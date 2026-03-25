/**
 * エントリー条件算出モジュール
 *
 * ロジックで指値・利確・損切り・数量を算出する。
 * AIに計算を任せず、テクニカル分析データから機械的に決定する。
 */

import type { TechnicalSummary } from "./technical-analysis";
import {
  validateStopLoss,
  calculatePositionSize,
  estimateGapRisk,
} from "./risk-manager";
import { STOP_LOSS, POSITION_DEFAULTS, COLLAR } from "../lib/constants";
import type { TradingStrategy } from "./market-regime";

export interface EntryCondition {
  limitPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  quantity: number;
  riskRewardRatio: number;
  strategy: TradingStrategy;
}

/**
 * エントリー条件を算出する
 *
 * @param currentPrice - 現在価格
 * @param summary - テクニカル分析サマリー
 * @param score - スコアリング結果（総合スコアでポジションサイズを傾斜させる）
 * @param strategy - 取引戦略
 * @param availableBudget - 利用可能予算
 * @param maxPositionPct - 1銘柄あたり最大投資比率（%）
 * @param historicalData - OHLCVデータ（新しい順）。スイング時のギャップリスク推定に使用
 */
export function calculateEntryCondition(
  currentPrice: number,
  summary: TechnicalSummary,
  score: { totalScore: number },
  strategy: TradingStrategy,
  availableBudget: number,
  maxPositionPct: number,
  historicalData?: Array<{ open: number; close: number }>,
  collarPct?: number,
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
  // 現在価格から最大カラー幅以内に制限（ATR連動 or 固定値）
  let collar: number;
  if (collarPct != null) {
    collar = collarPct;
  } else if (summary.atr14 != null && currentPrice > 0) {
    const atrPct = summary.atr14 / currentPrice;
    collar = Math.max(
      COLLAR.MIN_PCT,
      Math.min(atrPct * COLLAR.ATR_MULTIPLIER, COLLAR.MAX_PCT),
    );
  } else {
    collar = COLLAR.FALLBACK_PCT;
  }
  limitPrice = Math.max(limitPrice, currentPrice * (1 - collar));
  limitPrice = Math.round(limitPrice);

  // 2. 利確参考値: ATR×5.0（実際の利確はトレーリングストップが担う、TPは安全弁）
  const atrTarget = summary.atr14
    ? limitPrice + summary.atr14 * 5.0
    : null;

  let takeProfitPrice = atrTarget ?? Math.round(limitPrice * 1.15);
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

  // 4. ギャップリスク推定（スイングのみ — デイトレはオーバーナイトリスクなし）
  let gapRiskPct: number | undefined;
  if (strategy === "swing" && historicalData && historicalData.length > 1) {
    gapRiskPct = estimateGapRisk(historicalData, summary.atr14, limitPrice);
  }

  // 5. 数量: リスクベース（ギャップリスク考慮・スコア傾斜）と予算の厳しい方
  const quantity = calculatePositionSize(
    limitPrice,
    availableBudget,
    maxPositionPct,
    stopLossPrice,
    gapRiskPct,
    score.totalScore,
  );

  // 6. リスクリワード比
  const risk = limitPrice - stopLossPrice;
  const reward = takeProfitPrice - limitPrice;
  const riskRewardRatio =
    risk > 0 ? Math.round((reward / risk) * 100) / 100 : 0;

  // RRフィルタ: 期待RR < 1.5 → 数量0にしてエントリー見送り
  if (riskRewardRatio < 1.5) {
    return {
      limitPrice,
      takeProfitPrice,
      stopLossPrice,
      quantity: 0,
      riskRewardRatio,
      strategy,
    };
  }

  return {
    limitPrice,
    takeProfitPrice,
    stopLossPrice,
    quantity,
    riskRewardRatio,
    strategy,
  };
}
