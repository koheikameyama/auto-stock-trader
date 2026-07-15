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
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

// API 呼び出し系のみモックし、extractFilledPrice のような純粋関数は実装をそのまま使う
vi.mock("../broker-orders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../broker-orders")>();
  return { ...actual, getOrderDetail: vi.fn() };
});

vi.mock("../broker-sl-manager", () => ({
  submitBrokerSL: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../order-executor", () => ({
  // 既定は claim 成功（=このイベントが勝者）。重複配信の敗者ケースは個別に false を返させる
  claimOrderFill: vi.fn().mockResolvedValue(true),
}));

vi.mock("../position-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../position-manager")>();
  return {
    ...actual,
    openPosition: vi.fn().mockResolvedValue({ id: "pos-123" }),
    closePosition: vi.fn().mockResolvedValue({ entryPrice: 1000, exitPrice: 1050, quantity: 100 }),
  };
});

vi.mock("../risk-manager", () => ({
  validateStopLoss: vi.fn().mockReturnValue({
    validatedPrice: 970,
    wasOverridden: false,
    reason: "",
  }),
}));

vi.mock("../../lib/slack", () => ({
  notifyOrderFilled: vi.fn(),
  notifySlack: vi.fn().mockResolvedValue(undefined),
}));

// 大引け後の受付停止窓の判定を制御可能にする（既定=場中扱いで即時SL発注）
vi.mock("../../lib/market-date", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/market-date")>();
  return {
    ...actual,
    isPostCloseOrderBlackout: vi.fn().mockReturnValue(false),
  };
});

import { handleBrokerFill } from "../broker-fill-handler";
import { prisma } from "../../lib/prisma";
import { getOrderDetail } from "../broker-orders";
import { submitBrokerSL } from "../broker-sl-manager";
import { claimOrderFill } from "../order-executor";
import { openPosition, closePosition } from "../position-manager";
import { notifyOrderFilled } from "../../lib/slack";
import { isPostCloseOrderBlackout } from "../../lib/market-date";
import type { ExecutionEvent } from "../broker-event-stream";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as any;
const mockGetOrderDetail = vi.mocked(getOrderDetail);
const mockSubmitBrokerSL = vi.mocked(submitBrokerSL);
const mockClaimOrderFill = vi.mocked(claimOrderFill);
const mockOpenPosition = vi.mocked(openPosition);
const mockClosePosition = vi.mocked(closePosition);
const mockNotifyOrderFilled = vi.mocked(notifyOrderFilled);
const mockIsBlackout = vi.mocked(isPostCloseOrderBlackout);

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
    strategy: "breakout",
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
    // 既定は「場中扱い」= 即時SL発注。受付停止窓のテストで個別に true へ上書きする。
    mockIsBlackout.mockReturnValue(false);
  });

  it("DBに該当注文がない場合は何もしない", async () => {
    mockPrisma.tradingOrder.findFirst.mockResolvedValue(null);

    await handleBrokerFill(makeEvent());

    expect(mockClaimOrderFill).not.toHaveBeenCalled();
    expect(mockOpenPosition).not.toHaveBeenCalled();
  });

  it("既にfilled状態の注文はスキップする", async () => {
    mockPrisma.tradingOrder.findFirst.mockResolvedValue(
      makeOrder({ status: "filled" }) as never,
    );

    await handleBrokerFill(makeEvent());

    expect(mockClaimOrderFill).not.toHaveBeenCalled();
  });

  it("既にcancelled状態の注文はスキップする", async () => {
    mockPrisma.tradingOrder.findFirst.mockResolvedValue(
      makeOrder({ status: "cancelled" }) as never,
    );

    await handleBrokerFill(makeEvent());

    expect(mockClaimOrderFill).not.toHaveBeenCalled();
  });

  it("注文詳細が取得できない場合は何もしない", async () => {
    mockPrisma.tradingOrder.findFirst.mockResolvedValue(
      makeOrder() as never,
    );
    mockGetOrderDetail.mockResolvedValue(null);

    await handleBrokerFill(makeEvent());

    expect(mockClaimOrderFill).not.toHaveBeenCalled();
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
    expect(mockClaimOrderFill).not.toHaveBeenCalled();
  });

  describe("買い約定", () => {
    it("ポジションをオープンし注文に紐付ける", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder() as never,
      );
      mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);
      mockPrisma.tradingPosition.findFirst.mockResolvedValue(null);

      await handleBrokerFill(makeEvent());

      expect(mockClaimOrderFill).toHaveBeenCalledWith("order-1", 1000);
      expect(mockOpenPosition).toHaveBeenCalledWith(
        "stock-1",
        "breakout",
        1000,
        100,
        expect.any(Number), // takeProfitPrice
        expect.any(Number), // stopLossPrice
        expect.any(Object), // entrySnapshot
        30, // entryAtr
        undefined, // regimeInfo (entrySnapshot に regimeInfo ブロックなし)
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
          strategy: "breakout",
        }),
      );
    });

    it("大引け後の受付停止窓では即時SL発注をスキップする（ensure-broker-sl に委譲）", async () => {
      mockIsBlackout.mockReturnValue(true);
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder() as never,
      );
      mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);
      mockPrisma.tradingPosition.findFirst.mockResolvedValue(null);

      await handleBrokerFill(makeEvent());

      // ポジションのオープン自体は行う（stopLossPrice が DB に残り ensure-broker-sl が拾う）
      expect(mockOpenPosition).toHaveBeenCalled();
      // 受付停止窓では即時SL発注はしない
      expect(mockSubmitBrokerSL).not.toHaveBeenCalled();
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

      expect(mockClaimOrderFill).toHaveBeenCalled();
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
      mockPrisma.tradingPosition.findUnique.mockResolvedValue(
        { entryPrice: 1000, exitSnapshot: null } as never,
      );
      mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);

      await handleBrokerFill(makeEvent());

      expect(mockClaimOrderFill).toHaveBeenCalledWith("order-1", 1000);
      expect(mockClosePosition).toHaveBeenCalledWith(
        "pos-456",
        1000,
        expect.any(Object),
        null, // referencePrice: SL/trailingStop未設定時は null
      );
      expect(mockNotifyOrderFilled).toHaveBeenCalledWith(
        expect.objectContaining({
          side: "sell",
          pnl: expect.any(Number),
        }),
      );
    });

    it("trailingStopPriceがある場合は referencePrice として渡す", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder({ side: "sell", positionId: "pos-500" }) as never,
      );
      mockPrisma.tradingPosition.findUnique.mockResolvedValue(
        {
          entryPrice: 1000,
          exitSnapshot: null,
          stopLossPrice: 950,
          trailingStopPrice: 970,
        } as never,
      );
      mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);

      await handleBrokerFill(makeEvent());

      // trailingStop=970 を referencePrice として closePosition に渡す
      expect(mockClosePosition).toHaveBeenCalledWith(
        "pos-500",
        1000,
        expect.any(Object),
        970,
      );
    });

    it("trailingStopPriceがnullの場合は stopLossPrice を referencePrice として渡す", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder({ side: "sell", positionId: "pos-501" }) as never,
      );
      mockPrisma.tradingPosition.findUnique.mockResolvedValue(
        {
          entryPrice: 1000,
          exitSnapshot: null,
          stopLossPrice: 950,
          trailingStopPrice: null,
        } as never,
      );
      mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);

      await handleBrokerFill(makeEvent());

      expect(mockClosePosition).toHaveBeenCalledWith(
        "pos-501",
        1000,
        expect.any(Object),
        950,
      );
    });

    it("positionIdがない売り注文でもクラッシュしない", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder({ side: "sell", positionId: null }) as never,
      );
      mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);

      await handleBrokerFill(makeEvent());

      expect(mockClaimOrderFill).toHaveBeenCalled();
      expect(mockClosePosition).not.toHaveBeenCalled();
      expect(mockNotifyOrderFilled).toHaveBeenCalledWith(
        expect.objectContaining({
          side: "sell",
          pnl: 0,
        }),
      );
    });
  });

  describe("SL約定（逆指値・TradingOrderなし）", () => {
    function makeSLPosition(overrides?: Record<string, unknown>) {
      return {
        id: "pos-sl-1",
        quantity: 200,
        strategy: "gapup",
        entryPrice: 1398,
        stopLossPrice: 1366,
        trailingStopPrice: null,
        slBrokerOrderId: "123456",
        slBrokerBusinessDay: "20260701",
        stock: { tickerCode: "3989.T", name: "シェアリングテクノロジー" },
        ...overrides,
      };
    }

    it("TradingOrderが無くslBrokerOrderId一致のopenポジションがあればSL約定としてクローズする", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(null);
      mockPrisma.tradingPosition.findFirst.mockResolvedValue(makeSLPosition() as never);
      mockGetOrderDetail.mockResolvedValue(
        makeOrderDetail({
          aYakuzyouSikkouList: [{ sYakuzyouPrice: "1334", sYakuzyouSuryou: "200" }],
        }) as never,
      );
      mockPrisma.tradingPosition.findUnique.mockResolvedValue({ status: "open" } as never);

      await handleBrokerFill(makeEvent({ orderNumber: "123456", businessDay: "20260701" }));

      // 実約定価格 ¥1334 でクローズ、想定決済価格(SL 1366)を referencePrice に
      expect(mockClosePosition).toHaveBeenCalledWith(
        "pos-sl-1",
        1334,
        expect.objectContaining({ exitReason: "SL約定（ブローカー自律執行）", exitPrice: 1334 }),
        1366,
      );
      // slBrokerOrderId をクリア
      expect(mockPrisma.tradingPosition.update).toHaveBeenCalledWith({
        where: { id: "pos-sl-1" },
        data: { slBrokerOrderId: null, slBrokerBusinessDay: null },
      });
      expect(mockNotifyOrderFilled).toHaveBeenCalledWith(
        expect.objectContaining({ side: "sell", filledPrice: 1334, exitReason: "SL約定" }),
      );
    });

    it("ポジションが既にクローズ済みなら二重クローズしない（べき等）", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(null);
      mockPrisma.tradingPosition.findFirst.mockResolvedValue(makeSLPosition() as never);
      mockGetOrderDetail.mockResolvedValue(
        makeOrderDetail({
          aYakuzyouSikkouList: [{ sYakuzyouPrice: "1334", sYakuzyouSuryou: "200" }],
        }) as never,
      );
      mockPrisma.tradingPosition.findUnique.mockResolvedValue({ status: "closed" } as never);

      await handleBrokerFill(makeEvent({ orderNumber: "123456", businessDay: "20260701" }));

      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it("SL約定価格が異常に低い場合は自動クローズを中止する", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(null);
      mockPrisma.tradingPosition.findFirst.mockResolvedValue(makeSLPosition() as never);
      // entry 1398 × 0.9 = 1258.2 未満 → 異常値
      mockGetOrderDetail.mockResolvedValue(
        makeOrderDetail({
          aYakuzyouSikkouList: [{ sYakuzyouPrice: "800", sYakuzyouSuryou: "200" }],
        }) as never,
      );
      mockPrisma.tradingPosition.findUnique.mockResolvedValue({ status: "open" } as never);

      await handleBrokerFill(makeEvent({ orderNumber: "123456", businessDay: "20260701" }));

      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it("SL注文がまだ全部約定でない場合は何もしない", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(null);
      mockPrisma.tradingPosition.findFirst.mockResolvedValue(makeSLPosition() as never);
      mockGetOrderDetail.mockResolvedValue(makeOrderDetail({ sOrderStatus: "1" }) as never); // UNFILLED

      await handleBrokerFill(makeEvent({ orderNumber: "123456", businessDay: "20260701" }));

      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it("slBrokerBusinessDay 欠落（空文字）でも EC イベントの営業日でバックフィルしてクローズする（KOH-532）", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(null);
      mockPrisma.tradingPosition.findFirst.mockResolvedValue(
        makeSLPosition({ slBrokerBusinessDay: "" }) as never,
      );
      mockGetOrderDetail.mockResolvedValue(
        makeOrderDetail({
          aYakuzyouSikkouList: [{ sYakuzyouPrice: "1334", sYakuzyouSuryou: "200" }],
        }) as never,
      );
      mockPrisma.tradingPosition.findUnique.mockResolvedValue({ status: "open" } as never);

      await handleBrokerFill(makeEvent({ orderNumber: "123456", businessDay: "20260707" }));

      // EC イベントの営業日でバックフィル
      expect(mockPrisma.tradingPosition.update).toHaveBeenCalledWith({
        where: { id: "pos-sl-1" },
        data: { slBrokerBusinessDay: "20260707" },
      });
      // バックフィルした営業日で約定詳細を取得してクローズ
      expect(mockGetOrderDetail).toHaveBeenCalledWith("123456", "20260707");
      expect(mockClosePosition).toHaveBeenCalledWith(
        "pos-sl-1",
        1334,
        expect.objectContaining({ exitReason: "SL約定（ブローカー自律執行）" }),
        1366,
      );
    });

    it("slBrokerBusinessDay も EC イベントの営業日も無い場合は何もしない（reconciliation に委譲）", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(null);
      mockPrisma.tradingPosition.findFirst.mockResolvedValue(
        makeSLPosition({ slBrokerBusinessDay: null }) as never,
      );

      await handleBrokerFill(makeEvent({ orderNumber: "123456", businessDay: "" }));

      expect(mockGetOrderDetail).not.toHaveBeenCalled();
      expect(mockClosePosition).not.toHaveBeenCalled();
    });
  });

  describe("加重平均約定価格", () => {
    it("複数回に分けて約定した場合の加重平均を計算する", async () => {
      mockPrisma.tradingOrder.findFirst.mockResolvedValue(
        makeOrder({ side: "sell", positionId: "pos-789" }) as never,
      );
      mockPrisma.tradingPosition.findUnique.mockResolvedValue(
        { entryPrice: 1000, exitSnapshot: null } as never,
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
      expect(mockClaimOrderFill).toHaveBeenCalledWith("order-1", 1004);
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

      expect(mockClaimOrderFill).not.toHaveBeenCalled();
    });
  });
});

// ============================================================
// KOH-549: 重複WSイベントの競合 / 約定単価の丸め
// ============================================================

describe("handleBrokerFill: 重複WSイベント（KOH-549）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlackout.mockReturnValue(false);
    mockClaimOrderFill.mockResolvedValue(true);
  });

  it("claim に負けた重複イベントは後処理に進まない（正常約定を cancelled に上書きしない）", async () => {
    // 立花の EVENT I/F は同一約定を複数回配信する。2026-07-14 の 3276.T/8008.T では
    // 2イベントが同時に status='pending' を読んで両方素通りし、先行側が建てたポジションを
    // 後続側が「二重建て」と誤認して cancelled に上書きした。
    // claim に負けた側は即 return し、openPosition も status 上書きもしてはいけない。
    mockClaimOrderFill.mockResolvedValue(false);
    mockPrisma.tradingOrder.findFirst.mockResolvedValue(makeOrder() as never);
    mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);
    // 先行イベントが既にポジションを建てている状態
    mockPrisma.tradingPosition.findFirst.mockResolvedValue({ id: "pos-123" } as never);

    await handleBrokerFill(makeEvent());

    expect(mockClaimOrderFill).toHaveBeenCalledOnce();
    expect(mockOpenPosition).not.toHaveBeenCalled();
    expect(mockPrisma.tradingOrder.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "cancelled" } }),
    );
  });

  it("claim に勝ったイベントだけが後処理に進む", async () => {
    mockClaimOrderFill.mockResolvedValue(true);
    mockPrisma.tradingOrder.findFirst.mockResolvedValue(makeOrder() as never);
    mockGetOrderDetail.mockResolvedValue(makeOrderDetail() as never);
    mockPrisma.tradingPosition.findFirst.mockResolvedValue(null);

    await handleBrokerFill(makeEvent());

    expect(mockOpenPosition).toHaveBeenCalled();
  });

  it("約定単価の円未満を丸めない（9009.T の実約定 ¥1,238.5）", async () => {
    // TOPIX100 構成銘柄は呼値が0.5円。Math.round していると ¥1,239 になり ¥50 の誤差が出る
    mockPrisma.tradingOrder.findFirst.mockResolvedValue(
      makeOrder({ side: "sell", positionId: null, stock: { tickerCode: "9009.T", name: "京成電鉄" } }) as never,
    );
    mockGetOrderDetail.mockResolvedValue(
      makeOrderDetail({
        aYakuzyouSikkouList: [{ sYakuzyouPrice: "1238.5000", sYakuzyouSuryou: "100" }],
      }) as never,
    );

    await handleBrokerFill(makeEvent());

    expect(mockClaimOrderFill).toHaveBeenCalledWith("order-1", 1238.5);
  });

  it("分割約定は数量加重平均し、小数第2位まで保持する", async () => {
    mockPrisma.tradingOrder.findFirst.mockResolvedValue(makeOrder() as never);
    mockGetOrderDetail.mockResolvedValue(
      makeOrderDetail({
        // (1238.5*100 + 1239*300) / 400 = 1238.875 → 1238.88
        aYakuzyouSikkouList: [
          { sYakuzyouPrice: "1238.5", sYakuzyouSuryou: "100" },
          { sYakuzyouPrice: "1239", sYakuzyouSuryou: "300" },
        ],
      }) as never,
    );
    mockPrisma.tradingPosition.findFirst.mockResolvedValue(null);

    await handleBrokerFill(makeEvent());

    expect(mockClaimOrderFill).toHaveBeenCalledWith("order-1", 1238.88);
  });
});
