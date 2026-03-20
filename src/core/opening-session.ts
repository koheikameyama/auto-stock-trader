/**
 * 寄り付きセッション分析
 *
 * order-manager（9:30 JST）実行時に取得できる寄り付き後のデータを分析し、
 * AI レビュー向けのコンテキストを生成する。
 *
 * open, high, low, volume, price, previousClose から以下を検出:
 *   - ギャップ（前日終値と始値の乖離）
 *   - 出来高異常（25日平均比）
 *   - 寄り付き後の売り浴びせ（始値からの下落）
 */

import type { StockQuote } from "./market-data";

// ========================================
// 閾値定数
// ========================================

export const OPENING_SESSION = {
  /** ギャップダウン警告閾値（%） */
  GAP_DOWN_WARN: -2,
  /** ギャップアップ警告閾値（%） */
  GAP_UP_WARN: 3,
  /** 出来高異常判定の倍率（25日平均比） */
  VOLUME_ANOMALY_RATIO: 3,
  /** 寄り付き後売り浴びせ判定閾値（%） */
  SELL_OFF_THRESHOLD: -1.5,
} as const;

// ========================================
// インターフェース
// ========================================

export interface OpeningSessionAnalysis {
  /** ギャップ率 (open - previousClose) / previousClose * 100 */
  gapPercent: number;
  /** 出来高比率（現在出来高 / 25日平均出来高） */
  volumeRatio: number;
  /** 寄り付き後の騰落率 (price - open) / open * 100 */
  sellOffPercent: number;
  /** AI レビュー向けテキスト要約（異常がなければ null） */
  summary: string | null;
}

// ========================================
// 分析関数
// ========================================

/**
 * 寄り付きセッションを分析する
 *
 * @param quote - 現在のクォートデータ
 * @param avgVolume25 - 25日平均出来高
 * @returns 分析結果
 */
export function analyzeOpeningSession(
  quote: StockQuote,
  avgVolume25: number,
): OpeningSessionAnalysis {
  const gapPercent =
    ((quote.open - quote.previousClose) / quote.previousClose) * 100;

  const volumeRatio = avgVolume25 > 0 ? quote.volume / avgVolume25 : 0;

  const sellOffPercent = ((quote.price - quote.open) / quote.open) * 100;

  const alerts: string[] = [];

  // ギャップ検出
  if (gapPercent <= OPENING_SESSION.GAP_DOWN_WARN) {
    alerts.push(
      `大幅ギャップダウン（${gapPercent.toFixed(1)}%）。悪材料の可能性`,
    );
  } else if (gapPercent >= OPENING_SESSION.GAP_UP_WARN) {
    alerts.push(
      `大幅ギャップアップ（+${gapPercent.toFixed(1)}%）。高値掴みリスク`,
    );
  }

  // 出来高異常
  if (volumeRatio >= OPENING_SESSION.VOLUME_ANOMALY_RATIO) {
    alerts.push(
      `異常な出来高（平均の${volumeRatio.toFixed(1)}倍）。材料出現の可能性`,
    );
  }

  // 寄り付き後売り浴びせ
  if (sellOffPercent <= OPENING_SESSION.SELL_OFF_THRESHOLD) {
    alerts.push(
      `寄り付き後売り浴びせ（${sellOffPercent.toFixed(1)}%）。サポート割れリスク`,
    );
  }

  const summary = alerts.length > 0 ? alerts.join("\n") : null;

  return { gapPercent, volumeRatio, sellOffPercent, summary };
}
