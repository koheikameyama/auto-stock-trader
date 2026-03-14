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

  // 条件1: SMA25付近 + 反発サイン → 15
  if (
    deviationRate25 >= ENTRY.PULLBACK_NEAR_MIN &&
    deviationRate25 <= ENTRY.PULLBACK_NEAR_MAX &&
    hasReversalSign(recentBars)
  ) {
    return SUB_MAX.PULLBACK_DEPTH;
  }

  // 条件2: SMA5-SMA25間（浅い押し目）→ 10
  if (sma5 != null && close < sma5 && close > sma25 && deviationRate25 > ENTRY.PULLBACK_NEAR_MAX) {
    return 10;
  }

  // 条件3: SMA25一時割れ復帰 → 8
  if (close > sma25 && recentBars.length >= 3) {
    const recentBelow = recentBars.slice(1, 4).some((bar) => {
      return bar.close < sma25;
    });
    if (recentBelow) return 8;
  }

  // 条件4: SMA5上（押してない）→ 3
  if (sma5 != null && close >= sma5) return 3;

  // 条件5: SMA25大幅下 → 0
  if (deviationRate25 < ENTRY.PULLBACK_DEEP_THRESHOLD) return 0;

  return 0;
}

/**
 * ブレイクアウト検出スコア（0-12）
 */
export function scoreBreakout(
  bars: OHLCVData[],
  avgVolume25: number | null,
): number {
  if (bars.length < 2) return 0;

  const currentClose = bars[0].close;
  const currentVolume = bars[0].volume;

  const lookback20 = bars.slice(1, ENTRY.BREAKOUT_LOOKBACK_20 + 1);
  const max20 = lookback20.length > 0 ? Math.max(...lookback20.map((b) => b.close)) : Infinity;

  const lookback10 = bars.slice(1, ENTRY.BREAKOUT_LOOKBACK_10 + 1);
  const max10 = lookback10.length > 0 ? Math.max(...lookback10.map((b) => b.close)) : Infinity;

  if (currentClose > max20 && lookback20.length >= ENTRY.BREAKOUT_LOOKBACK_20) {
    const volumeRatio = avgVolume25 && avgVolume25 > 0
      ? currentVolume / avgVolume25
      : 1;
    if (volumeRatio > ENTRY.BREAKOUT_VOLUME_RATIO) return SUB_MAX.BREAKOUT; // 12
    return 7;
  }

  if (currentClose > max10 && lookback10.length >= ENTRY.BREAKOUT_LOOKBACK_10) {
    return 4;
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

  // 十字線（実体がほぼゼロ）→ 3
  const totalRange = today.high - today.low;
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
  const breakout = scoreBreakout(input.bars, input.avgVolume25);
  const candlestickSignal = scoreCandlestickSignal(input.bars, input.avgVolume25);

  return {
    total: pullbackDepth + breakout + candlestickSignal,
    pullbackDepth,
    breakout,
    candlestickSignal,
  };
}
