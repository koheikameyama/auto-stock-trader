import { describe, it, expect, vi, beforeEach } from "vitest";

// ========================================
// モック設定
// ========================================

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    marketAssessment: {
      findUnique: vi.fn(),
    },
    stock: {
      findUnique: vi.fn(),
    },
    tradingOrder: {
      create: vi.fn(),
      update: vi.fn(),
    },
    tradingConfig: {
      findFirst: vi.fn(),
    },
    tradingPosition: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../../position-manager", () => ({
  getCashBalance: vi.fn(),
  getEffectiveCapital: vi.fn(),
}));

vi.mock("../../risk-manager", () => ({
  canOpenPosition: vi.fn(),
}));

vi.mock("../../broker-orders", () => ({
  submitOrder: vi.fn(),
}));

vi.mock("../../../lib/slack", () => ({
  notifyOrderPlaced: vi.fn(),
  notifySlack: vi.fn(),
}));

vi.mock("../../../lib/date-utils", () => ({
  getTodayForDB: vi.fn().mockReturnValue(new Date("2026-03-24T00:00:00Z")),
}));

import { executeEntry } from "../entry-executor";
import { prisma } from "../../../lib/prisma";
import { getCashBalance, getEffectiveCapital } from "../../position-manager";
import { canOpenPosition } from "../../risk-manager";
import { submitOrder as submitBrokerOrder } from "../../broker-orders";
import { notifyOrderPlaced } from "../../../lib/slack";
import type { BreakoutTrigger } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as any;
const mockGetCashBalance = vi.mocked(getCashBalance);
const mockGetEffectiveCapital = vi.mocked(getEffectiveCapital);
const mockCanOpenPosition = vi.mocked(canOpenPosition);
const mockSubmitBrokerOrder = vi.mocked(submitBrokerOrder);
const mockNotifyOrderPlaced = vi.mocked(notifyOrderPlaced);

// ========================================
// テストデータ
// ========================================

function makeTrigger(overrides: Partial<BreakoutTrigger> = {}): BreakoutTrigger {
  return {
    ticker: "7203.T",
    currentPrice: 1000,
    cumulativeVolume: 200_000,
    volumeSurgeRatio: 2.5,
    high20: 990,
    atr14: 20,
    triggeredAt: new Date("2026-03-24T01:30:00Z"), // 10:30 JST
    ...overrides,
  };
}

function makeStock(overrides: Record<string, unknown> = {}) {
  return {
    id: "stock-1",
    tickerCode: "7203.T",
    name: "トヨタ自動車",
    sector: "輸送用機器",
    ...overrides,
  };
}

function makeAssessment(shouldTrade: boolean) {
  return {
    id: "assessment-1",
    date: new Date("2026-03-24T00:00:00Z"),
    shouldTrade,
    sentiment: "bullish",
    reasoning: "市場は強気",
    selectedStocks: null,
  };
}

// ========================================
// テスト
// ========================================

describe("executeEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // デフォルトのハッピーパスのモック設定
    // trigger: currentPrice=1000, atr14=20
    // SL = max(1000 - 20*1.0, 1000*0.97) = max(980, 970) = 980
    // riskPerShare = 20
    // effectiveCapital=500,000 → riskAmount=10,000 → rawQty=500 → 500株
    // requiredAmount = 1000 * 500 = 500,000 → cashBalance=1,000,000 で十分
    mockPrisma.marketAssessment.findUnique.mockResolvedValue(makeAssessment(true));
    mockPrisma.stock.findUnique.mockResolvedValue(makeStock());
    mockPrisma.tradingConfig.findFirst.mockResolvedValue({
      id: "config-1",
      isActive: true,
      totalBudget: 500_000,
    });
    mockPrisma.tradingPosition.findMany.mockResolvedValue([]);
    mockGetCashBalance.mockResolvedValue(1_000_000);
    mockGetEffectiveCapital.mockResolvedValue(500_000);
    mockCanOpenPosition.mockResolvedValue({ allowed: true, reason: "OK" });
    mockPrisma.tradingOrder.create.mockResolvedValue({ id: "order-1" });
    mockPrisma.tradingOrder.update.mockResolvedValue({});
    mockSubmitBrokerOrder.mockResolvedValue({
      success: true,
      orderNumber: "999001",
      businessDay: "20260324",
      isDryRun: false,
    });
    mockNotifyOrderPlaced.mockResolvedValue(undefined);
  });

  // 1. shouldTrade=false → 注文しない
  it("1. shouldTrade=false → 注文を作成しない", async () => {
    mockPrisma.marketAssessment.findUnique.mockResolvedValue(makeAssessment(false));

    const result = await executeEntry(makeTrigger(), "simulation");

    expect(result.success).toBe(false);
    expect(result.reason).toContain("shouldTrade=false");
    expect(mockPrisma.tradingOrder.create).not.toHaveBeenCalled();
    expect(mockNotifyOrderPlaced).not.toHaveBeenCalled();
  });

  // 2. 買い余力不足 → 注文しない
  it("2. 買い余力不足 → 注文を作成しない", async () => {
    // currentPrice=1000, atr14=20 → SL=980, riskPerShare=20
    // effectiveCapital=500,000 → riskAmount=10,000 → rawQty=500 → quantity=500株
    // requiredAmount = 1000 * 500 = 500,000 > cashBalance=50,000 → 残高不足
    mockGetCashBalance.mockResolvedValue(50_000);
    // effectiveCapital はデフォルトの 500,000 のまま

    const result = await executeEntry(makeTrigger(), "simulation");

    expect(result.success).toBe(false);
    expect(result.reason).toContain("残高不足");
    expect(mockPrisma.tradingOrder.create).not.toHaveBeenCalled();
  });

  // 3. SLが3%を超える → 3%にクランプされる
  it("3. ATRベースSLが3%超 → 3%上限にクランプされる", async () => {
    // currentPrice=1000, atr14=50 → rawSL = 1000 - 50*1.0 = 950 (5%下) → max3% → SL=970
    const trigger = makeTrigger({ currentPrice: 1000, atr14: 50 });

    const result = await executeEntry(trigger, "simulation");

    expect(result.success).toBe(true);

    const createCall = mockPrisma.tradingOrder.create.mock.calls[0][0];
    const stopLossPrice = createCall.data.stopLossPrice;
    // 3%上限: 1000 * (1 - 0.03) = 970
    expect(stopLossPrice).toBe(970);
    // エントリースナップショットにslClampedフラグが記録される
    expect(createCall.data.entrySnapshot.slClamped).toBe(true);
  });

  // 4. ポジションサイズが100株単位に丸められる
  it("4. ポジションサイズが100株単位に切り捨てられる", async () => {
    // currentPrice=1000, atr14=15 → SL = max(1000-15, 970) = 985
    // riskPerShare = 1000 - 985 = 15
    // effectiveCapital=500,000（デフォルト） → riskAmount=10,000
    // rawQuantity = 10,000 / 15 = 666.67 → floor(666/100)*100 = 600（100単位切捨て）
    const trigger = makeTrigger({ currentPrice: 1000, atr14: 15 });
    const result = await executeEntry(trigger, "simulation");

    expect(result.success).toBe(true);

    const createCall = mockPrisma.tradingOrder.create.mock.calls[0][0];
    const quantity = createCall.data.quantity;
    // 100の倍数であることを確認
    expect(quantity % 100).toBe(0);
    expect(quantity).toBeGreaterThan(0);
    // 666 → 600 であることを確認
    expect(quantity).toBe(600);
  });

  // 5. 正常ケース: TradingOrder作成 + submitBrokerOrder呼び出し
  it("5. 正常ケース: TradingOrderが作成され、submitBrokerOrderが呼び出される", async () => {
    const trigger = makeTrigger();

    const result = await executeEntry(trigger, "live");

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("order-1");

    // TradingOrder作成確認
    expect(mockPrisma.tradingOrder.create).toHaveBeenCalledOnce();
    const createCall = mockPrisma.tradingOrder.create.mock.calls[0][0];
    expect(createCall.data.side).toBe("buy");
    expect(createCall.data.strategy).toBe("breakout");
    expect(createCall.data.status).toBe("pending");
    expect(createCall.data.limitPrice).toBe(1000);
    expect(createCall.data.quantity).toBeGreaterThan(0);

    // submitBrokerOrder呼び出し確認
    expect(mockSubmitBrokerOrder).toHaveBeenCalledOnce();
    const brokerCall = mockSubmitBrokerOrder.mock.calls[0][0];
    expect(brokerCall.ticker).toBe("7203.T");
    expect(brokerCall.side).toBe("buy");
    expect(brokerCall.limitPrice).toBe(1000);

    // brokerOrderId/businessDayのDB更新確認
    expect(mockPrisma.tradingOrder.update).toHaveBeenCalledOnce();

    // Slack通知確認
    expect(mockNotifyOrderPlaced).toHaveBeenCalledOnce();
  });

  // 6. セクター集中超過 → 注文しない
  it("6. セクター集中超過（canOpenPosition=false） → 注文を作成しない", async () => {
    mockCanOpenPosition.mockResolvedValue({
      allowed: false,
      reason: "同一セクターの最大保有数（1）に達しています",
    });

    const result = await executeEntry(makeTrigger(), "simulation");

    expect(result.success).toBe(false);
    expect(result.reason).toContain("同一セクター");
    expect(mockPrisma.tradingOrder.create).not.toHaveBeenCalled();
    expect(mockNotifyOrderPlaced).not.toHaveBeenCalled();
  });

  // 追加: simulationモードではsubmitBrokerOrderを呼ばない
  it("simulationモードではsubmitBrokerOrderを呼ばない", async () => {
    const result = await executeEntry(makeTrigger(), "simulation");

    expect(result.success).toBe(true);
    expect(mockSubmitBrokerOrder).not.toHaveBeenCalled();
  });

  // 追加: MarketAssessmentがない場合もスキップ
  it("MarketAssessmentが存在しない場合はスキップ", async () => {
    mockPrisma.marketAssessment.findUnique.mockResolvedValue(null);

    const result = await executeEntry(makeTrigger(), "simulation");

    expect(result.success).toBe(false);
    expect(result.reason).toContain("MarketAssessmentがありません");
    expect(mockPrisma.tradingOrder.create).not.toHaveBeenCalled();
  });

  it("expiresAtが5日後の15:00に設定される", async () => {
    const result = await executeEntry(makeTrigger(), "simulation");

    expect(result.success).toBe(true);

    const createCall = mockPrisma.tradingOrder.create.mock.calls[0][0];
    const expiresAt: Date = createCall.data.expiresAt;
    expect(expiresAt).toBeInstanceOf(Date);

    // 現在から4〜6日後の範囲であること（テスト実行タイミングの揺れを許容）
    const now = new Date();
    const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(4);
    expect(diffDays).toBeLessThan(6);

    // 時刻が15:00であること（JST→UTCで6:00）
    expect(expiresAt.getUTCHours()).toBe(6);
    expect(expiresAt.getUTCMinutes()).toBe(0);
  });
});
