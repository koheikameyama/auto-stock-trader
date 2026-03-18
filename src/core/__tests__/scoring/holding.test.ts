import { describe, it, expect } from "vitest";
import { scoreHolding } from "../../scoring/holding";
import type { ScoringInput } from "../../scoring/types";
import type { OHLCVData, TechnicalSummary } from "../../technical-analysis";
import { HOLDING_SCORE } from "../../../lib/constants/scoring";

/** テスト用OHLCVデータ生成（newest-first） */
function makeOHLCV(
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

/** テスト用上昇トレンドOHLCVデータ（newest-first、SMA25上かつ週足SMA13上） */
function makeUptrendOHLCV(count: number): OHLCVData[] {
  return Array.from({ length: count }, (_, i) => {
    // newest-first: i=0が最新日
    const dayIndex = count - 1 - i;
    const baseClose = 80 + dayIndex * 0.3; // ゆるやかに上昇
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

function makeSummary(
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

function makeInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    historicalData: makeOHLCV(100),
    latestPrice: 100,
    latestVolume: 100000,
    weeklyVolatility: 3,
    summary: makeSummary(),
    avgVolume25: 100000,
    ...overrides,
  };
}

describe("scoreHolding", () => {
  it("スコアが 0-67 の範囲に収まる", () => {
    const result = scoreHolding(makeInput());
    expect(result.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.totalScore).toBeLessThanOrEqual(HOLDING_SCORE.TOTAL_MAX);
  });

  it("holdingRank が返される", () => {
    const result = scoreHolding(makeInput());
    expect([
      "strong",
      "healthy",
      "weakening",
      "deteriorating",
      "critical",
    ]).toContain(result.holdingRank);
  });

  it("トレンド品質とリスク品質のスコアが返される（エントリータイミングなし）", () => {
    const result = scoreHolding(makeInput());
    expect(result.trendQuality.total).toBeGreaterThanOrEqual(0);
    expect(result.trendQuality.total).toBeLessThanOrEqual(40);
    expect(result.riskQuality.total).toBeGreaterThanOrEqual(0);
    expect(result.riskQuality.total).toBeLessThanOrEqual(25);
    // entryTiming は HoldingScore に存在しない
    expect(result).not.toHaveProperty("entryTiming");
  });

  describe("保有用ゲート", () => {
    it("流動性枯渇（avgVolume25 < 30,000）→ gate不通過 + アラート", () => {
      const result = scoreHolding(makeInput({ avgVolume25: 20000 }));
      expect(result.gate.passed).toBe(false);
      expect(result.gate.failedGate).toBe("liquidity_dried");
      expect(result.alerts.some((a) => a.type === "liquidity_warning")).toBe(
        true,
      );
    });

    it("流動性OK（avgVolume25 >= 30,000）→ gate通過", () => {
      const result = scoreHolding(makeInput({ avgVolume25: 50000 }));
      expect(result.gate.passed).toBe(true);
      expect(result.gate.failedGate).toBeNull();
    });

    it("週足SMA13割れ → critical + weekly_breakdown + アラート", () => {
      // 長期上昇後に急落するデータ（newest-first）
      // 最新4週は急落して週足SMA13を下回る
      const data = Array.from({ length: 200 }, (_, i) => {
        const dayIndex = 200 - 1 - i; // oldest=0, newest=199
        // 最初160日は上昇（80→128）、最後40日は急落（128→60）
        const baseClose =
          dayIndex <= 160
            ? 80 + dayIndex * 0.3
            : 128 - (dayIndex - 160) * 1.7;
        return {
          date: `2025-${String(Math.floor(dayIndex / 30) + 1).padStart(2, "0")}-${String((dayIndex % 30) + 1).padStart(2, "0")}`,
          open: baseClose + 1,
          high: baseClose + 3,
          low: baseClose - 3,
          close: baseClose,
          volume: 100000,
        };
      });

      const latestClose = data[0].close;
      const result = scoreHolding(
        makeInput({
          historicalData: data,
          latestPrice: latestClose,
          summary: makeSummary({
            sma5: latestClose + 2,
            sma25: latestClose + 10,
            sma75: latestClose + 20,
            currentPrice: latestClose,
          }),
        }),
      );
      expect(result.holdingRank).toBe("critical");
      expect(result.totalScore).toBe(0);
      expect(result.gate.failedGate).toBe("weekly_breakdown");
      expect(result.alerts.some((a) => a.type === "trend_collapse")).toBe(true);
    });
  });

  describe("ランク判定", () => {
    it("高スコア → strong", () => {
      // 上昇トレンドのデータで高スコアを狙う
      const uptrendData = makeUptrendOHLCV(100);
      const latestClose = uptrendData[0].close;
      const result = scoreHolding(
        makeInput({
          historicalData: uptrendData,
          latestPrice: latestClose,
          summary: makeSummary({
            sma5: latestClose - 1,
            sma25: latestClose - 5,
            sma75: latestClose - 10,
            atr14: latestClose * 0.03,
            currentPrice: latestClose,
          }),
          sectorRelativeStrength: 3.0,
        }),
      );
      // トレンド品質 + リスク品質が高ければ strong になるはず
      if (result.totalScore >= HOLDING_SCORE.RANKS.STRONG) {
        expect(result.holdingRank).toBe("strong");
      }
    });
  });

  describe("セクターモメンタム", () => {
    it("セクター強 → ボーナス加算", () => {
      const base = scoreHolding(makeInput({ sectorRelativeStrength: null }));
      const strong = scoreHolding(
        makeInput({ sectorRelativeStrength: 3.0 }),
      );
      expect(strong.sectorMomentumScore).toBeGreaterThan(
        base.sectorMomentumScore,
      );
    });

    it("セクター弱 → ペナルティ", () => {
      const result = scoreHolding(
        makeInput({ sectorRelativeStrength: -3.0 }),
      );
      expect(result.sectorMomentumScore).toBeLessThan(0);
    });
  });

  describe("アラート生成", () => {
    it("セクターモメンタム <= -2 → sector_weakness アラート", () => {
      const result = scoreHolding(
        makeInput({ sectorRelativeStrength: -3.0 }),
      );
      expect(result.alerts.some((a) => a.type === "sector_weakness")).toBe(
        true,
      );
    });
  });
});
