import { describe, it, expect } from "vitest";
import {
  detectPanicSignal,
  computeNikkeiDownStreak,
  PANIC_SIGNAL_DEFAULTS,
} from "../entry-conditions";

/** 発火する既定の入力（各テストで1脚だけ崩す） */
function makeInput(overrides?: Partial<Parameters<typeof detectPanicSignal>[0]>) {
  return {
    prevVixClose: 30,
    breadth: 0.3,
    nikkeiDownStreak: 3,
    prevDayConditionsMet: false,
    ...overrides,
  };
}

describe("detectPanicSignal", () => {
  it("3条件が揃い前営業日が非該当なら発火する", () => {
    const r = detectPanicSignal(makeInput());
    expect(r.conditionsMet).toBe(true);
    expect(r.isEpisodeFirstDay).toBe(true);
    expect(r.triggered).toBe(true);
    expect(r.rejectReasons).toEqual([]);
  });

  describe("VIX（排他: > 25）", () => {
    it("ちょうど 25 は不発", () => {
      expect(detectPanicSignal(makeInput({ prevVixClose: 25 })).triggered).toBe(false);
    });
    it("25.1 は発火", () => {
      expect(detectPanicSignal(makeInput({ prevVixClose: 25.1 })).triggered).toBe(true);
    });
  });

  describe("breadth（排他: < 40%）", () => {
    it("ちょうど 40% は不発", () => {
      expect(detectPanicSignal(makeInput({ breadth: 0.4 })).triggered).toBe(false);
    });
    it("39.9% は発火", () => {
      expect(detectPanicSignal(makeInput({ breadth: 0.399 })).triggered).toBe(true);
    });
  });

  describe("N225連続下落（>= 3）", () => {
    it("2日は不発", () => {
      expect(detectPanicSignal(makeInput({ nikkeiDownStreak: 2 })).triggered).toBe(false);
    });
    it("3日は発火", () => {
      expect(detectPanicSignal(makeInput({ nikkeiDownStreak: 3 })).triggered).toBe(true);
    });
    it("5日も発火（下限のみ）", () => {
      expect(detectPanicSignal(makeInput({ nikkeiDownStreak: 5 })).triggered).toBe(true);
    });
  });

  describe("エピソード初日のみ", () => {
    it("前営業日も該当していたら conditionsMet でも発注しない", () => {
      const r = detectPanicSignal(makeInput({ prevDayConditionsMet: true }));
      expect(r.conditionsMet).toBe(true);
      expect(r.isEpisodeFirstDay).toBe(false);
      expect(r.triggered).toBe(false);
      expect(r.rejectReasons.join()).toContain("エピソード継続日");
    });
  });

  describe("データ欠損では発火しない（stale/NaN で -12% を張らない）", () => {
    it.each([
      ["VIX が NaN", { prevVixClose: NaN }],
      ["breadth が NaN", { breadth: NaN }],
      ["streak が NaN", { nikkeiDownStreak: NaN }],
      ["VIX が Infinity", { prevVixClose: Infinity }],
    ])("%s → 不発", (_label, override) => {
      expect(detectPanicSignal(makeInput(override)).triggered).toBe(false);
    });
  });

  it("不発理由が全脚ぶん列挙される", () => {
    const r = detectPanicSignal(makeInput({ prevVixClose: 10, breadth: 0.8, nikkeiDownStreak: 0 }));
    expect(r.rejectReasons).toHaveLength(3);
  });

  it("既定パラメータが PANIC 定数と一致している", () => {
    expect(PANIC_SIGNAL_DEFAULTS).toEqual({ vixMin: 25, breadthMax: 0.4, minDownStreak: 3 });
  });
});

describe("computeNikkeiDownStreak", () => {
  // BT (scripts/_gen-panic-events.ts:76-82) と同じ `cur < prev` 定義
  it("単調下落は本数を数える", () => {
    expect(computeNikkeiDownStreak([100, 99, 98, 97])).toBe(3);
  });

  it("末尾で終わる連続下落だけを数える（途中の上昇でリセット）", () => {
    expect(computeNikkeiDownStreak([100, 101, 100, 99])).toBe(2);
  });

  it("横ばい（cur === prev）は 0 にリセットする（BT の定義）", () => {
    expect(computeNikkeiDownStreak([100, 99, 99, 98])).toBe(1);
  });

  it("最終日が上昇なら 0", () => {
    expect(computeNikkeiDownStreak([100, 99, 98, 99])).toBe(0);
  });

  it("本数不足でも落ちない", () => {
    expect(computeNikkeiDownStreak([])).toBe(0);
    expect(computeNikkeiDownStreak([100])).toBe(0);
  });

  it("窓の外まで続く下落は窓の長さで頭打ちになる（実運用では十分な窓を渡す）", () => {
    expect(computeNikkeiDownStreak([100, 99, 98])).toBe(2);
  });
});
