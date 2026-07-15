import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingPosition: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../../core/broker-sl-manager", () => ({
  submitBrokerSL: vi.fn(),
}));

vi.mock("../../lib/slack", () => ({
  notifySlack: vi.fn().mockResolvedValue(undefined),
}));

import { main, resetSLFailureCounts } from "../ensure-broker-sl";
import { prisma } from "../../lib/prisma";
import { submitBrokerSL } from "../../core/broker-sl-manager";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as any;
const mockSubmit = vi.mocked(submitBrokerSL);

function makePosition(overrides?: Record<string, unknown>) {
  return {
    id: "pos-1",
    quantity: 100,
    stopLossPrice: 880,
    strategy: "panic",
    stock: { tickerCode: "1321" },
    ...overrides,
  };
}

describe("ensure-broker-sl のリトライ制御 (KOH-555)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSLFailureCounts();
    mockPrisma.tradingPosition.findMany.mockResolvedValue([makePosition()]);
  });

  it("SL未発注ポジションに再発注する", async () => {
    mockSubmit.mockResolvedValue(true);

    await main();

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ positionId: "pos-1", ticker: "1321", strategy: "panic" }),
    );
  });

  it("成功が続く限り何度でも再発注する（正常な期限更新でリトライ枠を使い切らない）", async () => {
    // 立花の sOrderExpireDay は最大10営業日なので、20営業日保有する panic/buyback の
    // 逆指値は正常系でも期限が来て再発注される。通算で数えると数回で上限に達し、
    // そのポジションが恒久的に SL 無しになるのが修正前の挙動だった。
    mockSubmit.mockResolvedValue(true);

    for (let i = 0; i < 5; i++) await main();

    expect(mockSubmit).toHaveBeenCalledTimes(5);
  });

  it("連続失敗が上限に達したら再発注を止める", async () => {
    mockSubmit.mockResolvedValue(false);

    for (let i = 0; i < 5; i++) await main();

    // MAX_SL_RETRIES = 3 回まで試して打ち止め
    expect(mockSubmit).toHaveBeenCalledTimes(3);
  });

  it("途中で成功したら連続失敗カウントがリセットされる", async () => {
    mockSubmit.mockResolvedValueOnce(false).mockResolvedValueOnce(false); // 2連敗
    mockSubmit.mockResolvedValueOnce(true); // 成功 → リセット
    mockSubmit.mockResolvedValue(false); // 以降また失敗

    for (let i = 0; i < 7; i++) await main();

    // 2失敗 + 1成功 + 3失敗 = 6回試行して打ち止め（リセットが無ければ3回で止まる）
    expect(mockSubmit).toHaveBeenCalledTimes(6);
  });

  it("stopLossPrice が未設定のポジションはスキップする", async () => {
    mockPrisma.tradingPosition.findMany.mockResolvedValue([
      makePosition({ stopLossPrice: null }),
    ]);

    await main();

    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
