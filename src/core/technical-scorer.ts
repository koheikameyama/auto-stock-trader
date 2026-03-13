/**
 * ロジックスコアリングエンジン（4カテゴリ100点満点）
 *
 * カテゴリ1: テクニカル指標（40点） — RSI, MA, 出来高変化, MACD
 * カテゴリ2: チャート・ローソク足パターン（20点）
 * カテゴリ3: 流動性（25点） — 売買代金, 値幅率, 安定性
 * カテゴリ4: ファンダメンタルズ（15点） — PER, PBR, 収益性, 時価総額
 *
 * 即死ルール: 1つでも該当 → 即0点
 *
 * 全て純粋関数（I/Oなし）。
 */

import type { TechnicalSummary } from "./technical-analysis";
import type { OHLCVData } from "./technical-analysis";
import type { ChartPatternResult, ChartPatternRank } from "../lib/chart-patterns";
import type { PatternResult } from "../lib/candlestick-patterns";
import type { WeeklyTrendResult } from "../lib/technical-indicators";
import { calculateMACD } from "../lib/technical-indicators";
import { SCORING } from "../lib/constants";

// ========================================
// 型定義
// ========================================

export interface FundamentalInput {
  per: number | null;
  pbr: number | null;
  eps: number | null;
  marketCap: number | null;
  latestPrice: number;
}

export interface LogicScoreInput {
  summary: TechnicalSummary;
  chartPatterns: ChartPatternResult[];
  candlestickPattern: PatternResult | null;
  historicalData: OHLCVData[];
  latestPrice: number;
  latestVolume: number;
  weeklyVolatility: number | null;
  weeklyTrend?: WeeklyTrendResult | null;
  fundamentals?: FundamentalInput;
  nextEarningsDate?: Date | null;
  exDividendDate?: Date | null;
  rsScore?: number; // 0-15, caller pre-computes
}

export type VolumeDirection = "accumulation" | "distribution" | "neutral";

export interface LogicScore {
  totalScore: number;
  rank: "S" | "A" | "B" | "C";

  technical: {
    total: number;
    rsi: number;
    ma: number;
    volume: number;
    volumeDirection: VolumeDirection;
    macd: number;
    rs: number; // NEW
  };
  pattern: {
    total: number;
    chart: number;
    candlestick: number;
  };
  liquidity: {
    total: number;
    tradingValue: number;
    spreadProxy: number;
    stability: number;
  };
  fundamental: {
    total: number;
    per: number;
    pbr: number;
    profitability: number;
    marketCap: number;
  };

  isDisqualified: boolean;
  disqualifyReason: string | null;

  topPattern: {
    name: string;
    rank: string;
    winRate: number;
    signal: string;
  } | null;

  technicalSignal: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";

  weeklyTrendPenalty: number;
}

/** 後方互換: 旧 ScorerInput */
export type ScorerInput = LogicScoreInput;
/** 後方互換: 旧 TechnicalScore */
export type TechnicalScore = LogicScore;

// ========================================
// 即死ルール
// ========================================

interface DisqualifyResult {
  isDisqualified: boolean;
  reason: string | null;
}

function checkDisqualify(input: LogicScoreInput): DisqualifyResult {
  const { latestPrice, weeklyVolatility, historicalData } = input;

  // 10万円で買えない（株価 > 1,000円）
  if (latestPrice > SCORING.DISQUALIFY.MAX_PRICE) {
    return { isDisqualified: true, reason: "price_too_high" };
  }

  // 値幅率が広すぎる（当日 high-low / close > 5%）
  if (historicalData.length > 0) {
    const latest = historicalData[0];
    if (latest.close <= 0) {
      return { isDisqualified: true, reason: "invalid_price_data" };
    }
    const spreadPct = (latest.high - latest.low) / latest.close;
    if (spreadPct > SCORING.DISQUALIFY.MAX_DAILY_SPREAD_PCT) {
      return { isDisqualified: true, reason: "spread_too_wide" };
    }
  }

  // ボラティリティ異常（週次 > 8%）
  if (
    weeklyVolatility != null &&
    weeklyVolatility > SCORING.DISQUALIFY.MAX_WEEKLY_VOLATILITY
  ) {
    return { isDisqualified: true, reason: "volatility_extreme" };
  }

  // 決算発表前後はエントリー禁止（前5日〜後2日）
  if (input.nextEarningsDate) {
    const now = new Date();
    const diffDays = Math.round(
      (input.nextEarningsDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (
      diffDays >= -SCORING.DISQUALIFY.EARNINGS_DAYS_AFTER &&
      diffDays <= SCORING.DISQUALIFY.EARNINGS_DAYS_BEFORE
    ) {
      return { isDisqualified: true, reason: "earnings_upcoming" };
    }
  }

  // 配当落ち日前後はエントリー禁止（前2日〜後1日）
  if (input.exDividendDate) {
    const now = new Date();
    const diffDays = Math.round(
      (input.exDividendDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (
      diffDays >= -SCORING.DISQUALIFY.EX_DIVIDEND_DAYS_AFTER &&
      diffDays <= SCORING.DISQUALIFY.EX_DIVIDEND_DAYS_BEFORE
    ) {
      return { isDisqualified: true, reason: "ex_dividend_upcoming" };
    }
  }

  return { isDisqualified: false, reason: null };
}

// ========================================
// カテゴリ1: テクニカル指標（40点）
// ========================================

/** RSI スコア（0-12点）— 区分線形: RSI 50-65 に最高得点 */
export function scoreRSI(rsi: number | null): number {
  if (rsi == null) return 0;
  const max = SCORING.SUB_MAX.RSI; // 12
  if (rsi >= 50 && rsi < 65) return max;
  if (rsi >= 40 && rsi < 50) return Math.round(4 + (rsi - 40) / 10 * (max - 4));
  if (rsi >= 65 && rsi < 75) return Math.round(max - (rsi - 65) / 10 * (max - 4));
  if (rsi >= 30 && rsi < 40) return Math.round((rsi - 30) / 10 * 4);
  return 0;
}

/** MACD スコア（0-7点）— 加速度判定付き */
export function scoreMACD(summary: TechnicalSummary, prevHistogram: number | null): number {
  const macd = summary.macd;
  if (!macd || macd.macd == null || macd.signal == null || macd.histogram == null) return 0;
  if (macd.macd > macd.signal) {
    if (macd.histogram > 0) {
      return (prevHistogram !== null && macd.histogram > prevHistogram) ? 7 : 5;
    }
    return 3;
  }
  if (prevHistogram !== null && macd.histogram > prevHistogram) return 1;
  return 0;
}

/** 1本前のヒストグラムを取得（MACD加速度判定用） */
export function getPrevHistogram(historicalData: OHLCVData[]): number | null {
  if (historicalData.length < 36) return null;
  const prevData = historicalData.slice(1);
  const prices = prevData.map((d) => ({ close: d.close }));
  const result = calculateMACD(prices);
  return result.histogram;
}

/** 相対強度スコア（0-15点）— 呼び出し元で事前計算したRSスコアをクランプ */
export function scoreRS(rsScore: number | undefined): number {
  if (rsScore == null) return 0;
  return Math.min(SCORING.SUB_MAX.RELATIVE_STRENGTH, Math.max(0, Math.round(rsScore)));
}

/**
 * 銘柄群のセクター内相対強度スコアを一括計算
 *
 * - セクター平均との差分（相対パフォーマンス）でパーセンタイルを算出
 * - セクター銘柄数が MIN_SECTOR_STOCKS 未満の場合は 0 を返す
 */
export function calculateRsScores(
  candidates: { tickerCode: string; weekChangeRate: number | null; sector: string }[],
  sectorAvgs: Record<string, number>,
): Map<string, number> {
  const result = new Map<string, number>();
  const maxScore = SCORING.RELATIVE_STRENGTH.MAX_SCORE;
  const minStocks = SCORING.RELATIVE_STRENGTH.MIN_SECTOR_STOCKS;
  const rsValues: { tickerCode: string; rs: number }[] = [];
  for (const c of candidates) {
    if (c.weekChangeRate == null || sectorAvgs[c.sector] == null) {
      result.set(c.tickerCode, 0);
      continue;
    }
    const sectorCount = candidates.filter(
      (x) => x.sector === c.sector && x.weekChangeRate != null,
    ).length;
    if (sectorCount < minStocks) {
      result.set(c.tickerCode, 0);
      continue;
    }
    rsValues.push({ tickerCode: c.tickerCode, rs: c.weekChangeRate - sectorAvgs[c.sector] });
  }
  if (rsValues.length === 0) return result;
  const sorted = [...rsValues].sort((a, b) => a.rs - b.rs);
  for (let i = 0; i < sorted.length; i++) {
    const percentile = sorted.length === 1 ? 50 : (i / (sorted.length - 1)) * 100;
    result.set(sorted[i].tickerCode, Math.round((percentile / 100) * maxScore));
  }
  return result;
}

/** 移動平均線 / 乖離率 スコア（0-18点） */
export function scoreMA(summary: TechnicalSummary): number {
  const { trend, orderAligned, slopesAligned } = summary.maAlignment;
  if (trend === "uptrend" && orderAligned && slopesAligned) return 18;
  if (trend === "uptrend" && orderAligned) return 14;
  if (trend === "uptrend") return 10;
  if (trend === "downtrend" && orderAligned && slopesAligned) return 0;
  if (trend === "downtrend" && orderAligned) return 1;
  if (trend === "downtrend") return 3;
  return 6; // neutral
}

// ========================================
// 出来高方向性分析
// ========================================

interface VolumeDirectionResult {
  direction: VolumeDirection;
  buyingRatio: number; // 0-1（買い出来高 / 全出来高）
  obvTrend: "up" | "down" | "flat";
}

/**
 * 出来高の方向性を分析（買い集め vs 投げ売り）
 *
 * Factor 1: 陽線/陰線 × 出来高で「買い出来高」「売り出来高」を推定
 * Factor 2: OBVトレンドで中期的な資金フローを確認
 */
export function calculateVolumeDirection(
  ohlcvData: OHLCVData[],
): VolumeDirectionResult {
  const vd = SCORING.VOLUME_DIRECTION;

  if (ohlcvData.length < vd.MIN_DATA_DAYS) {
    return { direction: "neutral", buyingRatio: 0.5, obvTrend: "flat" };
  }

  // Factor 1: 陽線/陰線ベースの買い/売り出来高比率（直近N日）
  const lookbackDays = Math.min(ohlcvData.length, vd.LOOKBACK_DAYS);
  const recentData = ohlcvData.slice(0, lookbackDays);

  let buyingVolume = 0;
  let sellingVolume = 0;

  for (const d of recentData) {
    if (d.volume <= 0) continue;
    if (d.close > d.open) {
      buyingVolume += d.volume;
    } else if (d.close < d.open) {
      sellingVolume += d.volume;
    } else {
      // 同値: 50/50に分配
      buyingVolume += d.volume * 0.5;
      sellingVolume += d.volume * 0.5;
    }
  }

  const totalVolume = buyingVolume + sellingVolume;
  const buyingRatio = totalVolume > 0 ? buyingVolume / totalVolume : 0.5;

  // Factor 2: OBVトレンド（直近N日）
  const obvDays = Math.min(ohlcvData.length, vd.OBV_PERIOD);
  const obvData = ohlcvData.slice(0, obvDays).slice().reverse(); // oldest first
  let obv = 0;
  const obvValues: number[] = [0];

  for (let i = 1; i < obvData.length; i++) {
    if (obvData[i].close > obvData[i - 1].close) {
      obv += obvData[i].volume;
    } else if (obvData[i].close < obvData[i - 1].close) {
      obv -= obvData[i].volume;
    }
    obvValues.push(obv);
  }

  // OBV前半 vs 後半の平均を比較
  const mid = Math.floor(obvValues.length / 2);
  const recentHalf = obvValues.slice(mid);
  const earlierHalf = obvValues.slice(0, mid);
  const recentAvg =
    recentHalf.reduce((s, v) => s + v, 0) / recentHalf.length;
  const earlierAvg =
    earlierHalf.length > 0
      ? earlierHalf.reduce((s, v) => s + v, 0) / earlierHalf.length
      : 0;

  let obvTrend: "up" | "down" | "flat" = "flat";
  if (earlierAvg === 0) {
    if (recentAvg > 0) obvTrend = "up";
    else if (recentAvg < 0) obvTrend = "down";
  } else {
    if (recentAvg > earlierAvg * 1.1) obvTrend = "up";
    else if (recentAvg < earlierAvg * 0.9) obvTrend = "down";
  }

  // 総合判定: 買い出来高比率をベースに、OBVで補強
  let direction: VolumeDirection = "neutral";

  if (buyingRatio >= vd.ACCUMULATION_THRESHOLD) {
    direction = "accumulation";
  } else if (buyingRatio <= vd.DISTRIBUTION_THRESHOLD) {
    direction = "distribution";
  } else if (obvTrend === "up" && buyingRatio >= 0.5) {
    // OBV上昇 + やや買い優勢 → 買い集め
    direction = "accumulation";
  } else if (obvTrend === "down" && buyingRatio <= 0.5) {
    // OBV下降 + やや売り優勢 → 投げ売り
    direction = "distribution";
  }

  return { direction, buyingRatio, obvTrend };
}

/** 出来高変化スコア（0-13点）— 出来高の量 × 方向性で評価（連続関数） */
export function scoreVolumeChange(
  volumeRatio: number | null,
  direction: VolumeDirection,
): number {
  if (volumeRatio == null) return 0;
  const baseScore = Math.max(0, Math.min(10, volumeRatio * 5));
  const multiplier = direction === "accumulation" ? 1.3 : direction === "distribution" ? 0.5 : 1.0;
  return Math.min(SCORING.SUB_MAX.VOLUME_CHANGE, Math.round(baseScore * multiplier));
}

// ========================================
// カテゴリ2: チャート・ローソク足パターン（20点）
// ========================================

/** チャートパターン スコア（0-10点） */
export function scoreChartPattern(
  patterns: ChartPatternResult[],
): { score: number; topPattern: LogicScore["topPattern"] } {
  if (patterns.length === 0) {
    return { score: 0, topPattern: null };
  }

  const max = SCORING.SUB_MAX.CHART_PATTERN; // 10
  const rankScoreMap: Record<ChartPatternRank, number> = {
    S: max,  // 10
    A: 8,
    B: 6,
    C: 4,
    D: 2,
  };

  const buyPatterns = patterns.filter((p) => p.signal === "buy");
  const sellPatterns = patterns.filter((p) => p.signal === "sell");

  if (buyPatterns.length > 0) {
    const best = buyPatterns.sort(
      (a, b) => rankScoreMap[b.rank] - rankScoreMap[a.rank],
    )[0];
    return {
      score: rankScoreMap[best.rank],
      topPattern: {
        name: best.patternName,
        rank: best.rank,
        winRate: best.winRate,
        signal: best.signal,
      },
    };
  }

  if (sellPatterns.length > 0) {
    const best = sellPatterns.sort(
      (a, b) => rankScoreMap[b.rank] - rankScoreMap[a.rank],
    )[0];
    // 売りパターンは反転（高ランク売り = 低スコア）
    const invertedScore = max - rankScoreMap[best.rank];
    return {
      score: invertedScore,
      topPattern: {
        name: best.patternName,
        rank: best.rank,
        winRate: best.winRate,
        signal: best.signal,
      },
    };
  }

  // neutral パターンのみ
  const best = patterns[0];
  return {
    score: Math.round(max * 0.4), // 4
    topPattern: {
      name: best.patternName,
      rank: best.rank,
      winRate: best.winRate,
      signal: best.signal,
    },
  };
}

/** ローソク足パターン スコア（0-5点）— null=0, neutral=0 */
export function scoreCandlestick(pattern: PatternResult | null): number {
  const max = SCORING.SUB_MAX.CANDLESTICK; // 5
  if (pattern == null) return 0;
  if (pattern.signal === "buy") return Math.round(pattern.strength * max / 100);
  if (pattern.signal === "sell") return Math.round((100 - pattern.strength) * max / 100);
  return 0;
}

// ========================================
// カテゴリ3: 流動性（25点）
// ========================================

/** 売買代金スコア（0-5点） */
export function scoreTradingValue(price: number, volume: number): number {
  const tradingValue = price * volume;
  const tiers = SCORING.LIQUIDITY.TRADING_VALUE_TIERS;
  const scores = [5, 4, 3, 1];

  for (let i = 0; i < tiers.length; i++) {
    if (tradingValue >= tiers[i]) return scores[i];
  }
  return 0;
}

/** 値幅率スコア（スプレッド代替）（0-3点）— 空データ=0 */
export function scoreSpreadProxy(historicalData: OHLCVData[]): number {
  if (historicalData.length === 0) return 0;

  const latest = historicalData[0];
  if (latest.close <= 0) return 0;
  const spreadPct = (latest.high - latest.low) / latest.close;
  const tiers = SCORING.LIQUIDITY.SPREAD_PROXY_TIERS;
  const scores = [3, 2, 1, 0];

  for (let i = 0; i < tiers.length; i++) {
    if (spreadPct <= tiers[i]) return scores[i];
  }
  return 0;
}

/** 売買代金安定性スコア（0-2点）：過去5日の売買代金の変動係数 */
export function scoreStability(historicalData: OHLCVData[]): number {
  const days = Math.min(historicalData.length, 5);
  if (days < 2) return 0; // データ不足は0

  const tradingValues = historicalData.slice(0, days).map(
    (d) => d.close * d.volume,
  );
  const mean = tradingValues.reduce((s, v) => s + v, 0) / tradingValues.length;
  if (mean === 0) return 1;

  const variance =
    tradingValues.reduce((s, v) => s + (v - mean) ** 2, 0) / tradingValues.length;
  const cv = Math.sqrt(variance) / mean; // 変動係数

  const tiers = SCORING.LIQUIDITY.STABILITY_CV_TIERS;
  const scores = [2, 1, 1];

  for (let i = 0; i < tiers.length; i++) {
    if (cv <= tiers[i]) return scores[i];
  }
  return 0;
}

// ========================================
// カテゴリ4: ファンダメンタルズ（15点）
// ========================================

/** PER スコア（0-4点） */
export function scorePER(per: number | null): number {
  if (per == null || per <= 0) return SCORING.FUNDAMENTAL.PER_DEFAULT;

  for (const tier of SCORING.FUNDAMENTAL.PER_TIERS) {
    if (per >= tier.min && per < tier.max) return tier.score;
  }
  return SCORING.FUNDAMENTAL.PER_DEFAULT; // PER >= 50
}

/** PBR スコア（0-3点） */
export function scorePBR(pbr: number | null): number {
  if (pbr == null) return SCORING.FUNDAMENTAL.PBR_DEFAULT;
  if (pbr > 5.0) return SCORING.FUNDAMENTAL.PBR_OVER_5;

  for (const tier of SCORING.FUNDAMENTAL.PBR_TIERS) {
    if (pbr >= tier.min && pbr < tier.max) return tier.score;
  }
  return SCORING.FUNDAMENTAL.PBR_DEFAULT;
}

/** 収益性スコア（0-2点）— EPS基準 */
export function scoreProfitability(eps: number | null, latestPrice: number): number {
  if (eps == null) return SCORING.FUNDAMENTAL.EPS_NULL;
  if (eps <= 0) return SCORING.FUNDAMENTAL.EPS_NEGATIVE;

  if (latestPrice > 0 && eps >= latestPrice * SCORING.FUNDAMENTAL.EPS_STRONG_RATIO) {
    return SCORING.SUB_MAX.PROFITABILITY; // 2点
  }
  return SCORING.FUNDAMENTAL.EPS_POSITIVE; // 1点
}

/** 時価総額スコア（0-1点） */
export function scoreMarketCapFundamental(marketCap: number | null): number {
  if (marketCap == null) return SCORING.FUNDAMENTAL.MARKET_CAP_DEFAULT;

  for (const tier of SCORING.FUNDAMENTAL.MARKET_CAP_TIERS) {
    if (marketCap >= tier.min) return tier.score;
  }
  return SCORING.FUNDAMENTAL.MARKET_CAP_DEFAULT;
}

// ========================================
// メインスコアリング関数
// ========================================

export function getRank(score: number): "S" | "A" | "B" | "C" {
  if (score >= SCORING.THRESHOLDS.S_RANK) return "S";
  if (score >= SCORING.THRESHOLDS.A_RANK) return "A";
  if (score >= SCORING.THRESHOLDS.B_RANK) return "B";
  return "C";
}

function getTechnicalSignal(
  score: number,
): "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell" {
  if (score >= 80) return "strong_buy";
  if (score >= 65) return "buy";
  if (score >= 50) return "neutral";
  if (score >= 35) return "sell";
  return "strong_sell";
}

/**
 * 4カテゴリスコアリング（100点満点）
 *
 * 即死ルール → テクニカル(40) + パターン(20) + 流動性(25) + ファンダ(15)
 */
export function scoreTechnicals(input: LogicScoreInput): LogicScore {
  const {
    summary,
    chartPatterns,
    candlestickPattern,
    historicalData,
    latestPrice,
    latestVolume,
    fundamentals,
  } = input;

  // 即死ルールチェック
  const disqualify = checkDisqualify(input);
  if (disqualify.isDisqualified) {
    return {
      totalScore: 0,
      rank: "C",
      technical: { total: 0, rsi: 0, ma: 0, volume: 0, volumeDirection: "neutral", macd: 0, rs: 0 },
      pattern: { total: 0, chart: 0, candlestick: 0 },
      liquidity: { total: 0, tradingValue: 0, spreadProxy: 0, stability: 0 },
      fundamental: { total: 0, per: 0, pbr: 0, profitability: 0, marketCap: 0 },
      isDisqualified: true,
      disqualifyReason: disqualify.reason,
      topPattern: null,
      technicalSignal: "strong_sell",
      weeklyTrendPenalty: 0,
    };
  }

  // カテゴリ1: テクニカル指標（40点）
  const rsiScore = scoreRSI(summary.rsi);
  let maScore = scoreMA(summary);
  const volumeDir = calculateVolumeDirection(historicalData);
  const volumeChangeScore = scoreVolumeChange(
    summary.volumeAnalysis.volumeRatio,
    volumeDir.direction,
  );

  // 週足トレンド整合性チェック: 日足↑ × 週足↓ → MA減点
  let weeklyTrendPenalty = 0;
  if (
    input.weeklyTrend &&
    input.weeklyTrend.trend === "downtrend" &&
    summary.maAlignment.trend === "uptrend"
  ) {
    weeklyTrendPenalty = -SCORING.WEEKLY_TREND.PENALTY;
    maScore = Math.max(0, maScore + weeklyTrendPenalty);
  }

  const prevHistogram = getPrevHistogram(historicalData);
  const macdScore = scoreMACD(summary, prevHistogram);
  const rsScoreValue = scoreRS(input.rsScore);
  const technicalTotal = rsiScore + maScore + volumeChangeScore + macdScore + rsScoreValue;

  // カテゴリ2: チャート・ローソク足パターン（20点）
  const { score: chartScore, topPattern } = scoreChartPattern(chartPatterns);
  const candlestickScore = scoreCandlestick(candlestickPattern);
  const patternTotal = chartScore + candlestickScore;

  // カテゴリ3: 流動性（25点）
  const tradingValueScore = scoreTradingValue(latestPrice, latestVolume);
  const spreadProxyScore = scoreSpreadProxy(historicalData);
  const stabilityScore = scoreStability(historicalData);
  const liquidityTotal = tradingValueScore + spreadProxyScore + stabilityScore;

  // カテゴリ4: ファンダメンタルズ（15点）
  const perScore = scorePER(fundamentals?.per ?? null);
  const pbrScore = scorePBR(fundamentals?.pbr ?? null);
  const profitabilityScore = scoreProfitability(
    fundamentals?.eps ?? null,
    fundamentals?.latestPrice ?? latestPrice,
  );
  const marketCapScore = scoreMarketCapFundamental(fundamentals?.marketCap ?? null);
  const fundamentalTotal = perScore + pbrScore + profitabilityScore + marketCapScore;

  const totalScore = technicalTotal + patternTotal + liquidityTotal + fundamentalTotal;

  return {
    totalScore,
    rank: getRank(totalScore),
    technical: {
      total: technicalTotal,
      rsi: rsiScore,
      ma: maScore,
      volume: volumeChangeScore,
      volumeDirection: volumeDir.direction,
      macd: macdScore,
      rs: rsScoreValue,
    },
    pattern: {
      total: patternTotal,
      chart: chartScore,
      candlestick: candlestickScore,
    },
    liquidity: {
      total: liquidityTotal,
      tradingValue: tradingValueScore,
      spreadProxy: spreadProxyScore,
      stability: stabilityScore,
    },
    fundamental: {
      total: fundamentalTotal,
      per: perScore,
      pbr: pbrScore,
      profitability: profitabilityScore,
      marketCap: marketCapScore,
    },
    isDisqualified: false,
    disqualifyReason: null,
    topPattern,
    technicalSignal: getTechnicalSignal(totalScore),
    weeklyTrendPenalty,
  };
}
