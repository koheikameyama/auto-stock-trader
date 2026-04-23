import { describe, it, expect } from "vitest";
import { applySlippage, SLIPPAGE_PROFILES } from "../trading-costs";

describe("applySlippage", () => {
  it('profile "none" は価格を変更しない', () => {
    expect(applySlippage(1000, "buy", "entry_market", "none")).toBe(1000);
    expect(applySlippage(1000, "sell", "exit_stop", "none")).toBe(1000);
  });

  it("buy 側は価格が bps 分だけ上振れ（不利）", () => {
    // standard: entryMarket=10bps → 1000 * (1 + 0.0010) = 1001
    const px = applySlippage(1000, "buy", "entry_market", "standard");
    expect(px).toBeCloseTo(1001, 2);
  });

  it("sell 側は価格が bps 分だけ下振れ（不利）", () => {
    // standard: exitMarket=10bps → 1000 * (1 - 0.0010) = 999
    const px = applySlippage(1000, "sell", "exit_market", "standard");
    expect(px).toBeCloseTo(999, 2);
  });

  it("exit_stop は exit_market よりスリッページが大きい", () => {
    const stopPx = applySlippage(1000, "sell", "exit_stop", "standard");
    const marketPx = applySlippage(1000, "sell", "exit_market", "standard");
    // SL発動時の方が約定価格が低い（不利）
    expect(stopPx).toBeLessThan(marketPx);
  });

  it("limit 注文はスリッページ 0（既定で指値通りに約定）", () => {
    expect(applySlippage(1000, "buy", "limit", "heavy")).toBe(1000);
    expect(applySlippage(1000, "sell", "limit", "heavy")).toBe(1000);
  });

  it("heavy > standard > light > none の順でスリッページが大きい", () => {
    const buyNone = applySlippage(1000, "buy", "entry_market", "none");
    const buyLight = applySlippage(1000, "buy", "entry_market", "light");
    const buyStandard = applySlippage(1000, "buy", "entry_market", "standard");
    const buyHeavy = applySlippage(1000, "buy", "entry_market", "heavy");
    expect(buyNone).toBe(1000);
    expect(buyLight).toBeGreaterThan(buyNone);
    expect(buyStandard).toBeGreaterThan(buyLight);
    expect(buyHeavy).toBeGreaterThan(buyStandard);
  });

  it("価格が 0 以下の場合はそのまま返す", () => {
    expect(applySlippage(0, "buy", "entry_market", "heavy")).toBe(0);
    expect(applySlippage(-100, "sell", "exit_stop", "heavy")).toBe(-100);
  });

  it("SLIPPAGE_PROFILES.heavy の exitStopBps は 50 bps", () => {
    expect(SLIPPAGE_PROFILES.heavy.exitStopBps).toBe(50);
  });
});
