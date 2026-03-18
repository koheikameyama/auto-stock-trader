/**
 * 保有継続スコアリング（Holding Score）
 *
 * エントリータイミング（35点）を除外し、
 * トレンド品質（40点）+ リスク品質（25点）+ セクターモメンタム（-3〜+5）
 * で「保有継続すべきか」を評価する。65点満点（+セクター補正）。
 */

import { HOLDING_SCORE } from "../../lib/constants/scoring";
import { scoreTrendQuality } from "./trend-quality";
import { scoreRiskQuality } from "./risk-quality";
import { scoreSectorMomentum } from "./sector-momentum";
import { computeScoringIntermediates } from "./intermediates";
import { getHoldingRank } from "./types";
import type {
  ScoringInput,
  HoldingScore,
  HoldingAlert,
  HoldingGateResult,
} from "./types";

/**
 * 保有継続スコアリング
 * @param input エントリースコアリングと同じ入力（ScoringInput）
 * @returns HoldingScore
 */
export function scoreHolding(input: ScoringInput): HoldingScore {
  const { historicalData, latestPrice, summary, avgVolume25 } = input;

  const alerts: HoldingAlert[] = [];

  // --- 1. 保有用ゲートチェック ---
  const gate = checkHoldingGates(avgVolume25 ?? null);

  // 流動性枯渇: ゲート不通過でもスコアは計算する（情報として記録）
  if (!gate.passed && gate.failedGate === "liquidity_dried") {
    alerts.push({
      type: "liquidity_warning",
      severity: "critical",
      message: `出来高枯渇（25日平均: ${avgVolume25?.toLocaleString() ?? "不明"}）`,
    });
  }

  // --- 2. 中間値計算 ---
  const intermediates = computeScoringIntermediates(historicalData);
  const {
    weeklyClose,
    weeklySma13,
    prevWeeklySma13,
    daysAboveSma25,
    atrCv,
    volumeCv,
    volumeMA5,
    volumeMA25,
    bbWidthPercentile,
  } = intermediates;

  // 週足崩壊チェック
  if (
    weeklySma13 != null &&
    weeklyClose != null &&
    weeklyClose < weeklySma13
  ) {
    alerts.push({
      type: "trend_collapse",
      severity: "critical",
      message: `週足SMA13割れ（終値: ${weeklyClose.toFixed(0)}, SMA13: ${weeklySma13.toFixed(0)}）`,
    });

    // 週足崩壊 = ゲート不通過
    return {
      totalScore: 0,
      holdingRank: "critical",
      trendQuality: {
        total: 0,
        maAlignment: 0,
        weeklyTrend: 0,
        trendContinuity: 0,
      },
      riskQuality: {
        total: 0,
        atrStability: 0,
        rangeContraction: 0,
        volumeStability: 0,
      },
      sectorMomentumScore: 0,
      gate: { passed: false, failedGate: "weekly_breakdown" },
      alerts,
    };
  }

  // --- 3. トレンド品質（0-40点） ---
  const trendQuality = scoreTrendQuality({
    close: latestPrice,
    sma5: summary.sma5,
    sma25: summary.sma25,
    sma75: summary.sma75,
    weeklyClose,
    weeklySma13,
    prevWeeklySma13,
    daysAboveSma25,
  });

  // --- 4. リスク品質（0-25点） ---
  const riskQuality = scoreRiskQuality({
    atrCv,
    bbWidthPercentile,
    volumeMA5,
    volumeMA25,
    volumeCv,
  });

  // --- 5. セクターモメンタム（-3〜+5） ---
  const sectorMomentumScore = scoreSectorMomentum(
    input.sectorRelativeStrength,
  );

  // --- 6. 合計 & ランク ---
  const baseScore = trendQuality.total + riskQuality.total;
  const totalScore = Math.min(
    HOLDING_SCORE.TOTAL_MAX,
    Math.max(0, baseScore + sectorMomentumScore),
  );

  // --- 7. アラート生成 ---
  if (trendQuality.total <= 10) {
    alerts.push({
      type: "trend_collapse",
      severity: "warning",
      message: `トレンド品質が低下（${trendQuality.total}/40）`,
    });
  }

  if (riskQuality.total <= 5) {
    alerts.push({
      type: "risk_spike",
      severity: "warning",
      message: `リスク品質が悪化（${riskQuality.total}/25）`,
    });
  }

  if (sectorMomentumScore <= -2) {
    alerts.push({
      type: "sector_weakness",
      severity: "warning",
      message: `セクターモメンタム悪化（${sectorMomentumScore}）`,
    });
  }

  const holdingRank = getHoldingRank(totalScore);

  return {
    totalScore,
    holdingRank,
    trendQuality,
    riskQuality,
    sectorMomentumScore,
    gate: gate.passed
      ? { passed: true, failedGate: null }
      : gate,
    alerts,
  };
}

/**
 * 保有用ゲートチェック
 * エントリー用ゲートのサブセットのみ適用
 */
function checkHoldingGates(
  avgVolume25: number | null,
): HoldingGateResult {
  // 流動性枯渇
  if (
    avgVolume25 != null &&
    avgVolume25 < HOLDING_SCORE.GATES.MIN_AVG_VOLUME_25
  ) {
    return { passed: false, failedGate: "liquidity_dried" };
  }

  return { passed: true, failedGate: null };
}
