/**
 * SL/TP の算出（発注時・約定時で共通）
 *
 * ## 基準価格は「約定価格」でなければならない
 *
 * 発注時点では約定価格が分からないので、`entry-executor` はスキャン時のライブ値
 * (`currentPrice`) を基準に SL/TP を計算して注文に載せる。これ自体は避けられない。
 * 問題はその後で、**約定したら約定価格を基準に張り直さないと BT と定義がズレる**。
 *
 * BT (`combined-simulation.ts`) の SL は一貫して
 *   `signal.entryPrice - atr14 * atrMultiplier`（= 約定価格基準、3%上限でクランプ）
 * であり、記録されている全成績はこの定義で出ている。
 *
 * 旧実装は約定後に `validateStopLoss()` を通すだけだった。しかし同関数が見るのは
 * 「ATR×0.5未満なら引き上げ / ATR×2.0超なら引き下げ / 3%超ならクランプ」の3点で、
 * GU/PSC の設計値 ATR×0.8 からのズレは **0.5〜2.0 の帯に収まる限り素通し**する。
 * 結果、SL はトリガー価格基準のまま残り続けていた。
 *
 * 実測（2026-07-31 時点の本番 GU/PSC 31玉）:
 *   実効SL幅 ÷ 設計幅(ATR×0.8) = 平均 0.959 / 範囲 0.67〜1.30 / 21玉が設計より狭い。
 *   引け成行の買いは34件中24件がマイナススリッページなので、構造的に「狭くなる」側に偏る
 *   （狭いSL = ノイズで刈られやすい）。ポジションサイズは発注時のリスク幅で決めているため、
 *   実リスク額も設計値からズレる（例: 6349.T は計画 ¥2,400 に対し実効 ¥1,700）。
 *
 * ## 対象外の戦略
 *
 * - buyback / panic: -12% 固定カタストロフSL。ATR で張り直してはいけない（`fixed-sl.ts` / KOH-555）
 * - us_etf: -2% 固定SL。ATR を使わないので `SL_ATR_MULTIPLIER` に入れない = 従来経路のまま
 */

import { STOP_LOSS } from "../lib/constants";
import { GAPUP } from "../lib/constants/gapup";
import { WEEKLY_BREAK } from "../lib/constants/weekly-break";
import { POST_SURGE_CONSOLIDATION } from "../lib/constants/post-surge-consolidation";
import { isFixedSlStrategy } from "../lib/constants/fixed-sl";
import { validateStopLoss } from "./risk-manager";

/**
 * SL幅 = ATR × N。**ここに無い戦略は ATR ベースでない**ため約定価格での張り直し対象外。
 * BT 側（`combined-simulation.ts` の `atrMultiplier`）と同じ値を使うこと。
 */
const SL_ATR_MULTIPLIER: Readonly<Record<string, number>> = {
  gapup: GAPUP.STOP_LOSS.ATR_MULTIPLIER,
  "weekly-break": WEEKLY_BREAK.STOP_LOSS.ATR_MULTIPLIER,
  "post-surge-consolidation": POST_SURGE_CONSOLIDATION.STOP_LOSS.ATR_MULTIPLIER,
};

/**
 * 参考TPの ATR 倍率。
 * 実際の利確はトレーリングストップが担うので、この値はサイジングには使わない。
 */
export const TAKE_PROFIT_ATR_MULTIPLIER = 5.0;

/**
 * 注文に TP/SL が無かった場合のフォールバック倍率。
 *
 * 現状の買い注文生成経路（entry-executor / us-etf-monitor / panic-monitor）は全て
 * TP/SL を必ず載せるので実際には到達しないが、「SL無しでポジションを持たない」ための安全網
 * として残す（固定SL戦略が SL 未指定で来た時に -3% に落ちる挙動は KOH-555 のテストが固定）。
 */
const FALLBACK_TP_RATIO = 1.05;
const FALLBACK_SL_RATIO = 0.97;

/** 戦略の SL ATR 倍率。ATR ベースでない戦略は null */
export function getSlAtrMultiplier(strategy: string): number | null {
  return SL_ATR_MULTIPLIER[strategy] ?? null;
}

/**
 * ATR ベースの SL/TP を算出する（BT の `combined-simulation.ts` と同一の式）。
 *
 * @param basePrice 基準価格。発注時はスキャン時のライブ値、約定後は約定価格
 * @returns `isClamped` は SL が ATR ベースより 3% 上限で切り上げられたか
 */
export function calculateAtrExitPrices(
  basePrice: number,
  atr14: number,
  atrMultiplier: number,
): {
  stopLossPrice: number;
  takeProfitPrice: number;
  rawStopLoss: number;
  isClamped: boolean;
} {
  const rawStopLoss = basePrice - atr14 * atrMultiplier;
  const maxStopLoss = basePrice * (1 - STOP_LOSS.MAX_LOSS_PCT);
  return {
    stopLossPrice: Math.round(Math.max(rawStopLoss, maxStopLoss)),
    takeProfitPrice: Math.round(basePrice + atr14 * TAKE_PROFIT_ATR_MULTIPLIER),
    rawStopLoss,
    isClamped: rawStopLoss < maxStopLoss,
  };
}

/**
 * 約定価格ベースで TP/SL を確定する。
 *
 * 約定検知の2経路（`broker-fill-handler`＝EVENT I/F 主系 / `position-monitor`＝ポーリング補系）
 * で挙動が割れないよう、両方からこの関数を呼ぶこと。
 *
 * @param strategy 固定SL戦略(buyback/panic)は注文で指定した SL をそのまま採用する。
 *   `validateStopLoss` のルール1が3%超のSLを一律 -3% にクランプするため、-12% 固定
 *   カタストロフ損切りを指定しても約定時に潰されてしまう (KOH-555)。これらの戦略は SL幅を
 *   前提に建玉サイズを決めている(risk2%/12% ≒ cash の16.7%)ので、SL だけ縮むと整合も壊れる。
 */
export function recalculateExitPricesOnFill(
  filledPrice: number,
  orderTP: number | null,
  orderSL: number | null,
  entryAtr: number | null,
  strategy: string,
): { takeProfitPrice: number; stopLossPrice: number } {
  let takeProfitPrice = orderTP ?? Math.round(filledPrice * FALLBACK_TP_RATIO);
  let stopLossPrice = orderSL ?? Math.round(filledPrice * FALLBACK_SL_RATIO);

  // 固定SL戦略: 注文で指定した SL をそのまま採用する（クランプ・ATR再計算を一切しない）
  if (isFixedSlStrategy(strategy)) {
    return { takeProfitPrice, stopLossPrice };
  }

  // ATRベース戦略: 約定価格を基準に張り直す（BT と同じ定義に揃える）
  const atrMultiplier = getSlAtrMultiplier(strategy);
  if (entryAtr && atrMultiplier != null) {
    const recalculated = calculateAtrExitPrices(
      filledPrice,
      entryAtr,
      atrMultiplier,
    );
    return {
      takeProfitPrice: recalculated.takeProfitPrice,
      stopLossPrice: recalculated.stopLossPrice,
    };
  }

  // ATR不明 or ATRベースでない戦略（us_etf 等）: 従来どおり約定価格で再検証するのみ
  const slValidation = validateStopLoss(filledPrice, stopLossPrice, entryAtr, []);
  if (slValidation.wasOverridden) {
    stopLossPrice = Math.round(slValidation.validatedPrice);

    // ATR ベースで TP も再計算
    if (entryAtr) {
      const atrBasedTP = filledPrice + entryAtr * 1.5;
      takeProfitPrice = Math.round(Math.max(takeProfitPrice, atrBasedTP));
    }

    // RR >= 1.5 を確保
    const risk = filledPrice - stopLossPrice;
    const reward = takeProfitPrice - filledPrice;
    if (risk > 0 && reward / risk < 1.5) {
      takeProfitPrice = Math.round(filledPrice + risk * 1.5);
    }
  }

  return { takeProfitPrice, stopLossPrice };
}
