// 技術指標計算ライブラリ

import {
  TRENDLINE,
  RSI_THRESHOLDS,
  MACD_CONFIG,
  SMA_PERIODS,
  TECHNICAL_SIGNAL,
  GAP_DETECTION,
  SUPPORT_RESISTANCE,
  MA_ALIGNMENT,
  TRENDLINE_SCORE,
  SCORING,
} from "./constants";

interface PriceData {
  close: number;
  high?: number;
  low?: number;
}

/**
 * RSI (Relative Strength Index) - 相対力指数
 * 0-100の範囲で、70以上で買われすぎ、30以下で売られすぎ
 */
export function calculateRSI(
  prices: PriceData[],
  period: number = 14,
): number | null {
  if (prices.length < period + 1) return null;

  const changes = prices
    .slice(0, period + 1)
    .map((p, i, arr) => (i === 0 ? 0 : p.close - arr[i - 1].close))
    .slice(1);

  const gains = changes.map((c) => (c > 0 ? c : 0));
  const losses = changes.map((c) => (c < 0 ? Math.abs(c) : 0));

  const avgGain = gains.reduce((sum, g) => sum + g, 0) / period;
  const avgLoss = losses.reduce((sum, l) => sum + l, 0) / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  return Math.round(rsi * 100) / 100;
}

/**
 * SMA (Simple Moving Average) - 単純移動平均
 */
export function calculateSMA(
  prices: PriceData[],
  period: number,
): number | null {
  if (prices.length < period) return null;

  const sum = prices.slice(0, period).reduce((acc, p) => acc + p.close, 0);
  return Math.round((sum / period) * 100) / 100;
}

/**
 * EMA (Exponential Moving Average) - 指数移動平均
 */
export function calculateEMA(
  prices: PriceData[],
  period: number,
): number | null {
  if (prices.length < period) return null;

  const k = 2 / (period + 1);
  const sma = calculateSMA(prices.slice(-period), period);
  if (!sma) return null;

  let ema = sma;
  for (let i = prices.length - period - 1; i >= 0; i--) {
    ema = prices[i].close * k + ema * (1 - k);
  }

  return Math.round(ema * 100) / 100;
}

/**
 * MACD (Moving Average Convergence Divergence)
 * MACDライン、シグナルライン、ヒストグラムを計算
 *
 * シグナル線はMACDヒストリーの9期間EMAで正しく算出する。
 * 必要データ数: SLOW_PERIOD(26) + SIGNAL_PERIOD(9) - 1 = 34日分
 */
export function calculateMACD(prices: PriceData[]): {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
} {
  const minRequired = MACD_CONFIG.SLOW_PERIOD + MACD_CONFIG.SIGNAL_PERIOD - 1;
  if (prices.length < MACD_CONFIG.SLOW_PERIOD) {
    return { macd: null, signal: null, histogram: null };
  }

  // 各日のMACD値を算出するため、各日のEMA12/EMA26を逐次計算
  // prices は新しい順なので reversed で古い順にする
  const closes = prices.map((p) => p.close).reverse();

  const fastK = 2 / (MACD_CONFIG.FAST_PERIOD + 1);
  const slowK = 2 / (MACD_CONFIG.SLOW_PERIOD + 1);
  const signalK = 2 / (MACD_CONFIG.SIGNAL_PERIOD + 1);

  // EMA12の初期値: 最初の12日のSMA
  let emaFast =
    closes.slice(0, MACD_CONFIG.FAST_PERIOD).reduce((s, v) => s + v, 0) /
    MACD_CONFIG.FAST_PERIOD;

  // EMA26の初期値: 最初の26日のSMA
  let emaSlow =
    closes.slice(0, MACD_CONFIG.SLOW_PERIOD).reduce((s, v) => s + v, 0) /
    MACD_CONFIG.SLOW_PERIOD;

  // SLOW_PERIOD目からMACD値を蓄積
  const macdHistory: number[] = [];

  // EMA12を先にSLOW_PERIOD-1まで進める
  for (let i = MACD_CONFIG.FAST_PERIOD; i < MACD_CONFIG.SLOW_PERIOD; i++) {
    emaFast = closes[i] * fastK + emaFast * (1 - fastK);
  }

  // SLOW_PERIOD目以降: EMA12とEMA26を同時に更新しMACD値を記録
  macdHistory.push(emaFast - emaSlow);
  for (let i = MACD_CONFIG.SLOW_PERIOD; i < closes.length; i++) {
    emaFast = closes[i] * fastK + emaFast * (1 - fastK);
    emaSlow = closes[i] * slowK + emaSlow * (1 - slowK);
    macdHistory.push(emaFast - emaSlow);
  }

  const currentMacd = macdHistory[macdHistory.length - 1];

  // シグナル線: MACDヒストリーの9期間EMA
  if (macdHistory.length < MACD_CONFIG.SIGNAL_PERIOD) {
    // シグナル線を計算するにはデータ不足だが、MACDは返せる
    return {
      macd: Math.round(currentMacd * 100) / 100,
      signal: null,
      histogram: null,
    };
  }

  let signalEma =
    macdHistory.slice(0, MACD_CONFIG.SIGNAL_PERIOD).reduce((s, v) => s + v, 0) /
    MACD_CONFIG.SIGNAL_PERIOD;

  for (let i = MACD_CONFIG.SIGNAL_PERIOD; i < macdHistory.length; i++) {
    signalEma = macdHistory[i] * signalK + signalEma * (1 - signalK);
  }

  const histogram = currentMacd - signalEma;

  return {
    macd: Math.round(currentMacd * 100) / 100,
    signal: Math.round(signalEma * 100) / 100,
    histogram: Math.round(histogram * 100) / 100,
  };
}

/**
 * ボリンジャーバンド
 */
export function calculateBollingerBands(
  prices: PriceData[],
  period: number = 20,
  stdDev: number = 2,
): {
  upper: number | null;
  middle: number | null;
  lower: number | null;
} {
  if (prices.length < period) {
    return { upper: null, middle: null, lower: null };
  }

  const middle = calculateSMA(prices, period);
  if (!middle) return { upper: null, middle: null, lower: null };

  const recentPrices = prices.slice(0, period).map((p) => p.close);
  const variance =
    recentPrices.reduce((sum, price) => sum + Math.pow(price - middle, 2), 0) /
    period;
  const sd = Math.sqrt(variance);

  return {
    upper: Math.round((middle + stdDev * sd) * 100) / 100,
    middle: Math.round(middle * 100) / 100,
    lower: Math.round((middle - stdDev * sd) * 100) / 100,
  };
}

/**
 * 技術指標の総合評価（買いシグナル = 1, 売りシグナル = -1, 中立 = 0）
 */
export function getTechnicalSignal(prices: PriceData[]): {
  signal: number;
  strength: string;
  reasons: string[];
} {
  const rsi = calculateRSI(prices);
  const sma25 = calculateSMA(prices, SMA_PERIODS.MEDIUM);
  const macd = calculateMACD(prices);
  const maAlignment = calculateMAAlignment(prices);
  const currentPrice = prices[0].close;

  let signal = 0;
  const reasons: string[] = [];

  // RSIチェック
  if (rsi !== null) {
    if (rsi < RSI_THRESHOLDS.OVERSOLD) {
      signal += 1;
      reasons.push(`RSI${rsi.toFixed(1)}で売られすぎ`);
    } else if (rsi > RSI_THRESHOLDS.OVERBOUGHT) {
      signal -= 1;
      reasons.push(`RSI${rsi.toFixed(1)}で買われすぎ`);
    }
  }

  // 移動平均チェック
  if (sma25 !== null) {
    if (currentPrice > sma25) {
      signal += TECHNICAL_SIGNAL.MA_WEIGHT;
      reasons.push("25日移動平均を上回る");
    } else {
      signal -= TECHNICAL_SIGNAL.MA_WEIGHT;
      reasons.push("25日移動平均を下回る");
    }
  }

  // MACDチェック
  if (macd.macd !== null && macd.signal !== null) {
    if (macd.histogram && macd.histogram > 0) {
      signal += TECHNICAL_SIGNAL.MA_WEIGHT;
      reasons.push("MACDが上向き");
    } else {
      signal -= TECHNICAL_SIGNAL.MA_WEIGHT;
      reasons.push("MACDが下向き");
    }
  }

  // 移動平均線の並び・方向性チェック（パーフェクトオーダー）
  if (maAlignment.trend === "uptrend") {
    signal += TECHNICAL_SIGNAL.PERFECT_ORDER;
    reasons.push("移動平均線が上昇トレンド（短期→中期→長期の順に並び右肩上がり）");
  } else if (maAlignment.trend === "downtrend") {
    signal -= TECHNICAL_SIGNAL.PERFECT_ORDER;
    reasons.push("移動平均線が下降トレンド（長期→中期→短期の順に並び右肩下がり）");
  } else if (maAlignment.orderAligned && !maAlignment.slopesAligned) {
    // 並びは正しいが方向性が揃っていない（トレンド転換の可能性）
    if (maAlignment.sma5 !== null && maAlignment.sma75 !== null) {
      if (maAlignment.sma5 > maAlignment.sma75) {
        signal += TECHNICAL_SIGNAL.PARTIAL_ORDER;
        reasons.push("移動平均線の並びは上昇順だが方向性は不揃い");
      } else {
        signal -= TECHNICAL_SIGNAL.PARTIAL_ORDER;
        reasons.push("移動平均線の並びは下降順だが方向性は不揃い");
      }
    }
  }

  let strength = "中立";
  if (signal >= TECHNICAL_SIGNAL.STRONG_BUY) strength = "強い買い";
  else if (signal >= TECHNICAL_SIGNAL.BUY) strength = "買い";
  else if (signal <= TECHNICAL_SIGNAL.STRONG_SELL) strength = "強い売り";
  else if (signal <= TECHNICAL_SIGNAL.SELL) strength = "売り";

  return {
    signal: Math.round(signal * 100) / 100,
    strength,
    reasons,
  };
}

/**
 * 移動平均線の並び順・方向性を評価（パーフェクトオーダー判定）
 * 上昇トレンド: SMA5 > SMA25 > SMA75、かつ3本とも右肩上がり
 * 下降トレンド: SMA5 < SMA25 < SMA75、かつ3本とも右肩下がり
 *
 * @param prices - 価格データ（新しい順）
 * @param slopeLookback - 方向性判定のための比較日数（デフォルト5日）
 */
export function calculateMAAlignment(
  prices: PriceData[],
  slopeLookback: number = MA_ALIGNMENT.SLOPE_LOOKBACK,
): {
  trend: "uptrend" | "downtrend" | "none";
  sma5: number | null;
  sma25: number | null;
  sma75: number | null;
  orderAligned: boolean;
  slopesAligned: boolean;
} {
  const sma5 = calculateSMA(prices, SMA_PERIODS.SHORT);
  const sma25 = calculateSMA(prices, SMA_PERIODS.MEDIUM);
  const sma75 = calculateSMA(prices, SMA_PERIODS.LONG);

  const noTrend = {
    trend: "none" as const,
    sma5,
    sma25,
    sma75,
    orderAligned: false,
    slopesAligned: false,
  };

  if (!sma5 || !sma25 || !sma75) return noTrend;

  const isUptrendOrder = sma5 > sma25 && sma25 > sma75;
  const isDowntrendOrder = sma5 < sma25 && sma25 < sma75;

  if (!isUptrendOrder && !isDowntrendOrder) return noTrend;

  // N日前のMAと比較して方向性を判定
  if (prices.length < SMA_PERIODS.LONG + slopeLookback) {
    return { ...noTrend, orderAligned: true };
  }

  const prevPrices = prices.slice(slopeLookback);
  const prevSma5 = calculateSMA(prevPrices, 5);
  const prevSma25 = calculateSMA(prevPrices, 25);
  const prevSma75 = calculateSMA(prevPrices, 75);

  if (!prevSma5 || !prevSma25 || !prevSma75) {
    return { ...noTrend, orderAligned: true };
  }

  const allRising = sma5 > prevSma5 && sma25 > prevSma25 && sma75 > prevSma75;
  const allFalling = sma5 < prevSma5 && sma25 < prevSma25 && sma75 < prevSma75;

  if (isUptrendOrder && allRising) {
    return {
      trend: "uptrend",
      sma5,
      sma25,
      sma75,
      orderAligned: true,
      slopesAligned: true,
    };
  }

  if (isDowntrendOrder && allFalling) {
    return {
      trend: "downtrend",
      sma5,
      sma25,
      sma75,
      orderAligned: true,
      slopesAligned: true,
    };
  }

  return {
    trend: "none",
    sma5,
    sma25,
    sma75,
    orderAligned: true,
    slopesAligned: false,
  };
}

/**
 * 移動平均線からの乖離率（%）を計算
 * 乖離率 = (現在価格 - SMA) / SMA × 100
 *
 * @param prices - 価格データ（新しい順）
 * @param period - 移動平均の期間（デフォルト25日）
 * @returns 乖離率（%）。データ不足の場合は null
 */
export function calculateDeviationRate(
  prices: PriceData[],
  period: number = 25,
): number | null {
  const sma = calculateSMA(prices, period);
  if (sma === null || sma === 0) return null;

  const currentPrice = prices[0].close;
  const rate = ((currentPrice - sma) / sma) * 100;
  return Math.round(rate * 100) / 100;
}
/**
 * 窓（ギャップ）判定ロジック
 * 直近の「窓開け」の発生と、それが「窓埋め」されたかを判定する
 */
export function detectGaps(prices: PriceData[]): {
  type: "up" | "down" | null;
  price: number | null;
  isFilled: boolean;
  date: string | null;
} {
  // prices は新しい順 (index 0 が最新)
  if (prices.length < 2)
    return { type: null, price: null, isFilled: false, date: null };

  // 直近最大5日間で窓を探す
  for (let i = 0; i < Math.min(GAP_DETECTION.LOOKBACK_DAYS, prices.length - 1); i++) {
    const today = prices[i];
    const yesterday = prices[i + 1];

    if (
      today.high === undefined ||
      today.low === undefined ||
      yesterday.high === undefined ||
      yesterday.low === undefined
    )
      continue;

    // 上窓 (昨日の高値より今日の下値が高い)
    if (today.low > yesterday.high) {
      // 窓埋め判定: 以降の日の安値がこの窓の水準まで下がったか
      let isFilled = false;
      for (let j = 0; j < i; j++) {
        const p = prices[j];
        if (p && p.low !== undefined && p.low <= yesterday.high) {
          isFilled = true;
          break;
        }
      }
      return {
        type: "up",
        price: yesterday.high,
        isFilled,
        date: (today as any).date || null,
      };
    }

    // 下窓 (昨日の安値より今日の高値が低い)
    if (today.high < yesterday.low) {
      // 窓埋め判定: 以降の日の高値がこの窓の水準まで上がったか
      let isFilled = false;
      for (let j = 0; j < i; j++) {
        const p = prices[j];
        if (p && p.high !== undefined && p.high >= yesterday.low) {
          isFilled = true;
          break;
        }
      }
      return {
        type: "down",
        price: yesterday.low,
        isFilled,
        date: (today as any).date || null,
      };
    }
  }

  return { type: null, price: null, isFilled: false, date: null };
}

/**
 * 支持線・抵抗線の抽出ロジック
 * 過去の値動きから反発・反落が多かった主要な価格帯を抽出する
 */
export function findSupportResistance(prices: PriceData[]): {
  supports: number[];
  resistances: number[];
} {
  if (prices.length < SUPPORT_RESISTANCE.MIN_DATA_POINTS) return { supports: [], resistances: [] };

  const highs = prices
    .map((p) => p.high || p.close)
    .filter(Boolean) as number[];
  const lows = prices.map((p) => p.low || p.close).filter(Boolean) as number[];

  // ヒストグラム的手法で価格の出現頻度を確認
  const pricePoints = [...highs, ...lows];
  const min = Math.min(...pricePoints);
  const max = Math.max(...pricePoints);
  const step = (max - min) / SUPPORT_RESISTANCE.BUCKET_COUNT;

  const buckets: { [key: number]: number } = {};
  pricePoints.forEach((p) => {
    const bucket = Math.floor((p - min) / step);
    buckets[bucket] = (buckets[bucket] || 0) + 1;
  });

  // 頻出価格帯を特定
  const sortedBuckets = Object.entries(buckets)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SUPPORT_RESISTANCE.TOP_LEVELS);

  const levels = sortedBuckets.map(
    ([bucket]) => min + Number(bucket) * step + step / 2,
  );
  const currentPrice = prices[0].close;

  return {
    supports: levels.filter((l) => l < currentPrice).sort((a, b) => b - a),
    resistances: levels.filter((l) => l > currentPrice).sort((a, b) => a - b),
  };
}

/**
 * トレンドラインの1点
 */
export interface TrendlinePoint {
  index: number;
  date: string;
  price: number;
}

/**
 * トレンドライン（支持線または抵抗線）の結果
 */
export interface TrendlineInfo {
  startPoint: TrendlinePoint;
  endPoint: TrendlinePoint;
  slope: number;
  direction: "up" | "flat" | "down";
  currentProjectedPrice: number;
  broken: boolean;
  touches: number;
}

/**
 * トレンドライン検出の結果
 */
export interface TrendlineResult {
  support: TrendlineInfo | null;
  resistance: TrendlineInfo | null;
  overallTrend: "uptrend" | "downtrend" | "sideways";
}

/**
 * トレンドライン用のOHLCデータ型
 */
interface TrendlinePriceData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * ローカル極値（高値/安値のピーク/トラフ）を検出する
 */
function findTrendlineExtremes(
  prices: TrendlinePriceData[],
  windowSize: number = TRENDLINE.WINDOW_SIZE,
): { peaks: number[]; troughs: number[] } {
  const peaks: number[] = [];
  const troughs: number[] = [];

  for (let i = windowSize; i < prices.length - windowSize; i++) {
    let isPeak = true;
    let isTrough = true;

    for (let j = 1; j <= windowSize; j++) {
      if (
        prices[i].high <= prices[i - j].high ||
        prices[i].high <= prices[i + j].high
      ) {
        isPeak = false;
      }
      if (
        prices[i].low >= prices[i - j].low ||
        prices[i].low >= prices[i + j].low
      ) {
        isTrough = false;
      }
    }

    if (isPeak) peaks.push(i);
    if (isTrough) troughs.push(i);
  }

  return { peaks, troughs };
}

/**
 * 2点を通る直線上のインデックス位置での価格を計算する
 */
function getProjectedPrice(
  idx1: number,
  price1: number,
  idx2: number,
  price2: number,
  targetIdx: number,
): number {
  if (idx1 === idx2) return price1;
  const slope = (price2 - price1) / (idx2 - idx1);
  return price1 + slope * (targetIdx - idx1);
}

/**
 * サポートトレンドライン（安値同士を結ぶ上昇支持線）を検出する
 *
 * アルゴリズム:
 * 1. ローカルの安値（トラフ）を検出
 * 2. すべてのトラフのペアに対してラインを引く
 * 3. 各ラインの品質を評価:
 *    - 接触回数（ラインに近い安値の数）
 *    - 逸脱回数（ラインを下回る安値の数）
 * 4. 最も品質の高いラインを選択
 */
function detectSupportTrendline(
  prices: TrendlinePriceData[],
  troughs: number[],
): TrendlineInfo | null {
  if (troughs.length < TRENDLINE.MIN_TOUCHES) return null;

  const minSpan = Math.floor(prices.length * TRENDLINE.MIN_SPAN_RATIO);
  let bestScore = -Infinity;
  let bestLine: {
    i: number;
    j: number;
    touches: number;
    slope: number;
  } | null = null;

  for (let a = 0; a < troughs.length; a++) {
    for (let b = a + 1; b < troughs.length; b++) {
      const idxA = troughs[a];
      const idxB = troughs[b];

      // スパンが短すぎるラインは除外
      if (idxB - idxA < minSpan) continue;

      const priceA = prices[idxA].low;
      const priceB = prices[idxB].low;
      const slope = (priceB - priceA) / (idxB - idxA);
      const avgPrice = (priceA + priceB) / 2;

      let touches = 0;
      let violations = 0;

      for (let k = idxA; k <= Math.min(idxB, prices.length - 1); k++) {
        const projected = getProjectedPrice(idxA, priceA, idxB, priceB, k);
        const diff = (prices[k].low - projected) / avgPrice;

        if (Math.abs(diff) <= TRENDLINE.TOUCH_TOLERANCE) {
          touches++;
        } else if (diff < -TRENDLINE.TOUCH_TOLERANCE) {
          violations++;
        }
      }

      const totalPoints = idxB - idxA + 1;
      if (violations / totalPoints > TRENDLINE.MAX_VIOLATION_RATIO) continue;
      if (touches < TRENDLINE.MIN_TOUCHES) continue;

      // スコア: 接触回数を重視、スパンの長さにボーナス
      const score = touches * TRENDLINE_SCORE.TOUCH_WEIGHT + (idxB - idxA) * TRENDLINE_SCORE.SPAN_WEIGHT - violations * TRENDLINE_SCORE.VIOLATION_PENALTY;

      if (score > bestScore) {
        bestScore = score;
        bestLine = { i: idxA, j: idxB, touches, slope };
      }
    }
  }

  if (!bestLine) return null;

  const { i, j, touches, slope } = bestLine;
  const avgPrice =
    prices.reduce((sum, p) => sum + p.close, 0) / prices.length;
  const normalizedSlope = slope / avgPrice;

  let direction: "up" | "flat" | "down" = "flat";
  if (normalizedSlope > TRENDLINE.SIGNIFICANT_SLOPE) direction = "up";
  else if (normalizedSlope < -TRENDLINE.SIGNIFICANT_SLOPE) direction = "down";

  const lastIdx = prices.length - 1;
  const currentProjectedPrice = getProjectedPrice(
    i,
    prices[i].low,
    j,
    prices[j].low,
    lastIdx,
  );
  const latestLow = prices[lastIdx].low;
  const broken = latestLow < currentProjectedPrice * (1 - TRENDLINE.TOUCH_TOLERANCE);

  return {
    startPoint: { index: i, date: prices[i].date, price: prices[i].low },
    endPoint: { index: j, date: prices[j].date, price: prices[j].low },
    slope,
    direction,
    currentProjectedPrice: Math.round(currentProjectedPrice * 100) / 100,
    broken,
    touches,
  };
}

/**
 * レジスタンストレンドライン（高値同士を結ぶ抵抗線）を検出する
 */
function detectResistanceTrendline(
  prices: TrendlinePriceData[],
  peaks: number[],
): TrendlineInfo | null {
  if (peaks.length < TRENDLINE.MIN_TOUCHES) return null;

  const minSpan = Math.floor(prices.length * TRENDLINE.MIN_SPAN_RATIO);
  let bestScore = -Infinity;
  let bestLine: {
    i: number;
    j: number;
    touches: number;
    slope: number;
  } | null = null;

  for (let a = 0; a < peaks.length; a++) {
    for (let b = a + 1; b < peaks.length; b++) {
      const idxA = peaks[a];
      const idxB = peaks[b];

      if (idxB - idxA < minSpan) continue;

      const priceA = prices[idxA].high;
      const priceB = prices[idxB].high;
      const slope = (priceB - priceA) / (idxB - idxA);
      const avgPrice = (priceA + priceB) / 2;

      let touches = 0;
      let violations = 0;

      for (let k = idxA; k <= Math.min(idxB, prices.length - 1); k++) {
        const projected = getProjectedPrice(idxA, priceA, idxB, priceB, k);
        const diff = (prices[k].high - projected) / avgPrice;

        if (Math.abs(diff) <= TRENDLINE.TOUCH_TOLERANCE) {
          touches++;
        } else if (diff > TRENDLINE.TOUCH_TOLERANCE) {
          violations++;
        }
      }

      const totalPoints = idxB - idxA + 1;
      if (violations / totalPoints > TRENDLINE.MAX_VIOLATION_RATIO) continue;
      if (touches < TRENDLINE.MIN_TOUCHES) continue;

      const score = touches * TRENDLINE_SCORE.TOUCH_WEIGHT + (idxB - idxA) * TRENDLINE_SCORE.SPAN_WEIGHT - violations * TRENDLINE_SCORE.VIOLATION_PENALTY;

      if (score > bestScore) {
        bestScore = score;
        bestLine = { i: idxA, j: idxB, touches, slope };
      }
    }
  }

  if (!bestLine) return null;

  const { i, j, touches, slope } = bestLine;
  const avgPrice =
    prices.reduce((sum, p) => sum + p.close, 0) / prices.length;
  const normalizedSlope = slope / avgPrice;

  let direction: "up" | "flat" | "down" = "flat";
  if (normalizedSlope > TRENDLINE.SIGNIFICANT_SLOPE) direction = "up";
  else if (normalizedSlope < -TRENDLINE.SIGNIFICANT_SLOPE) direction = "down";

  const lastIdx = prices.length - 1;
  const currentProjectedPrice = getProjectedPrice(
    i,
    prices[i].high,
    j,
    prices[j].high,
    lastIdx,
  );
  const latestHigh = prices[lastIdx].high;
  const broken = latestHigh > currentProjectedPrice * (1 + TRENDLINE.TOUCH_TOLERANCE);

  return {
    startPoint: { index: i, date: prices[i].date, price: prices[i].high },
    endPoint: { index: j, date: prices[j].date, price: prices[j].high },
    slope,
    direction,
    currentProjectedPrice: Math.round(currentProjectedPrice * 100) / 100,
    broken,
    touches,
  };
}

/**
 * トレンドライン検出（メインのエントリーポイント）
 *
 * 安値同士を結ぶサポートラインと高値同士を結ぶレジスタンスラインを検出し、
 * 全体のトレンド方向を判定する。
 *
 * @param prices - OHLC データ（oldest-first）
 */
export function detectTrendlines(
  prices: TrendlinePriceData[],
): TrendlineResult {
  const empty: TrendlineResult = {
    support: null,
    resistance: null,
    overallTrend: "sideways",
  };

  if (prices.length < TRENDLINE.MIN_DATA_POINTS) return empty;

  const { peaks, troughs } = findTrendlineExtremes(prices);

  const support = detectSupportTrendline(prices, troughs);
  const resistance = detectResistanceTrendline(prices, peaks);

  // 全体トレンドの判定
  let overallTrend: "uptrend" | "downtrend" | "sideways" = "sideways";

  if (support && resistance) {
    // 両方検出された場合、傾きの方向で判定
    if (support.direction === "up" && resistance.direction === "up") {
      overallTrend = "uptrend";
    } else if (support.direction === "down" && resistance.direction === "down") {
      overallTrend = "downtrend";
    }
  } else if (support) {
    if (support.direction === "up") overallTrend = "uptrend";
    else if (support.direction === "down") overallTrend = "downtrend";
  } else if (resistance) {
    if (resistance.direction === "up") overallTrend = "uptrend";
    else if (resistance.direction === "down") overallTrend = "downtrend";
  }

  return { support, resistance, overallTrend };
}

// ========================================
// 週足トレンド分析
// ========================================

export interface WeeklyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface WeeklyTrendResult {
  trend: "uptrend" | "downtrend" | "none";
  sma13: number | null;
  sma26: number | null;
}

/**
 * 日足OHLCVデータ（oldest-first）を週足に集計する
 *
 * ISO週（月曜始まり）でグループ化し、各週のOHLCVを生成。
 * - open: 週初日の始値
 * - high: 週中の最高値
 * - low: 週中の最安値
 * - close: 週最終日の終値
 * - volume: 週合計出来高
 * - date: 週初日の日付
 *
 * @param dailyBars - 日足データ（oldest-first）
 * @returns 週足データ（oldest-first）
 */
export function aggregateDailyToWeekly(
  dailyBars: Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>,
): WeeklyBar[] {
  if (dailyBars.length === 0) return [];

  // ISO週キー（YYYY-WXX）でグループ化
  const weekMap = new Map<string, typeof dailyBars>();

  for (const bar of dailyBars) {
    const d = new Date(bar.date);
    // ISO week: 月曜始まり
    const dayOfWeek = d.getUTCDay() || 7; // 日曜=7
    const thursday = new Date(d);
    thursday.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(
      ((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
    const key = `${thursday.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;

    if (!weekMap.has(key)) {
      weekMap.set(key, []);
    }
    weekMap.get(key)!.push(bar);
  }

  // 各週のOHLCVを算出（oldest-first）
  const weeklyBars: WeeklyBar[] = [];
  const sortedKeys = [...weekMap.keys()].sort();

  for (const key of sortedKeys) {
    const bars = weekMap.get(key)!;
    if (bars.length === 0) continue;

    weeklyBars.push({
      date: bars[0].date,
      open: bars[0].open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((sum, b) => sum + b.volume, 0),
    });
  }

  return weeklyBars;
}

/**
 * 週足のSMA13/SMA26アラインメントからトレンド方向を判定する
 *
 * - SMA13 > SMA26 → uptrend
 * - SMA13 < SMA26 → downtrend
 * - データ不足 or SMA13 ≈ SMA26 → none
 *
 * @param weeklyBars - 週足データ（oldest-first）
 * @returns 週足トレンド結果
 */
export function analyzeWeeklyTrend(
  weeklyBars: WeeklyBar[],
): WeeklyTrendResult {
  const noTrend: WeeklyTrendResult = { trend: "none", sma13: null, sma26: null };

  if (weeklyBars.length < SCORING.WEEKLY_TREND.MIN_WEEKLY_BARS) {
    return noTrend;
  }

  // calculateSMA は newest-first を期待するので reverse
  const newestFirst = [...weeklyBars].reverse().map((b) => ({ close: b.close }));

  const sma13 = calculateSMA(newestFirst, 13);
  const sma26 = calculateSMA(newestFirst, 26);

  // SMA13だけでも判定可能（SMA26不足時は最新終値と比較）
  if (sma13 === null) return noTrend;

  if (sma26 !== null) {
    return {
      trend: sma13 > sma26 ? "uptrend" : sma13 < sma26 ? "downtrend" : "none",
      sma13,
      sma26,
    };
  }

  // SMA26がない場合: SMA13と最新終値の関係で判定
  const latestClose = weeklyBars[weeklyBars.length - 1].close;
  return {
    trend: latestClose > sma13 ? "uptrend" : latestClose < sma13 ? "downtrend" : "none",
    sma13,
    sma26: null,
  };
}
