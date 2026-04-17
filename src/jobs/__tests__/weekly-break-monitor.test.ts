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
  mockWBScan,
  mockGetEffectiveCapital,
  mockCountNonTradingDaysAhead,
  mockWeeklyBreakConstants,
} = vi.hoisted(() => ({
  mockGetWatchlist: vi.fn(),
  mockFetchQuotes: vi.fn(),
  mockExecuteEntry: vi.fn().mockResolvedValue({ success: true }),
  mockNotifySlack: vi.fn().mockResolvedValue(undefined),
  mockAssessmentFindUnique: vi.fn(),
  mockPositionFindMany: vi.fn().mockResolvedValue([]),
  mockDailyBarFindMany: vi.fn().mockResolvedValue([]),
  mockWBScan: vi.fn().mockReturnValue([]),
  mockGetEffectiveCapital: vi.fn().mockResolvedValue(1_000_000),
  mockCountNonTradingDaysAhead: vi.fn().mockReturnValue(2),
  mockWeeklyBreakConstants: {
    ENTRY_ENABLED: true,
    GUARD: { SCAN_HOUR: 15, SCAN_MINUTE: 20 },
    MARKET_FILTER: { BREADTH_THRESHOLD: 0.6 },
    ENTRY: { HIGH_LOOKBACK_WEEKS: 13, VOL_SURGE_RATIO: 1.3, MIN_AVG_VOLUME_25: 100_000, MIN_ATR_PCT: 1.5 },
    STOP_LOSS: { ATR_MULTIPLIER: 1.5 },
  },
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    marketAssessment: { findUnique: mockAssessmentFindUnique },
    tradingPosition: { findMany: mockPositionFindMany },
    stockDailyBar: { findMany: mockDailyBarFindMany },
  },
}));

vi.mock("../../lib/constants/weekly-break", () => ({
  get WEEKLY_BREAK() { return mockWeeklyBreakConstants; },
}));

vi.mock("../watchlist-builder", () => ({ getAllWatchlist: mockGetWatchlist }));
vi.mock("../../lib/tachibana-price-client", () => ({
  tachibanaFetchQuotesBatch: mockFetchQuotes,
}));
vi.mock("../../core/breakout/entry-executor", () => ({
  executeEntry: mockExecuteEntry,
}));
vi.mock("../../lib/slack", () => ({ notifySlack: mockNotifySlack }));
vi.mock("../../lib/market-date", () => ({
  getTodayForDB: vi.fn().mockReturnValue(new Date("2026-04-10T00:00:00Z")),
  countNonTradingDaysAhead: mockCountNonTradingDaysAhead,
}));
vi.mock("../../core/position-manager", () => ({
  getEffectiveCapital: mockGetEffectiveCapital,
}));
vi.mock("../../core/weekly-break/weekly-break-scanner", () => ({
  WeeklyBreakScanner: class { scan = mockWBScan; },
  groupDailyBarsByTicker: vi.fn().mockReturnValue(new Map()),
  buildWeeklyBarsFromDaily: vi.fn().mockReturnValue(new Map()),
}));

import { main, resetScanner } from "../weekly-break-monitor";

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

function makeDailyBars(ticker: string, close: number, count = 25) {
  return Array.from({ length: count }, () => ({
    tickerCode: ticker,
    close,
    open: close,
    high: close + 10,
    low: close - 10,
    volume: 100_000,
    date: new Date(),
  }));
}

function makeTrigger(ticker: string) {
  return {
    ticker,
    currentPrice: 1000,
    volumeSurgeRatio: 2.0,
    weeklyHigh: 950,
    atr14: 20,
    triggeredAt: new Date(),
  };
}

/** 標準セットアップ: 15:30 JST, 金曜, shouldTrade=true, WL=1, breadth=100% */
function setupDefaults() {
  vi.setSystemTime(new Date("2026-04-10T06:30:00Z")); // 15:30 JST (金曜)
  mockWeeklyBreakConstants.ENTRY_ENABLED = true;
  mockCountNonTradingDaysAhead.mockReturnValue(2); // 金曜 → 土日で2日
  mockAssessmentFindUnique.mockResolvedValue({ shouldTrade: true });
  mockGetWatchlist.mockResolvedValue([
    { ticker: "7203", avgVolume25: 100_000, high20: 1000, atr14: 20, latestClose: 980 },
  ]);
  mockFetchQuotes.mockResolvedValue([makeQuote("7203")]);
  mockDailyBarFindMany.mockResolvedValue(makeDailyBars("7203", 900));
  mockGetEffectiveCapital.mockResolvedValue(1_000_000);
}

// ========================================
// テスト
// ========================================

describe("weekly-break-monitor main()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetScanner();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ENTRY_ENABLED=false→即リターン", async () => {
    setupDefaults();
    mockWeeklyBreakConstants.ENTRY_ENABLED = false;
    await main();
    expect(mockAssessmentFindUnique).not.toHaveBeenCalled();
  });

  it("15:20より前→即リターン", async () => {
    vi.setSystemTime(new Date("2026-04-10T05:00:00Z")); // 14:00 JST
    mockWeeklyBreakConstants.ENTRY_ENABLED = true;
    mockCountNonTradingDaysAhead.mockReturnValue(2);
    await main();
    expect(mockAssessmentFindUnique).not.toHaveBeenCalled();
  });

  it("同日2回目→即リターン", async () => {
    setupDefaults();
    await main();
    vi.clearAllMocks();
    await main();
    expect(mockAssessmentFindUnique).not.toHaveBeenCalled();
  });

  it("週末最終営業日でない（nonTradingDaysAhead < 2）→スキップ", async () => {
    setupDefaults();
    mockCountNonTradingDaysAhead.mockReturnValue(1);
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
    expect(mockWBScan).not.toHaveBeenCalled();
  });

  it("breadth < threshold → スキップ", async () => {
    setupDefaults();
    mockDailyBarFindMany.mockResolvedValue(makeDailyBars("7203", 1100));
    await main();
    expect(mockWBScan).not.toHaveBeenCalled();
  });

  it("トリガー発火→executeEntryを strategy='weekly-break' で呼ぶ", async () => {
    setupDefaults();
    const trigger = makeTrigger("7203");
    mockWBScan.mockReturnValue([trigger]);
    await main();
    expect(mockExecuteEntry).toHaveBeenCalledWith(trigger, "weekly-break");
  });

  it("スキャン完了時にSlack通知を送信する", async () => {
    setupDefaults();
    mockWBScan.mockReturnValue([]);
    await main();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("スキャン完了"),
      }),
    );
  });

  it("エントリー失敗（非リトライ）→Slack warning", async () => {
    setupDefaults();
    mockWBScan.mockReturnValue([makeTrigger("7203")]);
    mockExecuteEntry.mockResolvedValue({ success: false, reason: "残高不足", retryable: false });
    await main();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("エントリー失敗"),
        color: "warning",
      }),
    );
  });

  it("エントリー失敗（リトライ可能）→ 次回呼び出しで再実行", async () => {
    setupDefaults();
    mockWBScan.mockReturnValue([makeTrigger("7203")]);
    mockExecuteEntry.mockResolvedValue({
      success: false,
      reason: "Tachibana API timeout",
      retryable: true,
    });
    await main();
    // フラグ未セット → 再実行される
    vi.clearAllMocks();
    setupDefaults();
    mockWBScan.mockReturnValue([makeTrigger("7203")]);
    mockExecuteEntry.mockResolvedValue({ success: true });
    await main();
    expect(mockExecuteEntry).toHaveBeenCalled();
  });

  it("エントリー例外→リトライ扱い（次回呼び出しで再実行）", async () => {
    setupDefaults();
    mockWBScan.mockReturnValue([makeTrigger("7203")]);
    mockExecuteEntry.mockRejectedValueOnce(new Error("接続エラー"));
    await main();
    // フラグ未セット → 次分で再実行される
    vi.clearAllMocks();
    setupDefaults();
    mockWBScan.mockReturnValue([makeTrigger("7203")]);
    mockExecuteEntry.mockResolvedValue({ success: true });
    await main();
    expect(mockExecuteEntry).toHaveBeenCalled();
  });

  it("スキャン処理全体のエラー→Slack warning（リトライ待機）", async () => {
    setupDefaults();
    // breadth用(1回目)は正常、daily bars用(2回目)はエラー
    mockDailyBarFindMany
      .mockResolvedValueOnce(makeDailyBars("7203", 900))
      .mockRejectedValueOnce(new Error("DBエラー"));
    await main();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("スキャンエラー"),
        color: "warning",
      }),
    );
    // フラグ未セット → 次分で再実行される
    vi.clearAllMocks();
    setupDefaults();
    await main();
    expect(mockDailyBarFindMany).toHaveBeenCalled();
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
