import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ========================================
// モック設定
// ========================================

const {
  mockGetWatchlist,
  mockFetchQuotes,
  mockExecuteEntry,
  mockNotifySlack,
  mockAssessmentFindUnique,
  mockPositionFindMany,
  mockDailyBarFindMany,
  mockGapUpScan,
} = vi.hoisted(() => ({
  mockGetWatchlist: vi.fn(), // getGuWatchlist のモック
  mockFetchQuotes: vi.fn(),
  mockExecuteEntry: vi.fn().mockResolvedValue({ success: true }),
  mockNotifySlack: vi.fn().mockResolvedValue(undefined),
  mockAssessmentFindUnique: vi.fn(),
  mockPositionFindMany: vi.fn().mockResolvedValue([]),
  mockDailyBarFindMany: vi.fn().mockResolvedValue([]),
  mockGapUpScan: vi.fn().mockReturnValue([]),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    marketAssessment: { findUnique: mockAssessmentFindUnique },
    tradingPosition: { findMany: mockPositionFindMany },
    stockDailyBar: { findMany: mockDailyBarFindMany },
  },
}));

vi.mock("../watchlist-builder", () => ({ getGuWatchlist: mockGetWatchlist }));
vi.mock("../../lib/tachibana-price-client", () => ({
  tachibanaFetchQuotesBatch: mockFetchQuotes,
}));
vi.mock("../../core/breakout/entry-executor", () => ({
  executeEntry: mockExecuteEntry,
}));
vi.mock("../../lib/slack", () => ({ notifySlack: mockNotifySlack }));
vi.mock("../../lib/market-date", () => ({
  getTodayForDB: vi.fn().mockReturnValue(new Date("2026-04-10T00:00:00Z")),
}));
vi.mock("../../core/gapup/gapup-scanner", () => ({
  GapUpScanner: class { scan = mockGapUpScan; },
}));

import { main, resetScanner } from "../gapup-monitor";

// ========================================
// ヘルパー
// ========================================

function makeQuote(ticker: string, price = 1000) {
  return {
    tickerCode: ticker,
    price,
    open: price - 10,
    high: price + 10,
    low: price - 15,
    volume: 200_000,
    askPrice: price + 1,
    bidPrice: price - 1,
    askSize: 100,
    bidSize: 100,
  };
}

/** SMA25 用の日足モックデータ */
function makeDailyBars(ticker: string, close: number, count = 25) {
  return Array.from({ length: count }, () => ({ tickerCode: ticker, close }));
}

function makeTrigger(ticker: string) {
  return {
    ticker,
    currentPrice: 1000,
    volume: 200_000,
    volumeSurgeRatio: 2.5,
    atr14: 20,
    prevClose: 950,
    triggeredAt: new Date(),
  };
}

/** 標準セットアップ: 15:30 JST, shouldTrade=true, WL=1銘柄, breadth=100% */
function setupDefaults() {
  vi.setSystemTime(new Date("2026-04-10T06:30:00Z")); // 15:30 JST
  mockAssessmentFindUnique.mockResolvedValue({ shouldTrade: true });
  mockGetWatchlist.mockResolvedValue([
    { ticker: "7203", avgVolume25: 100_000, high20: 1000, atr14: 20, latestClose: 980 },
  ]);
  mockFetchQuotes.mockResolvedValue([makeQuote("7203")]);
  // close=900, livePrice=1000 → SMA≈904 → breadth=100%
  mockDailyBarFindMany.mockResolvedValue(makeDailyBars("7203", 900));
}

// ========================================
// テスト
// ========================================

describe("gapup-monitor main()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetScanner();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("15:20より前はDB呼び出しなしで即リターン", async () => {
    vi.setSystemTime(new Date("2026-04-10T05:00:00Z")); // 14:00 JST
    await main();
    expect(mockAssessmentFindUnique).not.toHaveBeenCalled();
  });

  it("同日2回目の呼び出しは即リターン", async () => {
    setupDefaults();
    await main();
    vi.clearAllMocks();
    await main();
    expect(mockAssessmentFindUnique).not.toHaveBeenCalled();
  });

  it("MarketAssessment未作成→スキップ", async () => {
    setupDefaults();
    mockAssessmentFindUnique.mockResolvedValue(null);
    await main();
    expect(mockGetWatchlist).not.toHaveBeenCalled();
  });

  it("shouldTrade=false→スキップ", async () => {
    setupDefaults();
    mockAssessmentFindUnique.mockResolvedValue({ shouldTrade: false });
    await main();
    expect(mockGetWatchlist).not.toHaveBeenCalled();
  });

  it("ウォッチリスト空→スキップ", async () => {
    setupDefaults();
    mockGetWatchlist.mockResolvedValue([]);
    await main();
    expect(mockFetchQuotes).not.toHaveBeenCalled();
  });

  it("OHLCV取得0件→スキップ", async () => {
    setupDefaults();
    mockFetchQuotes.mockResolvedValue([null]);
    await main();
    expect(mockGapUpScan).not.toHaveBeenCalled();
  });

  it("breadth < threshold → スキップ", async () => {
    setupDefaults();
    // close=1100, livePrice=1000 → SMA≈1096 → breadth=0%
    mockDailyBarFindMany.mockResolvedValue(makeDailyBars("7203", 1100));
    await main();
    expect(mockGapUpScan).not.toHaveBeenCalled();
  });

  it("トリガーなし→Slack通知（0件）を送信", async () => {
    setupDefaults();
    mockGapUpScan.mockReturnValue([]);
    await main();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("0件") }),
    );
  });

  it("トリガー発火→executeEntryを strategy='gapup' で呼ぶ", async () => {
    setupDefaults();
    const trigger = makeTrigger("7203");
    mockGapUpScan.mockReturnValue([trigger]);
    mockExecuteEntry.mockResolvedValue({ success: true });
    await main();
    expect(mockExecuteEntry).toHaveBeenCalledWith(trigger, "gapup");
  });

  it("エントリー失敗→Slack warning", async () => {
    setupDefaults();
    mockGapUpScan.mockReturnValue([makeTrigger("7203")]);
    mockExecuteEntry.mockResolvedValue({ success: false, reason: "残高不足" });
    await main();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("エントリー失敗"),
        color: "warning",
      }),
    );
  });

  it("エントリー例外→Slack danger", async () => {
    setupDefaults();
    mockGapUpScan.mockReturnValue([makeTrigger("7203")]);
    mockExecuteEntry.mockRejectedValue(new Error("接続エラー"));
    await main();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("エントリー例外"),
        color: "danger",
      }),
    );
  });

  it("resetScannerで1日1回制限が解除される", async () => {
    setupDefaults();
    await main();
    resetScanner();
    vi.clearAllMocks();
    setupDefaults();
    await main();
    expect(mockAssessmentFindUnique).toHaveBeenCalled();
  });
});
