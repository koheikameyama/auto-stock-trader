/**
 * ポジション出口判定モジュール（純粋関数）
 *
 * position-monitor.ts とバックテスト simulation-engine.ts で
 * 同一の出口判定ロジックを共有する。
 *
 * 判定順序:
 * 1. トレーリングストップ算出
 * 2. 利確チェック（TP）
 * 3. 損切り / トレーリングストップチェック（SL） — TP より優先
 * 4. タイムストップ（スイングのみ、最大保有日数超過）
 */

import { calculateTrailingStop } from "./trailing-stop";
import { TIME_STOP } from "../lib/constants";

export interface PositionForExit {
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  entryAtr: number | null;
  maxHighDuringHold: number;
  currentTrailingStop: number | null;
  strategy: "day_trade" | "swing";
  holdingBusinessDays: number;
  activationMultiplierOverride?: number;
}

export interface BarForExit {
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ExitReason =
  | "take_profit"
  | "stop_loss"
  | "trailing_profit"
  | "time_stop";

export interface ExitCheckResult {
  exitPrice: number | null;
  exitReason: ExitReason | null;
  newMaxHigh: number;
  trailingStopPrice: number | null;
  isTrailingActivated: boolean;
}

/**
 * ポジションの出口条件をチェックする
 *
 * position-monitor.ts と simulation-engine.ts で共有。
 * DB操作は一切行わない純粋関数。
 */
export function checkPositionExit(
  position: PositionForExit,
  bar: BarForExit,
): ExitCheckResult {
  // maxHigh を更新（トレーリングストップ算出に必要）
  const newMaxHigh = Math.max(position.maxHighDuringHold, bar.high);

  // 1. トレーリングストップ算出
  const trailingResult = calculateTrailingStop({
    entryPrice: position.entryPrice,
    maxHighDuringHold: newMaxHigh,
    currentTrailingStop: position.currentTrailingStop,
    originalStopLoss: position.stopLossPrice,
    originalTakeProfit: position.takeProfitPrice,
    entryAtr: position.entryAtr,
    strategy: position.strategy,
    activationMultiplierOverride: position.activationMultiplierOverride,
  });

  const effectiveTP = trailingResult.effectiveTakeProfit;
  const effectiveSL = trailingResult.effectiveStopLoss;

  let exitPrice: number | null = null;
  let exitReason: ExitReason | null = null;

  // 2. 利確チェック（トレーリング発動中は effectiveTP = null なのでスキップ）
  if (effectiveTP !== null && bar.high >= effectiveTP) {
    // ギャップアップで寄り付いた場合、寄り付き値で約定（売り手に有利）
    exitPrice = bar.open > effectiveTP ? bar.open : effectiveTP;
    exitReason = "take_profit";
  }

  // 3. 損切り / トレーリングストップチェック（利確より優先）
  if (bar.low <= effectiveSL) {
    // ギャップダウンで SL を突き抜けた場合、寄り付き値で約定（スリッページ反映）
    exitPrice = bar.open < effectiveSL ? bar.open : effectiveSL;
    exitReason = trailingResult.isActivated ? "trailing_profit" : "stop_loss";
  }

  // 4. タイムストップ（スイングのみ — デイトレは別途強制決済）
  if (exitPrice === null && position.strategy !== "day_trade") {
    if (position.holdingBusinessDays >= TIME_STOP.MAX_HOLDING_DAYS) {
      exitPrice = bar.close;
      exitReason = "time_stop";
    }
  }

  return {
    exitPrice,
    exitReason,
    newMaxHigh,
    trailingStopPrice: trailingResult.trailingStopPrice,
    isTrailingActivated: trailingResult.isActivated,
  };
}
