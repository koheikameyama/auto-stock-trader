/**
 * MA押し目買いエントリー条件の共通モジュール
 *
 * バックテスト・ライブ共通の純粋関数
 */

/**
 * MA押し目買いシグナル判定
 *
 * 条件:
 * 1. close > sma50（上昇トレンド）
 * 2. 直近N日以内に20日高値更新（勢いの証明）
 * 3. low <= sma20 * (1 + maTouchBuffer)（MAタッチ）
 * 4. close >= sma20（引けでMAより上）
 * 5. close > open（陽線）
 * 6. 直近3日の出来高 < avgVolume25 * volumeDryupRatio（干上がり）
 */
export function isMaPullbackSignal(params: {
  close: number;
  open: number;
  low: number;
  sma20: number;
  sma50: number;
  avgVolume25: number;
  /** 直近3日の出来高（本日含む、古い順） */
  recentVolumes: number[];
  /** 直近RECENT_HIGH_LOOKBACK日以内に20日高値を更新したか */
  hadRecentHigh: boolean;
  maTouchBuffer: number;
  volumeDryupRatio: number;
}): boolean {
  const {
    close, open, low,
    sma20, sma50,
    avgVolume25,
    recentVolumes,
    hadRecentHigh,
    maTouchBuffer,
    volumeDryupRatio,
  } = params;

  if (sma20 <= 0 || sma50 <= 0) return false;

  // 1. 上昇トレンド確認
  if (close <= sma50) return false;

  // 2. 直近に勢いがある
  if (!hadRecentHigh) return false;

  // 3. MAにタッチ
  if (low > sma20 * (1 + maTouchBuffer)) return false;

  // 4. 引けでMA上
  if (close < sma20) return false;

  // 5. 陽線
  if (close <= open) return false;

  // 6. 出来高干上がり（データが揃っている場合のみ判定）
  if (avgVolume25 > 0 && recentVolumes.length >= 3) {
    const threshold = avgVolume25 * volumeDryupRatio;
    if (recentVolumes.some((v) => v >= threshold)) return false;
  }

  return true;
}
