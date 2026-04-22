import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindMany, mockCount } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockCount: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingPosition: {
      findMany: mockFindMany,
      count: mockCount,
    },
  },
}));

const { mockCalculateDrawdownStatus } = vi.hoisted(() => ({
  mockCalculateDrawdownStatus: vi.fn(),
}));

vi.mock("../../core/drawdown-manager", () => ({
  calculateDrawdownStatus: mockCalculateDrawdownStatus,
}));

import { detectAnomalies } from "../anomaly-detector";

const okDD = {
  currentEquity: 1000000,
  peakEquity: 1000000,
  drawdownPct: 0,
  weeklyPnl: 0,
  weeklyDrawdownPct: 0,
  monthlyPnl: 0,
  monthlyDrawdownPct: 0,
  shouldHaltTrading: false,
  reason: "OK",
};

function makePos(pnl: number) {
  // entry=1000, qty=1, exit=1000+pnl → getPositionPnl = pnl
  return { entryPrice: 1000, exitPrice: 1000 + pnl, quantity: 1 };
}

describe("detectAnomalies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCalculateDrawdownStatus.mockResolvedValue(okDD);
    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(1); // 直近30日のエントリーあり（沈黙検知を抑制）
  });

  it("全指標OK時は空配列を返す", async () => {
    const anomalies = await detectAnomalies();
    expect(anomalies).toEqual([]);
  });

  it("月次DD ≥ 10% で monthly_drawdown を検知", async () => {
    mockCalculateDrawdownStatus.mockResolvedValue({
      ...okDD,
      monthlyDrawdownPct: 12.5,
      monthlyPnl: -125000,
    });
    const anomalies = await detectAnomalies();
    expect(anomalies.map((a) => a.code)).toContain("monthly_drawdown");
  });

  it("直近20件揃って勝率<30%で low_win_rate を検知", async () => {
    // 5勝15敗 = 25%
    const positions = [
      ...Array(5).fill(null).map(() => makePos(100)),
      ...Array(15).fill(null).map(() => makePos(-100)),
    ];
    // findMany は (1) 直近20件 (2) 直近5日の順で呼ばれるため両方で値を返す
    mockFindMany.mockResolvedValueOnce(positions).mockResolvedValueOnce([]);
    const anomalies = await detectAnomalies();
    expect(anomalies.map((a) => a.code)).toContain("low_win_rate");
  });

  it("直近20件未満なら low_win_rate を検知しない（サンプル不足）", async () => {
    const positions = Array(10).fill(null).map(() => makePos(-100));
    mockFindMany.mockResolvedValueOnce(positions).mockResolvedValueOnce([]);
    const anomalies = await detectAnomalies();
    expect(anomalies.map((a) => a.code)).not.toContain("low_win_rate");
  });

  it("直近5日で連敗4件以上 (loss_streak)", async () => {
    const lossesInWindow = [
      makePos(-100), makePos(-100), makePos(-100), makePos(-100), makePos(50),
    ];
    mockFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce(lossesInWindow);
    const anomalies = await detectAnomalies();
    expect(anomalies.map((a) => a.code)).toContain("loss_streak");
  });

  it("直近5日で連敗3件は閾値未満 → 検知しない", async () => {
    const lossesInWindow = [
      makePos(-100), makePos(-100), makePos(-100), makePos(50),
    ];
    mockFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce(lossesInWindow);
    const anomalies = await detectAnomalies();
    expect(anomalies.map((a) => a.code)).not.toContain("loss_streak");
  });

  it("直近30日エントリーゼロで silent_entries を検知", async () => {
    mockCount.mockResolvedValue(0);
    const anomalies = await detectAnomalies();
    expect(anomalies.map((a) => a.code)).toContain("silent_entries");
  });

  it("複数の異常を同時に検知", async () => {
    mockCalculateDrawdownStatus.mockResolvedValue({
      ...okDD,
      monthlyDrawdownPct: 15,
      monthlyPnl: -150000,
    });
    mockCount.mockResolvedValue(0);
    const anomalies = await detectAnomalies();
    const codes = anomalies.map((a) => a.code);
    expect(codes).toContain("monthly_drawdown");
    expect(codes).toContain("silent_entries");
  });
});
