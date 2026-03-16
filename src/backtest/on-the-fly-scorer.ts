/**
 * オンザフライスコアリングモジュール
 *
 * バックテスト実行時にメモリ内でスコアリングを計算し、
 * candidateMap（日付別S/Aランク銘柄マップ）を構築する。
 * DB読み書き不要。backfill-scoring-records.ts と共通ロジック。
 */

import { analyzeTechnicals } from "../core/technical-analysis";
import type { OHLCVData } from "../core/technical-analysis";
import { scoreStock } from "../core/scoring";
import { TECHNICAL_MIN_DATA } from "../lib/constants/technical";
import { getSectorGroup } from "../lib/constants";
import { SECTOR_MOMENTUM_SCORING } from "../lib/constants/scoring";

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
  trendQualityScore: number;
  trendQualityBreakdown: {
    maAlignment: number;
    weeklyTrend: number;
    trendContinuity: number;
  };
  entryTimingScore: number;
  entryTimingBreakdown: {
    pullbackDepth: number;
    breakout: number;
    candlestickSignal: number;
  };
  riskQualityScore: number;
  riskQualityBreakdown: {
    atrStability: number;
    rangeContraction: number;
    volumeStability: number;
  };
  sectorMomentumScore: number;
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
  _stocks: { tickerCode: string; jpxSectorName: string | null }[],
  nikkei225Ohlcv?: OHLCVData[],
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

  // セクターモメンタム計算（日経225データがある場合）
  const sectorRelativeStrengthMap = new Map<string, number>();

  if (nikkei225Ohlcv && nikkei225Ohlcv.length > 0) {
    // 日経225の週間変化率
    const nikkeiSliceEnd = nikkei225Ohlcv.findIndex((d) => d.date > targetDate);
    const nikkeiSlice = nikkeiSliceEnd === -1 ? nikkei225Ohlcv : nikkei225Ohlcv.slice(0, nikkeiSliceEnd);
    let nikkeiWeekChange: number | null = null;
    if (nikkeiSlice.length >= 6) {
      const latestClose = nikkeiSlice[nikkeiSlice.length - 1].close;
      const fiveDaysAgoClose = nikkeiSlice[nikkeiSlice.length - 6].close;
      nikkeiWeekChange = ((latestClose - fiveDaysAgoClose) / fiveDaysAgoClose) * 100;
    }

    if (nikkeiWeekChange != null) {
      // 各銘柄の週間変化率をセクターグループ別に集計
      const sectorChanges = new Map<string, number[]>();
      for (const [ticker, slice] of stockSlices) {
        const fund = fundamentalsMap.get(ticker);
        if (!fund?.jpxSectorName) continue;
        const group = getSectorGroup(fund.jpxSectorName);
        if (!group) continue;

        if (slice.length >= 6) {
          const latestClose = slice[slice.length - 1].close;
          const fiveDaysAgoClose = slice[slice.length - 6].close;
          const weekChange = ((latestClose - fiveDaysAgoClose) / fiveDaysAgoClose) * 100;
          const changes = sectorChanges.get(group) ?? [];
          changes.push(weekChange);
          sectorChanges.set(group, changes);
        }
      }

      // セクター平均 → 相対強度
      for (const [group, changes] of sectorChanges) {
        if (changes.length < SECTOR_MOMENTUM_SCORING.MIN_SECTOR_STOCK_COUNT) continue;
        const avg = changes.reduce((a, b) => a + b, 0) / changes.length;
        sectorRelativeStrengthMap.set(group, avg - nikkeiWeekChange);
      }
    }
  }

  // 各銘柄をスコアリング
  const results: ScoredRecord[] = [];

  for (const [ticker, slice] of stockSlices) {
    try {
      const fund = fundamentalsMap.get(ticker);
      if (!fund) continue;

      // analyzeTechnicals は newest-first を期待
      const newestFirst = [...slice].reverse();
      const summary = analyzeTechnicals(newestFirst);
      const latest = newestFirst[0];

      // セクター相対強度を取得
      const sectorGroup = fund.jpxSectorName ? getSectorGroup(fund.jpxSectorName) : null;
      const sectorRelativeStrength = sectorGroup
        ? (sectorRelativeStrengthMap.get(sectorGroup) ?? null)
        : null;

      // スコアリング
      const score = scoreStock({
        historicalData: newestFirst,
        latestPrice: latest.close,
        latestVolume: latest.volume,
        weeklyVolatility: fund.volatility,
        summary,
        avgVolume25: summary.volumeAnalysis.avgVolume20,
        nextEarningsDate: fund.nextEarningsDate,
        exDividendDate: fund.exDividendDate,
        sectorRelativeStrength,
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
        trendQualityScore: score.trendQuality.total,
        trendQualityBreakdown: {
          maAlignment: score.trendQuality.maAlignment,
          weeklyTrend: score.trendQuality.weeklyTrend,
          trendContinuity: score.trendQuality.trendContinuity,
        },
        entryTimingScore: score.entryTiming.total,
        entryTimingBreakdown: {
          pullbackDepth: score.entryTiming.pullbackDepth,
          breakout: score.entryTiming.breakout,
          candlestickSignal: score.entryTiming.candlestickSignal,
        },
        riskQualityScore: score.riskQuality.total,
        riskQualityBreakdown: {
          atrStability: score.riskQuality.atrStability,
          rangeContraction: score.riskQuality.rangeContraction,
          volumeStability: score.riskQuality.volumeStability,
        },
        sectorMomentumScore: score.sectorMomentumScore,
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
  nikkei225Ohlcv?: OHLCVData[],
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
      nikkei225Ohlcv,
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
