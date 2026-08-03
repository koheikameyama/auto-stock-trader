import { describe, it, expect } from "vitest";

import { checkGates } from "../filters";
import { SCORING } from "../../../lib/constants/scoring";
import { GAPUP } from "../../../lib/constants/gapup";
import { POST_SURGE_CONSOLIDATION } from "../../../lib/constants/post-surge-consolidation";

/** 流動性以外は必ず通る入力（¥1,000 × 100,000株 = 売買代金 ¥100M で MIN_TURNOVER ちょうど） */
function baseInput(overrides: Partial<Parameters<typeof checkGates>[0]> = {}) {
  return {
    latestPrice: 1_000,
    avgVolume25: 200_000,
    atrPct: 3,
    nextEarningsDate: null,
    recentEarningsDate: null,
    exDividendDate: null,
    today: new Date("2026-08-03T00:00:00Z"),
    maxPrice: 2_500,
    ...overrides,
  };
}

describe("checkGates の流動性ゲート", () => {
  it("minAvgVolume25 未指定なら従来どおり SCORING.GATES.MIN_AVG_VOLUME_25 を使う", () => {
    const justUnder = SCORING.GATES.MIN_AVG_VOLUME_25 - 1;
    // 汎用値(50,000)を下回るので落ちる
    expect(checkGates(baseInput({ avgVolume25: justUnder })).reason).toBe("volume");
    // 汎用値ちょうどは通る（売買代金も満たすよう価格を上げる）
    expect(
      checkGates(baseInput({ avgVolume25: SCORING.GATES.MIN_AVG_VOLUME_25, latestPrice: 2_000 })).passed,
    ).toBe(true);
  });

  it("minAvgVolume25 を渡すとその値でゲートする（GU/PSC は 100,000）", () => {
    const strict = GAPUP.ENTRY.MIN_AVG_VOLUME_25;
    // 汎用値は通るが戦略固有値では落ちる帯（BT との乖離で本番だけ通っていた領域）
    const inBetween = 82_000;
    expect(checkGates(baseInput({ avgVolume25: inBetween, latestPrice: 2_000 })).passed).toBe(true);
    expect(
      checkGates(baseInput({ avgVolume25: inBetween, latestPrice: 2_000, minAvgVolume25: strict })).reason,
    ).toBe("volume");
    expect(
      checkGates(baseInput({ avgVolume25: strict, latestPrice: 2_000, minAvgVolume25: strict })).passed,
    ).toBe(true);
  });

  it("GU と PSC の流動性下限は同値（ウォッチリスト共有の前提）", () => {
    expect(GAPUP.ENTRY.MIN_AVG_VOLUME_25).toBe(POST_SURGE_CONSOLIDATION.ENTRY.MIN_AVG_VOLUME_25);
  });

  it("avgVolume25 が null なら落ちる", () => {
    expect(checkGates(baseInput({ avgVolume25: null })).reason).toBe("volume");
  });

  it("流動性を緩めても他のゲート（価格上限・ATR）は独立して効く", () => {
    expect(
      checkGates(baseInput({ latestPrice: 3_000, minAvgVolume25: 1 })).reason,
    ).toBe("price");
    expect(checkGates(baseInput({ atrPct: 0.5, minAvgVolume25: 1 })).reason).toBe("atr");
  });
});
