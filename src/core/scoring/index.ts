import { ATR } from "technicalindicators";
import {
  calculateSMA,
  aggregateDailyToWeekly,
} from "../../lib/technical-indicators";
import { calculateBBWidthPercentile } from "../../lib/technical-indicators/bb-width-history";
import { SCORING, SECTOR_MOMENTUM_SCORING } from "../../lib/constants/scoring";
import { checkGates } from "./gates";
import { scoreTrendQuality, countDaysAboveSma25 } from "./trend-quality";
import { scoreEntryTiming } from "./entry-timing";
import {
  scoreRiskQuality,
  calculateAtrCv,
  calculateVolumeCv,
} from "./risk-quality";
import { scoreSectorMomentum } from "./sector-momentum";
import { getRank } from "./types";
import type { ScoringInput, NewLogicScore } from "./types";

export type { ScoringInput, NewLogicScore, ScoringGateResult } from "./types";
export { getRank } from "./types";

/**
 * メインスコアリング関数
 * 4カテゴリ（トレンド品質40 + エントリータイミング35 + リスク品質20 + セクターモメンタム5）= 100点満点
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
    rank: "D",
    gate,
    trendQuality: { total: 0, maAlignment: 0, weeklyTrend: 0, trendContinuity: 0 },
    entryTiming: { total: 0, pullbackDepth: 0, priorBreakout: 0, candlestickSignal: 0 },
    riskQuality: { total: 0, atrStability: 0, rangeContraction: 0, volumeStability: 0 },
    sectorMomentumScore: 0,
    isDisqualified: true,
    disqualifyReason: gate.failedGate,
  };

  if (!gate.passed) return zeroResult;

  // --- 2. 週足データ合成 ---
  const dailyOldestFirst = [...historicalData].reverse();
  const weeklyBars = aggregateDailyToWeekly(dailyOldestFirst);

  let weeklyClose: number | null = null;
  let weeklySma13: number | null = null;
  let prevWeeklySma13: number | null = null;

  if (weeklyBars.length >= 14) {
    const weeklyNewestFirst = [...weeklyBars].reverse().map((b) => ({ close: b.close }));
    weeklySma13 = calculateSMA(weeklyNewestFirst, 13);
    weeklyClose = weeklyNewestFirst[0].close;

    // 前週のSMA13: 1本ずらして計算
    if (weeklyNewestFirst.length >= 14) {
      prevWeeklySma13 = calculateSMA(weeklyNewestFirst.slice(1), 13);
    }
  }

  // 週足下降トレンド即死ルール: 週足SMA13を下回る銘柄はエントリー禁止
  if (weeklySma13 != null && weeklyClose != null && weeklyClose < weeklySma13) {
    return {
      ...zeroResult,
      gate: { passed: false, failedGate: "weeklyDowntrend" },
      disqualifyReason: "weeklyDowntrend",
    };
  }

  // --- 3. SMA25上の連続日数 ---
  const daysAboveSma25 = countDaysAboveSma25(historicalData);

  // --- 4. ATR14のCV ---
  const atr14Values = computeAtr14Series(historicalData);
  const atrCv = calculateAtrCv(atr14Values);

  // --- 5. 出来高CV ---
  const volumes = historicalData.map((d) => d.volume);
  const volumeCv = calculateVolumeCv(volumes);

  // --- 6. 出来高MA ---
  const volumeNewestFirst = historicalData.map((d) => ({ close: d.volume }));
  const volumeMA5 = calculateSMA(volumeNewestFirst, 5);
  const volumeMA25 = calculateSMA(volumeNewestFirst, 25);

  // --- 7. BB幅パーセンタイル ---
  const closePrices = historicalData.map((d) => d.close);
  const bbWidthPercentile = calculateBBWidthPercentile(
    closePrices,
    20,
    SCORING.RISK.BB_WIDTH_LOOKBACK,
  );

  // --- 8. 各カテゴリスコアリング ---
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

  // --- sector momentum ---
  const sectorMomentumScore = scoreSectorMomentum(input.sectorRelativeStrength);

  // --- 9. 合計 & ランク ---
  const totalScore = trendQuality.total + entryTiming.total + riskQuality.total + sectorMomentumScore;

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
 * ATR(14)の直近20日分の時系列を計算
 * @param data OHLCVデータ（newest-first）
 * @returns ATR14値の配列（newest-first）
 */
function computeAtr14Series(data: OHLCVData[]): number[] {
  if (data.length < 34) return []; // 14(ATR期間) + 20(CV計算) = 34

  const reversed = [...data].reverse();
  const result = ATR.calculate({
    high: reversed.map((d) => d.high),
    low: reversed.map((d) => d.low),
    close: reversed.map((d) => d.close),
    period: 14,
  });

  // oldest-first → newest-first
  return [...result].reverse();
}

type OHLCVData = ScoringInput["historicalData"][0];

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

  // セクターモメンタム（5点）
  lines.push(`  セクターモメンタム: ${score.sectorMomentumScore}/${SECTOR_MOMENTUM_SCORING.CATEGORY_MAX}`);

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
