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
import type { BreakEvenFloorMode } from "./trailing-stop";
import { TIME_STOP } from "../lib/constants";
import type { TradingStrategy } from "./market-regime";

export interface PositionForExit {
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  entryAtr: number | null;
  maxHighDuringHold: number;
  minLowDuringHold: number;
  currentTrailingStop: number | null;
  strategy: TradingStrategy;
  holdingBusinessDays: number;
  beActivationMultiplierOverride?: number;
  trailMultiplierOverride?: number;
  maxHoldingDaysOverride?: number;
  baseLimitHoldingDaysOverride?: number; // 含み損時の早期カット日数（gapup: 3日）
  /**
   * BE/トレール発動の「検知」に使う価格系列。
   * "high"（既定）= その日の日中高値で検知 = 無限頻度の完璧検知（本番・BTの既存挙動）。
   * "openclose" = 始値と終値の2点で検知 = 実質2回/日相当（曲線の形を見る中間点）。
   * "close" = 終値のみで検知 = 実質1回/日の最悪検知（頻度の価値幅を測る下限シミュレーション専用）。
   * 執行判定（TPはhigh・SL breachはlow）は本物の約定イベントなので常に不変。
   */
  activationDetectionSource?: "high" | "openclose" | "close";
  /** トレーリング発動後のストップ下限モード（既定 "entry" = 建値フロア） */
  breakEvenFloor?: BreakEvenFloorMode;
  /**
   * SL約定価格のイントラバー・モデル（既定 "end-of-bar" = 現行挙動）。
   *
   * "end-of-bar": 当日高値で切り上げた後のストップ（effectiveSL）と始値を比較し、
   *   始値が下なら「ギャップ突破」とみなして始値で約定させる。ただし effectiveSL は
   *   始値より後に起きた高値から作られた値なので、始値時点では実在しないストップと
   *   比較している（イントラバー先読み）。KOH-547: 建値1656/始値1656/高値1827 の日に、
   *   高値から作られたトレール1808 と始値1656 を比べて「1808を飛び越えた」と誤判定し、
   *   +9.2%のトレール約定を建値撤退(±0)として記録した。
   *
   * "stop-at-open": 始値時点で実在したストップ（前日までの最高値ベース）で
   *   ギャップ突破を判定する。バー内は 3 段階で評価する:
   *     1. 始値 <= 始値時点ストップ → 寄りでギャップ突破 → 始値で約定
   *     2. 安値 <= 始値時点ストップ → バー内でその水準に触れた → そのストップで約定
   *        （安値と高値の前後関係は日足では不明なため、安値が先に来た前提の保守側を採る）
   *     3. 安値 <= effectiveSL → 高値で切り上がったトレールに触れた → effectiveSL で約定
   */
  intraBarStopModel?: IntraBarStopModel;
}

export type IntraBarStopModel = "end-of-bar" | "stop-at-open";

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
  | "trailing_stop"
  | "time_stop";

export interface ExitCheckResult {
  exitPrice: number | null;
  exitReason: ExitReason | null;
  newMaxHigh: number;
  newMinLow: number;
  trailingStopPrice: number | null;
  isTrailingActivated: boolean;
}

/**
 * SL/トレール約定の理由を分類する。
 *
 * トレーリング発動中でも、約定が建値以下なら「利確」ではなく建値撤退として分類する。
 * （発動閾値を舐めた直後に建値フロア割れ・ギャップダウンで建値以下約定するケース）
 */
function classifyStopExit(
  isActivated: boolean,
  exitPrice: number,
  entryPrice: number,
): ExitReason {
  if (!isActivated) return "stop_loss";
  return exitPrice > entryPrice ? "trailing_profit" : "trailing_stop";
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
  // maxHigh / minLow を更新
  // BE/トレール発動の検知に使う高値。既定は日中高値(完璧検知)。"close" 指定時は終値のみで
  // 検知し、頻度低下(取りこぼし)をシミュレートする。執行(下の TP=high / SL=low)は不変。
  const detectHigh =
    position.activationDetectionSource === "close"
      ? bar.close
      : position.activationDetectionSource === "openclose"
        ? Math.max(bar.open, bar.close)
        : bar.high;
  const newMaxHigh = Math.max(position.maxHighDuringHold, detectHigh);
  const newMinLow = Math.min(position.minLowDuringHold, bar.low);

  // 1. トレーリングストップ算出
  const trailingResult = calculateTrailingStop({
    entryPrice: position.entryPrice,
    maxHighDuringHold: newMaxHigh,
    currentTrailingStop: position.currentTrailingStop,
    originalStopLoss: position.stopLossPrice,
    originalTakeProfit: position.takeProfitPrice,
    entryAtr: position.entryAtr,
    strategy: position.strategy,
    beActivationMultiplierOverride: position.beActivationMultiplierOverride,
    trailMultiplierOverride: position.trailMultiplierOverride,
    breakEvenFloor: position.breakEvenFloor,
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
    if (position.intraBarStopModel === "stop-at-open") {
      // 始値時点で実在したストップ = 前日までの最高値から作られた水準。
      // effectiveSL は当日高値で切り上がった後の水準なので、寄りのギャップ突破判定には使えない。
      const openTrailing = calculateTrailingStop({
        entryPrice: position.entryPrice,
        maxHighDuringHold: position.maxHighDuringHold,
        currentTrailingStop: position.currentTrailingStop,
        originalStopLoss: position.stopLossPrice,
        originalTakeProfit: position.takeProfitPrice,
        entryAtr: position.entryAtr,
        strategy: position.strategy,
        beActivationMultiplierOverride: position.beActivationMultiplierOverride,
        trailMultiplierOverride: position.trailMultiplierOverride,
        breakEvenFloor: position.breakEvenFloor,
      });
      const slAtOpen = openTrailing.effectiveStopLoss;

      if (bar.open <= slAtOpen) {
        // 1. 寄りでギャップ突破 → 始値で約定（スリッページ反映）
        exitPrice = bar.open;
        exitReason = classifyStopExit(
          openTrailing.isActivated,
          exitPrice,
          position.entryPrice,
        );
      } else if (bar.low <= slAtOpen) {
        // 2. バー内で始値時点のストップに触れた → その水準で約定。
        //    高値で切り上がる前に安値が来た可能性を潰せないため保守側を採る。
        exitPrice = slAtOpen;
        exitReason = classifyStopExit(
          openTrailing.isActivated,
          exitPrice,
          position.entryPrice,
        );
      } else {
        // 3. 始値時点のストップは無傷 → 高値で切り上がったトレールに触れて約定
        exitPrice = effectiveSL;
        exitReason = classifyStopExit(
          trailingResult.isActivated,
          exitPrice,
          position.entryPrice,
        );
      }
    } else {
      // ギャップダウンで SL を突き抜けた場合、寄り付き値で約定（スリッページ反映）
      exitPrice = bar.open < effectiveSL ? bar.open : effectiveSL;
      exitReason = classifyStopExit(
        trailingResult.isActivated,
        exitPrice,
        position.entryPrice,
      );
    }
  }

  // 4. タイムストップ
  //    トレーリングストップ発動中は利益を伸ばすためタイムストップを適用しない
  //    含み益がある場合は延長し、ハードキャップ（MAX_EXTENDED_HOLDING_DAYS）まで待つ
  if (exitPrice === null && !trailingResult.isActivated) {
    const hardCap = position.maxHoldingDaysOverride ?? TIME_STOP.MAX_EXTENDED_HOLDING_DAYS;
    const baseLimit = position.baseLimitHoldingDaysOverride ?? TIME_STOP.MAX_HOLDING_DAYS;
    const inProfit = bar.close > position.entryPrice;
    const hitHardCap = position.holdingBusinessDays >= hardCap;
    const hitBaseLimitWithNoProfit =
      position.holdingBusinessDays >= baseLimit && !inProfit;

    if (hitHardCap || hitBaseLimitWithNoProfit) {
      exitPrice = bar.close;
      exitReason = "time_stop";
    }
  }

  return {
    exitPrice,
    exitReason,
    newMaxHigh,
    newMinLow,
    trailingStopPrice: trailingResult.trailingStopPrice,
    isTrailingActivated: trailingResult.isActivated,
  };
}
