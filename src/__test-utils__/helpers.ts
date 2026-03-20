import type { OHLCVData, TechnicalSummary } from "../core/technical-analysis";

/** テスト用OHLCVデータ生成（newest-first） */
export function makeOHLCV(
  count: number,
  close = 100,
  options: { volume?: number } = {},
): OHLCVData[] {
  const volume = options.volume ?? 100000;
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-01-${String(count - i).padStart(2, "0")}`,
    open: close,
    high: close + 5,
    low: close - 5,
    close,
    volume,
  }));
}

/** テスト用上昇トレンドOHLCVデータ（newest-first） */
export function makeUptrendOHLCV(count: number): OHLCVData[] {
  return Array.from({ length: count }, (_, i) => {
    const dayIndex = count - 1 - i;
    const baseClose = 80 + dayIndex * 0.3;
    return {
      date: `2026-01-${String(count - i).padStart(2, "0")}`,
      open: baseClose - 1,
      high: baseClose + 3,
      low: baseClose - 3,
      close: baseClose,
      volume: 100000,
    };
  });
}

/** テスト用下降トレンドOHLCVデータ（newest-first） */
export function makeDowntrendOHLCV(count: number): OHLCVData[] {
  return Array.from({ length: count }, (_, i) => {
    const dayIndex = count - 1 - i;
    const baseClose = 120 - dayIndex * 0.3;
    return {
      date: `2026-01-${String(count - i).padStart(2, "0")}`,
      open: baseClose + 1,
      high: baseClose + 3,
      low: baseClose - 3,
      close: baseClose,
      volume: 100000,
    };
  });
}

/** テスト用TechnicalSummaryデフォルト値付き生成 */
export function makeSummary(
  overrides: Partial<TechnicalSummary> = {},
): TechnicalSummary {
  return {
    rsi: 55,
    sma5: 102,
    sma25: 98,
    sma75: 95,
    ema12: 100,
    ema26: 98,
    macd: { macd: 0.5, signal: 0.3, histogram: 0.2 },
    bollingerBands: { upper: 110, middle: 100, lower: 90 },
    atr14: 2,
    maAlignment: {
      trend: "uptrend",
      orderAligned: true,
      slopesAligned: true,
    },
    deviationRate25: 1.5,
    signal: { signal: 1, strength: "buy", reasons: [] },
    supports: [],
    resistances: [],
    gap: { type: null, price: null, isFilled: false },
    trendlines: {
      support: null,
      resistance: null,
      overallTrend: "uptrend",
    },
    volumeAnalysis: {
      avgVolume20: 100000,
      currentVolume: 120000,
      volumeRatio: 1.2,
    },
    currentPrice: 100,
    previousClose: 99,
    ...overrides,
  };
}
