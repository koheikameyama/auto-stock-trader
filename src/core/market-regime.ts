/**
 * マーケットレジーム判定モジュール
 *
 * VIXベースの機械的レジーム判定。
 * VIX > 30 でも完全停止せず1ポジション制限に留める（ブレイクアウト信号は自然に減少する）。
 *
 * 日経VI（^JNV）はYahoo Financeで取得不可となったため廃止。
 * VIXをプライマリ指標として使用する（日経VIとの相関が高く、実用上問題なし）。
 */

import { VIX_THRESHOLDS, MARKET_REGIME, CME_NIGHT_DIVERGENCE, NIKKEI_TREND_FILTER } from "../lib/constants";
import type { OHLCVData } from "./technical-analysis";

export type RegimeLevel = "normal" | "elevated" | "high" | "crisis";

export type Sentiment = "normal" | "crisis";

export interface MarketRegime {
  level: RegimeLevel;
  vix: number;
  maxPositions: number;
  minScore: number | null; // nullは取引停止
  shouldHaltTrading: boolean;
  reason: string;
}

/**
 * VIX水準からマーケットレジームを機械的に判定する
 *
 * - VIX > 30: crisis → 1ポジション制限（暴落時のブレイクアウトは本物の強さ）
 * - VIX 25-30: high → 最大1ポジション、Sランクのみ
 * - VIX 20-25: elevated → 最大2ポジション、S/Aランク
 * - VIX < 20: normal → 制限なし
 */
export function determineMarketRegime(vix: number): MarketRegime {
  if (vix > VIX_THRESHOLDS.HIGH) {
    return {
      level: "crisis",
      vix,
      maxPositions: MARKET_REGIME.CRISIS.maxPositions,
      minScore: MARKET_REGIME.CRISIS.minScore,
      shouldHaltTrading: false,
      reason: `VIX ${vix.toFixed(1)} > ${VIX_THRESHOLDS.HIGH}: 市場パニック状態。最大${MARKET_REGIME.CRISIS.maxPositions}ポジション`,
    };
  }

  if (vix > VIX_THRESHOLDS.ELEVATED) {
    return {
      level: "high",
      vix,
      maxPositions: MARKET_REGIME.HIGH.maxPositions,
      minScore: MARKET_REGIME.HIGH.minScore,
      shouldHaltTrading: false,
      reason: `VIX ${vix.toFixed(1)} > ${VIX_THRESHOLDS.ELEVATED}: 高ボラティリティ。最大${MARKET_REGIME.HIGH.maxPositions}ポジション、Sランクのみ`,
    };
  }

  if (vix > VIX_THRESHOLDS.NORMAL) {
    return {
      level: "elevated",
      vix,
      maxPositions: MARKET_REGIME.ELEVATED.maxPositions,
      minScore: MARKET_REGIME.ELEVATED.minScore,
      shouldHaltTrading: false,
      reason: `VIX ${vix.toFixed(1)} > ${VIX_THRESHOLDS.NORMAL}: やや不安定。最大${MARKET_REGIME.ELEVATED.maxPositions}ポジション、S/Aランク`,
    };
  }

  return {
    level: "normal",
    vix,
    maxPositions: MARKET_REGIME.NORMAL.maxPositions,
    minScore: MARKET_REGIME.NORMAL.minScore,
    shouldHaltTrading: false,
    reason: `VIX ${vix.toFixed(1)}: 通常レジーム`,
  };
}

/**
 * CME日経先物ナイトセッション乖離率からプレマーケットリスクを判定する
 *
 * 乖離率(%) = ((CME先物価格 × USDJPY) / 日経前日終値 - 1) × 100
 * ※ NKD=FはUSD建てのため、USDJPY変換が必要
 *
 * - 乖離 ≤ -3.0% → crisis（取引停止、前場でギャップダウン必至）
 * - 乖離 ≤ -1.5% → elevated以上に引き上げ（警戒モード）
 * - それ以外 → レジームへの影響なし
 */
/**
 * VIXレジーム別リスク倍率を返す（既定: elevated=0.5, high=0.25, crisis=0, normal=1.0）
 *
 * 2026-04-22 の `--compare-vix-risk` BT検証で採用された既定値。BT・本番共通で使用する。
 * BT側 combined-simulation の quantity 計算と、本番側 entry-executor の riskPct 計算の
 * 両方に適用することで、BT結果と本番挙動の乖離を減らす。
 *
 * CLAUDE.md の「高ボラでサイズ縮小」コンセプトと整合。
 */
export function getRegimeRiskScale(
  regime: RegimeLevel,
  custom?: Partial<Record<RegimeLevel, number>>,
): number {
  if (custom && custom[regime] !== undefined) return custom[regime]!;
  if (regime === "elevated") return 0.5;
  if (regime === "high") return 0.25;
  if (regime === "crisis") return 0;
  return 1.0;
}

export function determinePreMarketRegime(cmeDivergencePct: number): {
  minLevel: RegimeLevel | null;
  reason: string | null;
} {
  if (cmeDivergencePct <= CME_NIGHT_DIVERGENCE.CRITICAL) {
    return {
      minLevel: "crisis",
      reason: `CME先物乖離率 ${cmeDivergencePct.toFixed(2)}% ≤ ${CME_NIGHT_DIVERGENCE.CRITICAL}%: ギャップダウン必至。全取引停止`,
    };
  }

  if (cmeDivergencePct <= CME_NIGHT_DIVERGENCE.WARNING) {
    return {
      minLevel: "elevated",
      reason: `CME先物乖離率 ${cmeDivergencePct.toFixed(2)}% ≤ ${CME_NIGHT_DIVERGENCE.WARNING}%: 警戒モード`,
    };
  }

  return { minLevel: null, reason: null };
}

// ========================================
// 日経225トレンドフィルター
// ========================================

export interface NikkeiTrendResult {
  isUptrend: boolean;
  nikkeiClose: number;
  sma25: number | null;
  maxPositions: number;
  minScore: number | null;
  reason: string;
}

/**
 * 日経225のSMA(25)ベーストレンド判定
 *
 * 日経225終値 < SMA(25) の場合、新規エントリーを制限する。
 * VIXレジームと併用し、より制限的な方を採用する。
 *
 * @param nikkeiData oldest-first の日経225 OHLCV配列（当日以前にスライス済み）
 */
export function determineNikkeiTrend(nikkeiData: OHLCVData[]): NikkeiTrendResult {
  const { SMA_PERIOD, MAX_POSITIONS_BELOW_SMA, MIN_SCORE_BELOW_SMA } = NIKKEI_TREND_FILTER;

  if (nikkeiData.length < SMA_PERIOD) {
    return {
      isUptrend: true,
      nikkeiClose: nikkeiData.length > 0 ? nikkeiData[nikkeiData.length - 1].close : 0,
      sma25: null,
      maxPositions: Infinity,
      minScore: null,
      reason: `日経225データ不足（${nikkeiData.length}/${SMA_PERIOD}日） → フィルターなし`,
    };
  }

  const latest = nikkeiData[nikkeiData.length - 1];
  const smaSlice = nikkeiData.slice(-SMA_PERIOD);
  const sma = smaSlice.reduce((sum, bar) => sum + bar.close, 0) / SMA_PERIOD;
  const isUptrend = latest.close >= sma;

  if (isUptrend) {
    return {
      isUptrend: true,
      nikkeiClose: latest.close,
      sma25: Math.round(sma),
      maxPositions: Infinity,
      minScore: null,
      reason: `日経225 ${latest.close.toFixed(0)} ≥ SMA${SMA_PERIOD} ${sma.toFixed(0)}: 上昇トレンド`,
    };
  }

  return {
    isUptrend: false,
    nikkeiClose: latest.close,
    sma25: Math.round(sma),
    maxPositions: MAX_POSITIONS_BELOW_SMA,
    minScore: MIN_SCORE_BELOW_SMA,
    reason: `日経225 ${latest.close.toFixed(0)} < SMA${SMA_PERIOD} ${sma.toFixed(0)}: 下落トレンド → 最大${MAX_POSITIONS_BELOW_SMA}ポジション`,
  };
}

/**
 * NikkeiトレンドフィルターをMarketRegimeに適用する（より制限的な方を採用）
 */
export function applyNikkeiFilter(
  regime: MarketRegime,
  nikkeiTrend: NikkeiTrendResult,
): MarketRegime {
  if (nikkeiTrend.isUptrend) return regime;

  const newMinScore =
    nikkeiTrend.minScore !== null &&
    (regime.minScore === null || nikkeiTrend.minScore > regime.minScore)
      ? nikkeiTrend.minScore
      : regime.minScore;

  const newMaxPositions = Math.min(regime.maxPositions, nikkeiTrend.maxPositions);

  if (newMinScore === regime.minScore && newMaxPositions === regime.maxPositions) {
    return regime;
  }

  return {
    ...regime,
    minScore: newMinScore,
    maxPositions: newMaxPositions,
    reason: `${regime.reason} + 日経SMA: ${nikkeiTrend.reason}`,
  };
}

export type TradingStrategy = "breakout" | "gapup" | "momentum" | "earnings-gap" | "weekly-break" | "squeeze-breakout" | "ma-pullback" | "gapdown-reversal" | "post-surge-consolidation" | "nr7" | "stop-high" | "early-volume-spike" | "down-day-reversal" | "overnight-gap-fade";

/**
 * CME先物乖離率を計算する
 *
 * @param cmeFuturesPrice CME日経先物価格（USD建て）
 * @param usdjpy USD/JPYレート
 * @param nikkeiPreviousClose 日経225前日終値
 */
export function calculateCmeDivergence(
  cmeFuturesPrice: number,
  _usdjpy: number,
  nikkeiPreviousClose: number,
): number {
  // NKD=F は円建てなので USD/JPY 換算は不要
  return ((cmeFuturesPrice / nikkeiPreviousClose) - 1) * 100;
}
