/**
 * テクニカル分析統合モジュール
 *
 * 既存の technical-indicators.ts をベースに、
 * technicalindicators NPM パッケージで ATR を補強
 */

import {
  calculateRSI,
  calculateSMA,
  calculateEMA,
  calculateMACD,
  calculateBollingerBands,
  calculateMAAlignment,
  calculateDeviationRate,
  getTechnicalSignal,
  findSupportResistance,
  detectGaps,
  detectTrendlines,
} from "../lib/technical-indicators";
import { ATR } from "technicalindicators";
import {
  SMA_PERIODS,
  MACD_CONFIG,
  VOLUME_ANALYSIS,
  TECHNICAL_MIN_DATA,
} from "../lib/constants";
import type { LogicScore } from "./technical-scorer";

// ========================================
// 型定義
// ========================================

export interface OHLCVData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalSummary {
  // 基本指標
  rsi: number | null;
  sma5: number | null;
  sma25: number | null;
  sma75: number | null;
  ema12: number | null;
  ema26: number | null;
  macd: { macd: number | null; signal: number | null; histogram: number | null };
  bollingerBands: {
    upper: number | null;
    middle: number | null;
    lower: number | null;
  };
  atr14: number | null;

  // 移動平均分析
  maAlignment: {
    trend: "uptrend" | "downtrend" | "none";
    orderAligned: boolean;
    slopesAligned: boolean;
  };
  deviationRate25: number | null;

  // 総合シグナル
  signal: { signal: number; strength: string; reasons: string[] };

  // サポート・レジスタンス
  supports: number[];
  resistances: number[];

  // ギャップ
  gap: {
    type: "up" | "down" | null;
    price: number | null;
    isFilled: boolean;
  };

  // トレンドライン
  trendlines: {
    support: { direction: string; broken: boolean } | null;
    resistance: { direction: string; broken: boolean } | null;
    overallTrend: string;
  };

  // 出来高分析
  volumeAnalysis: {
    avgVolume20: number | null;
    currentVolume: number;
    volumeRatio: number | null;
  };

  // 現在価格
  currentPrice: number;
  previousClose: number | null;
}

// ========================================
// メイン分析関数
// ========================================

/**
 * OHLCVデータからテクニカル分析サマリーを生成
 * @param data - OHLCVデータ（新しい順）
 */
export function analyzeTechnicals(data: OHLCVData[]): TechnicalSummary {
  if (data.length < TECHNICAL_MIN_DATA.BASIC) {
    throw new Error("テクニカル分析には最低2日分のデータが必要です");
  }

  // technical-indicators.ts は { close, high?, low? } の新しい順配列を期待
  const priceData = data.map((d) => ({
    close: d.close,
    high: d.high,
    low: d.low,
  }));

  const currentPrice = data[0].close;
  const previousClose = data.length > 1 ? data[1].close : null;

  // 基本指標
  const rsi = calculateRSI(priceData);
  const sma5 = calculateSMA(priceData, SMA_PERIODS.SHORT);
  const sma25 = calculateSMA(priceData, SMA_PERIODS.MEDIUM);
  const sma75 = calculateSMA(priceData, SMA_PERIODS.LONG);
  const ema12 = calculateEMA(priceData, MACD_CONFIG.FAST_PERIOD);
  const ema26 = calculateEMA(priceData, MACD_CONFIG.SLOW_PERIOD);
  const macd = calculateMACD(priceData);
  const bollingerBands = calculateBollingerBands(priceData);

  // ATR (technicalindicators パッケージ使用)
  const atr14 = calculateATR14(data);

  // 移動平均分析
  const maAlignment = calculateMAAlignment(priceData);
  const deviationRate25 = calculateDeviationRate(priceData, SMA_PERIODS.MEDIUM);

  // 総合シグナル
  const signal = getTechnicalSignal(priceData);

  // サポート・レジスタンス
  const { supports, resistances } = findSupportResistance(priceData);

  // ギャップ
  const gapResult = detectGaps(priceData);

  // トレンドライン（oldest-first を期待）
  const oldestFirst = [...data].reverse().map((d) => ({
    date: d.date,
    open: d.open,
    high: d.high,
    low: d.low,
    close: d.close,
  }));
  const trendlineResult = detectTrendlines(oldestFirst);

  // 出来高分析
  const volumes = data.map((d) => d.volume);
  const avgVolume20 =
    volumes.length >= VOLUME_ANALYSIS.AVERAGE_PERIOD
      ? volumes.slice(0, VOLUME_ANALYSIS.AVERAGE_PERIOD).reduce((sum, v) => sum + v, 0) / VOLUME_ANALYSIS.AVERAGE_PERIOD
      : null;
  const currentVolume = volumes[0];
  const volumeRatio = avgVolume20 ? currentVolume / avgVolume20 : null;

  return {
    rsi,
    sma5,
    sma25,
    sma75,
    ema12,
    ema26,
    macd,
    bollingerBands,
    atr14,
    maAlignment: {
      trend: maAlignment.trend,
      orderAligned: maAlignment.orderAligned,
      slopesAligned: maAlignment.slopesAligned,
    },
    deviationRate25,
    signal,
    supports: supports.map((s) => Math.round(s * 100) / 100),
    resistances: resistances.map((r) => Math.round(r * 100) / 100),
    gap: {
      type: gapResult.type,
      price: gapResult.price,
      isFilled: gapResult.isFilled,
    },
    trendlines: {
      support: trendlineResult.support
        ? {
            direction: trendlineResult.support.direction,
            broken: trendlineResult.support.broken,
          }
        : null,
      resistance: trendlineResult.resistance
        ? {
            direction: trendlineResult.resistance.direction,
            broken: trendlineResult.resistance.broken,
          }
        : null,
      overallTrend: trendlineResult.overallTrend,
    },
    volumeAnalysis: {
      avgVolume20,
      currentVolume,
      volumeRatio: volumeRatio
        ? Math.round(volumeRatio * 100) / 100
        : null,
    },
    currentPrice,
    previousClose,
  };
}

/**
 * ATR(14) を technicalindicators パッケージで計算
 * @param data - OHLCVデータ（新しい順）
 */
function calculateATR14(data: OHLCVData[]): number | null {
  if (data.length < TECHNICAL_MIN_DATA.ATR) return null;

  // technicalindicators は oldest-first を期待
  const reversed = [...data].reverse();

  const result = ATR.calculate({
    high: reversed.map((d) => d.high),
    low: reversed.map((d) => d.low),
    close: reversed.map((d) => d.close),
    period: 14,
  });

  if (result.length === 0) return null;
  return Math.round(result[result.length - 1] * 100) / 100;
}

/**
 * テクニカルサマリーをAIプロンプト用テキストに変換
 */
export function formatTechnicalForAI(summary: TechnicalSummary): string {
  const lines: string[] = [];

  lines.push(`現在価格: ¥${summary.currentPrice.toLocaleString()}`);
  if (summary.previousClose) {
    const change = summary.currentPrice - summary.previousClose;
    const changePct = (change / summary.previousClose) * 100;
    lines.push(
      `前日比: ${change >= 0 ? "+" : ""}¥${change.toLocaleString()} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`,
    );
  }

  lines.push("");
  lines.push("【テクニカル指標】");
  if (summary.rsi != null) lines.push(`RSI(14): ${summary.rsi}`);
  if (summary.sma5 != null) lines.push(`SMA5: ¥${summary.sma5}`);
  if (summary.sma25 != null) lines.push(`SMA25: ¥${summary.sma25}`);
  if (summary.sma75 != null) lines.push(`SMA75: ¥${summary.sma75}`);
  if (summary.macd.macd != null)
    lines.push(
      `MACD: ${summary.macd.macd} / Signal: ${summary.macd.signal} / Histogram: ${summary.macd.histogram}`,
    );
  if (summary.bollingerBands.upper != null)
    lines.push(
      `ボリンジャーバンド: Upper=${summary.bollingerBands.upper} / Middle=${summary.bollingerBands.middle} / Lower=${summary.bollingerBands.lower}`,
    );
  if (summary.atr14 != null) lines.push(`ATR(14): ¥${summary.atr14}`);
  if (summary.deviationRate25 != null)
    lines.push(`25日MA乖離率: ${summary.deviationRate25}%`);

  lines.push("");
  lines.push("【トレンド分析】");
  lines.push(
    `移動平均: ${summary.maAlignment.trend} (並び順: ${summary.maAlignment.orderAligned ? "整列" : "不整列"}, 方向: ${summary.maAlignment.slopesAligned ? "一致" : "不一致"})`,
  );
  lines.push(
    `総合シグナル: ${summary.signal.strength} (スコア: ${summary.signal.signal})`,
  );
  lines.push(`  理由: ${summary.signal.reasons.join(", ")}`);
  lines.push(`トレンドライン: ${summary.trendlines.overallTrend}`);

  if (summary.supports.length > 0)
    lines.push(`支持線: ¥${summary.supports.join(", ¥")}`);
  if (summary.resistances.length > 0)
    lines.push(`抵抗線: ¥${summary.resistances.join(", ¥")}`);

  if (summary.gap.type)
    lines.push(
      `ギャップ: ${summary.gap.type === "up" ? "上窓" : "下窓"} ¥${summary.gap.price} (${summary.gap.isFilled ? "埋め済み" : "未埋め"})`,
    );

  lines.push("");
  lines.push("【出来高】");
  lines.push(
    `出来高: ${summary.volumeAnalysis.currentVolume.toLocaleString()}株`,
  );
  if (summary.volumeAnalysis.volumeRatio != null)
    lines.push(
      `出来高比率(20日平均比): ${summary.volumeAnalysis.volumeRatio}倍`,
    );

  return lines.join("\n");
}

/**
 * ロジックスコアをAIプロンプト用テキスト（3カテゴリ形式）に変換
 *
 * AIには数値の再計算をさせず、ロジックが算出したスコア内訳を提示する。
 */
export function formatScoreForAI(
  score: LogicScore,
  summary: TechnicalSummary,
): string {
  const lines: string[] = [];
  lines.push(`【総合スコア】${score.totalScore}/100（${score.rank}ランク）`);

  lines.push(`【カテゴリ別】`);

  // テクニカル指標（40点）
  lines.push(`  テクニカル: ${score.technical.total}/40`);
  lines.push(
    `    RSI: ${score.technical.rsi}/15${summary.rsi != null ? `（RSI=${summary.rsi}）` : ""}`,
  );
  lines.push(`    移動平均: ${score.technical.ma}/15`);
  if (score.weeklyTrendPenalty < 0) {
    lines.push(
      `      ※週足トレンドペナルティ: ${score.weeklyTrendPenalty}（日足↑と週足↓が矛盾）`,
    );
  }
  const volDirLabel =
    score.technical.volumeDirection === "accumulation"
      ? "買い集め"
      : score.technical.volumeDirection === "distribution"
        ? "投げ売り"
        : "中立";
  lines.push(
    `    出来高変化: ${score.technical.volume}/10${summary.volumeAnalysis.volumeRatio ? `（${summary.volumeAnalysis.volumeRatio}倍 / ${volDirLabel}）` : ""}`,
  );

  // パターン（30点）
  lines.push(`  パターン: ${score.pattern.total}/30`);
  lines.push(`    チャートパターン: ${score.pattern.chart}/22`);
  if (score.topPattern) {
    lines.push(
      `      → ${score.topPattern.name}（${score.topPattern.rank}ランク / 勝率${score.topPattern.winRate}%）`,
    );
  }
  lines.push(`    ローソク足: ${score.pattern.candlestick}/8`);

  // 流動性（30点）
  lines.push(`  流動性: ${score.liquidity.total}/30`);
  lines.push(`    売買代金: ${score.liquidity.tradingValue}/12`);
  lines.push(`    値幅率: ${score.liquidity.spreadProxy}/10`);
  lines.push(`    安定性: ${score.liquidity.stability}/8`);

  lines.push(`【ロジック判定】${score.technicalSignal}`);
  return lines.join("\n");
}
