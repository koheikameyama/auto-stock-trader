import { describe, it, expect, vi, beforeEach } from "vitest";

// ========================================
// モック設定
// ========================================

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingOrder: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    tradingPosition: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("../broker-orders", () => ({
  getOrderDetail: vi.fn(),
}));

vi.mock("../broker-sl-manager", () => ({
  submitBrokerSL: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../order-executor", () => ({
  fillOrder: vi.fn(),
}));

vi.mock("../position-manager", () => ({
  openPosition: vi.fn().mockResolvedValue({ id: "pos-123" }),
  closePosition: vi.fn().mockResolvedValue({ realizedPnl: 5000 }),
}));

vi.mock("../risk-manager", () => ({
  validateStopLoss: vi.fn().mockReturnValue({
    validatedPrice: 970,
    wasOverridden: false,
    reason: "",
  }),
}));

vi.mock("../../lib/slack", () => ({
  notifyOrderFilled: vi.fn(),
  notifySlack: vi.fn(),
}));

import { handleBrokerFill } from "../broker-fill-handler";
import { prisma } from "../../lib/prisma";
import { getOrderDetail } from "../broker-orders";
import { submitBrokerSL } from "../broker-sl-manager";
import { fillOrder } from "../order-executor";
import { openPosition, closePosition } from "../position-manager";
import { notifyOrderFilled } from "../../lib/slack";
import type { ExecutionEvent } from "../broker-event-stream";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as any;
const mockGetOrderDetail = vi.mocked(getOrderDetail);
const mockSubmitBrokerSL = vi.mocked(submitBrokerSL);
const mockFillOrder = vi.mocked(fillOrder);
const mockOpenPosition = vi.mocked(openPosition);
const mockClosePosition = vi.mocked(closePosition);
const mockNotifyOrderFilled = vi.mocked(notifyOrderFilled);

// ========================================
// テストデータ
// ========================================

function makeEvent(overrides?: Partial<ExecutionEvent>): ExecutionEvent {
  return {
    orderNumber: "123456",
    businessDay: "20260320",
    raw: { p_cmd: "EC", p_order_number: "123456", p_eigyou_day: "20260320" },
    ...overrides,
  };
}

function makeOrder(overrides?: Record<string, unknown>) {
  return {
    id: "order-1",
    stockId: "stock-1",
    strategy: "swing",
    side: "buy",
    quantity: 100,
    status: "pending",
    brokerStatus: null,
    positionId: null,
    takeProfitPrice: 1050,
    stopLossPrice: 970,
    entrySnapshot: { technicals: { atr14: 30 } },
    stock: { tickerCode: "7203.T", name: "トヨタ自動車" },
    ...overrides,
  };
}

function makeOrderDetail(overrides?: Record<string, unknown>) {
  return {
    sResultCode: "0",
    sCLMID: "CLMOrderListDetail",
    sOrderStatus: "10", // FULLY_FILLED
    aYakuzyouSikkouList: [
      { sYakuzyouPrice: "1000", sYakuzyouSuryou: "100" },
    ],
    ...overrides,
  };
}

// ========================================
// テスト
// ========================================

describe("handleBrokerFill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("DBに該当注文がない場合は何もしない", async () => {
    mockPrisma.tradingOrder.findFirst.mockResolvedValue(null);

    await handleBrokerFill(makeEvent());

    expect(mockFillOrder).not.toHaveBeenCalled();
    expect(mockOpenPosition).not.toHaveBeenCalled();
  });

  it("既にfilled状態の注文はスキップする", async () => {
    mockPrisma.tradingOrder.findFirst.mockResolvedValue(
      makeOrder({ status: "filled" }) as never,
    );

    await handleBrokerFill(makeEvent());

    expect(mockFillOrder).not.toHaveBeenCalled();
  });

  it("既にcancelled状態の注文はスキップする", async () => {
    mockPrisma.tradingOrder.findFirst.mockResolvedValue(
      makeOrder({ status: "cancelled" }) as never,
    );

    await handleBrokerFill(makeEvent());

    expect(mockFillOrder).not.toHaveBeenCalled();
  });

  it("注文詳細が取得できない場合は何もしない", async () => {
    mockPrisma.tradingOrder.findFirst.mockResolvedValue(
      makeOrder() as never,
    );
    mockGetOrderDetail.mockResolvedValue(null);

    await handleBrokerFill(makeEvent());

    expect(mockFillOrder).not.toHaveBeenCalled();
  });

  it("全部約定でない場合はbrokerStatusのみ更新する", async () => {
    mockPrisma.tradingOrder.findFirst.mockResolvedValue(
      makeOrder() as never,
    );
    mockGetOrderDetail.mockResolvedValue(
      makeOrderDetail({ sOrderStatus: "1" }) as never, // UNFILLED
    );

    await handleBrokerFill(makeEvent());

    expect(mockPrisma.tradingOrder.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { brokerStatus: "1" },
    });
    expect(mockFillOrder).not.toHaveBeenCalled();
  });

  describe("買い約定", () => {
    it("ポジションをオープンし注文に紐付ける", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder() as never,
      );
      mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);
      mockPrisma.tradingPosition.findFirst.mockResolvedValue(null);

      await handleBrokerFill(makeEvent());

      expect(mockFillOrder).toHaveBeenCalledWith("order-1", 1000);
      expect(mockOpenPosition).toHaveBeenCalledWith(
        "stock-1",
        "swing",
        1000,
        100,
        expect.any(Number), // takeProfitPrice
        expect.any(Number), // stopLossPrice
        expect.any(Object), // entrySnapshot
        30, // entryAtr
      );
      // ポジションIDの紐付け
      expect(mockPrisma.tradingOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "order-1" },
          data: expect.objectContaining({ positionId: "pos-123" }),
        }),
      );
    });

    it("SL注文をブローカーに発注する", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder() as never,
      );
      mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);
      mockPrisma.tradingPosition.findFirst.mockResolvedValue(null);

      await handleBrokerFill(makeEvent());

      expect(mockSubmitBrokerSL).toHaveBeenCalledWith(
        expect.objectContaining({
          positionId: "pos-123",
          ticker: "7203.T",
          quantity: 100,
          strategy: "swing",
        }),
      );
    });

    it("同一銘柄のopenポジションがある場合はキャンセルする", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder() as never,
      );
      mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);
      mockPrisma.tradingPosition.findFirst.mockResolvedValue({
        id: "existing-pos",
      } as never);

      await handleBrokerFill(makeEvent());

      expect(mockFillOrder).toHaveBeenCalled();
      expect(mockOpenPosition).not.toHaveBeenCalled();
      expect(mockPrisma.tradingOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "cancelled" }),
        }),
      );
    });

    it("Slack通知を送信する", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder() as never,
      );
      mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);
      mockPrisma.tradingPosition.findFirst.mockResolvedValue(null);

      await handleBrokerFill(makeEvent());

      expect(mockNotifyOrderFilled).toHaveBeenCalledWith(
        expect.objectContaining({
          tickerCode: "7203.T",
          side: "buy",
          filledPrice: 1000,
          quantity: 100,
        }),
      );
    });
  });

  describe("売り約定", () => {
    it("ポジションをクローズし損益を計算する", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder({ side: "sell", positionId: "pos-456" }) as never,
      );
      mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);

      await handleBrokerFill(makeEvent());

      expect(mockFillOrder).toHaveBeenCalledWith("order-1", 1000);
      expect(mockClosePosition).toHaveBeenCalledWith(
        "pos-456",
        1000,
        expect.any(Object),
      );
      expect(mockNotifyOrderFilled).toHaveBeenCalledWith(
        expect.objectContaining({
          side: "sell",
          pnl: 5000,
        }),
      );
    });

    it("positionIdがない売り注文でもクラッシュしない", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder({ side: "sell", positionId: null }) as never,
      );
      mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);

      await handleBrokerFill(makeEvent());

      expect(mockFillOrder).toHaveBeenCalled();
      expect(mockClosePosition).not.toHaveBeenCalled();
      expect(mockNotifyOrderFilled).toHaveBeenCalledWith(
        expect.objectContaining({
          side: "sell",
          pnl: 0,
        }),
      );
    });
  });

  describe("加重平均約定価格", () => {
    it("複数回に分けて約定した場合の加重平均を計算する", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder({ side: "sell", positionId: "pos-789" }) as never,
      );
      mockGetOrderDetail.mockResolvedValue(
        makeOrderDetail({
          aYakuzyouSikkouList: [
            { sYakuzyouPrice: "1000", sYakuzyouSuryou: "60" },
            { sYakuzyouPrice: "1010", sYakuzyouSuryou: "40" },
          ],
        }) as never,
      );

      await handleBrokerFill(makeEvent());

      // 加重平均: (1000*60 + 1010*40) / 100 = 100400 / 100 = 1004
      expect(mockFillOrder).toHaveBeenCalledWith("order-1", 1004);
    });

    it("約定価格が0の場合は処理しない", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder() as never,
      );
      mockGetOrderDetail.mockResolvedValue(
        makeOrderDetail({
          aYakuzyouSikkouList: [
            { sYakuzyouPrice: "0", sYakuzyouSuryou: "100" },
          ],
        }) as never,
      );

      await handleBrokerFill(makeEvent());

      expect(mockFillOrder).not.toHaveBeenCalled();
    });
  });
});
