import { describe, it, expect, vi, beforeEach } from "vitest";

// ========================================
// モック設定
// ========================================

const { mockRequest, mockOrderFindMany, mockOrderUpdate, mockNotifySlack } =
  vi.hoisted(() => ({
    mockRequest: vi.fn(),
    mockOrderFindMany: vi.fn().mockResolvedValue([]),
    mockOrderUpdate: vi.fn().mockResolvedValue({}),
    mockNotifySlack: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("../broker-client", () => ({
  getTachibanaClient: vi.fn().mockReturnValue({
    isLoggedIn: vi.fn().mockReturnValue(true),
    request: mockRequest,
  }),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingConfig: { findFirst: vi.fn() },
    tradingOrder: {
      findMany: mockOrderFindMany,
      update: mockOrderUpdate,
    },
  },
}));

vi.mock("../../lib/slack", () => ({
  notifySlack: mockNotifySlack,
}));

import {
  cancelOrder,
  getHoldings,
  getOrders,
  syncBrokerOrderStatuses,
} from "../broker-orders";

// ========================================
// cancelOrder
// ========================================

describe("cancelOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("取消成功 + reason あり → success notifySlack を呼ぶ", async () => {
    mockRequest.mockResolvedValue({ sResultCode: "0" });

    const result = await cancelOrder("ORD-001", "20260403", "ポジションクローズ");

    expect(result.success).toBe(true);
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "注文キャンセル",
        message: expect.stringContaining("ポジションクローズ"),
        color: "warning",
      }),
    );
  });

  it("取消失敗 + reason あり → failure notifySlack を呼ぶ", async () => {
    mockRequest.mockResolvedValue({
      sResultCode: "E001",
      sResultText: "注文が見つかりません",
    });

    const result = await cancelOrder("ORD-001", "20260403", "ポジションクローズ");

    expect(result.success).toBe(false);
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "注文キャンセル失敗",
        color: "danger",
      }),
    );
  });

  it("reason なし → notifySlack を呼ばない", async () => {
    mockRequest.mockResolvedValue({ sResultCode: "0" });

    await cancelOrder("ORD-001", "20260403");

    expect(mockNotifySlack).not.toHaveBeenCalled();
  });

  it("API例外 → { success: false, error } を返す", async () => {
    mockRequest.mockRejectedValue(new Error("Connection timeout"));

    const result = await cancelOrder("ORD-001", "20260403");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Connection timeout");
  });
});

// ========================================
// getHoldings
// ========================================

describe("getHoldings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("APIエラー（sResultCode !== '0'）→ null を返す", async () => {
    mockRequest.mockResolvedValue({
      sResultCode: "E999",
      sResultText: "認証エラー",
    });

    const result = await getHoldings();

    expect(result).toBeNull();
  });

  it("空リスト → [] を返す", async () => {
    mockRequest.mockResolvedValue({
      sResultCode: "0",
      aGenbutuKabuList: [],
    });

    const result = await getHoldings();

    expect(result).toEqual([]);
  });

  it("保有銘柄をBrokerHolding型に正しくマッピングする", async () => {
    mockRequest.mockResolvedValue({
      sResultCode: "0",
      aGenbutuKabuList: [
        {
          sUriOrderIssueCode: "7203",
          sUriOrderZanKabuSuryou: "100",
          sUriOrderUritukeKanouSuryou: "100",
          sUriOrderGaisanBokaTanka: "3200",
          sUriOrderHyoukaTanka: "3350",
          sUriOrderGaisanHyoukagaku: "335000",
          sUriOrderGaisanHyoukaSoneki: "15000",
        },
      ],
    });

    const result = await getHoldings();

    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      ticker: "7203.T",
      quantity: 100,
      sellableQuantity: 100,
      bookValuePerShare: 3200,
      marketPrice: 3350,
      marketValue: 335000,
      unrealizedPnl: 15000,
    });
  });

  it("複数銘柄を保有している場合、全件返す", async () => {
    mockRequest.mockResolvedValue({
      sResultCode: "0",
      aGenbutuKabuList: [
        {
          sUriOrderIssueCode: "7203", sUriOrderZanKabuSuryou: "100",
          sUriOrderUritukeKanouSuryou: "100", sUriOrderGaisanBokaTanka: "3200",
          sUriOrderHyoukaTanka: "3350", sUriOrderGaisanHyoukagaku: "335000",
          sUriOrderGaisanHyoukaSoneki: "15000",
        },
        {
          sUriOrderIssueCode: "6758", sUriOrderZanKabuSuryou: "50",
          sUriOrderUritukeKanouSuryou: "50", sUriOrderGaisanBokaTanka: "2800",
          sUriOrderHyoukaTanka: "2900", sUriOrderGaisanHyoukagaku: "145000",
          sUriOrderGaisanHyoukaSoneki: "5000",
        },
      ],
    });

    const result = await getHoldings();

    expect(result).toHaveLength(2);
    expect(result![0].ticker).toBe("7203.T");
    expect(result![1].ticker).toBe("6758.T");
  });
});

// ========================================
// getOrders
// ========================================

describe("getOrders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockResolvedValue({ sResultCode: "0", aOrderList: [] });
  });

  it("フィルタなし → 空tickerとデフォルトステータスフィルタで呼ぶ", async () => {
    await getOrders();

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sIssueCode: "",
      }),
    );
  });

  it("ticker指定 → ブローカーコード（.Tなし）に変換して渡す", async () => {
    await getOrders({ ticker: "7203.T" });

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sIssueCode: "7203",
      }),
    );
  });

  it("statusFilter指定 → そのまま渡す", async () => {
    await getOrders({ statusFilter: "1" });

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sOrderSyoukaiStatus: "1",
      }),
    );
  });
});

// ========================================
// syncBrokerOrderStatuses
// ========================================

describe("syncBrokerOrderStatuses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("brokerOrderIdが設定されている注文がない場合は早期リターンする", async () => {
    mockRequest.mockResolvedValue({
      sResultCode: "0",
      aOrderList: [],
    });
    mockOrderFindMany.mockResolvedValue([]);

    await syncBrokerOrderStatuses();

    expect(mockOrderUpdate).not.toHaveBeenCalled();
  });

  it("ブローカー注文がEXPIRED → DBのpending注文をexpiredに更新する", async () => {
    mockRequest.mockResolvedValue({
      sResultCode: "0",
      aOrderList: [
        {
          sOrderOrderNumber: "ORD-001",
          sOrderSikkouDay: "20260403",
          sOrderStatusCode: "12", // EXPIRED
        },
      ],
    });
    mockOrderFindMany.mockResolvedValue([
      {
        id: "order-1",
        brokerOrderId: "ORD-001",
        brokerBusinessDay: "20260403",
        brokerStatus: "1",
        status: "pending",
        stock: { tickerCode: "7203.T" },
      },
    ]);

    await syncBrokerOrderStatuses();

    expect(mockOrderUpdate).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: expect.objectContaining({
        brokerStatus: "12",
        status: "expired",
      }),
    });
  });

  it("ブローカー注文がCANCELLED → DBのpending注文をcancelledに更新する", async () => {
    mockRequest.mockResolvedValue({
      sResultCode: "0",
      aOrderList: [
        {
          sOrderOrderNumber: "ORD-002",
          sOrderSikkouDay: "20260403",
          sOrderStatusCode: "7", // CANCELLED
        },
      ],
    });
    mockOrderFindMany.mockResolvedValue([
      {
        id: "order-2",
        brokerOrderId: "ORD-002",
        brokerBusinessDay: "20260403",
        brokerStatus: "1",
        status: "pending",
        stock: { tickerCode: "6758.T" },
      },
    ]);

    await syncBrokerOrderStatuses();

    expect(mockOrderUpdate).toHaveBeenCalledWith({
      where: { id: "order-2" },
      data: expect.objectContaining({
        brokerStatus: "7",
        status: "cancelled",
      }),
    });
  });

  it("DBのbrokerStatusと一致する場合はupdateを呼ばない", async () => {
    mockRequest.mockResolvedValue({
      sResultCode: "0",
      aOrderList: [
        {
          sOrderOrderNumber: "ORD-003",
          sOrderSikkouDay: "20260403",
          sOrderStatusCode: "1", // UNFILLED（DBと同じ）
        },
      ],
    });
    mockOrderFindMany.mockResolvedValue([
      {
        id: "order-3",
        brokerOrderId: "ORD-003",
        brokerBusinessDay: "20260403",
        brokerStatus: "1", // 同じ
        status: "pending",
        stock: { tickerCode: "7203.T" },
      },
    ]);

    await syncBrokerOrderStatuses();

    expect(mockOrderUpdate).not.toHaveBeenCalled();
  });
});
