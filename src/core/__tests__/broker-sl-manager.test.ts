import { describe, it, expect, vi, beforeEach } from "vitest";

// ========================================
// モック設定
// ========================================

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingPosition: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../broker-orders", () => ({
  submitOrder: vi.fn().mockResolvedValue({
    success: true,
    orderNumber: "SL-001",
    businessDay: "20260320",
    isDryRun: false,
  }),
  cancelOrder: vi.fn().mockResolvedValue({ success: true, isDryRun: false }),
  getEffectiveBrokerMode: vi.fn().mockReturnValue("live"),
}));

vi.mock("../../lib/slack", () => ({
  notifySlack: vi.fn().mockResolvedValue(undefined),
}));

import { submitBrokerSL, cancelBrokerSL, updateBrokerSL } from "../broker-sl-manager";
import { prisma } from "../../lib/prisma";
import { submitOrder, cancelOrder, getEffectiveBrokerMode } from "../broker-orders";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as any;
const mockSubmitOrder = vi.mocked(submitOrder);
const mockCancelOrder = vi.mocked(cancelOrder);
const mockGetEffectiveBrokerMode = vi.mocked(getEffectiveBrokerMode);

// ========================================
// submitBrokerSL
// ========================================

describe("submitBrokerSL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveBrokerMode.mockReturnValue("live");
  });

  it("SL注文を発注してポジションに紐付ける", async () => {
    await submitBrokerSL({
      positionId: "pos-1",
      ticker: "7203.T",
      quantity: 100,
      stopTriggerPrice: 970,
      strategy: "swing",
    });

    expect(mockSubmitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        ticker: "7203.T",
        side: "sell",
        quantity: 100,
        limitPrice: null,
        stopTriggerPrice: 970,
      }),
    );

    // ポジションにSL注文IDを保存
    expect(mockPrisma.tradingPosition.update).toHaveBeenCalledWith({
      where: { id: "pos-1" },
      data: {
        slBrokerOrderId: "SL-001",
        slBrokerBusinessDay: "20260320",
      },
    });
  });

  it("day_tradeの場合はexpireDayを設定しない", async () => {
    await submitBrokerSL({
      positionId: "pos-1",
      ticker: "7203.T",
      quantity: 100,
      stopTriggerPrice: 970,
      strategy: "day_trade",
    });

    expect(mockSubmitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        expireDay: undefined,
      }),
    );
  });

  it("swingの場合はexpireDayを設定する", async () => {
    await submitBrokerSL({
      positionId: "pos-1",
      ticker: "7203.T",
      quantity: 100,
      stopTriggerPrice: 970,
      strategy: "swing",
    });

    const call = mockSubmitOrder.mock.calls[0][0];
    expect(call.expireDay).toBeDefined();
    expect(call.expireDay).toMatch(/^\d{8}$/); // YYYYMMDD
  });

  it("simulationモードでは何もしない", async () => {
    mockGetEffectiveBrokerMode.mockReturnValue("simulation");

    await submitBrokerSL({
      positionId: "pos-1",
      ticker: "7203.T",
      quantity: 100,
      stopTriggerPrice: 970,
      strategy: "swing",
    });

    expect(mockSubmitOrder).not.toHaveBeenCalled();
    expect(mockPrisma.tradingPosition.update).not.toHaveBeenCalled();
  });

  it("submitOrder失敗時もthrowしない", async () => {
    mockSubmitOrder.mockResolvedValue({
      success: false,
      error: "API error",
      isDryRun: false,
    });

    await expect(
      submitBrokerSL({
        positionId: "pos-1",
        ticker: "7203.T",
        quantity: 100,
        stopTriggerPrice: 970,
        strategy: "swing",
      }),
    ).resolves.not.toThrow();

    // ポジション更新はされない
    expect(mockPrisma.tradingPosition.update).not.toHaveBeenCalled();
  });
});

// ========================================
// cancelBrokerSL
// ========================================

describe("cancelBrokerSL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveBrokerMode.mockReturnValue("live");
  });

  it("SL注文を取消してフィールドをクリアする", async () => {
    mockPrisma.tradingPosition.findUnique.mockResolvedValue({
      slBrokerOrderId: "SL-001",
      slBrokerBusinessDay: "20260320",
    });

    await cancelBrokerSL("pos-1");

    expect(mockCancelOrder).toHaveBeenCalledWith("SL-001", "20260320");
    expect(mockPrisma.tradingPosition.update).toHaveBeenCalledWith({
      where: { id: "pos-1" },
      data: {
        slBrokerOrderId: null,
        slBrokerBusinessDay: null,
      },
    });
  });

  it("SL注文が紐付いていない場合は何もしない", async () => {
    mockPrisma.tradingPosition.findUnique.mockResolvedValue({
      slBrokerOrderId: null,
      slBrokerBusinessDay: null,
    });

    await cancelBrokerSL("pos-1");

    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(mockPrisma.tradingPosition.update).not.toHaveBeenCalled();
  });

  it("simulationモードでは何もしない", async () => {
    mockGetEffectiveBrokerMode.mockReturnValue("simulation");

    await cancelBrokerSL("pos-1");

    expect(mockPrisma.tradingPosition.findUnique).not.toHaveBeenCalled();
    expect(mockCancelOrder).not.toHaveBeenCalled();
  });

  it("cancelOrder失敗時もフィールドをクリアする", async () => {
    mockPrisma.tradingPosition.findUnique.mockResolvedValue({
      slBrokerOrderId: "SL-001",
      slBrokerBusinessDay: "20260320",
    });
    mockCancelOrder.mockResolvedValue({
      success: false,
      error: "Order already filled",
      isDryRun: false,
    });

    await cancelBrokerSL("pos-1");

    // 取消失敗でもフィールドはクリア（約定済みの場合など）
    expect(mockPrisma.tradingPosition.update).toHaveBeenCalledWith({
      where: { id: "pos-1" },
      data: {
        slBrokerOrderId: null,
        slBrokerBusinessDay: null,
      },
    });
  });
});

// ========================================
// updateBrokerSL
// ========================================

describe("updateBrokerSL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveBrokerMode.mockReturnValue("live");
  });

  it("cancel → resubmit の順序で実行する", async () => {
    mockPrisma.tradingPosition.findUnique.mockResolvedValue({
      slBrokerOrderId: "SL-OLD",
      slBrokerBusinessDay: "20260320",
    });

    const callOrder: string[] = [];
    mockCancelOrder.mockImplementation(async () => {
      callOrder.push("cancel");
      return { success: true, isDryRun: false };
    });
    mockSubmitOrder.mockImplementation(async () => {
      callOrder.push("submit");
      return {
        success: true,
        orderNumber: "SL-NEW",
        businessDay: "20260320",
        isDryRun: false,
      };
    });

    await updateBrokerSL({
      positionId: "pos-1",
      ticker: "7203.T",
      quantity: 100,
      newStopTriggerPrice: 980,
      strategy: "swing",
    });

    expect(callOrder).toEqual(["cancel", "submit"]);
    expect(mockCancelOrder).toHaveBeenCalledWith("SL-OLD", "20260320");
    expect(mockSubmitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        stopTriggerPrice: 980,
      }),
    );
  });

  it("simulationモードでは何もしない", async () => {
    mockGetEffectiveBrokerMode.mockReturnValue("simulation");

    await updateBrokerSL({
      positionId: "pos-1",
      ticker: "7203.T",
      quantity: 100,
      newStopTriggerPrice: 980,
      strategy: "swing",
    });

    expect(mockCancelOrder).not.toHaveBeenCalled();
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });
});
