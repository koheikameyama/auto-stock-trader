/**
 * トレーリングストップ算出モジュール
 *
 * ATRベースのトレーリングストップを算出する。
 * - 一定以上の含み益が出た時点でアクティベーション
 * - maxHighDuringHold - ATR × multiplier でストップラインを引き上げ
 * - ストップラインは上方向にのみ移動（下がらない）
 * - 発動後は固定TP/SLを両方置き換え、上値を追う
 */

import { TRAILING_STOP, BREAK_EVEN_STOP } from "../lib/constants";

export interface TrailingStopInput {
  entryPrice: number;
  maxHighDuringHold: number;
  currentTrailingStop: number | null;
  originalStopLoss: number;
  originalTakeProfit: number;
  entryAtr: number | null;
  strategy: "day_trade" | "swing";
  activationMultiplierOverride?: number;
  trailMultiplierOverride?: number;
}

export interface TrailingStopResult {
  isActivated: boolean;
  trailingStopPrice: number | null;
  effectiveStopLoss: number;
  effectiveTakeProfit: number | null;
  reason: string;
}

/**
 * トレーリングストップを算出する
 *
 * 1. maxHigh が activationPrice 未満 → 未発動、固定TP/SLを返す
 * 2. maxHigh が activationPrice 以上 → トレーリング発動
 *    - trailingStop = maxHigh - trailWidth
 *    - ストップは上方向のみ移動（ラチェット）
 *    - 固定TPを無効化し上値を追う
 */
export function calculateTrailingStop(
  input: TrailingStopInput,
): TrailingStopResult {
  const {
    entryPrice,
    maxHighDuringHold,
    currentTrailingStop,
    originalStopLoss,
    originalTakeProfit,
    entryAtr,
    strategy,
    activationMultiplierOverride,
    trailMultiplierOverride,
  } = input;

  // 1. アクティベーション閾値を算出
  const activationMultiplier =
    activationMultiplierOverride ?? TRAILING_STOP.ACTIVATION_ATR_MULTIPLIER[strategy];
  const activationPrice = entryAtr
    ? entryPrice + entryAtr * activationMultiplier
    : entryPrice * (1 + TRAILING_STOP.ACTIVATION_PCT[strategy]);

  // 2. 未発動チェック
  if (maxHighDuringHold < activationPrice) {
    // 2.5. ブレイクイーブンストップ（トレーリング発動前の建値撤退）
    const beMultiplier = BREAK_EVEN_STOP.ACTIVATION_ATR_MULTIPLIER[strategy];
    const beActivationPrice = entryAtr
      ? entryPrice + entryAtr * beMultiplier
      : entryPrice * (1 + BREAK_EVEN_STOP.ACTIVATION_PCT[strategy]);

    if (maxHighDuringHold >= beActivationPrice) {
      const breakEvenStop = Math.max(entryPrice, originalStopLoss);
      return {
        isActivated: false,
        trailingStopPrice: null,
        effectiveStopLoss: breakEvenStop,
        effectiveTakeProfit: originalTakeProfit,
        reason: `ブレイクイーブン発動（最高値¥${Math.round(maxHighDuringHold)} >= BE発動¥${Math.round(beActivationPrice)}、SL→¥${Math.round(breakEvenStop)}）`,
      };
    }

    return {
      isActivated: false,
      trailingStopPrice: null,
      effectiveStopLoss: originalStopLoss,
      effectiveTakeProfit: originalTakeProfit,
      reason: `未発動（最高値¥${Math.round(maxHighDuringHold)} < BE発動¥${Math.round(beActivationPrice)} < TS発動¥${Math.round(activationPrice)}）`,
    };
  }

  // 3. トレール幅を算出
  const trailMultiplier =
    trailMultiplierOverride ?? TRAILING_STOP.TRAIL_ATR_MULTIPLIER[strategy];
  const trailWidth = entryAtr
    ? entryAtr * trailMultiplier
    : maxHighDuringHold * TRAILING_STOP.TRAIL_PCT[strategy];

  const rawTrailingStop = maxHighDuringHold - trailWidth;

  // 4. ラチェット（上方向のみ移動）+ ブレークイーブン保証
  //    発動条件（activation）< トレール幅（trail）の場合、
  //    発動直後のストップがエントリー以下になる構造的問題を防止
  let newTrailingStop = Math.round(rawTrailingStop);
  if (currentTrailingStop !== null) {
    newTrailingStop = Math.max(newTrailingStop, currentTrailingStop);
  }
  newTrailingStop = Math.max(newTrailingStop, originalStopLoss, entryPrice);

  // 5. 発動後: 固定TPを無効化し上値を追う
  return {
    isActivated: true,
    trailingStopPrice: newTrailingStop,
    effectiveStopLoss: newTrailingStop,
    effectiveTakeProfit: null,
    reason: `トレーリング発動（最高値¥${Math.round(maxHighDuringHold)} → ストップ¥${newTrailingStop}）`,
  };
}
