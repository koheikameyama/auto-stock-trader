import { describe, it, expect } from "vitest";
import {
  calculateTrailingStop,
  type TrailingStopInput,
} from "../trailing-stop";

// --- helpers ---

function makeInput(overrides: Partial<TrailingStopInput> = {}): TrailingStopInput {
  return {
    entryPrice: 2000,
    maxHighDuringHold: 2000,
    currentTrailingStop: null,
    originalStopLoss: 1920,   // entry - ATR*1.0
    originalTakeProfit: 2200,
    entryAtr: 80,
    strategy: "breakout",
    ...overrides,
  };
}

// --- tests ---

describe("calculateTrailingStop", () => {
  // ============================================================
  // 未発動
  // ============================================================
  describe("未発動（maxHigh < BE発動価格）", () => {
    it("breakout + ATRあり: maxHighがBE閾値未満 → 固定TP/SLを返す", () => {
      // BE = 2000 + 80*1.0 = 2080
      const result = calculateTrailingStop(
        makeInput({ maxHighDuringHold: 2070 }),
      );
      expect(result.isActivated).toBe(false);
      expect(result.trailingStopPrice).toBeNull();
      expect(result.effectiveStopLoss).toBe(1920);
      expect(result.effectiveTakeProfit).toBe(2200);
      expect(result.beActivationPrice).toBe(2080); // 2000 + 80*1.0
    });

    it("ATR null → %フォールバック（breakout: 2%）", () => {
      // BE = 2000 * 1.02 = 2040
      const result = calculateTrailingStop(
        makeInput({ entryAtr: null, maxHighDuringHold: 2030 }),
      );
      expect(result.isActivated).toBe(false);
      expect(result.beActivationPrice).toBe(2040);
      expect(result.effectiveStopLoss).toBe(1920);
      expect(result.effectiveTakeProfit).toBe(2200);
    });

    it("ちょうどBE閾値 − 1 → 未発動", () => {
      // BE = 2080 (breakout, ATR=80, mult=1.0)
      const result = calculateTrailingStop(
        makeInput({ maxHighDuringHold: 2079 }),
      );
      expect(result.isActivated).toBe(false);
    });
  });

  // ============================================================
  // 発動
  // ============================================================
  describe("発動（maxHigh >= BE発動価格）", () => {
    it("breakout + ATRあり: 正しいトレール幅で算出", () => {
      // BE = 2000 + 80*1.0 = 2080
      // maxHigh = 2200 >= 2080 → 発動
      // trailWidth = 80 * 1.5 = 120
      // raw = 2200 - 120 = 2080
      // ratchet: max(2080, SL=1920, entry=2000) = 2080
      const result = calculateTrailingStop(
        makeInput({ maxHighDuringHold: 2200 }),
      );
      expect(result.isActivated).toBe(true);
      expect(result.trailingStopPrice).toBe(2080);
      expect(result.effectiveStopLoss).toBe(2080);
      expect(result.effectiveTakeProfit).toBeNull(); // TP無効化
    });

    it("ちょうどBE閾値 → 発動", () => {
      // BE = 2080 ぴったり
      // trailWidth = 80 * 1.5 = 120
      // raw = 2080 - 120 = 1960 < entryPrice=2000 → entryPriceまで引き上げ
      const result = calculateTrailingStop(
        makeInput({ maxHighDuringHold: 2080 }),
      );
      expect(result.isActivated).toBe(true);
      expect(result.trailingStopPrice).toBe(2000); // entryPrice（フロア制約）
      expect(result.effectiveTakeProfit).toBeNull();
    });

    it("ATR null + breakout → %フォールバックで発動", () => {
      // BE = 2000 * 1.02 = 2040
      // maxHigh = 2100 >= 2040 → 発動
      // trailWidth = 2100 * 0.02 = 42
      // raw = 2100 - 42 = 2058
      const result = calculateTrailingStop(
        makeInput({ entryAtr: null, maxHighDuringHold: 2100 }),
      );
      expect(result.isActivated).toBe(true);
      expect(result.trailingStopPrice).toBe(2058);
    });
  });

  // ============================================================
  // ラチェット（下がらない）
  // ============================================================
  describe("ラチェット", () => {
    it("currentTrailingStopが高い場合、下がらない", () => {
      // maxHigh=2200 → raw = 2200 - 120 = 2080
      // currentTrailingStop=2150 > 2080 → 2150を維持
      const result = calculateTrailingStop(
        makeInput({ maxHighDuringHold: 2200, currentTrailingStop: 2150 }),
      );
      expect(result.trailingStopPrice).toBe(2150);
    });

    it("新計算が高い場合、切り上がる", () => {
      // maxHigh=2300 → raw = 2300 - 120 = 2180
      // currentTrailingStop=2150 < 2180 → 2180に切り上げ
      const result = calculateTrailingStop(
        makeInput({ maxHighDuringHold: 2300, currentTrailingStop: 2150 }),
      );
      expect(result.trailingStopPrice).toBe(2180);
    });

    it("currentTrailingStop null（初回発動）", () => {
      const result = calculateTrailingStop(
        makeInput({ maxHighDuringHold: 2200, currentTrailingStop: null }),
      );
      expect(result.trailingStopPrice).toBe(2080); // raw = 2200 - 120
    });
  });

  // ============================================================
  // フロア制約
  // ============================================================
  describe("フロア制約", () => {
    it("rawがentryPrice未満 → entryPriceまで引き上げ", () => {
      // maxHigh = 2080 (ギリ発動), trail = 80 → raw = 2000 = entry
      // もっとtrail幅が大きい場合: override trailMultiplier=1.5
      // trailWidth = 80*1.5 = 120, raw = 2080 - 120 = 1960 < entry=2000
      const result = calculateTrailingStop(
        makeInput({ maxHighDuringHold: 2080, trailMultiplierOverride: 1.5 }),
      );
      expect(result.trailingStopPrice).toBe(2000); // entryPrice
    });

    it("rawがoriginalStopLoss未満 → SLまで引き上げ", () => {
      // SLが非常に高い特殊ケース（通常はentryの方が高いが念のため）
      const result = calculateTrailingStop(
        makeInput({
          maxHighDuringHold: 2080,
          trailMultiplierOverride: 1.5,
          originalStopLoss: 2010, // entry=2000より高いSL
        }),
      );
      expect(result.trailingStopPrice).toBe(2010);
    });
  });

  // ============================================================
  // 戦略別パラメータ
  // ============================================================
  describe("戦略別パラメータ", () => {
    it("gapup: BE=ATR*0.3, trail=ATR*0.3（タイトなトレール）", () => {
      // BE = 2000 + 80*0.3 = 2024
      // maxHigh=2100 >= 2024 → 発動
      // trailWidth = 80*0.3 = 24
      // raw = 2100 - 24 = 2076
      const result = calculateTrailingStop(
        makeInput({ strategy: "gapup", maxHighDuringHold: 2100 }),
      );
      expect(result.isActivated).toBe(true);
      expect(result.beActivationPrice).toBe(2024);
      expect(result.trailingStopPrice).toBe(2076);
    });

    it("breakoutとgapupでBE/trail閾値が異なることを確認", () => {
      const breakoutResult = calculateTrailingStop(
        makeInput({ strategy: "breakout", maxHighDuringHold: 2100 }),
      );
      const gapupResult = calculateTrailingStop(
        makeInput({ strategy: "gapup", maxHighDuringHold: 2100 }),
      );
      // breakout BE=2080 vs gapup BE=2024 → 異なる
      expect(breakoutResult.beActivationPrice).not.toBe(gapupResult.beActivationPrice);
    });
  });

  // ============================================================
  // オーバーライド
  // ============================================================
  describe("オーバーライド", () => {
    it("beActivationMultiplierOverride", () => {
      // override BE mult to 0.5 → BE = 2000 + 80*0.5 = 2040
      const result = calculateTrailingStop(
        makeInput({
          maxHighDuringHold: 2050,
          beActivationMultiplierOverride: 0.5,
        }),
      );
      expect(result.isActivated).toBe(true);
      expect(result.beActivationPrice).toBe(2040);
    });

    it("trailMultiplierOverride", () => {
      // override trail mult to 0.5 → trailWidth = 80*0.5 = 40
      // raw = 2200 - 40 = 2160
      const result = calculateTrailingStop(
        makeInput({
          maxHighDuringHold: 2200,
          trailMultiplierOverride: 0.5,
        }),
      );
      expect(result.trailingStopPrice).toBe(2160);
    });
  });

  // ============================================================
  // 9319.Tシナリオ再現
  // ============================================================
  describe("9319.Tシナリオ（ATR null + breakout）", () => {
    it("entry=2148, maxHigh=2232 → trailingStop=2187", () => {
      // BE = 2148 * 1.02 = 2190.96
      // maxHigh 2232 >= 2190.96 → 発動
      // trailWidth = 2232 * 0.02 = 44.64
      // raw = 2232 - 44.64 = 2187.36 → round = 2187
      const result = calculateTrailingStop({
        entryPrice: 2148,
        maxHighDuringHold: 2232,
        currentTrailingStop: null,
        originalStopLoss: 2084,
        originalTakeProfit: 2300,
        entryAtr: null,
        strategy: "breakout",
      });
      expect(result.isActivated).toBe(true);
      expect(result.trailingStopPrice).toBe(2187);
      expect(result.effectiveTakeProfit).toBeNull();
    });
  });
});
