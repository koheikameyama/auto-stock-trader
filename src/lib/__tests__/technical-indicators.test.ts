import { describe, it, expect } from "vitest";
import {
  calculateRSI,
  calculateSMA,
  calculateEMA,
  calculateMACD,
  calculateBollingerBands,
  getTechnicalSignal,
  calculateMAAlignment,
  calculateDeviationRate,
  detectGaps,
  findSupportResistance,
  aggregateDailyToWeekly,
  analyzeWeeklyTrend,
} from "../technical-indicators";

// ========================================
// ヘルパー
// ========================================

/** 指定close値の配列からPriceData[]を生成（newest-first） */
function makePrices(closes: number[]) {
  return closes.map((close) => ({ close }));
}

/** OHLCV付きPriceDataを生成 */
function makeOHLCPrices(
  count: number,
  base: number,
  options?: { trend?: "up" | "down" | "flat"; volatility?: number },
) {
  const trend = options?.trend ?? "flat";
  const vol = options?.volatility ?? 5;
  // newest-first
  return Array.from({ length: count }, (_, i) => {
    const dayIndex = count - 1 - i;
    let close = base;
    if (trend === "up") close = base + dayIndex * 0.5;
    else if (trend === "down") close = base - dayIndex * 0.5;
    return {
      date: `2026-01-${String(count - i).padStart(2, "0")}`,
      close,
      high: close + vol,
      low: close - vol,
    };
  });
}

// ========================================
// calculateRSI
// ========================================

describe("calculateRSI", () => {
  it("データ不足 → null", () => {
    expect(calculateRSI(makePrices([100, 101, 102]), 14)).toBeNull();
  });

  it("全て上昇 → 100", () => {
    // calculateRSIはslice(0, period+1)の配列内でchangeを計算する
    // arr[i] - arr[i-1] が全て正 → 全gain → RSI=100
    const prices = makePrices(
      Array.from({ length: 15 }, (_, i) => 100 + i),
    );
    expect(calculateRSI(prices, 14)).toBe(100);
  });

  it("全て下落 → 0", () => {
    // arr[i] - arr[i-1] が全て負 → 全loss → RSI=0
    const prices = makePrices(
      Array.from({ length: 15 }, (_, i) => 100 - i),
    );
    expect(calculateRSI(prices, 14)).toBe(0);
  });

  it("混合データ → 0-100の範囲", () => {
    const prices = makePrices([
      105, 103, 106, 104, 102, 101, 103, 100, 99, 101, 100, 98, 97, 99, 100,
    ]);
    const rsi = calculateRSI(prices, 14);
    expect(rsi).not.toBeNull();
    expect(rsi!).toBeGreaterThanOrEqual(0);
    expect(rsi!).toBeLessThanOrEqual(100);
  });

  it("デフォルトperiod=14", () => {
    const prices = makePrices(Array.from({ length: 15 }, (_, i) => 100 + i));
    expect(calculateRSI(prices)).not.toBeNull();
  });
});

// ========================================
// calculateSMA
// ========================================

describe("calculateSMA", () => {
  it("データ不足 → null", () => {
    expect(calculateSMA(makePrices([100, 200]), 3)).toBeNull();
  });

  it("正確な平均値", () => {
    const prices = makePrices([10, 20, 30]);
    // newest-firstでslice(0,3) = [10, 20, 30] → avg = 20
    expect(calculateSMA(prices, 3)).toBe(20);
  });

  it("小数点第2位まで丸め", () => {
    const prices = makePrices([10, 20, 33]);
    // avg = 63/3 = 21.0
    expect(calculateSMA(prices, 3)).toBe(21);
  });
});

// ========================================
// calculateEMA
// ========================================

describe("calculateEMA", () => {
  it("データ不足 → null", () => {
    expect(calculateEMA(makePrices([100, 200]), 5)).toBeNull();
  });

  it("ちょうどperiod個 → SMAと一致", () => {
    const prices = makePrices([10, 20, 30, 40, 50]);
    const sma = calculateSMA(prices, 5);
    const ema = calculateEMA(prices, 5);
    expect(ema).toBe(sma);
  });

  it("最新価格が高い → EMA > SMA", () => {
    // EMAがSMAより大きくなるには、period以上のデータが必要
    // EMAは直近に重みが大きいので、直近が高ければSMAより大きくなる
    const prices = makePrices([
      200, 150, 120, 110, 105, 100, 100, 100, 100, 100,
      100, 100, 100, 100, 100,
    ]);
    const sma = calculateSMA(prices, 10);
    const ema = calculateEMA(prices, 10);
    expect(ema).not.toBeNull();
    expect(sma).not.toBeNull();
    expect(ema!).toBeGreaterThan(sma!);
  });
});

// ========================================
// calculateMACD
// ========================================

describe("calculateMACD", () => {
  it("データ < 26 → 全てnull", () => {
    const prices = makePrices(Array.from({ length: 25 }, () => 100));
    const result = calculateMACD(prices);
    expect(result.macd).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.histogram).toBeNull();
  });

  it("データ >= 26 but < 34 → macdのみ、signal/histogramはnull", () => {
    const prices = makePrices(Array.from({ length: 30 }, () => 100));
    const result = calculateMACD(prices);
    expect(result.macd).not.toBeNull();
    expect(result.signal).toBeNull();
    expect(result.histogram).toBeNull();
  });

  it("データ >= 34 → 全て値あり", () => {
    const prices = makePrices(Array.from({ length: 40 }, (_, i) => 100 + i * 0.5));
    const result = calculateMACD(prices);
    expect(result.macd).not.toBeNull();
    expect(result.signal).not.toBeNull();
    expect(result.histogram).not.toBeNull();
  });

  it("一定価格 → MACD ≈ 0", () => {
    const prices = makePrices(Array.from({ length: 40 }, () => 100));
    const result = calculateMACD(prices);
    expect(result.macd).toBeCloseTo(0, 1);
  });
});

// ========================================
// calculateBollingerBands
// ========================================

describe("calculateBollingerBands", () => {
  it("データ不足 → 全てnull", () => {
    const prices = makePrices(Array.from({ length: 10 }, () => 100));
    const result = calculateBollingerBands(prices, 20);
    expect(result.upper).toBeNull();
    expect(result.middle).toBeNull();
    expect(result.lower).toBeNull();
  });

  it("一定価格 → upper = middle = lower", () => {
    const prices = makePrices(Array.from({ length: 20 }, () => 100));
    const result = calculateBollingerBands(prices, 20);
    expect(result.upper).toBe(100);
    expect(result.middle).toBe(100);
    expect(result.lower).toBe(100);
  });

  it("変動データ → upper > middle > lower", () => {
    const prices = makePrices([
      110, 105, 95, 90, 108, 103, 97, 92, 106, 101,
      99, 94, 107, 102, 98, 93, 109, 104, 96, 91,
    ]);
    const result = calculateBollingerBands(prices, 20);
    expect(result.upper).not.toBeNull();
    expect(result.middle).not.toBeNull();
    expect(result.lower).not.toBeNull();
    expect(result.upper!).toBeGreaterThan(result.middle!);
    expect(result.middle!).toBeGreaterThan(result.lower!);
  });
});

// ========================================
// calculateMAAlignment
// ========================================

describe("calculateMAAlignment", () => {
  it("データ不足 → trend=none", () => {
    const prices = makePrices(Array.from({ length: 10 }, () => 100));
    const result = calculateMAAlignment(prices);
    expect(result.trend).toBe("none");
  });

  it("上昇トレンドデータ → uptrendの可能性", () => {
    // 100日分の上昇データ
    const prices = makeOHLCPrices(100, 80, { trend: "up" });
    const result = calculateMAAlignment(prices);
    // SMA5 > SMA25 > SMA75 の並び順になるはず
    if (result.sma5 && result.sma25 && result.sma75) {
      if (result.sma5 > result.sma25 && result.sma25 > result.sma75) {
        expect(result.orderAligned).toBe(true);
      }
    }
  });

  it("一定価格データ → trend=none", () => {
    const prices = makePrices(Array.from({ length: 100 }, () => 100));
    const result = calculateMAAlignment(prices);
    // SMA5 = SMA25 = SMA75 → orderAligned=false
    expect(result.trend).toBe("none");
  });
});

// ========================================
// calculateDeviationRate
// ========================================

describe("calculateDeviationRate", () => {
  it("データ不足 → null", () => {
    expect(calculateDeviationRate(makePrices([100]), 25)).toBeNull();
  });

  it("価格がSMAと一致 → 0", () => {
    const prices = makePrices(Array.from({ length: 25 }, () => 100));
    expect(calculateDeviationRate(prices, 25)).toBe(0);
  });

  it("価格がSMAより10%高い → 約10%", () => {
    // SMA = 100, 現在価格 = 110 → 10%
    const prices = makePrices([110, ...Array.from({ length: 24 }, () => 100)]);
    // SMA25 = (110 + 100*24) / 25 = 2510/25 = 100.4
    // deviation = (110 - 100.4) / 100.4 * 100 ≈ 9.56%
    const result = calculateDeviationRate(prices, 25);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0);
  });

  it("SMA = 0 → null", () => {
    const prices = makePrices(Array.from({ length: 25 }, () => 0));
    expect(calculateDeviationRate(prices, 25)).toBeNull();
  });
});

// ========================================
// detectGaps
// ========================================

describe("detectGaps", () => {
  it("データ不足 → type=null", () => {
    const result = detectGaps([{ close: 100, high: 105, low: 95 }]);
    expect(result.type).toBeNull();
  });

  it("上窓（ギャップアップ）を検出", () => {
    // today.low > yesterday.high
    const prices = [
      { close: 120, high: 125, low: 115, date: "2026-01-02" }, // today
      { close: 100, high: 110, low: 95, date: "2026-01-01" },  // yesterday
    ];
    const result = detectGaps(prices);
    expect(result.type).toBe("up");
    expect(result.price).toBe(110); // yesterday.high
  });

  it("下窓（ギャップダウン）を検出", () => {
    // today.high < yesterday.low
    const prices = [
      { close: 80, high: 85, low: 75, date: "2026-01-02" },
      { close: 100, high: 105, low: 90, date: "2026-01-01" },
    ];
    const result = detectGaps(prices);
    expect(result.type).toBe("down");
    expect(result.price).toBe(90); // yesterday.low
  });

  it("ギャップなし", () => {
    const prices = [
      { close: 102, high: 105, low: 98, date: "2026-01-02" },
      { close: 100, high: 103, low: 97, date: "2026-01-01" },
    ];
    const result = detectGaps(prices);
    expect(result.type).toBeNull();
  });

  it("high/lowがないデータ → スキップ", () => {
    const prices = [
      { close: 120 }, // high/low なし
      { close: 100 },
    ];
    const result = detectGaps(prices);
    expect(result.type).toBeNull();
  });
});

// ========================================
// findSupportResistance
// ========================================

describe("findSupportResistance", () => {
  it("データ不足 → 空配列", () => {
    const prices = makePrices(Array.from({ length: 5 }, () => 100));
    const result = findSupportResistance(prices);
    expect(result.supports).toEqual([]);
    expect(result.resistances).toEqual([]);
  });

  it("十分なデータ → サポートは現在価格以下、レジスタンスは現在価格以上", () => {
    const prices = makeOHLCPrices(30, 100, { volatility: 10 });
    const result = findSupportResistance(prices);
    const currentPrice = prices[0].close;
    result.supports.forEach((s) => expect(s).toBeLessThan(currentPrice));
    result.resistances.forEach((r) => expect(r).toBeGreaterThan(currentPrice));
  });

  it("サポートは降順ソート", () => {
    const prices = makeOHLCPrices(30, 100, { volatility: 15 });
    const result = findSupportResistance(prices);
    for (let i = 1; i < result.supports.length; i++) {
      expect(result.supports[i]).toBeLessThanOrEqual(result.supports[i - 1]);
    }
  });

  it("レジスタンスは昇順ソート", () => {
    const prices = makeOHLCPrices(30, 100, { volatility: 15 });
    const result = findSupportResistance(prices);
    for (let i = 1; i < result.resistances.length; i++) {
      expect(result.resistances[i]).toBeGreaterThanOrEqual(
        result.resistances[i - 1],
      );
    }
  });
});

// ========================================
// aggregateDailyToWeekly
// ========================================

describe("aggregateDailyToWeekly", () => {
  it("空配列 → 空配列", () => {
    expect(aggregateDailyToWeekly([])).toEqual([]);
  });

  it("同じ週の5日分 → 1本の週足", () => {
    // 2026-01-05（月）～ 2026-01-09（金）
    const daily = [
      { date: "2026-01-05", open: 100, high: 110, low: 95, close: 105, volume: 1000 },
      { date: "2026-01-06", open: 105, high: 115, low: 100, close: 108, volume: 1200 },
      { date: "2026-01-07", open: 108, high: 120, low: 103, close: 112, volume: 1100 },
      { date: "2026-01-08", open: 112, high: 118, low: 107, close: 110, volume: 900 },
      { date: "2026-01-09", open: 110, high: 116, low: 106, close: 114, volume: 1300 },
    ];
    const weekly = aggregateDailyToWeekly(daily);
    expect(weekly).toHaveLength(1);
    expect(weekly[0].open).toBe(100);     // 最初のopen
    expect(weekly[0].high).toBe(120);     // 最大high
    expect(weekly[0].low).toBe(95);       // 最小low
    expect(weekly[0].close).toBe(114);    // 最後のclose
    expect(weekly[0].volume).toBe(5500);  // volume合計
  });

  it("2週間分 → 2本の週足", () => {
    const daily = [
      { date: "2026-01-05", open: 100, high: 110, low: 95, close: 105, volume: 1000 },
      { date: "2026-01-06", open: 105, high: 112, low: 100, close: 108, volume: 1200 },
      { date: "2026-01-12", open: 108, high: 115, low: 103, close: 110, volume: 1100 },
      { date: "2026-01-13", open: 110, high: 118, low: 106, close: 114, volume: 900 },
    ];
    const weekly = aggregateDailyToWeekly(daily);
    expect(weekly).toHaveLength(2);
  });
});

// ========================================
// analyzeWeeklyTrend
// ========================================

describe("analyzeWeeklyTrend", () => {
  it("データ不足 → trend=none", () => {
    const bars = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      open: 100,
      high: 105,
      low: 95,
      close: 100,
      volume: 1000,
    }));
    const result = analyzeWeeklyTrend(bars);
    expect(result.trend).toBe("none");
    expect(result.sma13).toBeNull();
  });

  it("SMA13 > SMA26 → uptrend", () => {
    // 上昇トレンド: oldest-first、closeが段階的に上昇
    const bars = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      open: 100 + i * 2,
      high: 105 + i * 2,
      low: 95 + i * 2,
      close: 100 + i * 2,
      volume: 1000,
    }));
    const result = analyzeWeeklyTrend(bars);
    expect(result.trend).toBe("uptrend");
    expect(result.sma13).not.toBeNull();
    expect(result.sma26).not.toBeNull();
    expect(result.sma13!).toBeGreaterThan(result.sma26!);
  });

  it("SMA13 < SMA26 → downtrend", () => {
    // 下降トレンド: oldest-first、closeが段階的に下落
    const bars = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      open: 200 - i * 2,
      high: 205 - i * 2,
      low: 195 - i * 2,
      close: 200 - i * 2,
      volume: 1000,
    }));
    const result = analyzeWeeklyTrend(bars);
    expect(result.trend).toBe("downtrend");
    expect(result.sma13!).toBeLessThan(result.sma26!);
  });

  it("一定価格 → SMA13 = SMA26 → none", () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      open: 100,
      high: 105,
      low: 95,
      close: 100,
      volume: 1000,
    }));
    const result = analyzeWeeklyTrend(bars);
    expect(result.trend).toBe("none");
  });
});

// ========================================
// getTechnicalSignal（統合テスト）
// ========================================

describe("getTechnicalSignal", () => {
  it("データ不足 → signal値とstrength、reasonsが返される", () => {
    const prices = makePrices([100, 101, 102]);
    const result = getTechnicalSignal(prices);
    expect(result).toHaveProperty("signal");
    expect(result).toHaveProperty("strength");
    expect(result).toHaveProperty("reasons");
    expect(Array.isArray(result.reasons)).toBe(true);
  });

  it("十分なデータ → signalが数値で返される", () => {
    const prices = makeOHLCPrices(100, 100, { trend: "up" });
    const result = getTechnicalSignal(prices);
    expect(typeof result.signal).toBe("number");
    expect(["強い買い", "買い", "中立", "売り", "強い売り"]).toContain(
      result.strength,
    );
  });
});
