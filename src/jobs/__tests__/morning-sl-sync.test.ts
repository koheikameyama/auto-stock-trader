import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPositionFindMany, mockPositionUpdate, mockSubmitBrokerSL, mockNotifySlack } =
  vi.hoisted(() => ({
    mockPositionFindMany: vi.fn(),
    mockPositionUpdate: vi.fn().mockResolvedValue({}),
    mockSubmitBrokerSL: vi.fn().mockResolvedValue(undefined),
    mockNotifySlack: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingPosition: {
      findMany: mockPositionFindMany,
      update: mockPositionUpdate,
    },
  },
}));

vi.mock("../../core/broker-sl-manager", () => ({
  submitBrokerSL: mockSubmitBrokerSL,
}));

vi.mock("../../lib/slack", () => ({
  notifySlack: mockNotifySlack,
}));

// broker-client は直接実行ブランチのみで使うためモック
vi.mock("../../core/broker-client", () => ({
  getTachibanaClient: vi.fn(),
}));

import { main } from "../morning-sl-sync";

// テスト用ポジションファクトリ
function makePosition(overrides: {
  id?: string;
  ticker?: string;
  slBrokerOrderId?: string | null;
  trailingStopPrice?: number | null;
  stopLossPrice?: number | null;
  quantity?: number;
  strategy?: string;
}) {
  return {
    id: overrides.id ?? "pos-1",
    quantity: overrides.quantity ?? 100,
    strategy: overrides.strategy ?? "breakout",
    slBrokerOrderId: overrides.slBrokerOrderId ?? null,
    slBrokerBusinessDay: overrides.slBrokerOrderId ? "20260403" : null,
    trailingStopPrice: overrides.trailingStopPrice ?? null,
    stopLossPrice: overrides.stopLossPrice ?? 900,
    stock: {
      tickerCode: overrides.ticker ?? "7203.T",
      name: "トヨタ自動車",
    },
  };
}

describe("morning-sl-sync: main()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ────────────────────────────────────────────────────────────
  // 1. オープンポジションなし → 何もしない
  // ────────────────────────────────────────────────────────────
  it("オープンポジションが0件の場合、submitBrokerSLを呼ばない", async () => {
    mockPositionFindMany.mockResolvedValue([]);

    await main();

    expect(mockSubmitBrokerSL).not.toHaveBeenCalled();
    expect(mockNotifySlack).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────
  // 2. 旧SL注文IDがある場合 → update(null) → submitBrokerSL の順
  // ────────────────────────────────────────────────────────────
  it("旧SL注文IDをクリアしてからsubmitBrokerSLを呼ぶ", async () => {
    mockPositionFindMany.mockResolvedValue([
      makePosition({ slBrokerOrderId: "SL-OLD-001", stopLossPrice: 900 }),
    ]);

    const callOrder: string[] = [];
    mockPositionUpdate.mockImplementation(async () => {
      callOrder.push("update");
      return {};
    });
    mockSubmitBrokerSL.mockImplementation(async () => {
      callOrder.push("submit");
    });

    await main();

    expect(callOrder).toEqual(["update", "submit"]);
    expect(mockPositionUpdate).toHaveBeenCalledWith({
      where: { id: "pos-1" },
      data: { slBrokerOrderId: null, slBrokerBusinessDay: null },
    });
  });

  // ────────────────────────────────────────────────────────────
  // 3. trailingStopPrice が設定されている場合 → その価格で発注
  // ────────────────────────────────────────────────────────────
  it("trailingStopPriceがある場合、stopLossPriceではなくtrailingStopPriceで発注する", async () => {
    mockPositionFindMany.mockResolvedValue([
      makePosition({ trailingStopPrice: 980, stopLossPrice: 900 }),
    ]);

    await main();

    expect(mockSubmitBrokerSL).toHaveBeenCalledWith(
      expect.objectContaining({ stopTriggerPrice: 980 }),
    );
  });

  // ────────────────────────────────────────────────────────────
  // 4. trailingStopPrice が null → stopLossPrice にフォールバック
  // ────────────────────────────────────────────────────────────
  it("trailingStopPriceがnullの場合、stopLossPriceで発注する", async () => {
    mockPositionFindMany.mockResolvedValue([
      makePosition({ trailingStopPrice: null, stopLossPrice: 850 }),
    ]);

    await main();

    expect(mockSubmitBrokerSL).toHaveBeenCalledWith(
      expect.objectContaining({ stopTriggerPrice: 850 }),
    );
  });

  // ────────────────────────────────────────────────────────────
  // 5. stopPrice ≤ 0 → スキップ（submitBrokerSL を呼ばない）
  // ────────────────────────────────────────────────────────────
  it("SL価格が0以下のポジションはsubmitBrokerSLをスキップする", async () => {
    mockPositionFindMany.mockResolvedValue([
      makePosition({ trailingStopPrice: null, stopLossPrice: 0 }),
    ]);

    await main();

    expect(mockSubmitBrokerSL).not.toHaveBeenCalled();
    // Slack通知は送られる（failCount > 0）
    expect(mockNotifySlack).toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────
  // 6. submitBrokerSL が例外 → 他ポジションの処理は継続する
  // ────────────────────────────────────────────────────────────
  it("submitBrokerSLが1件目で例外を投げても2件目は処理される", async () => {
    mockPositionFindMany.mockResolvedValue([
      makePosition({ id: "pos-1", ticker: "7203.T", stopLossPrice: 900 }),
      makePosition({ id: "pos-2", ticker: "6758.T", stopLossPrice: 800 }),
    ]);

    mockSubmitBrokerSL
      .mockRejectedValueOnce(new Error("API timeout"))
      .mockResolvedValueOnce(undefined);

    await main();

    expect(mockSubmitBrokerSL).toHaveBeenCalledTimes(2);
  });

  // ────────────────────────────────────────────────────────────
  // 7. Slack通知に成功/失敗件数が含まれる
  // ────────────────────────────────────────────────────────────
  it("Slack通知メッセージに成功件数と失敗件数が含まれる", async () => {
    mockPositionFindMany.mockResolvedValue([
      makePosition({ id: "pos-1", stopLossPrice: 900 }),        // 成功
      makePosition({ id: "pos-2", stopLossPrice: 0 }),           // 失敗（SL価格なし）
    ]);

    await main();

    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("成功: 1件"),
      }),
    );
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("失敗: 1件"),
      }),
    );
  });
});
