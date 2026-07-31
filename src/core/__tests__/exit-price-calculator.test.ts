import { describe, it, expect } from "vitest";
import {
  calculateAtrExitPrices,
  getSlAtrMultiplier,
  recalculateExitPricesOnFill,
} from "../exit-price-calculator";

describe("calculateAtrExitPrices", () => {
  it("SL = 基準価格 - ATR × 倍率、TP = 基準価格 + ATR × 5", () => {
    const r = calculateAtrExitPrices(1000, 20, 0.8);
    expect(r.stopLossPrice).toBe(984); // 1000 - 16
    expect(r.takeProfitPrice).toBe(1100); // 1000 + 100
    expect(r.isClamped).toBe(false);
  });

  it("ATRベースSLが3%を超えたら3%上限でクランプする", () => {
    const r = calculateAtrExitPrices(1000, 100, 0.8);
    expect(r.stopLossPrice).toBe(970); // 1000 * 0.97（ATRベースは920）
    expect(r.rawStopLoss).toBe(920);
    expect(r.isClamped).toBe(true);
  });
});

describe("getSlAtrMultiplier", () => {
  it("ATRベース戦略は倍率を返す", () => {
    expect(getSlAtrMultiplier("gapup")).toBe(0.8);
    expect(getSlAtrMultiplier("post-surge-consolidation")).toBe(0.8);
    expect(getSlAtrMultiplier("weekly-break")).toBe(1.0);
  });

  it("ATRベースでない戦略は null（= 約定時の張り直し対象外）", () => {
    expect(getSlAtrMultiplier("us_etf")).toBeNull();
    expect(getSlAtrMultiplier("panic")).toBeNull();
    expect(getSlAtrMultiplier("buyback")).toBeNull();
  });
});

describe("recalculateExitPricesOnFill", () => {
  describe("ATRベース戦略は約定価格を基準に張り直す", () => {
    it("約定が発注時より下振れた場合（実際の 6349.T 2026-07-30）", () => {
      // 発注時: currentPrice 1939 基準で SL 1915 / TP 2088 を載せた
      // 約定: 1932（-36bps のマイナススリッページ）
      const r = recalculateExitPricesOnFill(1932, 2088, 1915, 29.88, "gapup");

      // 1932 - 29.88 × 0.8 = 1908.096 → 設計どおりの ATR×0.8 幅に戻る
      expect(r.stopLossPrice).toBe(1908);
      expect(r.takeProfitPrice).toBe(2081); // 1932 + 29.88 × 5
    });

    it("約定が発注時より上振れた場合も張り直す", () => {
      // 発注時 1000 基準の SL 984 を、約定 1010 基準へ
      const r = recalculateExitPricesOnFill(1010, 1100, 984, 20, "gapup");
      expect(r.stopLossPrice).toBe(994); // 1010 - 16
    });

    it("戦略ごとの ATR 倍率を使う（gapup 0.8 / weekly-break 1.0）", () => {
      const gu = recalculateExitPricesOnFill(1000, 1100, 990, 20, "gapup");
      const wb = recalculateExitPricesOnFill(1000, 1100, 990, 20, "weekly-break");
      expect(gu.stopLossPrice).toBe(984);
      expect(wb.stopLossPrice).toBe(980);
    });

    it("張り直した結果が3%を超えるなら上限でクランプする", () => {
      const r = recalculateExitPricesOnFill(1000, 1100, 990, 100, "post-surge-consolidation");
      expect(r.stopLossPrice).toBe(970);
    });

    it("ATR不明なら張り直せないので注文のSLを維持する", () => {
      const r = recalculateExitPricesOnFill(1000, 1100, 990, null, "gapup");
      expect(r.stopLossPrice).toBe(990);
    });
  });

  describe("対象外の戦略は注文のSLをそのまま使う", () => {
    it("固定SL戦略(panic)の -12% を ATR で上書きしない", () => {
      const r = recalculateExitPricesOnFill(1000, 1200, 880, 30, "panic");
      expect(r.stopLossPrice).toBe(880);
    });

    it("us_etf は ATRベースでないので張り直さない", () => {
      // ATR×0.8 で張り直すと 976 になるが、固定 -2% の 980 が維持されること
      const r = recalculateExitPricesOnFill(1000, 1050, 980, 30, "us_etf");
      expect(r.stopLossPrice).toBe(980);
    });
  });
});
