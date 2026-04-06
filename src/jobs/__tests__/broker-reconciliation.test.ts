import { describe, it, expect, vi, beforeEach } from "vitest";

// ========================================
// モック設定
// ========================================

const {
  mockPositionFindMany,
  mockPositionUpdate,
  mockOrderFindMany,
  mockOrderFindFirst,
  mockSyncBrokerOrderStatuses,
  mockRecoverMissedFills,
  mockGetHoldings,
  mockGetOrderDetail,
  mockGetOrders,
  mockCancelOrder,
  mockSubmitBrokerSL,
  mockClosePosition,
  mockVoidPosition,
  mockFetchStockQuote,
  mockNotifySlack,
  mockBrokerConstants,
} = vi.hoisted(() => ({
  mockPositionFindMany: vi.fn(),
  mockPositionUpdate: vi.fn().mockResolvedValue({}),
  mockOrderFindMany: vi.fn().mockResolvedValue([]),
  mockOrderFindFirst: vi.fn().mockResolvedValue(null),
  mockSyncBrokerOrderStatuses: vi.fn().mockResolvedValue(undefined),
  mockRecoverMissedFills: vi.fn().mockResolvedValue(undefined),
  mockGetHoldings: vi.fn(),
  mockGetOrderDetail: vi.fn(),
  mockGetOrders: vi.fn(),
  mockCancelOrder: vi.fn().mockResolvedValue({ success: true }),
  mockSubmitBrokerSL: vi.fn().mockResolvedValue(undefined),
  mockClosePosition: vi.fn().mockResolvedValue({ realizedPnl: -1000 }),
  mockVoidPosition: vi.fn().mockResolvedValue({}),
  mockFetchStockQuote: vi.fn().mockResolvedValue({ price: 950 }),
  mockNotifySlack: vi.fn().mockResolvedValue(undefined),
  mockBrokerConstants: { isTachibanaProduction: true },
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingPosition: {
      findMany: mockPositionFindMany,
      update: mockPositionUpdate,
    },
    tradingOrder: {
      findMany: mockOrderFindMany,
      findFirst: mockOrderFindFirst,
    },
  },
}));

vi.mock("../../core/broker-orders", () => ({
  syncBrokerOrderStatuses: mockSyncBrokerOrderStatuses,
  getHoldings: mockGetHoldings,
  getOrderDetail: mockGetOrderDetail,
  getOrders: mockGetOrders,
  cancelOrder: mockCancelOrder,
}));

vi.mock("../../lib/constants/broker", () => ({
  TACHIBANA_ORDER: {
    SIDE: { SELL: "1", BUY: "3" },
    MARGIN_TYPE: { CASH: "0", MARGIN_NEW: "2", MARGIN_CLOSE: "4" },
    EXCHANGE: { TSE: "00" },
    CONDITION: { NONE: "0", OPEN: "2", CLOSE: "4", FUNARI: "6" },
    REVERSE_ORDER_TYPE: { NORMAL: "0", REVERSE_ONLY: "1", NORMAL_AND_REVERSE: "2" },
    EXPIRE: { TODAY: "0" },
    TAX_TYPE: { SPECIFIC: "1", GENERAL: "3", NISA: "5" },
    MARKET_PRICE: "0",
  },
  TACHIBANA_ORDER_STATUS: {
    NOT_RECEIVED: "0",
    UNFILLED: "1",
    PARTIAL_FILLED: "9",
    FULLY_FILLED: "10",
    CANCELLED: "7",
    EXPIRED: "12",
    WAITING_REVERSE: "13",
    SWITCHING: "15",
    SWITCHED_UNFILLED: "16",
    SUBMITTING: "50",
  },
  get isTachibanaProduction() { return mockBrokerConstants.isTachibanaProduction; },
}));

vi.mock("../../core/broker-fill-handler", () => ({
  recoverMissedFills: mockRecoverMissedFills,
}));

vi.mock("../../core/broker-sl-manager", () => ({
  submitBrokerSL: mockSubmitBrokerSL,
}));

vi.mock("../../core/position-manager", () => ({
  closePosition: mockClosePosition,
  voidPosition: mockVoidPosition,
}));

vi.mock("../../core/market-data", () => ({
  fetchStockQuote: mockFetchStockQuote,
}));

vi.mock("../../lib/slack", () => ({
  notifySlack: mockNotifySlack,
}));

import { main } from "../broker-reconciliation";

// ========================================
// テスト用ファクトリ
// ========================================

function makePosition(overrides: {
  id?: string;
  ticker?: string;
  quantity?: number;
  strategy?: string;
  stopLossPrice?: number;
  trailingStopPrice?: number | null;
  slBrokerOrderId?: string | null;
  slBrokerBusinessDay?: string | null;
  createdAt?: Date;
} = {}) {
  const slId = overrides.slBrokerOrderId ?? null;
  return {
    id: overrides.id ?? "pos-1",
    quantity: overrides.quantity ?? 100,
    strategy: overrides.strategy ?? "breakout",
    stopLossPrice: overrides.stopLossPrice ?? 900,
    trailingStopPrice: overrides.trailingStopPrice ?? null,
    slBrokerOrderId: slId,
    slBrokerBusinessDay: slId ? (overrides.slBrokerBusinessDay ?? "20260403") : null,
    createdAt: overrides.createdAt ?? new Date(Date.now() - 10 * 60 * 1000), // 10分前
    stock: {
      tickerCode: overrides.ticker ?? "7203.T",
      name: "トヨタ自動車",
    },
  };
}

/** Phase 3 のみテストするセットアップ（Phase 4, 5 を無害化） */
function setupForPhase3(phase3Positions: ReturnType<typeof makePosition>[]) {
  // Phase 3: tradingPosition.findMany({ where: { status: "open" } })
  // Phase 4: tradingPosition.findMany({ where: { status: "open", slBrokerOrderId: { not: null } } })
  mockPositionFindMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.slBrokerOrderId) return []; // Phase 4 → 空
    return phase3Positions;
  });
  // Phase 5
  mockGetOrders.mockResolvedValue({ sResultCode: "0", aOrderList: [] });
}

/** Phase 4 のみテストするセットアップ（Phase 3 を無害化） */
function setupForPhase4(phase4Positions: ReturnType<typeof makePosition>[]) {
  mockPositionFindMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.slBrokerOrderId) return phase4Positions; // Phase 4
    return []; // Phase 3 → 空
  });
  mockGetOrders.mockResolvedValue({ sResultCode: "0", aOrderList: [] });
}

/** Phase 5 のみテストするセットアップ（Phase 3, 4 を無害化） */
function setupForPhase5() {
  mockPositionFindMany.mockResolvedValue([]); // Phase 3, 4 → 空
}

// ========================================
// Phase 3: 保有照合（reconcileHoldings）
// ========================================

describe("broker-reconciliation: Phase 3 保有照合", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrokerConstants.isTachibanaProduction = true;
  });

  it("openPositionsが0件の場合、closePositionを呼ばない", async () => {
    setupForPhase3([]);
    mockGetHoldings.mockResolvedValue([]);

    await main();

    expect(mockClosePosition).not.toHaveBeenCalled();
  });

  it("getHoldings()がnullを返す場合、closePositionを呼ばない（誤爆防止）", async () => {
    setupForPhase3([makePosition()]);
    mockGetHoldings.mockResolvedValue(null);

    await main();

    expect(mockClosePosition).not.toHaveBeenCalled();
  });

  it("開設直後（5分以内）のポジションはスキップする", async () => {
    const recentPosition = makePosition({
      createdAt: new Date(Date.now() - 2 * 60 * 1000), // 2分前
    });
    setupForPhase3([recentPosition]);
    mockGetHoldings.mockResolvedValue([]); // ブローカー保有なし

    await main();

    // スキップされるのでclosePositionは呼ばれない
    expect(mockClosePosition).not.toHaveBeenCalled();
  });

  it("ブローカー保有なし + SL FULLY_FILLED → 約定価格でclosePositionを呼ぶ", async () => {
    const position = makePosition({
      slBrokerOrderId: "SL-001",
      slBrokerBusinessDay: "20260403",
    });
    setupForPhase3([position]);
    mockGetHoldings.mockResolvedValue([]); // ブローカー保有なし

    // SL注文 FULLY_FILLED、約定価格890円
    mockGetOrderDetail.mockResolvedValue({
      sOrderStatusCode: "10", // FULLY_FILLED
      aYakuzyouSikkouList: [
        { sYakuzyouPrice: "890", sYakuzyouSuryou: "100" },
      ],
    });

    await main();

    expect(mockClosePosition).toHaveBeenCalledWith(
      "pos-1",
      890,
      expect.objectContaining({ exitReason: expect.stringContaining("SL約定") }),
    );
  });

  it("ブローカー保有なし + SL注文なし → voidPositionで損益なしクローズを呼ぶ", async () => {
    const position = makePosition({ slBrokerOrderId: null });
    setupForPhase3([position]);
    mockGetHoldings.mockResolvedValue([]);

    await main();

    expect(mockVoidPosition).toHaveBeenCalledWith(
      "pos-1",
      expect.stringContaining("保有照合クローズ"),
    );
  });

  it("数量不一致のポジションにはSlack warningを送信する", async () => {
    const position = makePosition({ quantity: 100 });
    setupForPhase3([position]);
    mockGetHoldings.mockResolvedValue([
      { ticker: "7203.T", quantity: 50 }, // 50株しかない
    ]);

    await main();

    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("保有数量不一致"),
        color: "warning",
      }),
    );
    // 数量不一致はclosePositionしない
    expect(mockClosePosition).not.toHaveBeenCalled();
  });
});

// ========================================
// Phase 4: SL注文照合（reconcileSLOrders）
// ========================================

describe("broker-reconciliation: Phase 4 SL注文照合", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrokerConstants.isTachibanaProduction = true;
  });

  it("SL注文がEXPIREDの場合、IDクリア → submitBrokerSLで再発注する", async () => {
    const position = makePosition({
      slBrokerOrderId: "SL-EXPIRED",
      stopLossPrice: 900,
    });
    setupForPhase4([position]);
    mockGetOrderDetail.mockResolvedValue({ sOrderStatusCode: "12" }); // EXPIRED

    await main();

    // IDクリア
    expect(mockPositionUpdate).toHaveBeenCalledWith({
      where: { id: "pos-1" },
      data: { slBrokerOrderId: null, slBrokerBusinessDay: null },
    });
    // 再発注
    expect(mockSubmitBrokerSL).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: "pos-1",
        stopTriggerPrice: 900,
      }),
    );
  });

  it("SL注文がCANCELLEDの場合、IDクリア → submitBrokerSLで再発注する", async () => {
    const position = makePosition({
      slBrokerOrderId: "SL-CANCELLED",
      stopLossPrice: 850,
    });
    setupForPhase4([position]);
    mockGetOrderDetail.mockResolvedValue({ sOrderStatusCode: "7" }); // CANCELLED

    await main();

    expect(mockPositionUpdate).toHaveBeenCalledWith({
      where: { id: "pos-1" },
      data: { slBrokerOrderId: null, slBrokerBusinessDay: null },
    });
    expect(mockSubmitBrokerSL).toHaveBeenCalledWith(
      expect.objectContaining({ stopTriggerPrice: 850 }),
    );
  });

  it("SL価格が0の場合、再発注せずSlack dangerを送信する", async () => {
    const position = makePosition({
      slBrokerOrderId: "SL-EXPIRED",
      stopLossPrice: 0,
      trailingStopPrice: null,
    });
    setupForPhase4([position]);
    mockGetOrderDetail.mockResolvedValue({ sOrderStatusCode: "12" }); // EXPIRED

    await main();

    expect(mockSubmitBrokerSL).not.toHaveBeenCalled();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({ color: "danger" }),
    );
  });

  it("getOrderDetailが失敗した場合、例外を投げずスキップする", async () => {
    const position = makePosition({ slBrokerOrderId: "SL-001" });
    setupForPhase4([position]);
    mockGetOrderDetail.mockRejectedValue(new Error("API timeout"));

    await expect(main()).resolves.not.toThrow();
    expect(mockSubmitBrokerSL).not.toHaveBeenCalled();
  });
});

// ========================================
// Phase 5: 孤立買い注文キャンセル（cancelOrphanedBuyOrders）
// ========================================

describe("broker-reconciliation: Phase 5 孤立買い注文キャンセル", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupForPhase5();
  });

  it("getOrdersがnullを返す場合、cancelOrderを呼ばない", async () => {
    mockGetOrders.mockResolvedValue(null);

    await main();

    expect(mockCancelOrder).not.toHaveBeenCalled();
  });

  it("売り注文はスキップする", async () => {
    mockGetOrders.mockResolvedValue({
      sResultCode: "0",
      aOrderList: [
        {
          sOrderOrderNumber: "ORD-001",
          sOrderSikkouDay: "20260403",
          sBaibaiKubun: "1", // SELL
          sOrderStatusCode: "1", // UNFILLED
        },
      ],
    });

    await main();

    expect(mockCancelOrder).not.toHaveBeenCalled();
  });

  it("DBに対応レコードがある買い注文はスキップする", async () => {
    mockGetOrders.mockResolvedValue({
      sResultCode: "0",
      aOrderList: [
        {
          sOrderOrderNumber: "ORD-001",
          sOrderSikkouDay: "20260403",
          sBaibaiKubun: "3", // BUY
          sOrderStatusCode: "1", // UNFILLED
        },
      ],
    });
    // DBに "ORD-001" が存在する
    mockOrderFindMany.mockResolvedValue([{ brokerOrderId: "ORD-001" }]);

    await main();

    expect(mockCancelOrder).not.toHaveBeenCalled();
  });

  it("DBに記録のない未約定買い注文をキャンセルしSlack warningを送信する", async () => {
    mockGetOrders.mockResolvedValue({
      sResultCode: "0",
      aOrderList: [
        {
          sOrderOrderNumber: "ORPHAN-001",
          sOrderSikkouDay: "20260403",
          sBaibaiKubun: "3", // BUY
          sOrderStatusCode: "1", // UNFILLED
        },
      ],
    });
    mockOrderFindMany.mockResolvedValue([]); // DBに対応なし

    await main();

    expect(mockCancelOrder).toHaveBeenCalledWith("ORPHAN-001", "20260403");
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("孤立買い注文をキャンセル"),
      }),
    );
  });
});

// ========================================
// デモ環境スキップ
// ========================================

describe("broker-reconciliation: デモ環境スキップ", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrokerConstants.isTachibanaProduction = false;
  });

  it("デモ環境ではPhase3保有照合をスキップしvoidPositionを呼ばない", async () => {
    setupForPhase3([makePosition()]);
    mockGetHoldings.mockResolvedValue([]); // 保有なし → 本来なら自動クローズ

    await main();

    expect(mockVoidPosition).not.toHaveBeenCalled();
    expect(mockClosePosition).not.toHaveBeenCalled();
  });
});
