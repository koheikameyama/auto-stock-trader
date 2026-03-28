/**
 * ギャップアップエントリー条件の共通モジュール
 */

export function isGapUpSignal(params: {
  open: number;
  close: number;
  prevClose: number;
  volume: number;
  avgVolume25: number;
  gapMinPct: number;
  volSurgeRatio: number;
}): boolean {
  const { open, close, prevClose, volume, avgVolume25, gapMinPct, volSurgeRatio } = params;

  if (prevClose <= 0) return false;
  if (open <= prevClose * (1 + gapMinPct)) return false;
  if (close < open) return false;
  if (close <= prevClose * (1 + gapMinPct)) return false;
  if (avgVolume25 > 0 && volume < avgVolume25 * volSurgeRatio) return false;

  return true;
}
