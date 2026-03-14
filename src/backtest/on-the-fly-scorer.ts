/**
 * オンザフライスコアリングモジュール
 *
 * バックテスト実行時にメモリ内でスコアリングを計算し、
 * candidateMap（日付別S/Aランク銘柄マップ）を構築する。
 * DB読み書き不要。backfill-scoring-records.ts と共通ロジック。
 */

import { analyzeTechnicals } from "../core/technical-analysis";
import type { OHLCVData } from "../core/technical-analysis";
import {
  scoreTechnicals,
  calculateRsScores,
} from "../core/technical-scorer";
import { detectChartPatterns } from "../lib/chart-patterns";
import { analyzeSingleCandle } from "../lib/candlestick-patterns";
import {
  aggregateDailyToWeekly,
  analyzeWeeklyTrend,
} from "../lib/technical-indicators";
import { getSectorGroup } from "../lib/constants/trading";
import { TECHNICAL_MIN_DATA } from "../lib/constants/technical";
import { SCORING_V1 as SCORING } from "../lib/constants/scoring";

// ========================================
// 型定義
// ========================================

export interface StockFundamentals {
  per: number | null;
  pbr: number | null;
  eps: number | null;
  marketCap: number | null;
  latestPrice: number;
  volatility: number | null;
  nextEarningsDate: Date | null;
  exDividendDate: Date | null;
  latestVolume: number;
  jpxSectorName: string | null;
}

export interface ScoredRecord {
  tickerCode: string;
  totalScore: number;
  rank: string;
  technicalScore: number;
  technicalBreakdown: {
    rsi: number;
    ma: number;
    volume: number;
    volumeDirection: string;
    macd: number;
    rs: number;
    weeklyTrendPenalty: number;
  };
  patternScore: number;
  patternBreakdown: { chart: number; candlestick: number };
  liquidityScore: number;
  liquidityBreakdown: {
    tradingValue: number;
    spreadProxy: number;
    stability: number;
  };
  fundamentalScore: number;
  fundamentalBreakdown: {
    per: number;
    pbr: number;
    profitability: number;
    marketCap: number;
  };
  isDisqualified: boolean;
  disqualifyReason: string | null;
  rejectionReason: string | null;
  entryPrice: number | null;
}

// ========================================
// コア関数
// ========================================

/**
 * 1日分の全銘柄をスコアリング（純粋関数、DB不要）
 */
export function scoreDayForAllStocks(
  targetDate: string,
  allOhlcv: Map<string, OHLCVData[]>,
  fundamentalsMap: Map<string, StockFundamentals>,
  stocks: { tickerCode: string; jpxSectorName: string | null }[],
): ScoredRecord[] {
  // 各銘柄の targetDate 以前のデータをスライス
  const stockSlices = new Map<string, OHLCVData[]>();
  for (const [ticker, data] of allOhlcv) {
    // data は oldest-first
    const sliceEnd = data.findIndex((d) => d.date > targetDate);
    const slice = sliceEnd === -1 ? data : data.slice(0, sliceEnd);
    if (slice.length >= TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) {
      stockSlices.set(ticker, slice);
    }
  }

  if (stockSlices.size === 0) return [];

  // weekChangeRate を計算し、RS スコアを算出
  const rsInput: {
    tickerCode: string;
    weekChangeRate: number | null;
    sector: string;
  }[] = [];
  const sectorMap: Record<string, number[]> = {};

  for (const [ticker, slice] of stockSlices) {
    const stock = stocks.find((s) => s.tickerCode === ticker);
    const sector = getSectorGroup(stock?.jpxSectorName ?? null) ?? "その他";

    // slice は oldest-first なので末尾が最新
    const latestIdx = slice.length - 1;
    let weekChangeRate: number | null = null;
    if (slice.length >= 5) {
      const current = slice[latestIdx].close;
      const weekAgo = slice[latestIdx - 4].close;
      if (weekAgo > 0) {
        weekChangeRate =
          Math.round(((current - weekAgo) / weekAgo) * 10000) / 100;
      }
    }

    rsInput.push({ tickerCode: ticker, weekChangeRate, sector });
    if (weekChangeRate != null) {
      if (!sectorMap[sector]) sectorMap[sector] = [];
      sectorMap[sector].push(weekChangeRate);
    }
  }

  const sectorAvgs: Record<string, number> = {};
  for (const [sector, rates] of Object.entries(sectorMap)) {
    sectorAvgs[sector] = rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  const rsScoreMap = calculateRsScores(rsInput, sectorAvgs);

  // 各銘柄をスコアリング
  const results: ScoredRecord[] = [];

  for (const [ticker, slice] of stockSlices) {
    try {
      const fund = fundamentalsMap.get(ticker);
      if (!fund) continue;

      // analyzeTechnicals は newest-first を期待
      const newestFirst = [...slice].reverse();
      const summary = analyzeTechnicals(newestFirst);

      // detectChartPatterns は oldest-first を期待
      const chartPatterns = detectChartPatterns(
        slice.map((d) => ({
          date: d.date,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
        })),
      );

      // 最新のローソク足
      const latest = newestFirst[0];
      const candlestickPattern = analyzeSingleCandle({
        date: latest.date,
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
      });

      // 週足トレンド
      const weeklyBars = aggregateDailyToWeekly(
        slice.map((d) => ({
          date: d.date,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          volume: d.volume,
        })),
      );
      const weeklyTrend =
        weeklyBars.length >= SCORING.WEEKLY_TREND.MIN_WEEKLY_BARS
          ? analyzeWeeklyTrend(weeklyBars)
          : null;

      // スコアリング
      const score = scoreTechnicals({
        summary,
        chartPatterns,
        candlestickPattern,
        historicalData: newestFirst,
        latestPrice: latest.close,
        latestVolume: latest.volume,
        weeklyVolatility: fund.volatility,
        weeklyTrend,
        fundamentals: {
          per: fund.per,
          pbr: fund.pbr,
          eps: fund.eps,
          marketCap: fund.marketCap,
          latestPrice: latest.close,
        },
        nextEarningsDate: fund.nextEarningsDate,
        exDividendDate: fund.exDividendDate,
        rsScore: rsScoreMap.get(ticker) ?? 0,
      });

      let rejectionReason: string | null = null;
      if (score.isDisqualified) {
        rejectionReason = "disqualified";
      } else if (score.totalScore < 65) {
        rejectionReason = "below_threshold";
      }

      results.push({
        tickerCode: ticker,
        totalScore: score.totalScore,
        rank: score.rank,
        technicalScore: score.technical.total,
        technicalBreakdown: {
          rsi: score.technical.rsi,
          ma: score.technical.ma,
          volume: score.technical.volume,
          volumeDirection: score.technical.volumeDirection,
          macd: score.technical.macd,
          rs: score.technical.rs,
          weeklyTrendPenalty: score.weeklyTrendPenalty,
        },
        patternScore: score.pattern.total,
        patternBreakdown: {
          chart: score.pattern.chart,
          candlestick: score.pattern.candlestick,
        },
        liquidityScore: score.liquidity.total,
        liquidityBreakdown: {
          tradingValue: score.liquidity.tradingValue,
          spreadProxy: score.liquidity.spreadProxy,
          stability: score.liquidity.stability,
        },
        fundamentalScore: score.fundamental.total,
        fundamentalBreakdown: {
          per: score.fundamental.per,
          pbr: score.fundamental.pbr,
          profitability: score.fundamental.profitability,
          marketCap: score.fundamental.marketCap,
        },
        isDisqualified: score.isDisqualified,
        disqualifyReason: score.disqualifyReason,
        rejectionReason,
        entryPrice: latest.close,
      });
    } catch {
      // スコアリング失敗は無視（データ不足等）
    }
  }

  return results;
}

/**
 * OHLCV データから指定期間の営業日リストを抽出
 */
export function extractTradingDays(
  allOhlcv: Map<string, OHLCVData[]>,
  startDate: string,
  endDate: string,
): string[] {
  const daySet = new Set<string>();
  for (const data of allOhlcv.values()) {
    for (const bar of data) {
      if (bar.date >= startDate && bar.date <= endDate) {
        daySet.add(bar.date);
      }
    }
  }
  return [...daySet].sort();
}

/**
 * メモリ内でcandidateMapを構築（オンザフライモード）
 *
 * 全営業日について全銘柄をスコアリングし、
 * S/Aランクの銘柄リストを日付別に返す。
 */
export function buildCandidateMapOnTheFly(
  allOhlcv: Map<string, OHLCVData[]>,
  fundamentalsMap: Map<string, StockFundamentals>,
  stocks: { tickerCode: string; jpxSectorName: string | null }[],
  startDate: string,
  endDate: string,
  targetRanks: readonly string[],
  fallbackRanks: readonly string[],
  minTickers: number,
): { candidateMap: Map<string, string[]>; allTickers: string[] } {
  const tradingDays = extractTradingDays(allOhlcv, startDate, endDate);
  const candidateMap = new Map<string, string[]>();
  const allTickerSet = new Set<string>();

  console.log(
    `[on-the-fly] スコアリング開始: ${tradingDays.length}営業日 × ${allOhlcv.size}銘柄`,
  );

  for (let i = 0; i < tradingDays.length; i++) {
    const targetDate = tradingDays[i];
    const dayRecords = scoreDayForAllStocks(
      targetDate,
      allOhlcv,
      fundamentalsMap,
      stocks,
    );

    // TARGET_RANKS（S）で候補を収集
    const targetTickers = dayRecords
      .filter(
        (r) =>
          !r.isDisqualified &&
          (targetRanks as readonly string[]).includes(r.rank),
      )
      .map((r) => r.tickerCode);

    // 不足時はFALLBACK_RANKS（S/A）で補完
    const tickers =
      targetTickers.length >= minTickers
        ? targetTickers
        : dayRecords
            .filter(
              (r) =>
                !r.isDisqualified &&
                (fallbackRanks as readonly string[]).includes(r.rank),
            )
            .map((r) => r.tickerCode);

    if (tickers.length > 0) {
      candidateMap.set(targetDate, tickers);
      for (const t of tickers) allTickerSet.add(t);
    }

    // 進捗ログ（10日ごと）
    if ((i + 1) % 10 === 0 || i === tradingDays.length - 1) {
      console.log(
        `[on-the-fly] ${targetDate}: ${dayRecords.length}銘柄スコア済 → 候補${tickers.length}件 [${i + 1}/${tradingDays.length}]`,
      );
    }
  }

  console.log(
    `[on-the-fly] 完了: ${candidateMap.size}営業日, ${allTickerSet.size}ユニーク銘柄`,
  );

  return {
    candidateMap,
    allTickers: [...allTickerSet],
  };
}
