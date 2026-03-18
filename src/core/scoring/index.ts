import { SCORING } from "../../lib/constants/scoring";
import { checkGates } from "./gates";
import { scoreTrendQuality } from "./trend-quality";
import { scoreEntryTiming } from "./entry-timing";
import { scoreRiskQuality } from "./risk-quality";
import { scoreSectorMomentum } from "./sector-momentum";
import { computeScoringIntermediates } from "./intermediates";
import { getRank } from "./types";
import type { ScoringInput, NewLogicScore } from "./types";

export type { ScoringInput, NewLogicScore, ScoringGateResult, ScoringRank } from "./types";
export type {
  HoldingScore,
  HoldingRank,
  HoldingGateResult,
  HoldingAlert,
} from "./types";
export { getRank, getHoldingRank } from "./types";
export { scoreHolding } from "./holding";

/**
 * メインスコアリング関数（エントリー判断用）
 * 3カテゴリ（トレンド品質40 + エントリータイミング35 + リスク品質25）= 100点満点
 * + セクターモメンタムボーナス（-3〜+5）
 */
export function scoreStock(input: ScoringInput): NewLogicScore {
  const { historicalData, latestPrice, summary, avgVolume25 } = input;

  // --- 1. ゲートチェック ---
  const atrPct =
    summary.atr14 != null && latestPrice > 0
      ? (summary.atr14 / latestPrice) * 100
      : null;

  const gate = checkGates({
    latestPrice,
    avgVolume25: avgVolume25 ?? null,
    atrPct,
    nextEarningsDate: input.nextEarningsDate ?? null,
    exDividendDate: input.exDividendDate ?? null,
    today: new Date(),
  });

  const zeroResult: NewLogicScore = {
    totalScore: 0,
    rank: "B",
    gate,
    trendQuality: { total: 0, maAlignment: 0, weeklyTrend: 0, trendContinuity: 0 },
    entryTiming: { total: 0, pullbackDepth: 0, priorBreakout: 0, candlestickSignal: 0 },
    riskQuality: { total: 0, atrStability: 0, rangeContraction: 0, volumeStability: 0 },
    sectorMomentumScore: 0,
    isDisqualified: true,
    disqualifyReason: gate.failedGate,
  };

  if (!gate.passed) return zeroResult;

  // --- 2. 中間値計算（共通ヘルパー） ---
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

  // 週足下降トレンド即死ルール: 週足SMA13を下回る銘柄はエントリー禁止
  if (weeklySma13 != null && weeklyClose != null && weeklyClose < weeklySma13) {
    return {
      ...zeroResult,
      gate: { passed: false, failedGate: "weeklyDowntrend" },
      disqualifyReason: "weeklyDowntrend",
    };
  }

  // --- 3. 各カテゴリスコアリング ---
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

  const entryTiming = scoreEntryTiming({
    close: latestPrice,
    sma5: summary.sma5,
    sma25: summary.sma25,
    deviationRate25: summary.deviationRate25,
    bars: historicalData,
    avgVolume25: avgVolume25 ?? null,
  });

  const riskQuality = scoreRiskQuality({
    atrCv,
    bbWidthPercentile,
    volumeMA5,
    volumeMA25,
    volumeCv,
  });

  // --- sector momentum bonus ---
  const sectorMomentumScore = scoreSectorMomentum(input.sectorRelativeStrength);

  // --- 4. 合計 & ランク ---
  const baseScore = trendQuality.total + entryTiming.total + riskQuality.total;
  const totalScore = Math.min(100, Math.max(0, baseScore + sectorMomentumScore));

  return {
    totalScore,
    rank: getRank(totalScore),
    gate,
    trendQuality,
    entryTiming,
    riskQuality,
    sectorMomentumScore,
    isDisqualified: false,
    disqualifyReason: null,
  };
}

/**
 * NewLogicScore をAIレビュー向けにフォーマット
 */
export function formatScoreForAI(
  score: NewLogicScore,
  summary: { rsi: number | null; sma25: number | null; atr14: number | null },
): string {
  const lines: string[] = [];
  lines.push(`【総合スコア】${score.totalScore}/100（${score.rank}ランク）`);

  if (score.isDisqualified) {
    lines.push(`【即死ルール】${score.disqualifyReason}`);
    return lines.join("\n");
  }

  lines.push(`【カテゴリ別】`);

  // トレンド品質（40点）
  lines.push(`  トレンド品質: ${score.trendQuality.total}/${SCORING.CATEGORY_MAX.TREND_QUALITY}`);
  lines.push(`    MA整列: ${score.trendQuality.maAlignment}/${SCORING.SUB_MAX.MA_ALIGNMENT}`);
  lines.push(`    週足トレンド: ${score.trendQuality.weeklyTrend}/${SCORING.SUB_MAX.WEEKLY_TREND}`);
  lines.push(`    トレンド継続: ${score.trendQuality.trendContinuity}/${SCORING.SUB_MAX.TREND_CONTINUITY}`);

  // エントリータイミング（35点）
  lines.push(`  エントリータイミング: ${score.entryTiming.total}/${SCORING.CATEGORY_MAX.ENTRY_TIMING}`);
  lines.push(`    押し目深さ: ${score.entryTiming.pullbackDepth}/${SCORING.SUB_MAX.PULLBACK_DEPTH}`);
  lines.push(`    BO後押し目: ${score.entryTiming.priorBreakout}/${SCORING.SUB_MAX.PRIOR_BREAKOUT}`);
  lines.push(`    ローソク足シグナル: ${score.entryTiming.candlestickSignal}/${SCORING.SUB_MAX.CANDLESTICK_SIGNAL}`);

  // リスク品質（25点）
  lines.push(`  リスク品質: ${score.riskQuality.total}/${SCORING.CATEGORY_MAX.RISK_QUALITY}`);
  lines.push(`    ATR安定性: ${score.riskQuality.atrStability}/${SCORING.SUB_MAX.ATR_STABILITY}`);
  lines.push(`    レンジ収束: ${score.riskQuality.rangeContraction}/${SCORING.SUB_MAX.RANGE_CONTRACTION}`);
  lines.push(`    出来高安定: ${score.riskQuality.volumeStability}/${SCORING.SUB_MAX.VOLUME_STABILITY}`);

  // セクターモメンタムボーナス
  const sectorSign = score.sectorMomentumScore >= 0 ? "+" : "";
  lines.push(`  セクターボーナス: ${sectorSign}${score.sectorMomentumScore}`);

  // テクニカル参考値
  const refParts: string[] = [];
  if (summary.rsi != null) refParts.push(`RSI=${summary.rsi}`);
  if (summary.sma25 != null) refParts.push(`SMA25=${summary.sma25.toFixed(0)}`);
  if (summary.atr14 != null) refParts.push(`ATR14=${summary.atr14.toFixed(1)}`);
  if (refParts.length > 0) {
    lines.push(`【参考指標】${refParts.join(" / ")}`);
  }

  return lines.join("\n");
}
