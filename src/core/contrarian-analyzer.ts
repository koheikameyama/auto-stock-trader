/**
 * 逆行ウィナー分析モジュール
 *
 * 取引見送り日（shouldTrade=false）に上昇した銘柄を特定・追跡し、
 * スコアリングへのボーナス加点を算出する。
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB, getDaysAgoForDB } from "../lib/date-utils";
import { CONTRARIAN } from "../lib/constants";

// ========================================
// 型定義
// ========================================

export interface ContrarianWinner {
  tickerCode: string;
  totalScore: number;
  rank: string;
  ghostProfitPct: number;
  entryPrice: number;
  closingPrice: number;
}

export interface ContrarianHistory {
  tickerCode: string;
  /** 逆行勝ち回数 */
  wins: number;
  /** 取引見送り日にスコアリングされた回数 */
  totalNoTradeDays: number;
  /** 勝ち日の平均利益率(%) */
  avgProfitPct: number;
}

// ========================================
// Phase 1: 当日の逆行ウィナー取得
// ========================================

/**
 * 今日が市場全体の取引停止日かどうかを判定する。
 */
export async function isNoTradeDay(date?: Date): Promise<boolean> {
  const targetDate = date ?? getTodayForDB();
  const assessment = await prisma.marketAssessment.findUnique({
    where: { date: targetDate },
  });
  return assessment?.shouldTrade === false;
}

/**
 * 当日の逆行ウィナー（取引見送り日に上昇した銘柄）を取得する。
 * Ghost Review が ghostProfitPct を更新した後に呼ぶこと。
 */
export async function getTodayContrarianWinners(): Promise<
  ContrarianWinner[]
> {
  const today = getTodayForDB();

  const winners = await prisma.scoringRecord.findMany({
    where: {
      date: today,
      rejectionReason: "market_halted",
      ghostProfitPct: { gt: 0 },
      closingPrice: { not: null },
      entryPrice: { not: null },
    },
    orderBy: { ghostProfitPct: "desc" },
  });

  return winners.map((w) => ({
    tickerCode: w.tickerCode,
    totalScore: w.totalScore,
    rank: w.rank,
    ghostProfitPct: Number(w.ghostProfitPct),
    entryPrice: Number(w.entryPrice),
    closingPrice: Number(w.closingPrice!),
  }));
}

// ========================================
// Phase 2: 逆行ヒストリー追跡
// ========================================

/**
 * 複数銘柄の逆行実績をバッチ取得する（N+1回避）。
 * 過去90日間の取引見送り日で、MIN_PROFIT_PCT以上上昇した回数を集計。
 */
export async function getContrarianHistoryBatch(
  tickerCodes: string[],
): Promise<Map<string, ContrarianHistory>> {
  if (tickerCodes.length === 0) return new Map();

  const since = getDaysAgoForDB(CONTRARIAN.LOOKBACK_DAYS);
  const today = getTodayForDB();

  const records = await prisma.scoringRecord.findMany({
    where: {
      tickerCode: { in: tickerCodes },
      rejectionReason: "market_halted",
      date: { gte: since, lt: today },
      ghostProfitPct: { not: null },
      closingPrice: { not: null },
    },
    select: {
      tickerCode: true,
      ghostProfitPct: true,
    },
  });

  // メモリ上で集計（groupByよりシンプル）
  const buckets = new Map<
    string,
    { wins: number; totalDays: number; profitSum: number }
  >();

  for (const r of records) {
    const pct = Number(r.ghostProfitPct);
    let bucket = buckets.get(r.tickerCode);
    if (!bucket) {
      bucket = { wins: 0, totalDays: 0, profitSum: 0 };
      buckets.set(r.tickerCode, bucket);
    }
    bucket.totalDays++;
    if (pct >= CONTRARIAN.MIN_PROFIT_PCT) {
      bucket.wins++;
      bucket.profitSum += pct;
    }
  }

  const result = new Map<string, ContrarianHistory>();
  for (const [ticker, bucket] of buckets) {
    result.set(ticker, {
      tickerCode: ticker,
      wins: bucket.wins,
      totalNoTradeDays: bucket.totalDays,
      avgProfitPct: bucket.wins > 0 ? bucket.profitSum / bucket.wins : 0,
    });
  }

  return result;
}

/**
 * 逆行実績からボーナスポイントを算出する。
 * 勝数・勝率・最低サンプル数の全条件を満たす必要がある。
 */
export function calculateContrarianBonus(
  wins: number,
  totalDays: number,
): number {
  if (totalDays < CONTRARIAN.MIN_SAMPLE_DAYS) return 0;
  const winRate = totalDays > 0 ? wins / totalDays : 0;
  for (const tier of CONTRARIAN.BONUS_TIERS) {
    if (wins >= tier.minWins && winRate >= tier.minWinRate) return tier.bonus;
  }
  return 0;
}
