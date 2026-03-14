import { describe, it, expect } from "vitest";
import {
  scoreMaAlignment,
  scoreWeeklyTrend,
  scoreTrendContinuity,
  countDaysAboveSma25,
} from "../../scoring/trend-quality";
import type { OHLCVData } from "../../technical-analysis";

describe("scoreMaAlignment", () => {
  it("完全パーフェクトオーダー(close>SMA5>SMA25>SMA75) → 18", () => {
    expect(scoreMaAlignment(100, 98, 95, 90)).toBe(18);
  });

  it("SMA75下(close>SMA5>SMA25, SMA25<SMA75) → 14", () => {
    expect(scoreMaAlignment(100, 98, 95, 97)).toBe(14);
  });

  it("SMA5割れ(close>SMA25, close<SMA5) → 8", () => {
    expect(scoreMaAlignment(96, 98, 95, 90)).toBe(8);
  });

  it("SMA25上だが配列崩れ → 4", () => {
    expect(scoreMaAlignment(96, 90, 95, 98)).toBe(4);
  });

  it("SMA25下 → 0", () => {
    expect(scoreMaAlignment(90, 95, 96, 100)).toBe(0);
  });

  it("SMA75=null(データ不足) → SMA25のみで評価、最大14", () => {
    expect(scoreMaAlignment(100, 98, 95, null)).toBe(14);
  });
});

describe("scoreWeeklyTrend", () => {
  it("SMA13上 & 上向き → 12", () => {
    expect(scoreWeeklyTrend(100, 95, 93)).toBe(12);
  });

  it("SMA13上 & 横ばい → 8", () => {
    expect(scoreWeeklyTrend(100, 95, 95)).toBe(8);
  });

  it("SMA13下 & 上向き → 4", () => {
    expect(scoreWeeklyTrend(90, 95, 93)).toBe(4);
  });

  it("SMA13下 & 下向き → 0", () => {
    expect(scoreWeeklyTrend(90, 95, 97)).toBe(0);
  });

  it("データ不足(null) → 0", () => {
    expect(scoreWeeklyTrend(100, null, null)).toBe(0);
  });
});

describe("scoreTrendContinuity", () => {
  it("10-30日連続 → 10", () => {
    expect(scoreTrendContinuity(20)).toBe(10);
  });

  it("5-9日 → 7", () => {
    expect(scoreTrendContinuity(7)).toBe(7);
  });

  it("31-50日 → 5", () => {
    expect(scoreTrendContinuity(40)).toBe(5);
  });

  it("50日超 → 2", () => {
    expect(scoreTrendContinuity(60)).toBe(2);
  });

  it("0日(SMA25下) → 0", () => {
    expect(scoreTrendContinuity(0)).toBe(0);
  });
});

describe("countDaysAboveSma25", () => {
  function makeBar(close: number, date: string = "2026-01-01"): OHLCVData {
    return { date, open: close, high: close + 1, low: close - 1, close, volume: 10000 };
  }

  it("データ不足(25日未満) → 0", () => {
    const data = Array.from({ length: 20 }, () => makeBar(100));
    expect(countDaysAboveSma25(data)).toBe(0);
  });

  it("全日SMA25上 → 全日数カウント", () => {
    // newest-first, 上昇トレンド: 最新=200, 最古=100
    const data = Array.from({ length: 50 }, (_, i) => makeBar(200 - i));
    // 各日のclose(200,199,...151)はSMA25(各日の25日窓の平均)より上のはず
    const count = countDaysAboveSma25(data);
    expect(count).toBeGreaterThan(0);
  });
});
