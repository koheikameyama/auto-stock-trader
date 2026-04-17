/**
 * 高騰後の出来高干上がり押し目戦略エントリー条件
 *
 * 条件:
 * 1. 急騰フィルター: close / close20DaysAgo - 1 >= momentumMinReturn
 * 2. 高値圏維持: close >= high20 * (1 - maxHighDistancePct)
 * 3. 当日陽線: close > open
 * 4. 当日出来高サージ: volume >= avgVolume25 * volSurgeRatio
 */

export function isPostSurgeConsolidationSignal(params: {
  open: number;
  close: number;
  close20DaysAgo: number;
  high20: number;
  volume: number;
  avgVolume25: number;
  momentumMinReturn: number;
  maxHighDistancePct: number;
  volSurgeRatio: number;
}): boolean {
  const {
    open,
    close,
    close20DaysAgo,
    high20,
    volume,
    avgVolume25,
    momentumMinReturn,
    maxHighDistancePct,
    volSurgeRatio,
  } = params;

  if (close20DaysAgo <= 0 || high20 <= 0) return false;

  // 1. 急騰フィルター
  if (close / close20DaysAgo - 1 < momentumMinReturn) return false;

  // 2. 高値圏維持
  if (close < high20 * (1 - maxHighDistancePct)) return false;

  // 3. 当日陽線
  if (close <= open) return false;

  // 4. 当日出来高サージ
  if (avgVolume25 > 0 && volume < avgVolume25 * volSurgeRatio) return false;

  return true;
}
