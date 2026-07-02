import { describe, it, expect } from "vitest";
import {
  toCostBps,
  computeStat,
  summarizeSlippage,
  type SlippageRecord,
} from "../slippage-analysis";

function rec(p: Partial<SlippageRecord>): SlippageRecord {
  return {
    side: "buy",
    strategy: "gapup",
    slippageBps: 0,
    notional: 100_000,
    filledAt: new Date("2026-01-15T06:30:00Z"),
    ...p,
  };
}

describe("toCostBps — 売買で符号を執行コストに統一", () => {
  it("買いは +slippage がコスト（高く買った）", () => {
    expect(toCostBps(rec({ side: "buy", slippageBps: 20 }))).toBe(20);
  });
  it("売りは -slippage がコスト（安く売った=slippage負がコスト正）", () => {
    // 売りで基準より安く約定 = slippageBps 負 → コストは正
    expect(toCostBps(rec({ side: "sell", slippageBps: -30 }))).toBe(30);
    // 売りで基準より高く約定 = 有利 → コスト負
    expect(toCostBps(rec({ side: "sell", slippageBps: 15 }))).toBe(-15);
  });
});

describe("computeStat", () => {
  it("空配列は n=0", () => {
    expect(computeStat([]).n).toBe(0);
  });
  it("平均・中央値・p90 を costBps ベースで算出", () => {
    const recs = [
      rec({ side: "buy", slippageBps: 0 }),
      rec({ side: "buy", slippageBps: 10 }),
      rec({ side: "buy", slippageBps: 20 }),
    ];
    const s = computeStat(recs);
    expect(s.n).toBe(3);
    expect(s.avgCostBps).toBeCloseTo(10, 5);
    expect(s.medianCostBps).toBe(10);
    expect(s.avgNotional).toBe(100_000);
  });
});

describe("summarizeSlippage", () => {
  it("約定金額帯ごとに買いを分類（キャパシティ曲線）", () => {
    const recs = [
      rec({ side: "buy", slippageBps: 5, notional: 50_000 }), // <100k
      rec({ side: "buy", slippageBps: 25, notional: 2_000_000 }), // 1M-3M
      rec({ side: "buy", slippageBps: 30, notional: 5_000_000 }), // 3M+
      rec({ side: "sell", slippageBps: -10, notional: 50_000, strategy: "psc" }),
    ];
    const sum = summarizeSlippage(recs);
    expect(sum.overall.n).toBe(4);
    expect(sum.byBuySell.buy.n).toBe(3);
    expect(sum.byBuySell.sell.n).toBe(1);

    const small = sum.buyByNotional.find((b) => b.label === "<¥100k")!;
    const big = sum.buyByNotional.find((b) => b.label === "¥3M+")!;
    expect(small.stat.n).toBe(1);
    expect(big.stat.n).toBe(1);
    // 金額が大きい帯ほどコストが高い（インパクトの兆候）
    expect(big.stat.avgCostBps).toBeGreaterThan(small.stat.avgCostBps);

    // 戦略別に分かれる
    expect(sum.byStrategy.map((s) => s.key).sort()).toEqual(["gapup", "psc"]);
  });

  it("月次は買いのみを filledAt で集計", () => {
    const recs = [
      rec({ side: "buy", filledAt: new Date("2026-01-10T06:30:00Z") }),
      rec({ side: "buy", filledAt: new Date("2026-02-10T06:30:00Z") }),
      rec({ side: "buy", filledAt: new Date("2026-02-20T06:30:00Z") }),
    ];
    const sum = summarizeSlippage(recs);
    expect(sum.byMonth.map((m) => m.month)).toEqual(["2026-01", "2026-02"]);
    expect(sum.byMonth.find((m) => m.month === "2026-02")!.buy.n).toBe(2);
  });
});
