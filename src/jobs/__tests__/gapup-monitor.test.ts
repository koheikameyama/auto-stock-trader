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
  mockAssessmentFindUnique.mockResolvedValue({ shouldTrade: true, breadth: 0.65 });
  mockGetWatchlist.mockResolvedValue([
    { ticker: "7203", avgVolume25: 100_000, high20: 1000, atr14: 20, latestClose: 980 },
  ]);
  mockFetchQuotes.mockResolvedValue([makeQuote("7203")]);
  mockDailyBarFindMany.mockResolvedValue([]);
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

  it("15:24より前はDB呼び出しなしで即リターン", async () => {
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
    mockAssessmentFindUnique.mockResolvedValue({ shouldTrade: true, breadth: 0.5 });
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

  it("エントリー失敗（非リトライ）→Slack warning", async () => {
    setupDefaults();
    mockGapUpScan.mockReturnValue([makeTrigger("7203")]);
    mockExecuteEntry.mockResolvedValue({ success: false, reason: "残高不足", retryable: false });
    await main();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("エントリー失敗"),
        color: "warning",
      }),
    );
  });

  it("エントリー失敗（リトライ可能）→ Slack通知なし・次回呼び出しでリトライ", async () => {
    setupDefaults();
    mockGapUpScan.mockReturnValue([makeTrigger("7203")]);
    mockExecuteEntry.mockResolvedValue({
      success: false,
      reason: "Tachibana API timeout",
      retryable: true,
    });
    await main();
    // エントリー失敗通知は送らない（スキャン完了通知のみ）
    const entryFailCalls = mockNotifySlack.mock.calls.filter((c) =>
      String(c[0]?.title ?? "").includes("エントリー失敗"),
    );
    expect(entryFailCalls).toHaveLength(0);
    // 再度呼び出すと executeEntry が再実行される（フラグ未セット）
    vi.clearAllMocks();
    setupDefaults();
    mockGapUpScan.mockReturnValue([makeTrigger("7203")]);
    mockExecuteEntry.mockResolvedValue({ success: true });
    await main();
    expect(mockExecuteEntry).toHaveBeenCalled();
  });

  it("エントリー例外→リトライ扱い（次回呼び出しで再実行）", async () => {
    setupDefaults();
    mockGapUpScan.mockReturnValue([makeTrigger("7203")]);
    mockExecuteEntry.mockRejectedValueOnce(new Error("接続エラー"));
    await main();
    // フラグ未セット → 次分で再実行される
    vi.clearAllMocks();
    setupDefaults();
    mockGapUpScan.mockReturnValue([makeTrigger("7203")]);
    mockExecuteEntry.mockResolvedValue({ success: true });
    await main();
    expect(mockExecuteEntry).toHaveBeenCalled();
  });

  it("OHLCV取得0件→フラグ未セット・次分でリトライ", async () => {
    setupDefaults();
    mockFetchQuotes.mockResolvedValueOnce([null]);
    await main();
    // 次分で再実行されることを確認（時価が復活したケース）
    vi.clearAllMocks();
    setupDefaults();
    await main();
    expect(mockFetchQuotes).toHaveBeenCalled();
  });

  it("時価取得例外→フラグ未セット・Slack warning", async () => {
    setupDefaults();
    mockFetchQuotes.mockRejectedValueOnce(new Error("全銘柄の時価取得に失敗"));
    await main();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("スキャンエラー"),
        color: "warning",
      }),
    );
    // 次分で再実行される
    vi.clearAllMocks();
    setupDefaults();
    await main();
    expect(mockFetchQuotes).toHaveBeenCalled();
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
