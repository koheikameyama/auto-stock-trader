import { describe, it, expect, vi, beforeEach } from "vitest";
import "../../lib/constants/retention";

// vi.hoisted で mock 関数を定義（vi.mock のホイスティングに対応）
const {
  mockScoringDelete, mockBacktestDelete, mockMarketDelete,
  mockArticleDelete, mockAnalysisDelete, mockSummaryDelete,
  mockStatusLogDelete, mockEventLogDelete, mockDefensiveDelete, mockUnfilledDelete,
} = vi.hoisted(() => ({
  mockScoringDelete: vi.fn().mockResolvedValue({ count: 0 }),
  mockBacktestDelete: vi.fn().mockResolvedValue({ count: 0 }),
  mockMarketDelete: vi.fn().mockResolvedValue({ count: 0 }),
  mockArticleDelete: vi.fn().mockResolvedValue({ count: 0 }),
  mockAnalysisDelete: vi.fn().mockResolvedValue({ count: 0 }),
  mockSummaryDelete: vi.fn().mockResolvedValue({ count: 0 }),
  mockStatusLogDelete: vi.fn().mockResolvedValue({ count: 0 }),
  mockEventLogDelete: vi.fn().mockResolvedValue({ count: 0 }),
  mockDefensiveDelete: vi.fn().mockResolvedValue({ count: 0 }),
  mockUnfilledDelete: vi.fn().mockResolvedValue({ count: 0 }),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    scoringRecord: { deleteMany: mockScoringDelete },
    backtestDailyResult: { deleteMany: mockBacktestDelete },
    marketAssessment: { deleteMany: mockMarketDelete },
    newsArticle: { deleteMany: mockArticleDelete },
    newsAnalysis: { deleteMany: mockAnalysisDelete },
    tradingDailySummary: { deleteMany: mockSummaryDelete },
    stockStatusLog: { deleteMany: mockStatusLogDelete },
    corporateEventLog: { deleteMany: mockEventLogDelete },
    defensiveExitFollowUp: { deleteMany: mockDefensiveDelete },
    unfilledOrderFollowUp: { deleteMany: mockUnfilledDelete },
  },
}));

const allMocks = [
  mockScoringDelete, mockBacktestDelete, mockMarketDelete,
  mockArticleDelete, mockAnalysisDelete, mockSummaryDelete,
  mockStatusLogDelete, mockEventLogDelete, mockDefensiveDelete, mockUnfilledDelete,
];

// getDaysAgoForDB をモック
vi.mock("../../lib/date-utils", () => ({
  getDaysAgoForDB: vi.fn((_days: number) => new Date(`2026-01-01T00:00:00Z`)),
}));

import { runDataCleanup } from "../data-cleanup";

describe("runDataCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("全テーブルに対して deleteMany を呼ぶ", async () => {
    const result = await runDataCleanup();

    for (const mock of allMocks) {
      expect(mock).toHaveBeenCalledTimes(1);
    }
    expect(result.totalDeleted).toBe(0);
    expect(Object.keys(result.deletedCounts)).toHaveLength(10);
  });

  it("各テーブルで正しい日付カラムと lt を使う", async () => {
    await runDataCleanup();

    // date カラムを使うテーブル
    expect(mockScoringDelete).toHaveBeenCalledWith({ where: { date: { lt: expect.any(Date) } } });
    expect(mockBacktestDelete).toHaveBeenCalledWith({ where: { date: { lt: expect.any(Date) } } });
    expect(mockMarketDelete).toHaveBeenCalledWith({ where: { date: { lt: expect.any(Date) } } });
    expect(mockAnalysisDelete).toHaveBeenCalledWith({ where: { date: { lt: expect.any(Date) } } });
    expect(mockSummaryDelete).toHaveBeenCalledWith({ where: { date: { lt: expect.any(Date) } } });

    // publishedAt カラム
    expect(mockArticleDelete).toHaveBeenCalledWith({ where: { publishedAt: { lt: expect.any(Date) } } });

    // createdAt カラム
    expect(mockStatusLogDelete).toHaveBeenCalledWith({ where: { createdAt: { lt: expect.any(Date) } } });

    // eventDate カラム
    expect(mockEventLogDelete).toHaveBeenCalledWith({ where: { eventDate: { lt: expect.any(Date) } } });
  });

  it("DefensiveExitFollowUp は isComplete=true のみ削除", async () => {
    await runDataCleanup();

    expect(mockDefensiveDelete).toHaveBeenCalledWith({
      where: {
        exitDate: { lt: expect.any(Date) },
        isComplete: true,
      },
    });
  });

  it("UnfilledOrderFollowUp は isComplete=true のみ削除", async () => {
    await runDataCleanup();

    expect(mockUnfilledDelete).toHaveBeenCalledWith({
      where: {
        orderDate: { lt: expect.any(Date) },
        isComplete: true,
      },
    });
  });

  it("削除件数を正しく集計する", async () => {
    mockScoringDelete.mockResolvedValueOnce({ count: 100 });
    mockBacktestDelete.mockResolvedValueOnce({ count: 50 });
    mockMarketDelete.mockResolvedValueOnce({ count: 10 });
    mockArticleDelete.mockResolvedValueOnce({ count: 200 });
    mockAnalysisDelete.mockResolvedValueOnce({ count: 5 });
    mockSummaryDelete.mockResolvedValueOnce({ count: 0 });
    mockStatusLogDelete.mockResolvedValueOnce({ count: 3 });
    mockEventLogDelete.mockResolvedValueOnce({ count: 1 });
    mockDefensiveDelete.mockResolvedValueOnce({ count: 2 });
    mockUnfilledDelete.mockResolvedValueOnce({ count: 0 });

    const result = await runDataCleanup();

    expect(result.totalDeleted).toBe(371);
    expect(result.deletedCounts.scoringRecord).toBe(100);
    expect(result.deletedCounts.newsArticle).toBe(200);
  });
});
