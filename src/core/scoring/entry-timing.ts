import { SCORING } from "../../lib/constants/scoring";
import type { OHLCVData } from "../technical-analysis";

const { SUB_MAX, ENTRY } = SCORING;

/**
 * 反発サインを検出
 * 直近2本のうち下ヒゲが実体以上、または前日陰線→当日陽線
 */
function hasReversalSign(bars: OHLCVData[]): boolean {
  if (bars.length < 2) return false;
  const [today, yesterday] = bars;

  for (const bar of [today, yesterday]) {
    const lowerShadow = Math.min(bar.open, bar.close) - bar.low;
    const realBody = Math.abs(bar.close - bar.open);
    if (lowerShadow >= realBody && realBody > 0) return true;
  }

  if (yesterday.close < yesterday.open && today.close > today.open) return true;

  return false;
}

/**
 * プルバック深度スコア（0-15）
 */
export function scorePullbackDepth(
  close: number,
  sma5: number | null,
  sma25: number | null,
  deviationRate25: number | null,
  recentBars: OHLCVData[],
): number {
  if (sma25 == null || deviationRate25 == null) return 0;

  // SMA25大幅下 → 0（先に判定）
  if (deviationRate25 < ENTRY.PULLBACK_DEEP_THRESHOLD) return 0;

  // 条件1: SMA25付近 + 反発サイン → 15
  if (
    deviationRate25 >= ENTRY.PULLBACK_NEAR_MIN &&
    deviationRate25 <= ENTRY.PULLBACK_NEAR_MAX &&
    hasReversalSign(recentBars)
  ) {
    return SUB_MAX.PULLBACK_DEPTH;
  }

  // 条件2: SMA25付近（反発サインなし）→ 10
  if (deviationRate25 >= ENTRY.PULLBACK_NEAR_MIN && deviationRate25 <= ENTRY.PULLBACK_NEAR_MAX) {
    return 10;
  }

  // 条件3: SMA5-SMA25間（浅い押し目）→ 10
  if (sma5 != null && close < sma5 && close > sma25 && deviationRate25 > ENTRY.PULLBACK_NEAR_MAX) {
    return 10;
  }

  // 条件4: SMA25一時割れ復帰 → 8
  if (close > sma25 && recentBars.length >= 3) {
    const recentBelow = recentBars.slice(1, 4).some((bar) => {
      return bar.close < sma25;
    });
    if (recentBelow) return 8;
  }

  // 条件5: SMA25上で適度な乖離（2-5%）→ 6
  if (deviationRate25 > ENTRY.PULLBACK_NEAR_MAX && deviationRate25 <= 5) {
    return 6;
  }

  // 条件6: SMA5上（トレンド中だが押してない）→ 4
  if (sma5 != null && close >= sma5) return 4;

  return 0;
}

/**
 * BO後押し目ボーナス（0-12）
 *
 * 直近にブレイクアウト（高値更新）があり、かつ現在押し目にいる場合のみ加点。
 * ブレイクアウト後にサポート転換した押し目は高品質なセットアップであるため、
 * 押し目スコアへのボーナスとして機能する。
 *
 * ゲート: pullbackScore === 0（押し目でない）→ 0点
 */
export function scorePriorBreakout(
  bars: OHLCVData[],
  avgVolume25: number | null,
  pullbackScore: number,
): number {
  if (pullbackScore === 0) return 0;
  if (bars.length < 2) return 0;

  const currentClose = bars[0].close;

  // --- 20日高値チェック ---
  const lookback20 = bars.slice(0, ENTRY.PRIOR_BREAKOUT_LOOKBACK_20 + 1);
  if (lookback20.length >= ENTRY.PRIOR_BREAKOUT_LOOKBACK_20 + 1) {
    const closes20 = lookback20.map((b) => b.close);
    const max20 = Math.max(...closes20);
    const max20DaysAgo = closes20.indexOf(max20);

    // 20日高値が1〜7日前に発生 = 最近ブレイクアウトした後に押している
    if (max20DaysAgo >= 1 && max20DaysAgo <= ENTRY.PRIOR_BREAKOUT_RECENCY_20) {
      const breakoutBar = bars[max20DaysAgo];
      const volumeRatio = avgVolume25 && avgVolume25 > 0
        ? breakoutBar.volume / avgVolume25
        : 1;
      if (volumeRatio > ENTRY.PRIOR_BREAKOUT_VOLUME_RATIO) return SUB_MAX.PRIOR_BREAKOUT; // 12
      if (volumeRatio > 1.2) return 9;
      return 7;
    }
  }

  // --- 10日高値チェック ---
  const lookback10 = bars.slice(0, ENTRY.PRIOR_BREAKOUT_LOOKBACK_10 + 1);
  if (lookback10.length >= ENTRY.PRIOR_BREAKOUT_LOOKBACK_10 + 1) {
    const closes10 = lookback10.map((b) => b.close);
    const max10 = Math.max(...closes10);
    const max10DaysAgo = closes10.indexOf(max10);

    // 10日高値が1〜5日前に発生
    if (max10DaysAgo >= 1 && max10DaysAgo <= ENTRY.PRIOR_BREAKOUT_RECENCY_10) {
      return 5;
    }

    // 高値圏で押している（20日高値の95%以上）
    if (currentClose >= max10 * ENTRY.PRIOR_BREAKOUT_NEAR_HIGH_PCT) {
      return 2;
    }
  }

  return 0;
}

/**
 * ローソク足シグナルスコア（0-8）
 */
export function scoreCandlestickSignal(
  bars: OHLCVData[],
  avgVolume25: number | null,
): number {
  if (bars.length < 2) return 0;
  let maxScore = 0;
  const today = bars[0];
  const yesterday = bars[1];
  const volumeRatio = avgVolume25 && avgVolume25 > 0
    ? today.volume / avgVolume25
    : 1;

  // 包み足（陽線）+ 出来高増加 → 8
  const todayBullish = today.close > today.open;
  const yesterdayBearish = yesterday.close < yesterday.open;
  const engulfing = todayBullish && yesterdayBearish &&
    today.close > yesterday.open && today.open < yesterday.close;
  if (engulfing && volumeRatio > 1.0) {
    maxScore = Math.max(maxScore, SUB_MAX.CANDLESTICK_SIGNAL); // 8
  }

  // 長い下ヒゲ（実体の2倍超 かつ 上ヒゲが下ヒゲの1/3以下）→ 6（ハンマー足）
  const lowerShadow = Math.min(today.open, today.close) - today.low;
  const realBody = Math.abs(today.close - today.open);
  const upperShadow = today.high - Math.max(today.open, today.close);
  if (realBody > 0 && lowerShadow > realBody * 2 && upperShadow <= lowerShadow / 3) {
    maxScore = Math.max(maxScore, 6);
  }

  // 連続陽線（3本）+ 出来高漸増 → 5
  if (bars.length >= 3) {
    const [b0, b1, b2] = bars;
    const allBullish = b0.close > b0.open && b1.close > b1.open && b2.close > b2.open;
    const volumeIncreasing = b0.volume > b1.volume && b1.volume > b2.volume;
    if (allBullish && volumeIncreasing) {
      maxScore = Math.max(maxScore, 5);
    }
  }

  // 強い陽線（終値が高値に近い + 実体が足レンジの60%超）→ 4
  const totalRange = today.high - today.low;
  if (totalRange > 0 && todayBullish) {
    const closeToHigh = (today.high - today.close) / totalRange;
    const bodyRatio = realBody / totalRange;
    if (closeToHigh < 0.15 && bodyRatio > 0.6) {
      maxScore = Math.max(maxScore, 4);
    }
  }

  // 十字線（実体がほぼゼロ）→ 3
  if (totalRange > 0 && realBody / totalRange < 0.1) {
    maxScore = Math.max(maxScore, 3);
  }

  return maxScore;
}

/** エントリータイミングの入力 */
export interface EntryTimingInput {
  close: number;
  sma5: number | null;
  sma25: number | null;
  deviationRate25: number | null;
  bars: OHLCVData[];
  avgVolume25: number | null;
}

/**
 * エントリータイミングトータル（0-35）
 */
export function scoreEntryTiming(input: EntryTimingInput) {
  const pullbackDepth = scorePullbackDepth(
    input.close, input.sma5, input.sma25, input.deviationRate25, input.bars,
  );
  const priorBreakout = scorePriorBreakout(input.bars, input.avgVolume25, pullbackDepth);
  const candlestickSignal = scoreCandlestickSignal(input.bars, input.avgVolume25);

  return {
    total: pullbackDepth + priorBreakout + candlestickSignal,
    pullbackDepth,
    priorBreakout,
    candlestickSignal,
  };
}
