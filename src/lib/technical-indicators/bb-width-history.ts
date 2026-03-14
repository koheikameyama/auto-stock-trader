/**
 * BB(20,2σ)幅の直近lookback日パーセンタイルを計算
 * @param prices 終値配列（newest-first）
 * @param period BB期間（デフォルト20）
 * @param lookback パーセンタイル計算期間（デフォルト60）
 * @returns 0-100のパーセンタイル、データ不足時null
 */
export function calculateBBWidthPercentile(
  prices: number[],
  period: number = 20,
  lookback: number = 60,
): number | null {
  const minRequired = period + lookback;
  if (prices.length < minRequired) return null;

  // 現在のBB幅を計算（最新の period 本）
  const currentWindow = prices.slice(0, period);
  const currentMean = currentWindow.reduce((a, b) => a + b, 0) / currentWindow.length;
  const currentVariance = currentWindow.reduce((sum, v) => sum + (v - currentMean) ** 2, 0) / currentWindow.length;
  const currentStd = Math.sqrt(currentVariance);
  const currentWidth = currentStd * 4;

  // lookback日分のBB幅を計算（newest-firstで期間ずつシフト）
  const widths: number[] = [];
  for (let daysAgo = 0; daysAgo < lookback; daysAgo++) {
    const startIdx = daysAgo;
    const endIdx = daysAgo + period;
    if (endIdx > prices.length) break;

    const window = prices.slice(startIdx, endIdx);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    widths.push(std * 4);
  }

  if (widths.length < 2) return null;

  const belowCount = widths.filter((w) => w < currentWidth).length;
  return Math.round((belowCount / (widths.length - 1)) * 100);
}
