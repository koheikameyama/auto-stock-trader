/**
 * チャート予測実験：特徴量計算 + 単一特徴ベースライン予測器
 *
 * 目的:
 *   「チャートから方向を予測 → 実測と照合 → どの条件で当たりやすいか」を
 *   統計的に検証するための、先読みゼロ・再現可能な特徴量/予測ロジック。
 *
 * 設計原則:
 *   - 特徴量は bars[0..i]（= 予測日 t まで）のみで計算する（未来足を1本も見ない）
 *   - ラベルは呼び出し側で bars[i+H] を使って別途付与する
 *   - 予測器はまず「単一特徴の符号」でベースラインを作る。無条件的中率
 *     （majority-class）を超える素性が1つも無ければ複雑化しても無駄、という
 *     プロジェクトの教訓（却下リスト系）に従う
 */

import type { OHLCVData } from "../core/technical-analysis";

// ──────────────────────────────────────────
// 特徴量
// ──────────────────────────────────────────

/** 予測日 t（bars の index i）時点の特徴量。すべて予測日までの情報のみ */
export interface PredictionFeatures {
  /** SMA25 の傾き（直近5営業日の変化率）。トレンド方向 */
  smaSlope25: number | null;
  /** close / SMA5 - 1。短期の位置 */
  priceVsSma5: number | null;
  /** close / SMA25 - 1。中期の位置（過熱/押し目） */
  priceVsSma25: number | null;
  /** close / SMA75 - 1。長期の位置 */
  priceVsSma75: number | null;
  /** 過去5営業日リターン。短期モメンタム */
  mom5: number | null;
  /** 過去20営業日リターン。中期モメンタム */
  mom20: number | null;
  /** ATR14 / close。ボラティリティ（%） */
  atrPct: number | null;
  /** volume / avgVolume25。出来高サージ */
  volRatio: number | null;
  /** (close - low20) / (high20 - low20)。20日レンジ内の位置 0〜1 */
  rangePos20: number | null;
  /** close / high20 - 1。20日高値からの距離（<=0） */
  distFromHigh20: number | null;
  /** RSI(14) */
  rsi14: number | null;
}

/** SMA（oldest-first bars, index i, period p） */
export function smaAt(bars: OHLCVData[], i: number, p: number): number | null {
  if (i < p - 1) return null;
  let s = 0;
  for (let k = i - p + 1; k <= i; k++) s += bars[k].close;
  return s / p;
}

/** 平均出来高 */
function avgVolAt(bars: OHLCVData[], i: number, p: number): number | null {
  if (i < p - 1) return null;
  let s = 0;
  for (let k = i - p + 1; k <= i; k++) s += bars[k].volume;
  return s / p;
}

/** RSI(14)。単純移動平均ベース（Cutler版） */
function rsi14At(bars: OHLCVData[], i: number): number | null {
  if (i < 14) return null;
  let gain = 0;
  let loss = 0;
  for (let k = i - 13; k <= i; k++) {
    const ch = bars[k].close - bars[k - 1].close;
    if (ch >= 0) gain += ch;
    else loss += -ch;
  }
  const avgGain = gain / 14;
  const avgLoss = loss / 14;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** ATR(14)。単純移動平均ベース */
function atr14At(bars: OHLCVData[], i: number): number | null {
  if (i < 14) return null;
  let sum = 0;
  for (let k = i - 13; k <= i; k++) {
    const prevClose = bars[k - 1].close;
    const tr = Math.max(
      bars[k].high - bars[k].low,
      Math.abs(bars[k].high - prevClose),
      Math.abs(bars[k].low - prevClose),
    );
    sum += tr;
  }
  return sum / 14;
}

/** 直近 p 日の高値/安値（index i を含む） */
function highLowAt(
  bars: OHLCVData[],
  i: number,
  p: number,
): { high: number; low: number } | null {
  if (i < p - 1) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = i - p + 1; k <= i; k++) {
    if (bars[k].high > hi) hi = bars[k].high;
    if (bars[k].low < lo) lo = bars[k].low;
  }
  return { high: hi, low: lo };
}

/**
 * 予測日 t（index i）時点の特徴量を計算する。
 * 情報は bars[0..i] のみ使用（未来足を参照しない）。
 */
export function computeFeaturesAt(
  bars: OHLCVData[],
  i: number,
): PredictionFeatures {
  const close = bars[i].close;

  const sma5 = smaAt(bars, i, 5);
  const sma25 = smaAt(bars, i, 25);
  const sma75 = smaAt(bars, i, 75);
  const sma25Prev = smaAt(bars, i - 5, 25);
  const avgVol25 = avgVolAt(bars, i, 25);
  const hl20 = highLowAt(bars, i, 20);

  const close5ago = i >= 5 ? bars[i - 5].close : null;
  const close20ago = i >= 20 ? bars[i - 20].close : null;
  const atr = atr14At(bars, i);

  return {
    smaSlope25:
      sma25 != null && sma25Prev != null && sma25Prev !== 0
        ? sma25 / sma25Prev - 1
        : null,
    priceVsSma5: sma5 != null && sma5 !== 0 ? close / sma5 - 1 : null,
    priceVsSma25: sma25 != null && sma25 !== 0 ? close / sma25 - 1 : null,
    priceVsSma75: sma75 != null && sma75 !== 0 ? close / sma75 - 1 : null,
    mom5: close5ago != null && close5ago !== 0 ? close / close5ago - 1 : null,
    mom20:
      close20ago != null && close20ago !== 0 ? close / close20ago - 1 : null,
    atrPct: atr != null && close !== 0 ? atr / close : null,
    volRatio:
      avgVol25 != null && avgVol25 !== 0 ? bars[i].volume / avgVol25 : null,
    rangePos20:
      hl20 != null && hl20.high !== hl20.low
        ? (close - hl20.low) / (hl20.high - hl20.low)
        : null,
    distFromHigh20:
      hl20 != null && hl20.high !== 0 ? close / hl20.high - 1 : null,
    rsi14: rsi14At(bars, i),
  };
}

// ──────────────────────────────────────────
// 単一特徴ベースライン予測器
// ──────────────────────────────────────────

export type Direction = "up" | "down";

export interface Predictor {
  name: string;
  /** チャート分析上の仮説（何を根拠に方向を張るか） */
  hypothesis: string;
  /** 予測。判定不能（特徴量 null）なら null を返す */
  predict: (f: PredictionFeatures) => Direction | null;
}

/**
 * v1 予測器群。いずれも「単一特徴の符号」で方向を張る素朴なベースライン。
 * ここで majority-class を明確に超える素性を見つけてから複雑化する。
 */
export const PREDICTORS: Predictor[] = [
  {
    name: "trend_sma25slope",
    hypothesis: "SMA25 が上向き → 上昇継続（トレンドフォロー）",
    predict: (f) =>
      f.smaSlope25 == null ? null : f.smaSlope25 > 0 ? "up" : "down",
  },
  {
    name: "mom5",
    hypothesis: "直近5日が上げ → 短期モメンタム継続",
    predict: (f) => (f.mom5 == null ? null : f.mom5 > 0 ? "up" : "down"),
  },
  {
    name: "mom20",
    hypothesis: "直近20日が上げ → 中期モメンタム継続",
    predict: (f) => (f.mom20 == null ? null : f.mom20 > 0 ? "up" : "down"),
  },
  {
    name: "price_above_sma25",
    hypothesis: "SMA25 上 → 上昇バイアス",
    predict: (f) =>
      f.priceVsSma25 == null ? null : f.priceVsSma25 > 0 ? "up" : "down",
  },
  {
    name: "rsi_gt50",
    hypothesis: "RSI>50 → 買い優勢の継続",
    predict: (f) => (f.rsi14 == null ? null : f.rsi14 > 50 ? "up" : "down"),
  },
  {
    name: "near_high_breakout",
    hypothesis: "20日高値近辺(-2%以内) → ブレイク継続",
    predict: (f) =>
      f.distFromHigh20 == null ? null : f.distFromHigh20 >= -0.02 ? "up" : "down",
  },
  {
    name: "rsi_oversold_bounce",
    hypothesis: "RSI<30 → 売られすぎリバウンド（逆張り）",
    predict: (f) => (f.rsi14 == null ? null : f.rsi14 < 30 ? "up" : "down"),
  },
  {
    name: "range_low_reversion",
    hypothesis: "20日レンジ下限近く(下25%) → 平均回帰の反発（逆張り）",
    predict: (f) =>
      f.rangePos20 == null ? null : f.rangePos20 < 0.25 ? "up" : "down",
  },
];
