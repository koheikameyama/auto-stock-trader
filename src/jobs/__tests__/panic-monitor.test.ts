import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ========================================
// モック設定
// ========================================

const {
  mockGetPanicMarketState,
  mockFetchQuotes,
  mockSubmitOrder,
  mockNotifySlack,
  mockCalculateDrawdownStatus,
  mockPositionFindMany,
  mockOrderFindFirst,
  mockOrderCreate,
  mockStockFindUnique,
  mockPanicSignalUpsert,
} = vi.hoisted(() => ({
  mockGetPanicMarketState: vi.fn(),
  mockFetchQuotes: vi.fn(),
  mockSubmitOrder: vi.fn(),
  mockNotifySlack: vi.fn().mockResolvedValue(undefined),
  mockCalculateDrawdownStatus: vi.fn(),
  mockPositionFindMany: vi.fn().mockResolvedValue([]),
  mockOrderFindFirst: vi.fn().mockResolvedValue(null),
  mockOrderCreate: vi.fn().mockResolvedValue({}),
  mockStockFindUnique: vi.fn(),
  mockPanicSignalUpsert: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingPosition: { findMany: mockPositionFindMany },
    tradingOrder: { findFirst: mockOrderFindFirst, create: mockOrderCreate },
    stock: { findUnique: mockStockFindUnique },
    panicSignal: { upsert: mockPanicSignalUpsert },
  },
}));
vi.mock("../../core/panic/market-state", () => ({ getPanicMarketState: mockGetPanicMarketState }));
vi.mock("../../lib/tachibana-price-client", () => ({ tachibanaFetchQuotesBatch: mockFetchQuotes }));
vi.mock("../../core/broker-orders", () => ({ submitOrder: mockSubmitOrder }));
vi.mock("../../core/drawdown-manager", () => ({ calculateDrawdownStatus: mockCalculateDrawdownStatus }));
vi.mock("../../lib/slack", () => ({ notifySlack: mockNotifySlack }));

import { main, resetScanner } from "../panic-monitor";

/** 発火する market-state（各テストで1脚だけ崩す） */
function makeState(overrides?: Record<string, unknown>) {
  return {
    conditionDate: new Date("2026-03-16T00:00:00Z"),
    breadth: 0.235,
    breadthAllJp: 0.26,
    nikkeiDownStreak: 3,
    prevVixClose: 27.2,
    vixAsOf: new Date("2026-03-13T00:00:00Z"),
    // 前営業日は breadth が閾値を超えていた = エピソード初日
    prevDayBreadth: 0.45,
    prevDayNikkeiDownStreak: 2,
    prevDayVixClose: 26.0,
    ...overrides,
  };
}

describe("panic-monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T06:30:00Z")); // 15:30 JST（15:24 以降）
    resetScanner();
    mockGetPanicMarketState.mockResolvedValue(makeState());
    mockPositionFindMany.mockResolvedValue([]);
    mockOrderFindFirst.mockResolvedValue(null);
    mockCalculateDrawdownStatus.mockResolvedValue({ shouldHaltTrading: false, reason: "" });
    mockFetchQuotes.mockResolvedValue([{ tickerCode: "1321", price: 30000, open: 30100, high: 30200, low: 29900, volume: 100000 }]);
    mockStockFindUnique.mockResolvedValue({ id: "stock-1321", name: "NEXT FUNDS 日経225連動型上場投信" });
    mockSubmitOrder.mockResolvedValue({ success: true, orderNumber: "PANIC-001", businessDay: "20260317" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("シグナル発火で 1321 を引け成行買いする", async () => {
    await main();

    expect(mockSubmitOrder).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: "1321", side: "buy", limitPrice: null, condition: "4" }),
    );
    // -12% SL を注文に載せる（約定後に broker-fill-handler が逆指値を別建て）
    expect(mockOrderCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          strategy: "panic",
          side: "buy",
          stopLossPrice: 30000 * 0.88,
        }),
      }),
    );
  });

  it("risk2% / -12%SL でロットを決める", async () => {
    await main();

    // riskAmount = 500,000 * 0.02 = 10,000 / slDistance = 30,000 * 0.12 = 3,600 → floor(2.77) = 2株
    expect(mockSubmitOrder).toHaveBeenCalledWith(expect.objectContaining({ quantity: 2 }));
  });

  it("15:24 より前は何もしない", async () => {
    vi.setSystemTime(new Date("2026-03-17T05:00:00Z")); // 14:00 JST

    await main();

    expect(mockGetPanicMarketState).not.toHaveBeenCalled();
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });

  it("同日2回目のスキャンは何もしない", async () => {
    await main();
    mockSubmitOrder.mockClear();

    await main();

    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });

  it("鮮度不足（market-state が判定不能）なら発注しない", async () => {
    mockGetPanicMarketState.mockResolvedValue({ unavailable: true, reason: "^VIX が stale" });

    await main();

    expect(mockSubmitOrder).not.toHaveBeenCalled();
    expect(mockNotifySlack).toHaveBeenCalledWith(expect.objectContaining({ color: "warning" }));
  });

  it("エピソード継続日（前営業日も3条件が揃っていた）は発注しない", async () => {
    mockGetPanicMarketState.mockResolvedValue(
      makeState({ prevDayBreadth: 0.3, prevDayNikkeiDownStreak: 3, prevDayVixClose: 27 }),
    );

    await main();

    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });

  it("条件を満たさなければ発注しない（breadth が閾値以上）", async () => {
    mockGetPanicMarketState.mockResolvedValue(makeState({ breadth: 0.5 }));

    await main();

    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });

  // KOH-554: BT は panic レッグにも DDハルトを掛けている（etfShouldTrade = ddHalt.shouldTrade）。
  // 雛形の us-etf-monitor はこれを見ておらず、踏襲すると BT が撃たない日に本番だけ撃つ。
  it("DDハルト中は発注しない（BT の etfShouldTrade = ddHalt.shouldTrade と揃える）", async () => {
    mockCalculateDrawdownStatus.mockResolvedValue({
      shouldHaltTrading: true,
      reason: "週次損失 6.2% ≥ 5%",
    });

    await main();

    expect(mockSubmitOrder).not.toHaveBeenCalled();
    expect(mockPanicSignalUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ skipReason: expect.stringContaining("DDハルト") }),
      }),
    );
  });

  it("既に panic ポジを保有していたら発注しない（枠1）", async () => {
    // runTimeStopExits の findMany（open のみ）→ 空、runEntry の findMany（open/ordered）→ 1件
    mockPositionFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "pos-1" }]);

    await main();

    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });

  it("時価取得失敗は retryable（当日フラグを立てず次分リトライする）", async () => {
    mockFetchQuotes.mockResolvedValue([]);

    await main();
    expect(mockSubmitOrder).not.toHaveBeenCalled();

    // 2回目は素通りする（lastScanDate が立っていない）
    mockFetchQuotes.mockResolvedValue([{ tickerCode: "1321", price: 30000, open: 30100, high: 30200, low: 29900, volume: 100000 }]);
    await main();
    expect(mockSubmitOrder).toHaveBeenCalled();
  });

  it("業務リジェクト([sub:)は非リトライで当日打ち止め", async () => {
    mockSubmitOrder.mockResolvedValue({ success: false, error: "[sub:11482] 資金不足" });

    await main();
    expect(mockSubmitOrder).toHaveBeenCalledTimes(1);

    await main();
    expect(mockSubmitOrder).toHaveBeenCalledTimes(1); // 増えない
  });

  it("Stock に 1321 が未登録なら 🚨 を上げて発注しない", async () => {
    mockStockFindUnique.mockResolvedValue(null);

    await main();

    expect(mockSubmitOrder).not.toHaveBeenCalled();
    expect(mockNotifySlack).toHaveBeenCalledWith(expect.objectContaining({ color: "danger" }));
  });

  describe("タイムストップ Exit", () => {
    it("20営業日未満は継続保有", async () => {
      mockPositionFindMany.mockResolvedValueOnce([
        { id: "pos-1", quantity: 2, createdAt: new Date("2026-03-16T06:00:00Z"), stock: { id: "s", tickerCode: "1321", name: "N225 ETF" } },
      ]);

      await main();

      expect(mockSubmitOrder).not.toHaveBeenCalledWith(expect.objectContaining({ side: "sell" }));
    });

    it("20営業日経過で引け成行売り", async () => {
      mockPositionFindMany.mockResolvedValueOnce([
        { id: "pos-1", quantity: 2, createdAt: new Date("2026-01-05T06:00:00Z"), stock: { id: "s", tickerCode: "1321", name: "N225 ETF" } },
      ]);

      await main();

      expect(mockSubmitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ ticker: "1321", side: "sell", quantity: 2, condition: "4" }),
      );
    });

    it("既に pending 売り注文があれば二重発注しない（3段リトライ対策）", async () => {
      mockPositionFindMany.mockResolvedValueOnce([
        { id: "pos-1", quantity: 2, createdAt: new Date("2026-01-05T06:00:00Z"), stock: { id: "s", tickerCode: "1321", name: "N225 ETF" } },
      ]);
      mockOrderFindFirst.mockResolvedValue({ id: "existing-sell" });

      await main();

      expect(mockSubmitOrder).not.toHaveBeenCalledWith(expect.objectContaining({ side: "sell" }));
    });
  });
});
