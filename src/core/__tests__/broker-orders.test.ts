import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  syncBrokerOrderStatuses,
} from "../broker-orders";

// prismaモック
vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingConfig: {
      findFirst: vi.fn(),
    },
    tradingOrder: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
  },
}));

// slackモック
vi.mock("../../lib/slack", () => ({
  notifySlack: vi.fn().mockResolvedValue(undefined),
}));

// broker-clientモック
vi.mock("../broker-client", () => ({
  getTachibanaClient: vi.fn().mockReturnValue({
    isLoggedIn: vi.fn().mockReturnValue(false),
    request: vi.fn(),
  }),
}));

describe("syncBrokerOrderStatuses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("brokerOrderIdが未設定のpending買い注文を自動キャンセルしSlackに通知する", async () => {
    const { prisma } = await import("../../lib/prisma");
    const { notifySlack } = await import("../../lib/slack");
    const { getTachibanaClient } = await import("../broker-client");

    vi.mocked(getTachibanaClient).mockReturnValue({
      isLoggedIn: vi.fn().mockReturnValue(true),
      request: vi.fn().mockResolvedValue({
        sResultCode: "0",
        aOrderList: [],
      }),
    } as unknown as ReturnType<typeof getTachibanaClient>);

    const orphanOrder = {
      id: "order-orphan-1",
      brokerOrderId: null,
      brokerBusinessDay: null,
      brokerStatus: null,
      status: "pending",
      side: "buy",
      stock: { tickerCode: "7203.T" },
    };

    vi.mocked(prisma.tradingOrder.findMany)
      .mockResolvedValueOnce([orphanOrder] as never) // orphan query
      .mockResolvedValueOnce([]); // existing sync query

    await syncBrokerOrderStatuses();

    expect(prisma.tradingOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-orphan-1" },
        data: { status: "cancelled" },
      }),
    );
    expect(notifySlack).toHaveBeenCalledWith(
      expect.objectContaining({ color: "danger" }),
    );
  });
});
