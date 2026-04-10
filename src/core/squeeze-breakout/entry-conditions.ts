/**
 * スクイーズブレイクアウト エントリー条件判定
 *
 * BB幅がスクイーズ状態（パーセンタイル閾値以下）のときに
 * 上方ブレイクアウト + 出来高サージ + 陽線 でエントリーシグナルを出す。
 */

export function isSqueezeBreakoutSignal(params: {
  /** BB幅の60日パーセンタイル (0-100) */
  bbWidthPercentile: number;
  /** スクイーズ閾値（この%以下でスクイーズ） */
  squeezeThreshold: number;
  /** 当日終値 */
  close: number;
  /** 当日始値 */
  open: number;
  /** 当日の上部BB(20,2σ) */
  upperBand: number;
  /** 過去20日の最高値（当日除く） */
  high20: number;
  /** 当日出来高 */
  volume: number;
  /** 25日平均出来高 */
  avgVolume25: number;
  /** 出来高サージ倍率 */
  volSurgeRatio: number;
}): boolean {
  const {
    bbWidthPercentile,
    squeezeThreshold,
    close,
    open,
    upperBand,
    high20,
    volume,
    avgVolume25,
    volSurgeRatio,
  } = params;

  // 1. スクイーズ状態か
  if (bbWidthPercentile > squeezeThreshold) return false;

  // 2. 上方ブレイクアウト（上部BB超え OR 20日高値超え）
  if (close <= upperBand && close <= high20) return false;

  // 3. 陽線（終値 > 始値 = 買い方優勢）
  if (close <= open) return false;

  // 4. 出来高サージ
  if (avgVolume25 > 0 && volume < avgVolume25 * volSurgeRatio) return false;

  return true;
}
