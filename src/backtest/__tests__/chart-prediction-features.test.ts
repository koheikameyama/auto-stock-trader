import { describe, it, expect } from "vitest";
import {
  computeFeaturesAt,
  smaAt,
  PREDICTORS,
  type PredictionFeatures,
} from "../chart-prediction-features";
import type { OHLCVData } from "../../core/technical-analysis";

/** 合成バーを作る（oldest-first）。close 配列から OHLCV を組む */
function makeBars(closes: number[], volume = 1000): OHLCVData[] {
  return closes.map((c, idx) => ({
    date: `2025-01-${String((idx % 28) + 1).padStart(2, "0")}`,
    open: c,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume,
  }));
}

describe("smaAt", () => {
  it("履歴不足なら null", () => {
    const bars = makeBars([1, 2, 3]);
    expect(smaAt(bars, 2, 5)).toBeNull();
  });

  it("正しい単純平均を返す", () => {
    const bars = makeBars([10, 20, 30, 40, 50]);
    expect(smaAt(bars, 4, 5)).toBe(30);
  });
});

describe("computeFeaturesAt — 先読みなし", () => {
  it("index i の特徴量は bars[i+1..] を一切参照しない", () => {
    // 前半上昇、i以降に急落を仕込む。i時点の特徴量が急落に影響されないことを確認
    const closes = Array.from({ length: 80 }, (_, k) => 100 + k); // 単調増加
    const bars = makeBars(closes);
    const i = 70;
    const before = computeFeaturesAt(bars, i);

    // i より後ろを破壊
    for (let k = i + 1; k < bars.length; k++) bars[k].close = 1;
    const after = computeFeaturesAt(bars, i);

    expect(after).toEqual(before);
  });

  it("上昇トレンドでは smaSlope25 / mom が正、rsi>50", () => {
    const closes = Array.from({ length: 80 }, (_, k) => 100 + k * 2);
    const f = computeFeaturesAt(makeBars(closes), 79);
    expect(f.smaSlope25).toBeGreaterThan(0);
    expect(f.mom5!).toBeGreaterThan(0);
    expect(f.mom20!).toBeGreaterThan(0);
    expect(f.rsi14!).toBeGreaterThan(50);
    // 新高値更新中なら high20 ≒ 当日高値なので距離はほぼ0（合成データは high=close×1.01）
    expect(f.distFromHigh20!).toBeGreaterThan(-0.02);
    expect(f.rangePos20!).toBeGreaterThan(0.9); // レンジ上端付近
  });

  it("下降トレンドでは smaSlope25 / mom が負、rsi<50", () => {
    const closes = Array.from({ length: 80 }, (_, k) => 300 - k * 2);
    const f = computeFeaturesAt(makeBars(closes), 79);
    expect(f.smaSlope25).toBeLessThan(0);
    expect(f.mom5!).toBeLessThan(0);
    expect(f.mom20!).toBeLessThan(0);
    expect(f.rsi14!).toBeLessThan(50);
  });

  it("履歴不足の序盤は主要特徴量が null", () => {
    const bars = makeBars([100, 101, 102, 103, 104]);
    const f = computeFeaturesAt(bars, 4);
    expect(f.smaSlope25).toBeNull();
    expect(f.mom20).toBeNull();
    expect(f.rsi14).toBeNull();
  });
});

describe("PREDICTORS", () => {
  const upFeat: PredictionFeatures = {
    smaSlope25: 0.01,
    priceVsSma5: 0.02,
    priceVsSma25: 0.03,
    priceVsSma75: 0.05,
    mom5: 0.02,
    mom20: 0.04,
    atrPct: 0.02,
    volRatio: 1.5,
    rangePos20: 0.9,
    distFromHigh20: -0.01,
    rsi14: 65,
  };

  it("トレンドフォロー系は上昇特徴量で up", () => {
    const byName = Object.fromEntries(PREDICTORS.map((p) => [p.name, p]));
    expect(byName["trend_sma25slope"].predict(upFeat)).toBe("up");
    expect(byName["mom20"].predict(upFeat)).toBe("up");
    expect(byName["rsi_gt50"].predict(upFeat)).toBe("up");
    expect(byName["near_high_breakout"].predict(upFeat)).toBe("up");
  });

  it("逆張り系は上昇特徴量では down（発火条件を満たさない）", () => {
    const byName = Object.fromEntries(PREDICTORS.map((p) => [p.name, p]));
    expect(byName["rsi_oversold_bounce"].predict(upFeat)).toBe("down");
    expect(byName["range_low_reversion"].predict(upFeat)).toBe("down");
  });

  it("特徴量が null なら予測も null", () => {
    const nullFeat = { ...upFeat, smaSlope25: null, rsi14: null };
    const byName = Object.fromEntries(PREDICTORS.map((p) => [p.name, p]));
    expect(byName["trend_sma25slope"].predict(nullFeat)).toBeNull();
    expect(byName["rsi_gt50"].predict(nullFeat)).toBeNull();
  });
});
