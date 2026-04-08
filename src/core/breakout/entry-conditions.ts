/**
 * ブレイクアウトエントリー条件の共通モジュール
 *
 * バックテスト (breakout-simulation.ts) と
 * ライブスキャナー (breakout-scanner.ts) の両方から呼ばれる純粋関数。
 */

/** ブレイクアウトシグナル判定（出来高サージ + 高値ブレイク + チェイスフィルター） */
export function isBreakoutSignal(params: {
  price: number;
  high20: number;
  volumeSurgeRatio: number;
  atr14: number;
  triggerThreshold: number;
  maxChaseAtr: number;
}): boolean {
  const { price, high20, volumeSurgeRatio, atr14, triggerThreshold, maxChaseAtr } = params;

  // 出来高サージ
  if (volumeSurgeRatio < triggerThreshold) return false;

  // 高値ブレイク
  if (price <= high20) return false;

  // 高値追いフィルター
  if (atr14 > 0) {
    const chaseAmount = price - high20;
    if (chaseAmount > atr14 * maxChaseAtr) return false;
  }

  return true;
}

/** ユニバースゲート（価格・出来高・ATR%・売買代金） */
export function passesUniverseGates(params: {
  price: number;
  avgVolume25: number;
  atrPct: number;
  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover?: number;
}): boolean {
  const { price, avgVolume25, atrPct, maxPrice, minAvgVolume25, minAtrPct, minTurnover } = params;

  if (price <= 0) return false;
  if (price > maxPrice) return false;
  if (avgVolume25 < minAvgVolume25) return false;
  if (atrPct < minAtrPct) return false;
  if (minTurnover && price * avgVolume25 < minTurnover) return false;

  return true;
}
