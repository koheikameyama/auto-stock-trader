import { describe, it, expect } from "vitest";
import { checkGates } from "../../scoring/gates";

describe("checkGates", () => {
  const baseInput = {
    latestPrice: 1000,
    avgVolume25: 100_000,
    atrPct: 2.5,
    nextEarningsDate: null,
    exDividendDate: null,
    today: new Date("2026-03-14"),
  };

  it("全条件クリア → passed=true", () => {
    const result = checkGates(baseInput);
    expect(result.passed).toBe(true);
    expect(result.failedGate).toBeNull();
  });

  it("出来高不足 → liquidity", () => {
    const result = checkGates({ ...baseInput, avgVolume25: 30_000 });
    expect(result.passed).toBe(false);
    expect(result.failedGate).toBe("liquidity");
  });

  it("株価超過 → spread", () => {
    const result = checkGates({ ...baseInput, latestPrice: 5001 });
    expect(result.passed).toBe(false);
    expect(result.failedGate).toBe("spread");
  });

  it("低ボラ → volatility", () => {
    const result = checkGates({ ...baseInput, atrPct: 1.0 });
    expect(result.passed).toBe(false);
    expect(result.failedGate).toBe("volatility");
  });

  it("決算5日以内 → earnings", () => {
    const result = checkGates({
      ...baseInput,
      nextEarningsDate: new Date("2026-03-17"),
    });
    expect(result.passed).toBe(false);
    expect(result.failedGate).toBe("earnings");
  });

  it("配当3日以内 → dividend", () => {
    const result = checkGates({
      ...baseInput,
      exDividendDate: new Date("2026-03-16"),
    });
    expect(result.passed).toBe(false);
    expect(result.failedGate).toBe("dividend");
  });

  it("exDividendDate=null → 合格（安全側デフォルト）", () => {
    const result = checkGates({ ...baseInput, exDividendDate: null });
    expect(result.passed).toBe(true);
  });
});
