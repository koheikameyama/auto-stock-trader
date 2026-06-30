import { describe, it, expect, vi, beforeEach } from "vitest";

// ========================================
// モック設定
// ========================================

const { mockOrderFindMany, mockOrderUpdateMany } = vi.hoisted(() => ({
  mockOrderFindMany: vi.fn(),
  mockOrderUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingOrder: {
      findMany: mockOrderFindMany,
      updateMany: mockOrderUpdateMany,
    },
  },
}));

// getStartOfDayJST は固定値で十分（クエリ条件の検証用）
vi.mock("../../lib/market-date", () => ({
  getStartOfDayJST: () => new Date("2026-06-30T00:00:00.000Z"),
}));

import { getSameDayPendingBuyTickers, expireOrders } from "../order-executor";

// ========================================
// getSameDayPendingBuyTickers（Issue #322: 戦略横断の二重発注防止）
// ========================================

describe("getSameDayPendingBuyTickers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("当日の pending 買い注文を全戦略横断で名寄せして返す（GU と PSC が同一銘柄でも除外できる）", async () => {
    mockOrderFindMany.mockResolvedValue([
      { stock: { tickerCode: "3989" }, strategy: "gapup" },
      { stock: { tickerCode: "7203" }, strategy: "post-surge-consolidation" },
    ]);

    const tickers = await getSameDayPendingBuyTickers();

    expect(tickers).toEqual(new Set(["3989", "7203"]));
    // 戦略で絞らず side=buy / status=pending / 当日 で抽出していること
    const where = mockOrderFindMany.mock.calls[0][0].where;
    expect(where.side).toBe("buy");
    expect(where.status).toBe("pending");
    expect(where.strategy).toBeUndefined();
    expect(where.createdAt).toEqual({ gte: new Date("2026-06-30T00:00:00.000Z") });
  });

  it("当日の pending 買い注文が無ければ空集合", async () => {
    mockOrderFindMany.mockResolvedValue([]);
    expect(await getSameDayPendingBuyTickers()).toEqual(new Set());
  });
});

// ========================================
// expireOrders（Issue #322: 約定×expire 競合の防止）
// ========================================

describe("expireOrders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ブローカー発注済み(brokerOrderId あり)の注文は時間ベースで expired にしない", async () => {
    mockOrderUpdateMany.mockResolvedValue({ count: 0 });

    await expireOrders();

    const where = mockOrderUpdateMany.mock.calls[0][0].where;
    // 立花に出した注文（引け成行の約定と競合しうる）を時間失効の対象外にする防御
    expect(where.brokerOrderId).toBeNull();
    expect(where.status).toBe("pending");
    expect(where.expiresAt.lte).toBeInstanceOf(Date);
  });

  it("更新件数を返す", async () => {
    mockOrderUpdateMany.mockResolvedValue({ count: 3 });
    expect(await expireOrders()).toBe(3);
  });
});
