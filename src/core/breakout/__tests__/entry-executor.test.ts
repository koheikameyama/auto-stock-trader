import { describe, it, expect, vi, beforeEach } from "vitest";

// ========================================
// モック設定
// ========================================

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    marketAssessment: {
      findUnique: vi.fn(),
    },
    stock: {
      findUnique: vi.fn(),
    },
    tradingOrder: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    tradingConfig: {
      findFirst: vi.fn(),
    },
    tradingPosition: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../../position-manager", () => ({
  getCashBalance: vi.fn(),
  getEffectiveCapital: vi.fn(),
}));

vi.mock("../../risk-manager", () => ({
  canOpenPosition: vi.fn(),
  getRiskPctByRR: vi.fn().mockReturnValue(2),
  getDynamicMaxPositionPct: vi.fn().mockReturnValue(200),
}));

vi.mock("../../broker-orders", () => ({
  submitOrder: vi.fn(),
  cancelOrder: vi.fn(),
}));

vi.mock("../../../lib/slack", () => ({
  notifyOrderPlaced: vi.fn(),
  notifySlack: vi.fn(),
}));

vi.mock("../../../lib/market-date", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/market-date")>();
  return {
    ...actual,
    getTodayForDB: vi.fn().mockReturnValue(new Date("2026-03-24T00:00:00Z")),
  };
});

import { executeEntry, invalidateStalePendingOrders } from "../entry-executor";
import { prisma } from "../../../lib/prisma";
import { getCashBalance, getEffectiveCapital } from "../../position-manager";
import { canOpenPosition } from "../../risk-manager";
import { submitOrder as submitBrokerOrder, cancelOrder } from "../../broker-orders";
import { notifyOrderPlaced } from "../../../lib/slack";
import type { BreakoutTrigger } from "../types";
import type { QuoteData } from "../breakout-scanner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as any;
const mockGetCashBalance = vi.mocked(getCashBalance);
const mockGetEffectiveCapital = vi.mocked(getEffectiveCapital);
const mockCanOpenPosition = vi.mocked(canOpenPosition);
const mockSubmitBrokerOrder = vi.mocked(submitBrokerOrder);
const mockNotifyOrderPlaced = vi.mocked(notifyOrderPlaced);
const mockCancelOrder = vi.mocked(cancelOrder);

// ========================================
// テストデータ
// ========================================

function makeTrigger(overrides: Partial<BreakoutTrigger> = {}): BreakoutTrigger {
  return {
    ticker: "7203.T",
    currentPrice: 1000,
    cumulativeVolume: 200_000,
    volumeSurgeRatio: 2.5,
    high20: 990,
    atr14: 20,
    triggeredAt: new Date("2026-03-24T01:30:00Z"), // 10:30 JST
    ...overrides,
  };
}

function makeStock(overrides: Record<string, unknown> = {}) {
  return {
    id: "stock-1",
    tickerCode: "7203.T",
    name: "トヨタ自動車",
    sector: "輸送用機器",
    ...overrides,
  };
}

function makeAssessment(shouldTrade: boolean) {
  return {
    id: "assessment-1",
    date: new Date("2026-03-24T00:00:00Z"),
    shouldTrade,
    sentiment: "normal",
    reasoning: "市場は通常",
    selectedStocks: null,
  };
}

// ========================================
// テスト
// ========================================

describe("executeEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // デフォルトのハッピーパスのモック設定
    mockPrisma.marketAssessment.findUnique.mockResolvedValue(makeAssessment(true));
    mockPrisma.stock.findUnique.mockResolvedValue(makeStock());
    mockPrisma.tradingConfig.findFirst.mockResolvedValue({
      id: "config-1",
      isActive: true,
      totalBudget: 500_000,
    });
    mockPrisma.tradingPosition.findMany.mockResolvedValue([]);
    mockGetCashBalance.mockResolvedValue(1_000_000);
    mockGetEffectiveCapital.mockResolvedValue(500_000);
    mockCanOpenPosition.mockResolvedValue({ allowed: true, reason: "OK" });
    mockPrisma.tradingOrder.create.mockResolvedValue({ id: "order-1" });
    mockPrisma.tradingOrder.update.mockResolvedValue({});
    mockSubmitBrokerOrder.mockResolvedValue({
      success: true,
      orderNumber: "999001",
      businessDay: "20260324",
    });
    mockNotifyOrderPlaced.mockResolvedValue(undefined);
  });

  // 1. shouldTrade=false → 注文しない
  it("1. shouldTrade=false → 注文を作成しない", async () => {
    mockPrisma.marketAssessment.findUnique.mockResolvedValue(makeAssessment(false));

    const result = await executeEntry(makeTrigger());

    expect(result.success).toBe(false);
    expect(result.reason).toContain("shouldTrade=false");
    expect(mockPrisma.tradingOrder.create).not.toHaveBeenCalled();
    expect(mockNotifyOrderPlaced).not.toHaveBeenCalled();
  });

  // 2. 買い余力不足 → 注文しない
  it("2. 買い余力不足 → 注文を作成しない", async () => {
    mockGetCashBalance.mockResolvedValue(50_000);

    const result = await executeEntry(makeTrigger());

    expect(result.success).toBe(false);
    expect(result.reason).toContain("残高不足");
    expect(mockPrisma.tradingOrder.create).not.toHaveBeenCalled();
  });

  // 3. SLが3%を超える → スキップされる
  it("3. ATRベースSLが3%超 → スキップされる", async () => {
    const trigger = makeTrigger({ currentPrice: 1000, atr14: 50 });

    const result = await executeEntry(trigger);

    expect(result.success).toBe(false);
    expect(result.reason).toContain("クランプ");
    expect(mockPrisma.tradingOrder.create).not.toHaveBeenCalled();
  });

  // 4. ポジションサイズが100株単位に丸められる
  it("4. ポジションサイズが100株単位に切り捨てられる", async () => {
    const trigger = makeTrigger({ currentPrice: 1000, atr14: 15 });
    const result = await executeEntry(trigger);

    expect(result.success).toBe(true);

    const createCall = mockPrisma.tradingOrder.create.mock.calls[0][0];
    const quantity = createCall.data.quantity;
    expect(quantity % 100).toBe(0);
    expect(quantity).toBeGreaterThan(0);
    expect(quantity).toBe(600);
  });

  // 5. 正常ケース: TradingOrder作成 + submitBrokerOrder呼び出し
  it("5. 正常ケース: TradingOrderが作成され、submitBrokerOrderが呼び出される", async () => {
    const trigger = makeTrigger();

    const result = await executeEntry(trigger);

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("order-1");

    // TradingOrder作成確認
    expect(mockPrisma.tradingOrder.create).toHaveBeenCalledOnce();
    const createCall = mockPrisma.tradingOrder.create.mock.calls[0][0];
    expect(createCall.data.side).toBe("buy");
    expect(createCall.data.strategy).toBe("breakout");
    expect(createCall.data.status).toBe("pending");
    expect(createCall.data.limitPrice).toBe(1000);
    expect(createCall.data.quantity).toBeGreaterThan(0);

    // submitBrokerOrder呼び出し確認
    expect(mockSubmitBrokerOrder).toHaveBeenCalledOnce();
    const brokerCall = mockSubmitBrokerOrder.mock.calls[0][0];
    expect(brokerCall.ticker).toBe("7203.T");
    expect(brokerCall.side).toBe("buy");
    expect(brokerCall.limitPrice).toBe(1000);

    // brokerOrderId/businessDayがcreate時に含まれることを確認
    const createData = mockPrisma.tradingOrder.create.mock.calls[0][0].data;
    expect(createData.brokerOrderId).toBe("999001");
    expect(createData.brokerBusinessDay).toBe("20260324");

    // Slack通知確認
    expect(mockNotifyOrderPlaced).toHaveBeenCalledOnce();
  });

  // 6. セクター集中超過 → 注文しない
  it("6. セクター集中超過（canOpenPosition=false） → 注文を作成しない", async () => {
    mockCanOpenPosition.mockResolvedValue({
      allowed: false,
      reason: "同一セクターの最大保有数（1）に達しています",
    });

    const result = await executeEntry(makeTrigger());

    expect(result.success).toBe(false);
    expect(result.reason).toContain("同一セクター");
    expect(mockPrisma.tradingOrder.create).not.toHaveBeenCalled();
    expect(mockNotifyOrderPlaced).not.toHaveBeenCalled();
  });

  // MarketAssessmentがない場合もスキップ
  it("MarketAssessmentが存在しない場合はスキップ", async () => {
    mockPrisma.marketAssessment.findUnique.mockResolvedValue(null);

    const result = await executeEntry(makeTrigger());

    expect(result.success).toBe(false);
    expect(result.reason).toContain("MarketAssessmentがありません");
    expect(mockPrisma.tradingOrder.create).not.toHaveBeenCalled();
  });

  it("expiresAtが5日後の15:00に設定される", async () => {
    const result = await executeEntry(makeTrigger());

    expect(result.success).toBe(true);

    const createCall = mockPrisma.tradingOrder.create.mock.calls[0][0];
    const expiresAt: Date = createCall.data.expiresAt;
    expect(expiresAt).toBeInstanceOf(Date);

    // 現在から4〜6日後の範囲であること（テスト実行タイミングの揺れを許容）
    const now = new Date();
    const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(4);
    expect(diffDays).toBeLessThan(6);

    // 時刻が15:00であること（JST→UTCで6:00）
    expect(expiresAt.getUTCHours()).toBe(6);
    expect(expiresAt.getUTCMinutes()).toBe(0);
  });
});

describe("invalidateStalePendingOrders", () => {
  function makePendingOrder(ticker: string, high20: number, overrides: Record<string, unknown> = {}) {
    return {
      id: `order-${ticker}`,
      side: "buy",
      status: "pending",
      strategy: "breakout",
      brokerOrderId: null,
      brokerBusinessDay: null,
      stock: { tickerCode: ticker },
      entrySnapshot: {
        trigger: { high20 },
      },
      ...overrides,
    };
  }

  function makeQuotes(data: Array<{ ticker: string; price: number }>): QuoteData[] {
    return data.map((d) => ({ ticker: d.ticker, price: d.price, volume: 100_000 }));
  }

  function makeSurgeRatios(data: Array<{ ticker: string; ratio: number }>): Map<string, number> {
    return new Map(data.map((d) => [d.ticker, d.ratio]));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockCancelOrder.mockResolvedValue({ success: true });
  });

  it("出来高萎縮（surgeRatio < 1.2）でpending注文をキャンセルする", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 990),
    ]);

    await invalidateStalePendingOrders(
      makeQuotes([{ ticker: "7203", price: 1000 }]),
      makeSurgeRatios([{ ticker: "7203", ratio: 0.8 }]),
    );

    expect(mockPrisma.tradingOrder.update).toHaveBeenCalledWith({
      where: { id: "order-7203" },
      data: { status: "cancelled" },
    });
  });

  it("高値割り込み（price <= high20）でpending注文をキャンセルする", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 1000),
    ]);

    await invalidateStalePendingOrders(
      makeQuotes([{ ticker: "7203", price: 995 }]),
      makeSurgeRatios([{ ticker: "7203", ratio: 2.5 }]),
    );

    expect(mockPrisma.tradingOrder.update).toHaveBeenCalledWith({
      where: { id: "order-7203" },
      data: { status: "cancelled" },
    });
  });

  it("条件を満たさない場合はキャンセルしない", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 990),
    ]);

    await invalidateStalePendingOrders(
      makeQuotes([{ ticker: "7203", price: 1000 }]),
      makeSurgeRatios([{ ticker: "7203", ratio: 2.5 }]),
    );

    expect(mockPrisma.tradingOrder.update).not.toHaveBeenCalled();
  });

  it("quoteが取得できない銘柄はスキップする", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 990),
    ]);

    await invalidateStalePendingOrders(
      makeQuotes([]),
      makeSurgeRatios([{ ticker: "7203", ratio: 0.5 }]),
    );

    expect(mockPrisma.tradingOrder.update).not.toHaveBeenCalled();
  });

  it("surgeRatioが取得できない銘柄はスキップする", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 990),
    ]);

    await invalidateStalePendingOrders(
      makeQuotes([{ ticker: "7203", price: 1000 }]),
      makeSurgeRatios([]),
    );

    expect(mockPrisma.tradingOrder.update).not.toHaveBeenCalled();
  });

  it("ブローカー注文がある場合はcancelOrderを呼ぶ", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 1000, {
        brokerOrderId: "B001",
        brokerBusinessDay: "20260326",
      }),
    ]);

    await invalidateStalePendingOrders(
      makeQuotes([{ ticker: "7203", price: 995 }]),
      makeSurgeRatios([{ ticker: "7203", ratio: 2.5 }]),
    );

    expect(mockCancelOrder).toHaveBeenCalledWith("B001", "20260326", expect.any(String));
    expect(mockPrisma.tradingOrder.update).toHaveBeenCalledWith({
      where: { id: "order-7203" },
      data: { status: "cancelled" },
    });
  });

  it("キャンセルした ticker の Set を返す", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 1000), // 高値割り込み → キャンセル
      makePendingOrder("9984", 990),  // 条件満たしている → キャンセルなし
    ]);

    const result = await invalidateStalePendingOrders(
      makeQuotes([{ ticker: "7203", price: 995 }, { ticker: "9984", price: 1000 }]),
      makeSurgeRatios([{ ticker: "7203", ratio: 2.5 }, { ticker: "9984", ratio: 2.5 }]),
    );

    expect(result).toBeInstanceOf(Set);
    expect(result.has("7203")).toBe(true);
    expect(result.has("9984")).toBe(false);
  });

  it("キャンセルなしの場合は空の Set を返す", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 990),
    ]);

    const result = await invalidateStalePendingOrders(
      makeQuotes([{ ticker: "7203", price: 1000 }]),
      makeSurgeRatios([{ ticker: "7203", ratio: 2.5 }]),
    );

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });
});
