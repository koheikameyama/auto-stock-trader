import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  submitOrder,
  cancelOrder,
  modifyOrder,
  getEffectiveBrokerMode,
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

import { prisma } from "../../lib/prisma";

describe("getEffectiveBrokerMode", () => {
  beforeEach(() => {
    vi.stubEnv("BROKER_MODE", "");
  });

  it("DBにbrokerModeがある場合はそれを返す", async () => {
    vi.mocked(prisma.tradingConfig.findFirst).mockResolvedValueOnce({
      brokerMode: "dry_run",
    } as never);

    const mode = await getEffectiveBrokerMode();
    expect(mode).toBe("dry_run");
  });

  it("DBにない場合はenv変数を返す", async () => {
    vi.mocked(prisma.tradingConfig.findFirst).mockResolvedValueOnce({
      brokerMode: "",
    } as never);
    vi.stubEnv("BROKER_MODE", "live");

    const mode = await getEffectiveBrokerMode();
    expect(mode).toBe("live");
  });

  it("両方ない場合はsimulationを返す", async () => {
    vi.mocked(prisma.tradingConfig.findFirst).mockResolvedValueOnce(null);

    const mode = await getEffectiveBrokerMode();
    expect(mode).toBe("simulation");
  });
});

describe("submitOrder", () => {
  beforeEach(() => {
    vi.stubEnv("BROKER_MODE", "");
  });

  it("simulationモードでは即座に成功を返す", async () => {
    vi.mocked(prisma.tradingConfig.findFirst).mockResolvedValueOnce(null);
    vi.stubEnv("BROKER_MODE", "simulation");

    const result = await submitOrder({
      ticker: "7203.T",
      side: "buy",
      quantity: 100,
      limitPrice: 2500,
    });

    expect(result.success).toBe(true);
    expect(result.isDryRun).toBe(false);
  });

  it("dry_runモードではログ出力してモックレスポンスを返す", async () => {
    vi.mocked(prisma.tradingConfig.findFirst).mockResolvedValueOnce({
      brokerMode: "dry_run",
    } as never);

    const result = await submitOrder({
      ticker: "7203.T",
      side: "buy",
      quantity: 100,
      limitPrice: 2500,
    });

    expect(result.success).toBe(true);
    expect(result.isDryRun).toBe(true);
    expect(result.orderNumber).toMatch(/^DRY_/);
  });
});

describe("cancelOrder", () => {
  it("simulationモードでは即座に成功を返す", async () => {
    vi.mocked(prisma.tradingConfig.findFirst).mockResolvedValueOnce(null);
    vi.stubEnv("BROKER_MODE", "simulation");

    const result = await cancelOrder("12345", "20260320");
    expect(result.success).toBe(true);
  });
});

describe("modifyOrder", () => {
  it("simulationモードでは即座に成功を返す", async () => {
    vi.mocked(prisma.tradingConfig.findFirst).mockResolvedValueOnce(null);
    vi.stubEnv("BROKER_MODE", "simulation");

    const result = await modifyOrder("12345", "20260320", { price: 2600 });
    expect(result.success).toBe(true);
  });
});
