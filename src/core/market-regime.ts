/**
 * マーケットレジーム判定モジュール
 *
 * VIXベースの機械的レジーム判定。
 * AIの前段で動作し、VIX > 30 の暴落局面ではAI判断を待たず取引停止する。
 *
 * 日経VI（^JNV）はYahoo Financeで取得不可となったため廃止。
 * VIXをプライマリ指標として使用する（日経VIとの相関が高く、実用上問題なし）。
 */

import { VIX_THRESHOLDS, MARKET_REGIME, CME_NIGHT_DIVERGENCE, STRATEGY_SWITCHING } from "../lib/constants";

export type RegimeLevel = "normal" | "elevated" | "high" | "crisis";

export interface MarketRegime {
  level: RegimeLevel;
  vix: number;
  maxPositions: number;
  minRank: "S" | "A" | "B" | null; // nullは取引停止
  shouldHaltTrading: boolean;
  reason: string;
}

/**
 * VIX水準からマーケットレジームを機械的に判定する
 *
 * - VIX > 30: crisis → 取引停止（AI判断不要）
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
      minRank: MARKET_REGIME.CRISIS.minRank,
      shouldHaltTrading: true,
      reason: `VIX ${vix.toFixed(1)} > ${VIX_THRESHOLDS.HIGH}: 市場パニック状態。全取引停止`,
    };
  }

  if (vix > VIX_THRESHOLDS.ELEVATED) {
    return {
      level: "high",
      vix,
      maxPositions: MARKET_REGIME.HIGH.maxPositions,
      minRank: MARKET_REGIME.HIGH.minRank,
      shouldHaltTrading: false,
      reason: `VIX ${vix.toFixed(1)} > ${VIX_THRESHOLDS.ELEVATED}: 高ボラティリティ。最大${MARKET_REGIME.HIGH.maxPositions}ポジション、Sランクのみ`,
    };
  }

  if (vix > VIX_THRESHOLDS.NORMAL) {
    return {
      level: "elevated",
      vix,
      maxPositions: MARKET_REGIME.ELEVATED.maxPositions,
      minRank: MARKET_REGIME.ELEVATED.minRank,
      shouldHaltTrading: false,
      reason: `VIX ${vix.toFixed(1)} > ${VIX_THRESHOLDS.NORMAL}: やや不安定。最大${MARKET_REGIME.ELEVATED.maxPositions}ポジション、S/Aランク`,
    };
  }

  return {
    level: "normal",
    vix,
    maxPositions: MARKET_REGIME.NORMAL.maxPositions,
    minRank: MARKET_REGIME.NORMAL.minRank,
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

export type TradingStrategy = "day_trade" | "swing";

export interface StrategyDecision {
  strategy: TradingStrategy;
  reason: string;
}

/**
 * 市場環境に基づいて当日の取引戦略を決定する（日単位・全銘柄共通）
 *
 * オーバーナイトリスクが高い環境ではデイトレに切り替え、持ち越しを回避する。
 * - VIX ≥ 25: デイトレ（翌日のギャップダウンリスクが高い）
 * - CME乖離率 ≤ -1.5%: デイトレ（翌朝のギャップリスクが顕在化）
 * - それ以外: スイング（トレンドに乗って利を伸ばす）
 */
export function determineTradingStrategy(
  vix: number,
  cmeDivergencePct: number | null,
): StrategyDecision {
  // VIXチェック（オーバーナイトリスク）
  if (vix >= STRATEGY_SWITCHING.VIX_DAY_TRADE_THRESHOLD) {
    return {
      strategy: "day_trade",
      reason: `VIX ${vix.toFixed(1)} ≥ ${STRATEGY_SWITCHING.VIX_DAY_TRADE_THRESHOLD}: オーバーナイトリスク回避のためデイトレ`,
    };
  }

  // CME乖離率チェック（翌朝ギャップリスク）
  if (
    cmeDivergencePct != null &&
    cmeDivergencePct <= STRATEGY_SWITCHING.CME_DIVERGENCE_DAY_TRADE_THRESHOLD
  ) {
    return {
      strategy: "day_trade",
      reason: `CME乖離率 ${cmeDivergencePct.toFixed(2)}% ≤ ${STRATEGY_SWITCHING.CME_DIVERGENCE_DAY_TRADE_THRESHOLD}%: ギャップリスク回避のためデイトレ`,
    };
  }

  return {
    strategy: STRATEGY_SWITCHING.DEFAULT_STRATEGY,
    reason: `通常環境（VIX ${vix.toFixed(1)}, CME乖離率 ${cmeDivergencePct != null ? cmeDivergencePct.toFixed(2) + "%" : "N/A"}）→ スイング`,
  };
}

/**
 * CME先物乖離率を計算する
 *
 * @param cmeFuturesPrice CME日経先物価格（USD建て）
 * @param usdjpy USD/JPYレート
 * @param nikkeiPreviousClose 日経225前日終値
 */
export function calculateCmeDivergence(
  cmeFuturesPrice: number,
  usdjpy: number,
  nikkeiPreviousClose: number,
): number {
  const cmeFuturesJpy = cmeFuturesPrice * usdjpy;
  return ((cmeFuturesJpy / nikkeiPreviousClose) - 1) * 100;
}
