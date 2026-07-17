import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================
// 目的: executeExitSell が防御成行売りの 11482（売付可能不足）を
//       「逆指値SLが先に約定して株を持って行った」サインとして扱い、
//       - SL約定を検知できたら自己修復クローズ（幻のオープンを残さない）
//       - 未約定なら SL追跡を復元して 🚨 決済スキップ
//       に正しくルーティングすることを固定する（KOH: 二重売りレースの後始末）。
// ============================================================

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingPosition: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock("../../core/broker-sl-manager", () => ({
  cancelBrokerSL: vi.fn().mockResolvedValue(undefined),
  updateBrokerSL: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../core/broker-fill-handler", () => ({
  handleBrokerSLFill: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../core/broker-orders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/broker-orders")>();
  return { ...actual, submitOrder: vi.fn(), fetchFilledPrice: vi.fn(), cancelOrder: vi.fn() };
});

vi.mock("../../core/position-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/position-manager")>();
  return { ...actual, closePosition: vi.fn(), getPositionPnl: vi.fn().mockReturnValue(0) };
});

vi.mock("../../lib/slack", () => ({
  notifyOrderFilled: vi.fn().mockResolvedValue(undefined),
  notifyRiskAlert: vi.fn().mockResolvedValue(undefined),
  notifySlack: vi.fn().mockResolvedValue(undefined),
}));

// isTachibanaProduction=true にして step2 の SL照合・本番経路を通す
vi.mock("../../lib/constants/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/constants/broker")>();
  return { ...actual, isTachibanaProduction: true };
});

import { executeExitSell } from "../position-monitor";
import { prisma } from "../../lib/prisma";
import { submitOrder } from "../../core/broker-orders";
import { handleBrokerSLFill } from "../../core/broker-fill-handler";
import { notifySlack } from "../../lib/slack";

const INSUFFICIENT_SELLABLE_ERR =
  "[sub:11482] 売付可能な株数が不足しているため、このご注文はお受けできません。";

function makePosition() {
  return {
    id: "pos-1",
    quantity: 100,
    strategy: "post-surge-consolidation",
    entryPrice: 768,
    stopLossPrice: 745,
    trailingStopPrice: null,
    slBrokerOrderId: "SL-ORD-1",
    slBrokerBusinessDay: "20260717",
    stock: { tickerCode: "8698.T", name: "マネックスG" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const baseParams = () => ({
  position: makePosition(),
  exitPrice: 745,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exitSnapshot: { exitReason: "損切り", exitPrice: 745 } as any,
  exitReason: "損切り",
});

// findUnique を select 形で分岐させる:
//  - {slBrokerOrderId} だけ  → step2 の取消照合（null = 取消成功 → 成行売りへ進む）
//  - {status} だけ           → tryRecoverFilledSL のクローズ判定
//  - {status, slBrokerOrderId} → restoreSLTracking の現状照合
function mockFindUnique(opts: {
  step2SlId?: string | null;
  statusAfterRecover?: string;
  restoreFresh?: { status: string; slBrokerOrderId: string | null } | null;
}) {
  (prisma.tradingPosition.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ select }: any) => {
      if (select?.status && select?.slBrokerOrderId) {
        return Promise.resolve(opts.restoreFresh ?? { status: "open", slBrokerOrderId: null });
      }
      if (select?.status) {
        return Promise.resolve({ status: opts.statusAfterRecover ?? "open" });
      }
      if (select?.slBrokerOrderId) {
        return Promise.resolve({ slBrokerOrderId: opts.step2SlId ?? null });
      }
      return Promise.resolve(null);
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeExitSell: 11482 の自己修復ルーティング", () => {
  it("成行売り 11482 かつ SL約定検知 → handleBrokerSLFill でクローズ、🚨決済スキップは出さない", async () => {
    mockFindUnique({ step2SlId: null, statusAfterRecover: "closed" });
    (submitOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: INSUFFICIENT_SELLABLE_ERR,
    });

    const result = await executeExitSell(baseParams());

    expect(handleBrokerSLFill).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    // 自己修復できたので「決済スキップ: 成行売り失敗」通知は出ない
    const skipCalled = (notifySlack as ReturnType<typeof vi.fn>).mock.calls.some(
      ([arg]) => typeof arg?.title === "string" && arg.title.includes("決済スキップ"),
    );
    expect(skipCalled).toBe(false);
    // 追跡復元(update)も呼ばれない（クローズ済み）
    expect(prisma.tradingPosition.update).not.toHaveBeenCalled();
  });

  it("成行売り 11482 かつ SL未約定 → SL追跡を復元し、🚨決済スキップを出す", async () => {
    mockFindUnique({
      step2SlId: null,
      statusAfterRecover: "open",
      restoreFresh: { status: "open", slBrokerOrderId: null },
    });
    (submitOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: INSUFFICIENT_SELLABLE_ERR,
    });

    const result = await executeExitSell(baseParams());

    expect(handleBrokerSLFill).toHaveBeenCalledTimes(1);
    // 追跡復元（元の注文番号を書き戻す）
    expect(prisma.tradingPosition.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pos-1" },
        data: expect.objectContaining({ slBrokerOrderId: "SL-ORD-1" }),
      }),
    );
    const skipCalled = (notifySlack as ReturnType<typeof vi.fn>).mock.calls.some(
      ([arg]) => typeof arg?.title === "string" && arg.title.includes("決済スキップ: 成行売り失敗"),
    );
    expect(skipCalled).toBe(true);
    expect(result).toBeNull();
  });

  it("11482 以外の失敗 → リカバリを試みず（handleBrokerSLFill 未呼出）🚨決済スキップ", async () => {
    mockFindUnique({ step2SlId: null });
    (submitOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "[sub:11999] その他のエラー",
    });

    const result = await executeExitSell(baseParams());

    expect(handleBrokerSLFill).not.toHaveBeenCalled();
    expect(prisma.tradingPosition.update).not.toHaveBeenCalled();
    const skipCalled = (notifySlack as ReturnType<typeof vi.fn>).mock.calls.some(
      ([arg]) => typeof arg?.title === "string" && arg.title.includes("決済スキップ: 成行売り失敗"),
    );
    expect(skipCalled).toBe(true);
    expect(result).toBeNull();
  });
});
