/**
 * チャートパターン検出ライブラリ
 *
 * 複数のローソク足から形成されるチャートパターン（フォーメーション）を検出する。
 * Thomas Bulkowski『Encyclopedia of Chart Patterns』(30,000+サンプル)の
 * 実証データに基づくランキング:
 *
 * 【S級 - 勝率85%以上】
 *   買い: 逆三尊(89%), ダブルボトム(88%)
 *   売り: 三尊(89%), 下降トライアングル(87%)
 *
 * 【A級 - 勝率80〜85%】
 *   買い: トリプルボトム(87%), 上昇トライアングル(83%)
 *   売り: (該当なし)
 *
 * 【B級 - 勝率65%未満】
 *   買い: カップウィズハンドル(68%), ソーサーボトム(65%), 下降ウェッジ(58%), 上昇フラッグ(54%)
 *   売り: ダブルトップ(73%), 逆カップウィズハンドル(68%), ソーサートップ(65%), 上昇ウェッジ(58%), 下降フラッグ(54%)
 *   中立: ボックスレンジ(55%), 三角保ち合い(55%)
 */

export interface PricePoint {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export type ChartPatternRank = "S" | "A" | "B";

export interface ChartPatternResult {
  pattern: string
  patternName: string
  signal: "buy" | "sell" | "neutral"
  rank: ChartPatternRank
  winRate: number // Bulkowski研究に基づく参考勝率 (0-100)
  strength: number // 0-100
  confidence: number // 0-1
  description: string
  explanation: string
  startIndex: number
  endIndex: number
}

import {
  PATTERN_CONFIG,
  CHART_PATTERNS_MIN_DATA,
  CHART_PATTERN_WINDOW_SIZE,
  DEFAULT_PRICE_TOLERANCE,
} from "./constants"

/**
 * ローカルの極値（高値・安値のピーク）を検出する
 */
function findLocalExtremes(
  prices: PricePoint[],
  windowSize: number = CHART_PATTERN_WINDOW_SIZE
): { peaks: number[]; troughs: number[] } {
  const peaks: number[] = []
  const troughs: number[] = []

  for (let i = windowSize; i < prices.length - windowSize; i++) {
    let isPeak = true
    let isTrough = true

    for (let j = 1; j <= windowSize; j++) {
      if (prices[i].high <= prices[i - j].high || prices[i].high <= prices[i + j].high) {
        isPeak = false
      }
      if (prices[i].low >= prices[i - j].low || prices[i].low >= prices[i + j].low) {
        isTrough = false
      }
    }

    if (isPeak) peaks.push(i)
    if (isTrough) troughs.push(i)
  }

  return { peaks, troughs }
}

/**
 * 2つの価格が「ほぼ同じ水準」かを判定
 */
function isSimilarPrice(price1: number, price2: number, tolerance: number = DEFAULT_PRICE_TOLERANCE): boolean {
  const avg = (price1 + price2) / 2
  if (avg <= 0) return false
  return Math.abs(price1 - price2) / avg <= tolerance
}

/**
 * トレンドの傾き（回帰直線）を計算
 */
function calculateSlope(values: number[]): number {
  const n = values.length
  if (n < 2) return 0

  const xMean = (n - 1) / 2
  const yMean = values.reduce((a, b) => a + b, 0) / n

  let numerator = 0
  let denominator = 0
  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (values[i] - yMean)
    denominator += (i - xMean) * (i - xMean)
  }

  return denominator === 0 ? 0 : numerator / denominator
}

/**
 * ① 逆三尊（Inverse Head & Shoulders）- 最強の買いシグナル
 *
 * 3つの谷で構成され、真ん中の谷（ヘッド）が最も深い。
 * 左右の谷（ショルダー）はほぼ同じ水準。
 * ネックラインを上抜けると強い上昇シグナル。
 */
function detectInverseHeadAndShoulders(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.inverse_head_and_shoulders
  if (prices.length < cfg.minDataPoints) return null

  const { troughs, peaks } = findLocalExtremes(prices, cfg.extremeWindow)

  if (troughs.length < 3 || peaks.length < 2) return null

  // 連続する3つの谷を探す
  for (let i = 0; i < troughs.length - 2; i++) {
    const leftShoulder = troughs[i]
    const head = troughs[i + 1]
    const rightShoulder = troughs[i + 2]

    // ヘッドが両ショルダーより深い
    if (prices[head].low >= prices[leftShoulder].low) continue
    if (prices[head].low >= prices[rightShoulder].low) continue

    // 両ショルダーがほぼ同じ水準
    if (!isSimilarPrice(prices[leftShoulder].low, prices[rightShoulder].low, cfg.shoulderTolerance)) continue

    // ショルダー間のピークを見つける（ネックライン）
    const necklinePeaks = peaks.filter(p => p > leftShoulder && p < rightShoulder)
    if (necklinePeaks.length < 1) continue

    const necklinePrice = Math.max(...necklinePeaks.map(p => prices[p].high))

    // 最新の終値がネックラインを上抜けているか
    const latestClose = prices[prices.length - 1].close
    const breakout = latestClose > necklinePrice

    const headDepth = (necklinePrice - prices[head].low) / necklinePrice

    return {
      pattern: "inverse_head_and_shoulders",
      patternName: "逆三尊（ぎゃくさんぞん）",
      signal: "buy",
      rank: cfg.rank,
      winRate: cfg.winRate,
      strength: breakout ? cfg.strength.breakout : cfg.strength.noBreakout,
      confidence: breakout ? cfg.confidence.breakout : cfg.confidence.noBreakout,
      description: breakout
        ? "逆三尊が完成し、ネックラインを上抜けました。強い上昇転換のサインです"
        : "逆三尊が形成中です。ネックラインを超えれば上昇転換の可能性があります",
      explanation:
        `【逆三尊とは】3回底を打つパターンで、真ん中の底が一番深い形です。` +
        `「もうこれ以上下がらない」という市場の意思が表れており、` +
        `チャートパターンの中で最も信頼度の高い買いシグナルの一つです。` +
        `谷の深さ: ${(headDepth * 100).toFixed(1)}%`,
      startIndex: leftShoulder,
      endIndex: rightShoulder,
    }
  }

  return null
}

/**
 * ② ダブルボトム（Double Bottom）- 強い買いシグナル
 *
 * 同じ水準の安値を2回つけてW字型を形成。
 * ネックラインを上抜けると上昇トレンドへ転換。
 */
function detectDoubleBottom(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.double_bottom
  if (prices.length < cfg.minDataPoints) return null

  const { troughs, peaks } = findLocalExtremes(prices, cfg.extremeWindow)

  if (troughs.length < 2 || peaks.length < 1) return null

  for (let i = 0; i < troughs.length - 1; i++) {
    const first = troughs[i]
    const second = troughs[i + 1]

    // 2つの谷の間にある程度の距離
    if (second - first < cfg.minPeakDistance) continue

    // 2つの底がほぼ同じ水準
    if (!isSimilarPrice(prices[first].low, prices[second].low, cfg.priceTolerance)) continue

    // 間にピーク（ネックライン）がある
    const middlePeaks = peaks.filter(p => p > first && p < second)
    if (middlePeaks.length === 0) continue

    const necklinePrice = Math.max(...middlePeaks.map(p => prices[p].high))
    const bottomPrice = Math.min(prices[first].low, prices[second].low)

    const latestClose = prices[prices.length - 1].close
    const breakout = latestClose > necklinePrice

    const patternHeight = (necklinePrice - bottomPrice) / bottomPrice

    return {
      pattern: "double_bottom",
      patternName: "ダブルボトム",
      signal: "buy",
      rank: cfg.rank,
      winRate: cfg.winRate,
      strength: breakout ? cfg.strength.breakout : cfg.strength.noBreakout,
      confidence: breakout ? cfg.confidence.breakout : cfg.confidence.noBreakout,
      description: breakout
        ? "ダブルボトムが完成しました。W字型の底打ちから上昇転換が期待できます"
        : "ダブルボトムを形成中です。2回同じ水準で底を打ち、反発が期待できます",
      explanation:
        `【ダブルボトムとは】株価が同じ水準で2回底を打ち、W字型を形成するパターンです。` +
        `「この価格まで下がると買いたい人が多い」ことを示しており、` +
        `ネックライン（中間の高値: ${necklinePrice.toLocaleString()}円）を超えると本格的な上昇が始まりやすいです。` +
        `パターンの高さ: ${(patternHeight * 100).toFixed(1)}%`,
      startIndex: first,
      endIndex: second,
    }
  }

  return null
}

/**
 * ③ 上昇フラッグ（Bull Flag）- 買いシグナル
 *
 * 急上昇の後、やや下向きの狭いレンジで推移する調整パターン。
 * 調整後に再び上昇する可能性が高い。
 */
function detectBullFlag(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.bull_flag
  if (prices.length < cfg.minDataPoints) return null

  // 前半: 急上昇（ポール）を探す
  const poleEnd = Math.floor(prices.length * cfg.poleEndRatio)
  const poleStart = Math.max(0, poleEnd - cfg.poleLookback)
  const poleRise =
    (prices[poleEnd].close - prices[poleStart].close) / prices[poleStart].close

  // 最低限の上昇が必要
  if (poleRise < cfg.minPoleRise) return null

  // 後半: フラッグ部分（やや下向きの狭いレンジ）
  const flagPrices = prices.slice(poleEnd)
  if (flagPrices.length < cfg.minFlagLength) return null

  const flagCloses = flagPrices.map(p => p.close)
  const flagSlope = calculateSlope(flagCloses)
  const avgPrice = flagCloses.reduce((a, b) => a + b, 0) / flagCloses.length
  const normalizedSlope = flagSlope / avgPrice

  // フラッグは緩やかに下降
  if (normalizedSlope > cfg.flagSlopeMax || normalizedSlope < cfg.flagSlopeMin) return null

  // フラッグのレンジが狭い（ボラティリティが低い）
  const flagHigh = Math.max(...flagPrices.map(p => p.high))
  const flagLow = Math.min(...flagPrices.map(p => p.low))
  const flagRange = (flagHigh - flagLow) / avgPrice

  if (flagRange > cfg.maxFlagRange) return null

  return {
    pattern: "bull_flag",
    patternName: "上昇フラッグ（ブルフラッグ）",
    signal: "buy",
    rank: cfg.rank,
    winRate: cfg.winRate,
    strength: cfg.strength.breakout,
    confidence: cfg.confidence.breakout,
    description:
      "上昇フラッグを形成中です。急上昇後の小休止で、再上昇の準備段階の可能性があります",
    explanation:
      `【上昇フラッグとは】株価が急に上がった後、少しだけ下がりながら横ばいになるパターンです。` +
      `旗竿（急上昇）と旗（調整）に見えることからこの名前がつきました。` +
      `「上昇の勢いは続いているが、一時的に休憩中」という状態です。` +
      `旗竿の上昇: +${(poleRise * 100).toFixed(1)}%、調整レンジ: ${(flagRange * 100).toFixed(1)}%`,
    startIndex: poleStart,
    endIndex: prices.length - 1,
  }
}

/**
 * ④ 上昇トライアングル（Ascending Triangle）- 買いシグナル
 *
 * 高値がほぼ水平、安値が切り上がるパターン。
 * 上値抵抗線を上抜けると上昇。
 */
function detectAscendingTriangle(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.ascending_triangle
  if (prices.length < cfg.minDataPoints) return null

  const { peaks, troughs } = findLocalExtremes(prices, cfg.extremeWindow)

  if (peaks.length < 2 || troughs.length < 2) return null

  // 高値がほぼ水平か確認
  const peakPrices = peaks.map(i => prices[i].high)
  const peakSlope = calculateSlope(peakPrices)
  const avgPeak = peakPrices.reduce((a, b) => a + b, 0) / peakPrices.length
  const normalizedPeakSlope = Math.abs(peakSlope / avgPeak)

  if (normalizedPeakSlope > cfg.peakSlopeMax) return null // 高値が水平でない

  // 安値が切り上がっているか確認
  const troughPrices = troughs.map(i => prices[i].low)
  const troughSlope = calculateSlope(troughPrices)
  const avgTrough = troughPrices.reduce((a, b) => a + b, 0) / troughPrices.length
  const normalizedTroughSlope = troughSlope / avgTrough

  if (normalizedTroughSlope <= cfg.troughSlopeMin) return null // 安値が切り上がっていない

  const resistanceLevel = avgPeak
  const latestClose = prices[prices.length - 1].close
  const breakout = latestClose > resistanceLevel

  return {
    pattern: "ascending_triangle",
    patternName: "上昇トライアングル（アセンディング・トライアングル）",
    signal: "buy",
    rank: cfg.rank,
    winRate: cfg.winRate,
    strength: breakout ? cfg.strength.breakout : cfg.strength.noBreakout,
    confidence: breakout ? cfg.confidence.breakout : cfg.confidence.noBreakout,
    description: breakout
      ? "上昇トライアングルの上値抵抗線を突破しました。上昇の勢いが強まっています"
      : "上昇トライアングルを形成中。安値が切り上がっており、上放れの可能性があります",
    explanation:
      `【上昇トライアングルとは】高値のラインはほぼ水平なのに、安値が徐々に切り上がっていくパターンです。` +
      `三角形が徐々に狭まり、買い手の圧力が強まっていることを示します。` +
      `上値の壁（${resistanceLevel.toLocaleString()}円付近）を超えると、一気に上昇することが多いです。`,
    startIndex: Math.min(...peaks, ...troughs),
    endIndex: Math.max(...peaks, ...troughs),
  }
}

/**
 * ⑤ トリプルボトム（Triple Bottom）- 買いシグナル
 *
 * 同じ水準で3回底を打つパターン。ダブルボトムより信頼度が高い。
 */
function detectTripleBottom(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.triple_bottom
  if (prices.length < cfg.minDataPoints) return null

  const { troughs, peaks } = findLocalExtremes(prices, cfg.extremeWindow)

  if (troughs.length < 3 || peaks.length < 2) return null

  for (let i = 0; i < troughs.length - 2; i++) {
    const t1 = troughs[i]
    const t2 = troughs[i + 1]
    const t3 = troughs[i + 2]

    // 3つの底がほぼ同じ水準
    const low1 = prices[t1].low
    const low2 = prices[t2].low
    const low3 = prices[t3].low

    if (!isSimilarPrice(low1, low2, cfg.priceTolerance)) continue
    if (!isSimilarPrice(low2, low3, cfg.priceTolerance)) continue
    if (!isSimilarPrice(low1, low3, cfg.priceTolerance)) continue

    // 間にピークがある
    const middlePeaks = peaks.filter(p => p > t1 && p < t3)
    if (middlePeaks.length < cfg.minMiddlePeaks) continue

    const necklinePrice = Math.max(...middlePeaks.map(p => prices[p].high))
    const bottomPrice = Math.min(low1, low2, low3)
    const latestClose = prices[prices.length - 1].close
    const breakout = latestClose > necklinePrice

    return {
      pattern: "triple_bottom",
      patternName: "トリプルボトム",
      signal: "buy",
      rank: cfg.rank,
      winRate: cfg.winRate,
      strength: breakout ? cfg.strength.breakout : cfg.strength.noBreakout,
      confidence: breakout ? cfg.confidence.breakout : cfg.confidence.noBreakout,
      description: breakout
        ? "トリプルボトムが完成しました。3回同じ底で跳ね返され、強い買い転換です"
        : "トリプルボトムを形成中。3回同じ水準で底を打っており、非常に強い下値支持があります",
      explanation:
        `【トリプルボトムとは】同じ価格帯で3回底を打つパターンです。` +
        `ダブルボトムの「もう下がらない」というサインがさらに強力になった形です。` +
        `底値: ${bottomPrice.toLocaleString()}円付近、` +
        `ネックライン: ${necklinePrice.toLocaleString()}円`,
      startIndex: t1,
      endIndex: t3,
    }
  }

  return null
}

/**
 * ⑥ ダブルトップ（Double Top）- 強い売りシグナル
 *
 * 同じ水準の高値を2回つけてM字型を形成。
 * ネックラインを下抜けると下落トレンドへ転換。
 */
function detectDoubleTop(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.double_top
  if (prices.length < cfg.minDataPoints) return null

  const { peaks, troughs } = findLocalExtremes(prices, cfg.extremeWindow)

  if (peaks.length < 2 || troughs.length < 1) return null

  for (let i = 0; i < peaks.length - 1; i++) {
    const first = peaks[i]
    const second = peaks[i + 1]

    if (second - first < cfg.minPeakDistance) continue

    // 2つの高値がほぼ同じ水準
    if (!isSimilarPrice(prices[first].high, prices[second].high, cfg.priceTolerance)) continue

    // 間にトラフ（ネックライン）がある
    const middleTroughs = troughs.filter(t => t > first && t < second)
    if (middleTroughs.length === 0) continue

    const necklinePrice = Math.min(...middleTroughs.map(t => prices[t].low))
    const topPrice = Math.max(prices[first].high, prices[second].high)

    const latestClose = prices[prices.length - 1].close
    const breakdown = latestClose < necklinePrice

    const patternHeight = (topPrice - necklinePrice) / topPrice

    return {
      pattern: "double_top",
      patternName: "ダブルトップ",
      signal: "sell",
      rank: cfg.rank,
      winRate: cfg.winRate,
      strength: breakdown ? cfg.strength.breakout : cfg.strength.noBreakout,
      confidence: breakdown ? cfg.confidence.breakout : cfg.confidence.noBreakout,
      description: breakdown
        ? "ダブルトップが完成しました。M字型の天井から下落転換が始まっています"
        : "ダブルトップを形成中です。2回同じ高値で跳ね返されており、上値が重い状況です",
      explanation:
        `【ダブルトップとは】株価が同じ水準で2回天井を打ち、M字型を形成するパターンです。` +
        `「この価格まで上がると売りたい人が多い」ことを示しており、` +
        `ネックライン（中間の安値: ${necklinePrice.toLocaleString()}円）を割り込むと下落が加速しやすいです。` +
        `パターンの高さ: ${(patternHeight * 100).toFixed(1)}%`,
      startIndex: first,
      endIndex: second,
    }
  }

  return null
}

/**
 * ⑦ 三尊（Head & Shoulders）- 売りシグナル
 *
 * 3つの山で構成され、真ん中の山（ヘッド）が最も高い。
 * ネックラインを下抜けると強い下落シグナル。
 */
function detectHeadAndShoulders(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.head_and_shoulders
  if (prices.length < cfg.minDataPoints) return null

  const { peaks, troughs } = findLocalExtremes(prices, cfg.extremeWindow)

  if (peaks.length < 3 || troughs.length < 2) return null

  for (let i = 0; i < peaks.length - 2; i++) {
    const leftShoulder = peaks[i]
    const head = peaks[i + 1]
    const rightShoulder = peaks[i + 2]

    // ヘッドが両ショルダーより高い
    if (prices[head].high <= prices[leftShoulder].high) continue
    if (prices[head].high <= prices[rightShoulder].high) continue

    // 両ショルダーがほぼ同じ水準
    if (!isSimilarPrice(prices[leftShoulder].high, prices[rightShoulder].high, cfg.shoulderTolerance)) continue

    // ショルダー間のトラフを見つける（ネックライン）
    const necklineTroughs = troughs.filter(t => t > leftShoulder && t < rightShoulder)
    if (necklineTroughs.length < 1) continue

    const necklinePrice = Math.min(...necklineTroughs.map(t => prices[t].low))
    const headHeight = (prices[head].high - necklinePrice) / prices[head].high

    const latestClose = prices[prices.length - 1].close
    const breakdown = latestClose < necklinePrice

    return {
      pattern: "head_and_shoulders",
      patternName: "三尊（さんぞん）",
      signal: "sell",
      rank: cfg.rank,
      winRate: cfg.winRate,
      strength: breakdown ? cfg.strength.breakout : cfg.strength.noBreakout,
      confidence: breakdown ? cfg.confidence.breakout : cfg.confidence.noBreakout,
      description: breakdown
        ? "三尊が完成し、ネックラインを下抜けました。強い下落転換のサインです"
        : "三尊を形成中です。ネックラインを割り込むと本格的な下落の可能性があります",
      explanation:
        `【三尊とは】3回山を作り、真ん中の山が一番高い形（人の頭と両肩に見える）です。` +
        `「上昇の勢いが弱まり、もう上がれない」ことを示す代表的な天井パターンです。` +
        `逆三尊の逆で、最も信頼度の高い売りシグナルの一つです。` +
        `ヘッドの高さ: ${(headHeight * 100).toFixed(1)}%`,
      startIndex: leftShoulder,
      endIndex: rightShoulder,
    }
  }

  return null
}

/**
 * ⑧ 下降フラッグ（Bear Flag）- 売りシグナル
 *
 * 急下落の後、やや上向きの狭いレンジで推移する調整パターン。
 * 調整後に再び下落する可能性が高い。
 */
function detectBearFlag(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.bear_flag
  if (prices.length < cfg.minDataPoints) return null

  const poleEnd = Math.floor(prices.length * cfg.poleEndRatio)
  const poleStart = Math.max(0, poleEnd - cfg.poleLookback)
  const poleDrop =
    (prices[poleStart].close - prices[poleEnd].close) / prices[poleStart].close

  // 最低限の下落が必要
  if (poleDrop < cfg.minPoleDrop) return null

  // フラッグ部分
  const flagPrices = prices.slice(poleEnd)
  if (flagPrices.length < cfg.minFlagLength) return null

  const flagCloses = flagPrices.map(p => p.close)
  const flagSlope = calculateSlope(flagCloses)
  const avgPrice = flagCloses.reduce((a, b) => a + b, 0) / flagCloses.length
  const normalizedSlope = flagSlope / avgPrice

  // フラッグは緩やかに上昇
  if (normalizedSlope < cfg.flagSlopeMin || normalizedSlope > cfg.flagSlopeMax) return null

  const flagHigh = Math.max(...flagPrices.map(p => p.high))
  const flagLow = Math.min(...flagPrices.map(p => p.low))
  const flagRange = (flagHigh - flagLow) / avgPrice

  if (flagRange > cfg.maxFlagRange) return null

  return {
    pattern: "bear_flag",
    patternName: "下降フラッグ（ベアフラッグ）",
    signal: "sell",
    rank: cfg.rank,
    winRate: cfg.winRate,
    strength: cfg.strength.breakout,
    confidence: cfg.confidence.breakout,
    description:
      "下降フラッグを形成中です。急下落後の小反発で、再下落の準備段階の可能性があります",
    explanation:
      `【下降フラッグとは】株価が急に下がった後、少しだけ上がりながら横ばいになるパターンです。` +
      `上昇フラッグの逆で、「下落の勢いは続いているが、一時的に反発中」という状態です。` +
      `旗竿の下落: -${(poleDrop * 100).toFixed(1)}%、調整レンジ: ${(flagRange * 100).toFixed(1)}%`,
    startIndex: poleStart,
    endIndex: prices.length - 1,
  }
}

/**
 * ⑨ 下降トライアングル（Descending Triangle）- 売りシグナル
 *
 * 安値がほぼ水平、高値が切り下がるパターン。
 * 下値支持線を下抜けると下落。
 */
function detectDescendingTriangle(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.descending_triangle
  if (prices.length < cfg.minDataPoints) return null

  const { peaks, troughs } = findLocalExtremes(prices, cfg.extremeWindow)

  if (peaks.length < 2 || troughs.length < 2) return null

  // 安値がほぼ水平か確認
  const troughPrices = troughs.map(i => prices[i].low)
  const troughSlope = calculateSlope(troughPrices)
  const avgTrough = troughPrices.reduce((a, b) => a + b, 0) / troughPrices.length
  const normalizedTroughSlope = Math.abs(troughSlope / avgTrough)

  if (normalizedTroughSlope > cfg.troughSlopeMax) return null

  // 高値が切り下がっているか確認
  const peakPrices = peaks.map(i => prices[i].high)
  const peakSlope = calculateSlope(peakPrices)
  const avgPeak = peakPrices.reduce((a, b) => a + b, 0) / peakPrices.length
  const normalizedPeakSlope = peakSlope / avgPeak

  if (normalizedPeakSlope >= cfg.peakSlopeMin) return null

  const supportLevel = avgTrough
  const latestClose = prices[prices.length - 1].close
  const breakdown = latestClose < supportLevel

  return {
    pattern: "descending_triangle",
    patternName: "下降トライアングル（ディセンディング・トライアングル）",
    signal: "sell",
    rank: cfg.rank,
    winRate: cfg.winRate,
    strength: breakdown ? cfg.strength.breakout : cfg.strength.noBreakout,
    confidence: breakdown ? cfg.confidence.breakout : cfg.confidence.noBreakout,
    description: breakdown
      ? "下降トライアングルの支持線を下抜けました。下落の勢いが強まっています"
      : "下降トライアングルを形成中。高値が切り下がっており、下放れの可能性があります",
    explanation:
      `【下降トライアングルとは】安値のラインはほぼ水平なのに、高値が徐々に切り下がっていくパターンです。` +
      `上昇トライアングルの逆で、売り手の圧力が強まっていることを示します。` +
      `下値の壁（${supportLevel.toLocaleString()}円付近）を割り込むと、一気に下落することが多いです。`,
    startIndex: Math.min(...peaks, ...troughs),
    endIndex: Math.max(...peaks, ...troughs),
  }
}

/**
 * ボックスレンジ（Box Range）- 中立シグナル
 *
 * 一定の価格帯で上下を繰り返すパターン。
 * どちらに抜けるかで次のトレンドが決まる。
 */
function detectBoxRange(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.box_range
  if (prices.length < cfg.minDataPoints) return null

  const { peaks, troughs } = findLocalExtremes(prices, cfg.extremeWindow)

  if (peaks.length < 2 || troughs.length < 2) return null

  // 高値がほぼ水平
  const peakPrices = peaks.map(i => prices[i].high)
  const avgPeak = peakPrices.reduce((a, b) => a + b, 0) / peakPrices.length
  const peakVariance = peakPrices.reduce((sum, p) => sum + Math.pow(p - avgPeak, 2), 0) / peakPrices.length
  const peakStdDev = Math.sqrt(peakVariance) / avgPeak

  // 安値がほぼ水平
  const troughPrices = troughs.map(i => prices[i].low)
  const avgTrough = troughPrices.reduce((a, b) => a + b, 0) / troughPrices.length
  const troughVariance = troughPrices.reduce((sum, p) => sum + Math.pow(p - avgTrough, 2), 0) / troughPrices.length
  const troughStdDev = Math.sqrt(troughVariance) / avgTrough

  // 高値・安値の標準偏差が小さい（水平に近い）
  if (peakStdDev > cfg.maxStdDev || troughStdDev > cfg.maxStdDev) return null

  // レンジの幅が適度
  const rangeWidth = (avgPeak - avgTrough) / avgTrough
  if (rangeWidth < cfg.minRangeWidth || rangeWidth > cfg.maxRangeWidth) return null

  const latestClose = prices[prices.length - 1].close
  const positionInRange = (latestClose - avgTrough) / (avgPeak - avgTrough)

  return {
    pattern: "box_range",
    patternName: "ボックスレンジ",
    signal: "neutral",
    rank: cfg.rank,
    winRate: cfg.winRate,
    strength: cfg.strength.breakout,
    confidence: cfg.confidence.breakout,
    description:
      `ボックスレンジで推移中です。${avgTrough.toLocaleString()}円〜${avgPeak.toLocaleString()}円の間で動いています`,
    explanation:
      `【ボックスレンジとは】株価が一定の範囲内で上下を繰り返す「もみ合い」の状態です。` +
      `この範囲を上に抜ければ上昇トレンド、下に抜ければ下落トレンドが始まりやすいです。` +
      `レンジ幅: ${(rangeWidth * 100).toFixed(1)}%、` +
      `現在位置: レンジの${(positionInRange * 100).toFixed(0)}%地点`,
    startIndex: Math.min(...peaks, ...troughs),
    endIndex: Math.max(...peaks, ...troughs),
  }
}

/**
 * 三角保ち合い（Symmetrical Triangle）- 中立シグナル
 *
 * 高値が切り下がり、安値が切り上がるパターン。
 * 三角形が収束し、どちらかにブレイクする。
 */
function detectSymmetricalTriangle(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.symmetrical_triangle
  if (prices.length < cfg.minDataPoints) return null

  const { peaks, troughs } = findLocalExtremes(prices, cfg.extremeWindow)

  if (peaks.length < 2 || troughs.length < 2) return null

  // 高値が切り下がっている
  const peakPrices = peaks.map(i => prices[i].high)
  const peakSlope = calculateSlope(peakPrices)
  const avgPeak = peakPrices.reduce((a, b) => a + b, 0) / peakPrices.length
  const normalizedPeakSlope = peakSlope / avgPeak

  if (normalizedPeakSlope >= cfg.peakSlopeMax) return null // 高値が切り下がっていない

  // 安値が切り上がっている
  const troughPrices = troughs.map(i => prices[i].low)
  const troughSlope = calculateSlope(troughPrices)
  const avgTrough = troughPrices.reduce((a, b) => a + b, 0) / troughPrices.length
  const normalizedTroughSlope = troughSlope / avgTrough

  if (normalizedTroughSlope <= cfg.troughSlopeMin) return null // 安値が切り上がっていない

  // 収束度合い
  const latestRange = peakPrices[peakPrices.length - 1] - troughPrices[troughPrices.length - 1]
  const initialRange = peakPrices[0] - troughPrices[0]
  const convergenceRatio = latestRange / initialRange

  return {
    pattern: "symmetrical_triangle",
    patternName: "三角保ち合い（シンメトリカル・トライアングル）",
    signal: "neutral",
    rank: cfg.rank,
    winRate: cfg.winRate,
    strength: cfg.strength.breakout,
    confidence: cfg.confidence.breakout,
    description:
      "三角保ち合いを形成中です。値幅が狭まっており、近いうちに大きく動く可能性があります",
    explanation:
      `【三角保ち合いとは】高値が切り下がり、安値が切り上がって三角形のように収束していくパターンです。` +
      `売り手と買い手がせめぎ合い、やがてどちらかに大きく動きます。` +
      `上に抜ければ買い、下に抜ければ売りのサインになります。` +
      `収束度: ${((1 - convergenceRatio) * 100).toFixed(0)}%`,
    startIndex: Math.min(...peaks, ...troughs),
    endIndex: Math.max(...peaks, ...troughs),
  }
}

/**
 * カップウィズハンドル（Cup with Handle）- B級買いシグナル
 *
 * U字型の底（カップ）の後、小さな下落調整（ハンドル）を経て上昇する。
 * Bulkowski勝率: 68%
 */
function detectCupWithHandle(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.cup_with_handle
  if (prices.length < cfg.minDataPoints) return null

  // カップ部分を探す: 前半で下落→底→上昇
  const cupEnd = Math.floor(prices.length * cfg.cupEndRatio)
  const cupStart = 0

  // カップの左リム（開始点の高値）
  const leftRimPrice = prices[cupStart].close
  // カップの底を探す
  let cupBottomIdx = cupStart
  for (let i = cupStart + 1; i < cupEnd; i++) {
    if (prices[i].low < prices[cupBottomIdx].low) {
      cupBottomIdx = i
    }
  }

  // 底がカップの中間付近にあるか（U字型の確認）
  if (cupBottomIdx < cupStart + cfg.cupBottomMargin || cupBottomIdx > cupEnd - cfg.cupBottomMargin) return null

  // カップの右リム（カップ終了点の高値）
  const rightRimPrice = prices[cupEnd].close
  const cupBottomPrice = prices[cupBottomIdx].low

  // カップの深さ（浅すぎても深すぎてもNG）
  const avgRim = (leftRimPrice + rightRimPrice) / 2
  const cupDepth = (avgRim - cupBottomPrice) / avgRim
  if (cupDepth < cfg.minCupDepth || cupDepth > cfg.maxCupDepth) return null

  // 右リムが左リムの一定割合以上まで回復していること（U字型）
  if (rightRimPrice < leftRimPrice * cfg.rimRecovery) return null

  // ハンドル部分: カップ後の小さな調整
  const handlePrices = prices.slice(cupEnd)
  if (handlePrices.length < cfg.minHandleLength) return null

  const handleLow = Math.min(...handlePrices.map(p => p.low))
  const handleDrop = (rightRimPrice - handleLow) / rightRimPrice

  // ハンドルの下落はカップ深さの一定割合以内
  if (handleDrop > cupDepth * cfg.maxHandleDropRatio) return null
  // ハンドルは最低限の調整
  if (handleDrop < cfg.minHandleDrop) return null

  const latestClose = prices[prices.length - 1].close
  const breakout = latestClose > Math.max(leftRimPrice, rightRimPrice)

  return {
    pattern: "cup_with_handle",
    patternName: "カップウィズハンドル",
    signal: "buy",
    rank: cfg.rank,
    winRate: cfg.winRate,
    strength: breakout ? cfg.strength.breakout : cfg.strength.noBreakout,
    confidence: breakout ? cfg.confidence.breakout : cfg.confidence.noBreakout,
    description: breakout
      ? "カップウィズハンドルが完成し、リム（縁）を上抜けました。上昇トレンドの開始が期待できます"
      : "カップウィズハンドルを形成中です。U字型の底から回復し、小さな調整（取っ手）を経ています",
    explanation:
      `【カップウィズハンドルとは】コーヒーカップのような形をしたパターンです。` +
      `U字型に下がって戻り（カップ）、少しだけ下がる調整（取っ手＝ハンドル）の後に上昇します。` +
      `ウォーレン・バフェットの師匠ウィリアム・オニールが重視したパターンで、成長株に多く出現します。` +
      `カップの深さ: ${(cupDepth * 100).toFixed(1)}%、ハンドルの調整: ${(handleDrop * 100).toFixed(1)}%`,
    startIndex: cupStart,
    endIndex: prices.length - 1,
  }
}

/**
 * ソーサーボトム（Saucer Bottom）- B級買いシグナル
 *
 * 非常に緩やかなU字型の底を形成する長期パターン。
 * カップウィズハンドルより浅く緩やか。
 * Bulkowski勝率: 65%
 */
function detectSaucerBottom(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.saucer_bottom
  if (prices.length < cfg.minDataPoints) return null

  // 前半で緩やかに下落、後半で緩やかに上昇
  const midPoint = Math.floor(prices.length / 2)
  const firstHalf = prices.slice(0, midPoint).map(p => p.close)
  const secondHalf = prices.slice(midPoint).map(p => p.close)

  const firstSlope = calculateSlope(firstHalf)
  const secondSlope = calculateSlope(secondHalf)

  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length

  const normFirstSlope = firstSlope / avgFirst
  const normSecondSlope = secondSlope / avgSecond

  // 前半は下降（緩やか）、後半は上昇（緩やか）
  if (normFirstSlope >= -cfg.minSlope) return null  // 前半が下がっていない
  if (normSecondSlope <= cfg.minSlope) return null   // 後半が上がっていない

  // 両方とも急激でないこと（ソーサーは緩やか）
  if (Math.abs(normFirstSlope) > cfg.maxSlope) return null
  if (Math.abs(normSecondSlope) > cfg.maxSlope) return null

  // 底が浅い
  const startPrice = prices[0].close
  const bottomPrice = Math.min(...prices.map(p => p.low))
  const endPrice = prices[prices.length - 1].close
  const depth = (Math.max(startPrice, endPrice) - bottomPrice) / Math.max(startPrice, endPrice)

  if (depth < cfg.minDepth || depth > cfg.maxDepth) return null

  // 最終価格が開始価格の一定割合以上まで回復
  if (endPrice < startPrice * cfg.minRecovery) return null

  const recovery = endPrice > startPrice

  return {
    pattern: "saucer_bottom",
    patternName: "ソーサーボトム（受け皿型の底）",
    signal: "buy",
    rank: cfg.rank,
    winRate: cfg.winRate,
    strength: recovery ? cfg.strength.breakout : cfg.strength.noBreakout,
    confidence: recovery ? cfg.confidence.breakout : cfg.confidence.noBreakout,
    description: recovery
      ? "ソーサーボトムが完成に近づいています。緩やかに底を打ち、回復基調に入っています"
      : "ソーサーボトムを形成中です。緩やかなU字型の底から徐々に回復しています",
    explanation:
      `【ソーサーボトムとは】お皿（ソーサー）のような浅くて広いU字型の底パターンです。` +
      `急落ではなく、ゆっくりと下がってゆっくりと回復する形で、「市場心理がじわじわ改善している」ことを示します。` +
      `カップウィズハンドルより穏やかで、中長期の底打ちサインとして使われます。` +
      `底の深さ: ${(depth * 100).toFixed(1)}%`,
    startIndex: 0,
    endIndex: prices.length - 1,
  }
}

/**
 * 逆カップウィズハンドル（Inverse Cup with Handle）- B級売りシグナル
 *
 * カップウィズハンドルの逆で、逆U字型の天井の後に小さな上昇調整を経て下落。
 * Bulkowski勝率: 68%
 */
function detectInverseCupWithHandle(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.inverse_cup_with_handle
  if (prices.length < cfg.minDataPoints) return null

  const cupEnd = Math.floor(prices.length * cfg.cupEndRatio)
  const cupStart = 0

  // 逆カップの左リム（開始点の安値）
  const leftRimPrice = prices[cupStart].close
  // 逆カップの天井を探す
  let cupTopIdx = cupStart
  for (let i = cupStart + 1; i < cupEnd; i++) {
    if (prices[i].high > prices[cupTopIdx].high) {
      cupTopIdx = i
    }
  }

  if (cupTopIdx < cupStart + cfg.cupTopMargin || cupTopIdx > cupEnd - cfg.cupTopMargin) return null

  const rightRimPrice = prices[cupEnd].close
  const cupTopPrice = prices[cupTopIdx].high

  // 逆カップの高さ
  const avgRim = (leftRimPrice + rightRimPrice) / 2
  const cupHeight = (cupTopPrice - avgRim) / avgRim
  if (cupHeight < cfg.minCupHeight || cupHeight > cfg.maxCupHeight) return null

  // 右リムが左リムの一定範囲以内（逆U字型）
  if (rightRimPrice > leftRimPrice * cfg.rimMax) return null

  // ハンドル部分: 逆カップ後の小さな上昇
  const handlePrices = prices.slice(cupEnd)
  if (handlePrices.length < cfg.minHandleLength) return null

  const handleHigh = Math.max(...handlePrices.map(p => p.high))
  const handleRise = (handleHigh - rightRimPrice) / rightRimPrice

  if (handleRise > cupHeight * cfg.maxHandleRiseRatio) return null
  if (handleRise < cfg.minHandleRise) return null

  const latestClose = prices[prices.length - 1].close
  const breakdown = latestClose < Math.min(leftRimPrice, rightRimPrice)

  return {
    pattern: "inverse_cup_with_handle",
    patternName: "逆カップウィズハンドル",
    signal: "sell",
    rank: cfg.rank,
    winRate: cfg.winRate,
    strength: breakdown ? cfg.strength.breakout : cfg.strength.noBreakout,
    confidence: breakdown ? cfg.confidence.breakout : cfg.confidence.noBreakout,
    description: breakdown
      ? "逆カップウィズハンドルが完成し、リムを下抜けました。下落トレンドの開始が懸念されます"
      : "逆カップウィズハンドルを形成中です。逆U字型の天井から戻りが弱い状態です",
    explanation:
      `【逆カップウィズハンドルとは】カップウィズハンドルの逆さまパターンです。` +
      `逆U字型に上がって下がり（逆カップ）、少し戻した後（ハンドル）に再下落します。` +
      `「上昇の勢いが尽きて、天井を打った」サインとして使われます。` +
      `逆カップの高さ: ${(cupHeight * 100).toFixed(1)}%、ハンドルの戻り: ${(handleRise * 100).toFixed(1)}%`,
    startIndex: cupStart,
    endIndex: prices.length - 1,
  }
}

/**
 * ソーサートップ（Saucer Top）- B級売りシグナル
 *
 * 非常に緩やかな逆U字型の天井パターン。
 * Bulkowski勝率: 65%
 */
function detectSaucerTop(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.saucer_top
  if (prices.length < cfg.minDataPoints) return null

  const midPoint = Math.floor(prices.length / 2)
  const firstHalf = prices.slice(0, midPoint).map(p => p.close)
  const secondHalf = prices.slice(midPoint).map(p => p.close)

  const firstSlope = calculateSlope(firstHalf)
  const secondSlope = calculateSlope(secondHalf)

  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length

  const normFirstSlope = firstSlope / avgFirst
  const normSecondSlope = secondSlope / avgSecond

  // 前半は上昇（緩やか）、後半は下降（緩やか）
  if (normFirstSlope <= cfg.minSlope) return null
  if (normSecondSlope >= -cfg.minSlope) return null

  if (Math.abs(normFirstSlope) > cfg.maxSlope) return null
  if (Math.abs(normSecondSlope) > cfg.maxSlope) return null

  const startPrice = prices[0].close
  const topPrice = Math.max(...prices.map(p => p.high))
  const endPrice = prices[prices.length - 1].close
  const height = (topPrice - Math.min(startPrice, endPrice)) / topPrice

  if (height < cfg.minHeight || height > cfg.maxHeight) return null

  if (endPrice > startPrice * cfg.maxEndPriceRatio) return null

  const decline = endPrice < startPrice

  return {
    pattern: "saucer_top",
    patternName: "ソーサートップ（受け皿型の天井）",
    signal: "sell",
    rank: cfg.rank,
    winRate: cfg.winRate,
    strength: decline ? cfg.strength.breakout : cfg.strength.noBreakout,
    confidence: decline ? cfg.confidence.breakout : cfg.confidence.noBreakout,
    description: decline
      ? "ソーサートップが完成に近づいています。緩やかに天井を打ち、下落基調に入っています"
      : "ソーサートップを形成中です。緩やかな逆U字型の天井から徐々に下降しています",
    explanation:
      `【ソーサートップとは】ソーサーボトムの逆で、浅くて広い逆U字型の天井パターンです。` +
      `ゆっくりと上がってゆっくりと下がる形で、「買い意欲がじわじわ低下している」ことを示します。` +
      `急落ではなく緩やかな転換なので、注意深く観察する必要があります。` +
      `天井の高さ: ${(height * 100).toFixed(1)}%`,
    startIndex: 0,
    endIndex: prices.length - 1,
  }
}

/**
 * 下降ウェッジ（Falling Wedge）- C級買いシグナル
 *
 * 高値も安値も下がっているが、安値の方が急に下がり収束していく。
 * 下方向に収束するが、上にブレイクする確率が高い。
 * Bulkowski勝率: 58%
 */
function detectFallingWedge(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.falling_wedge
  if (prices.length < cfg.minDataPoints) return null

  const { peaks, troughs } = findLocalExtremes(prices, cfg.extremeWindow)

  if (peaks.length < 2 || troughs.length < 2) return null

  const peakPrices = peaks.map(i => prices[i].high)
  const troughPrices = troughs.map(i => prices[i].low)

  const peakSlope = calculateSlope(peakPrices)
  const troughSlope = calculateSlope(troughPrices)

  const avgPeak = peakPrices.reduce((a, b) => a + b, 0) / peakPrices.length
  const avgTrough = troughPrices.reduce((a, b) => a + b, 0) / troughPrices.length

  const normPeakSlope = peakSlope / avgPeak
  const normTroughSlope = troughSlope / avgTrough

  // 両方下がっている
  if (normPeakSlope >= cfg.minSlope) return null
  if (normTroughSlope >= cfg.minSlope) return null

  // 安値の方がより急に下がっている（収束）
  if (normTroughSlope >= normPeakSlope) return null

  // 実際に収束しているか（後半のレンジ < 前半のレンジ）
  const firstRange = peakPrices[0] - troughPrices[0]
  const lastRange = peakPrices[peakPrices.length - 1] - troughPrices[troughPrices.length - 1]
  if (firstRange <= 0 || lastRange >= firstRange) return null

  const latestClose = prices[prices.length - 1].close
  const upperLine = peakPrices[peakPrices.length - 1]
  const breakout = latestClose > upperLine

  return {
    pattern: "falling_wedge",
    patternName: "下降ウェッジ（フォーリング・ウェッジ）",
    signal: "buy",
    rank: cfg.rank,
    winRate: cfg.winRate,
    strength: breakout ? cfg.strength.breakout : cfg.strength.noBreakout,
    confidence: breakout ? cfg.confidence.breakout : cfg.confidence.noBreakout,
    description: breakout
      ? "下降ウェッジの上値ラインを上抜けました。下落トレンドからの反転が期待できます"
      : "下降ウェッジを形成中です。値幅が狭まっており、上放れの可能性があります",
    explanation:
      `【下降ウェッジとは】高値も安値も下がっていますが、徐々に値幅が狭まっていくパターンです。` +
      `一見弱そうですが、「売りの勢いが弱まっている」ことを示しており、` +
      `上に抜ければ買いのサインになります。下降トレンドの終わりに出やすいパターンです。`,
    startIndex: Math.min(...peaks, ...troughs),
    endIndex: Math.max(...peaks, ...troughs),
  }
}

/**
 * 上昇ウェッジ（Rising Wedge）- C級売りシグナル
 *
 * 高値も安値も上がっているが、高値の上昇が鈍化し収束していく。
 * 上方向に収束するが、下にブレイクする確率が高い。
 * Bulkowski勝率: 58%
 */
function detectRisingWedge(prices: PricePoint[]): ChartPatternResult | null {
  const cfg = PATTERN_CONFIG.rising_wedge
  if (prices.length < cfg.minDataPoints) return null

  const { peaks, troughs } = findLocalExtremes(prices, cfg.extremeWindow)

  if (peaks.length < 2 || troughs.length < 2) return null

  const peakPrices = peaks.map(i => prices[i].high)
  const troughPrices = troughs.map(i => prices[i].low)

  const peakSlope = calculateSlope(peakPrices)
  const troughSlope = calculateSlope(troughPrices)

  const avgPeak = peakPrices.reduce((a, b) => a + b, 0) / peakPrices.length
  const avgTrough = troughPrices.reduce((a, b) => a + b, 0) / troughPrices.length

  const normPeakSlope = peakSlope / avgPeak
  const normTroughSlope = troughSlope / avgTrough

  // 両方上がっている
  if (normPeakSlope <= cfg.minSlope) return null
  if (normTroughSlope <= cfg.minSlope) return null

  // 高値の上昇が安値の上昇より鈍い（収束）
  if (normPeakSlope >= normTroughSlope) return null

  // 実際に収束しているか
  const firstRange = peakPrices[0] - troughPrices[0]
  const lastRange = peakPrices[peakPrices.length - 1] - troughPrices[troughPrices.length - 1]
  if (firstRange <= 0 || lastRange >= firstRange) return null

  const latestClose = prices[prices.length - 1].close
  const lowerLine = troughPrices[troughPrices.length - 1]
  const breakdown = latestClose < lowerLine

  return {
    pattern: "rising_wedge",
    patternName: "上昇ウェッジ（ライジング・ウェッジ）",
    signal: "sell",
    rank: cfg.rank,
    winRate: cfg.winRate,
    strength: breakdown ? cfg.strength.breakout : cfg.strength.noBreakout,
    confidence: breakdown ? cfg.confidence.breakout : cfg.confidence.noBreakout,
    description: breakdown
      ? "上昇ウェッジの下値ラインを下抜けました。上昇トレンドからの反転が懸念されます"
      : "上昇ウェッジを形成中です。値幅が狭まっており、下放れの可能性があります",
    explanation:
      `【上昇ウェッジとは】高値も安値も上がっていますが、徐々に値幅が狭まっていくパターンです。` +
      `一見強そうですが、「買いの勢いが弱まっている」ことを示しており、` +
      `下に抜ければ売りのサインになります。上昇トレンドの終わりに出やすいパターンです。`,
    startIndex: Math.min(...peaks, ...troughs),
    endIndex: Math.max(...peaks, ...troughs),
  }
}

/**
 * すべてのチャートパターンを検出する（メインのエントリーポイント）
 */
export function detectChartPatterns(prices: PricePoint[]): ChartPatternResult[] {
  if (prices.length < CHART_PATTERNS_MIN_DATA) return []

  const detectors = [
    // S級
    detectInverseHeadAndShoulders,
    detectDoubleBottom,
    detectHeadAndShoulders,
    detectDescendingTriangle,
    // A級
    detectTripleBottom,
    detectAscendingTriangle,
    // B級
    detectCupWithHandle,
    detectSaucerBottom,
    detectDoubleTop,
    detectInverseCupWithHandle,
    detectSaucerTop,
    // C級
    detectFallingWedge,
    detectBullFlag,
    detectRisingWedge,
    detectBearFlag,
    // D級
    detectBoxRange,
    detectSymmetricalTriangle,
  ]

  const results: ChartPatternResult[] = []

  for (const detector of detectors) {
    const result = detector(prices)
    if (result) {
      results.push(result)
    }
  }

  // 信頼度の高い順にソート
  results.sort((a, b) => b.strength * b.confidence - a.strength * a.confidence)

  return results
}

/**
 * 投資スタイルに応じたチャートパターンの重み付け指示を生成
 */
function getStyleGuidance(investmentStyle?: string | null): string {
  switch (investmentStyle) {
    case "CONSERVATIVE":
      return (
        "\n\n【投資スタイル別の判断基準: 安定配当型】\n" +
        "- S級・A級パターン（勝率80%以上）のみを買い・ホールド判断の根拠として重視してください\n" +
        "- B級以下のパターンは参考情報に留め、単独での買い根拠としないでください\n" +
        "- S級の売りシグナル（三尊・下降トライアングル）が出た場合は強く警戒してください"
      )
    case "AGGRESSIVE":
      return (
        "\n\n【投資スタイル別の判断基準: アクティブ型】\n" +
        "- C級以上のパターンも含めて積極的に判断してください\n" +
        "- D級（ボックスレンジ等）でも中長期の期待値が高ければ押し目買いの根拠にしてOKです\n" +
        "- 勝率が低いパターンでも他のテクニカル指標が揃っていれば買い提案を検討してください"
      )
    default: // BALANCED or unset
      return (
        "\n\n【投資スタイル別の判断基準: 成長投資型】\n" +
        "- B級以上のパターン（勝率65%以上）をアクション提案の根拠として考慮してください\n" +
        "- C級・D級のパターンは補助的な情報として扱い、他の指標と合わせて判断してください"
      )
  }
}

/**
 * チャートパターンの結果をAIプロンプト向けのテキストに変換
 * @param patterns - 検出されたチャートパターン
 * @param investmentStyle - ユーザーの投資スタイル（任意）
 */
export function formatChartPatternsForPrompt(
  patterns: ChartPatternResult[],
  investmentStyle?: string | null,
): string {
  if (patterns.length === 0) {
    return "チャートパターン: 特に検出されたパターンはありません"
  }

  const lines = ["【チャートパターン分析】（※勝率はBulkowski研究に基づく参考値）"]

  for (const p of patterns) {
    const signalLabel =
      p.signal === "buy" ? "買い" : p.signal === "sell" ? "売り" : "様子見"
    lines.push(
      `- ${p.patternName}: ${signalLabel}シグナル（ランク: ${p.rank}級、参考勝率: ${p.winRate}%、強さ: ${p.strength}%）`
    )
    lines.push(`  ${p.description}`)
  }

  if (investmentStyle) {
    lines.push(getStyleGuidance(investmentStyle))
  }

  return lines.join("\n")
}
