/**
 * 株式分析プロンプト用コンテキスト生成ユーティリティ
 *
 * purchase-recommendation と portfolio-analysis の両ルートで共通して使用する
 * プロンプトコンテキスト文字列ビルダー関数群。
 *
 * ⚠️ prices 引数はすべて oldest-first（古い順）で渡すこと。
 */

import {
  analyzeSingleCandle,
  CandlestickData,
} from "@/lib/candlestick-patterns";
import {
  detectChartPatterns,
  formatChartPatternsForPrompt,
  PricePoint,
} from "@/lib/chart-patterns";
import {
  calculateRSI,
  calculateMACD,
  calculateDeviationRate,
  detectGaps,
  findSupportResistance,
  detectTrendlines,
} from "@/lib/technical-indicators";
import {
  MA_DEVIATION,
  FETCH_FAIL_WARNING_THRESHOLD,
  VOLUME_ANALYSIS,
  RELATIVE_STRENGTH,
} from "@/lib/constants";
import { MarketIndexData } from "@/lib/market-index";

// OHLCV データ型（oldest-first で渡す）
export interface OHLCVData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// 財務指標フィールド型（Prisma Decimal / number / null すべて受け入れる）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DecimalLike = any;

export interface StockFinancials {
  marketCap?: DecimalLike;
  dividendYield?: DecimalLike;
  pbr?: DecimalLike;
  per?: DecimalLike;
  roe?: DecimalLike;
  isProfitable?: boolean | null;
  profitTrend?: string | null;
  revenueGrowth?: DecimalLike;
  eps?: DecimalLike;
  fiftyTwoWeekHigh?: DecimalLike;
  fiftyTwoWeekLow?: DecimalLike;
}

/**
 * 財務指標コンテキスト文字列を生成する
 * @param stock - 財務指標フィールドを持つ銘柄オブジェクト
 * @param currentPrice - 現在株価（52週レンジ算出に使用）
 */
export function buildFinancialMetrics(
  stock: StockFinancials,
  currentPrice: number | null,
): string {
  const metrics: string[] = [];

  if (stock.marketCap) {
    const marketCap = Number(stock.marketCap);
    if (marketCap >= 10000) {
      metrics.push(
        `- 会社の規模: 大企業（時価総額${(marketCap / 10000).toFixed(1)}兆円）`,
      );
    } else if (marketCap >= 1000) {
      metrics.push(
        `- 会社の規模: 中堅企業（時価総額${marketCap.toFixed(0)}億円）`,
      );
    } else {
      metrics.push(
        `- 会社の規模: 小型企業（時価総額${marketCap.toFixed(0)}億円）`,
      );
    }
  }

  if (stock.dividendYield) {
    const divYield = Number(stock.dividendYield);
    if (divYield >= 4) {
      metrics.push(`- 配当: 高配当（年${divYield.toFixed(2)}%）`);
    } else if (divYield >= 2) {
      metrics.push(`- 配当: 普通（年${divYield.toFixed(2)}%）`);
    } else if (divYield > 0) {
      metrics.push(`- 配当: 低め（年${divYield.toFixed(2)}%）`);
    } else {
      metrics.push("- 配当: なし");
    }
  }

  if (stock.pbr) {
    const pbr = Number(stock.pbr);
    if (pbr < 1) {
      metrics.push("- 株価水準(PBR): 割安（資産価値より安い）");
    } else if (pbr < 1.5) {
      metrics.push("- 株価水準(PBR): 適正");
    } else {
      metrics.push("- 株価水準(PBR): やや割高");
    }
  }

  // PER（株価収益率）
  if (stock.per) {
    const per = Number(stock.per);
    if (per < 0) {
      metrics.push("- 収益性(PER): 赤字のため算出不可");
    } else if (per < 10) {
      metrics.push(`- 収益性(PER): 割安（${per.toFixed(1)}倍）`);
    } else if (per < 20) {
      metrics.push(`- 収益性(PER): 適正（${per.toFixed(1)}倍）`);
    } else if (per < 30) {
      metrics.push(`- 収益性(PER): やや割高（${per.toFixed(1)}倍）`);
    } else {
      metrics.push(`- 収益性(PER): 割高（${per.toFixed(1)}倍）`);
    }
  }

  // ROE（自己資本利益率）
  if (stock.roe) {
    const roe = Number(stock.roe) * 100; // 小数点で保存されている場合
    if (roe >= 15) {
      metrics.push(`- 経営効率(ROE): 優秀（${roe.toFixed(1)}%）`);
    } else if (roe >= 10) {
      metrics.push(`- 経営効率(ROE): 良好（${roe.toFixed(1)}%）`);
    } else if (roe >= 5) {
      metrics.push(`- 経営効率(ROE): 普通（${roe.toFixed(1)}%）`);
    } else if (roe > 0) {
      metrics.push(`- 経営効率(ROE): 低め（${roe.toFixed(1)}%）`);
    } else {
      metrics.push(`- 経営効率(ROE): 赤字`);
    }
  }

  // 業績トレンド
  if (stock.isProfitable !== null && stock.isProfitable !== undefined) {
    if (stock.isProfitable) {
      if (stock.profitTrend === "increasing") {
        metrics.push("- 業績: 黒字（利益増加傾向）");
      } else if (stock.profitTrend === "decreasing") {
        metrics.push("- 業績: 黒字（利益減少傾向）");
      } else {
        metrics.push("- 業績: 黒字");
      }
    } else {
      metrics.push("- 業績: 赤字");
    }
  }

  // 売上成長率
  if (stock.revenueGrowth) {
    const growth = Number(stock.revenueGrowth);
    if (growth >= 20) {
      metrics.push(`- 売上成長: 急成長（前年比+${growth.toFixed(1)}%）`);
    } else if (growth >= 10) {
      metrics.push(`- 売上成長: 好調（前年比+${growth.toFixed(1)}%）`);
    } else if (growth >= 0) {
      metrics.push(`- 売上成長: 安定（前年比+${growth.toFixed(1)}%）`);
    } else if (growth >= -10) {
      metrics.push(`- 売上成長: やや減少（前年比${growth.toFixed(1)}%）`);
    } else {
      metrics.push(`- 売上成長: 減少傾向（前年比${growth.toFixed(1)}%）`);
    }
  }

  // EPS（1株当たり利益）
  if (stock.eps) {
    const eps = Number(stock.eps);
    if (eps > 0) {
      metrics.push(`- 1株利益(EPS): ${eps.toFixed(0)}円`);
    } else {
      metrics.push(`- 1株利益(EPS): 赤字`);
    }
  }

  if (stock.fiftyTwoWeekHigh && stock.fiftyTwoWeekLow && currentPrice) {
    const high = Number(stock.fiftyTwoWeekHigh);
    const low = Number(stock.fiftyTwoWeekLow);
    const position =
      high !== low ? ((currentPrice - low) / (high - low)) * 100 : 50;
    metrics.push(
      `- 1年間の値動き: 高値${high.toFixed(0)}円〜安値${low.toFixed(0)}円（現在は${position.toFixed(0)}%の位置）`,
    );
  }

  return metrics.length > 0 ? metrics.join("\n") : "財務データなし";
}

/**
 * ローソク足パターン分析コンテキスト文字列を生成する
 * @param prices - OHLCV データ（oldest-first）
 */
export function buildCandlestickContext(prices: OHLCVData[]): string {
  if (prices.length < 1) return "";

  const latest = prices[prices.length - 1];
  const latestCandle: CandlestickData = {
    date: latest.date,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    close: latest.close,
  };
  const pattern = analyzeSingleCandle(latestCandle);

  let buySignals = 0;
  let sellSignals = 0;
  for (const price of prices.slice(-5)) {
    const p = analyzeSingleCandle({
      date: price.date,
      open: price.open,
      high: price.high,
      low: price.low,
      close: price.close,
    });
    if (p.strength >= 60) {
      if (p.signal === "buy") buySignals++;
      else if (p.signal === "sell") sellSignals++;
    }
  }

  return `
【ローソク足パターン分析】
- 最新パターン: ${pattern.description}
- シグナル: ${pattern.signal}
- 強さ: ${pattern.strength}%
- 直近5日の買いシグナル: ${buySignals}回
- 直近5日の売りシグナル: ${sellSignals}回
`;
}

/**
 * RSI / MACD テクニカル指標コンテキスト文字列を生成する
 * @param prices - OHLCV データ（oldest-first）
 */
export function buildTechnicalContext(prices: OHLCVData[]): string {
  if (prices.length < 26) return "";

  const pricesForCalc = prices.map((p) => ({ close: p.close }));
  const rsi = calculateRSI(pricesForCalc, 14);
  const macd = calculateMACD(pricesForCalc);

  let rsiInterpretation = "";
  if (rsi !== null) {
    if (rsi <= 30) {
      rsiInterpretation = `${rsi.toFixed(1)}（売られすぎ → 反発の可能性あり）`;
    } else if (rsi <= 40) {
      rsiInterpretation = `${rsi.toFixed(1)}（やや売られすぎ）`;
    } else if (rsi >= 70) {
      rsiInterpretation = `${rsi.toFixed(1)}（買われすぎ → 下落の可能性あり）`;
    } else if (rsi >= 60) {
      rsiInterpretation = `${rsi.toFixed(1)}（やや買われすぎ）`;
    } else {
      rsiInterpretation = `${rsi.toFixed(1)}（通常範囲）`;
    }
  }

  let macdInterpretation = "";
  if (macd.histogram !== null) {
    if (macd.histogram > 1) {
      macdInterpretation = "上昇トレンド（勢いあり）";
    } else if (macd.histogram > 0) {
      macdInterpretation = "やや上昇傾向";
    } else if (macd.histogram < -1) {
      macdInterpretation = "下落トレンド（勢いあり）";
    } else if (macd.histogram < 0) {
      macdInterpretation = "やや下落傾向";
    } else {
      macdInterpretation = "横ばい";
    }
  }

  if (rsi === null && macd.histogram === null) return "";

  return `
【テクニカル指標】
${rsi !== null ? `- RSI（売られすぎ・買われすぎの指標）: ${rsiInterpretation}` : ""}
${macd.histogram !== null ? `- MACD（トレンドの勢い指標）: ${macdInterpretation}` : ""}
`;
}

/**
 * 移動平均乖離率コンテキスト文字列を生成する
 * @param prices - OHLCV データ（oldest-first）
 */
export function buildDeviationRateContext(prices: OHLCVData[]): string {
  if (prices.length < MA_DEVIATION.PERIOD) return "";

  // oldest-first → newest-first に変換して乖離率を計算
  const pricesForCalc = [...prices].reverse().map((p) => ({ close: p.close }));
  const rate = calculateDeviationRate(pricesForCalc, MA_DEVIATION.PERIOD);
  if (rate === null) return "";

  let interpretation = "";
  if (rate >= MA_DEVIATION.UPPER_THRESHOLD) {
    interpretation = `${rate.toFixed(1)}%（過熱圏。高値づかみリスクに注意）`;
  } else if (rate <= MA_DEVIATION.LOWER_THRESHOLD) {
    interpretation = `${rate.toFixed(1)}%（売られすぎ圏。リバウンドの可能性あり）`;
  } else if (Math.abs(rate) <= 5) {
    interpretation = `${rate >= 0 ? "+" : ""}${rate.toFixed(1)}%（移動平均線に沿った安定した値動き）`;
  } else {
    interpretation = `${rate >= 0 ? "+" : ""}${rate.toFixed(1)}%`;
  }

  return `
【移動平均乖離率】
- 25日移動平均線からの乖離率: ${interpretation}
`;
}

/**
 * チャートパターン（複数足フォーメーション）コンテキスト文字列を生成する
 * @param prices - OHLCV データ（oldest-first）
 * @param investmentStyle - ユーザーの投資スタイル（任意）。指定するとスタイル別の重み付け指示が付加される
 */
export function buildChartPatternContext(
  prices: OHLCVData[],
  investmentStyle?: string | null,
): string {
  if (prices.length < 15) return "";

  const pricePoints: PricePoint[] = prices.map((p) => ({
    date: p.date,
    open: p.open,
    high: p.high,
    low: p.low,
    close: p.close,
  }));
  const chartPatterns = detectChartPatterns(pricePoints);
  if (chartPatterns.length === 0) return "";

  return "\n" + formatChartPatternsForPrompt(chartPatterns, investmentStyle);
}

/**
 * 週間変化率コンテキスト文字列と変化率数値を生成する
 *
 * 警告閾値は統一: +30%(急騰), +20%(注意), -20%(大幅下落)
 * ウォッチリスト・ポートフォリオで同じ基準を使用する。
 *
 * @param prices - OHLCV データ（oldest-first）
 */
export function buildWeekChangeContext(
  prices: OHLCVData[],
): { text: string; rate: number | null } {
  if (prices.length < 5) return { text: "", rate: null };

  const latestClose = prices[prices.length - 1].close;
  const weekAgoClose = prices[Math.max(0, prices.length - 6)].close;
  const rate = ((latestClose - weekAgoClose) / weekAgoClose) * 100;

  let text = "";

  if (rate >= 30) {
    text = `
【警告: 急騰銘柄】
- 週間変化率: +${rate.toFixed(1)}%（非常に高い）
- 急騰後は反落リスクが高いため、慎重に判断してください`;
  } else if (rate >= 20) {
    text = `
【注意: 上昇率が高い】
- 週間変化率: +${rate.toFixed(1)}%
- すでに上昇している可能性があるため、追加上昇余地を慎重に判断してください`;
  } else if (rate <= -20) {
    text = `
【注意: 大幅下落】
- 週間変化率: ${rate.toFixed(1)}%
- 下落理由を確認し、反発の可能性を慎重に判断してください`;
  }

  return { text, rate };
}

/**
 * marketSignal 定義セクション（両ルート共通）
 *
 * bullish/neutral/bearish の定義と、recommendation と独立して判断する旨を記載。
 * purchase-recommendation・portfolio-analysis の両プロンプトで使用する。
 */
export const PROMPT_MARKET_SIGNAL_DEFINITION = `【marketSignalの定義】
- bullish: テクニカル・ファンダメンタル総合で上昇優勢（RSI底打ち、MACD上昇転換、黒字増益など）
- neutral: どちらとも言えない、横ばい（シグナルが混在、or 材料不足）
- bearish: 下落優勢、リスクが高い（RSI高水準、MACD下降、赤字継続など）
※ marketSignal は recommendation と独立して判断する（強制補正前の純粋な市場シグナル）`;

/**
 * ニュース・創作禁止制約（両ルート共通）
 *
 * 提供されていない情報の創作を禁止するルール。
 * purchase-recommendation・portfolio-analysis の両プロンプトで使用する。
 */
export const PROMPT_NEWS_CONSTRAINTS = `- 提供されたニュース情報を参考にしてください
- ニュースにない情報は推測や創作をしないでください
- 決算発表、業績予想、M&A、人事異動など、提供されていない情報を創作しないでください
- 過去の一般知識（例:「○○社は過去に○○した」）は使用しないでください`;

/**
 * 市場全体の状況コンテキスト文字列を生成する（両ルート共通）
 * @param marketData - getNikkei225Data() の戻り値
 */
export function buildMarketContext(marketData: MarketIndexData | null): string {
  if (!marketData) return "";

  const trendDesc =
    marketData.trend === "up"
      ? "上昇傾向"
      : marketData.trend === "down"
        ? "下落傾向"
        : "横ばい";

  return `
【市場全体の状況】
- 日経平均株価: ${marketData.currentPrice.toLocaleString()}円
- 週間変化率: ${marketData.weekChangeRate >= 0 ? "+" : ""}${marketData.weekChangeRate.toFixed(1)}%
- トレンド: ${trendDesc}

※市場全体の状況を考慮して判断してください。
  市場が弱い中で堅調な銘柄は評価できます。
  市場上昇時は追い風として言及できます。
`;
}

/**
 * 防御モードコンテキスト文字列を生成する
 * 市場パニック時にAIプロンプトに警告を挿入する
 */
export function buildDefensiveModeContext(marketData: MarketIndexData | null): string {
  if (!marketData?.isMarketPanic) return "";

  return `
【⚠️ 市場パニック - 防御モード発動中】
日経平均が週間${marketData.weekChangeRate.toFixed(1)}%と大幅に下落しています。
全投資スタイルの閾値が引き締められ、より慎重な判断基準が適用されています。
- 新規購入は特に慎重に判断してください
- 「落ちるナイフを掴む」リスクを重視してください
- 市場の安定を確認するまで様子見が安全です
`;
}

/**
 * 出来高分析コンテキスト文字列を生成する
 *
 * 下落日と上昇日の平均出来高を比較して「本物の売り圧力」か「出来高を伴わない調整」かを判定する。
 * - 下落日出来高 >> 上昇日 → 機関投資家による分配売り（構造的な下落）
 * - 下落日出来高 << 上昇日 → 売り圧力弱い（一時的な調整）
 *
 * @param prices - OHLCV データ（oldest-first、volume を含む）
 */
export function buildVolumeAnalysisContext(prices: OHLCVData[]): string {
  const recentPrices = prices.slice(-VOLUME_ANALYSIS.ANALYSIS_DAYS);
  if (recentPrices.length < 4) return "";

  const upDayVolumes: number[] = [];
  const downDayVolumes: number[] = [];

  for (let i = 1; i < recentPrices.length; i++) {
    const p = recentPrices[i];
    const prev = recentPrices[i - 1];
    if (!p.volume || p.volume === 0) continue;

    if (p.close > prev.close) {
      upDayVolumes.push(p.volume);
    } else if (p.close < prev.close) {
      downDayVolumes.push(p.volume);
    }
  }

  if (upDayVolumes.length === 0 || downDayVolumes.length === 0) return "";

  const avgUpVolume =
    upDayVolumes.reduce((a, b) => a + b, 0) / upDayVolumes.length;
  const avgDownVolume =
    downDayVolumes.reduce((a, b) => a + b, 0) / downDayVolumes.length;
  const ratio = avgDownVolume / avgUpVolume;

  let signal: string;
  let interpretation: string;

  if (ratio >= VOLUME_ANALYSIS.DISTRIBUTION_THRESHOLD) {
    signal = "分配売り（Distribution）";
    interpretation = `下落日の出来高が上昇日の${ratio.toFixed(1)}倍と高く、売り圧力が強い状態です。今の下落は一時的でなく構造的な可能性があります。`;
  } else if (ratio <= VOLUME_ANALYSIS.ACCUMULATION_THRESHOLD) {
    signal = "出来高を伴わない調整（Low Volume Pullback）";
    interpretation = `下落日の出来高が上昇日の${ratio.toFixed(1)}倍と低く、本格的な売り圧力ではありません。一時的な調整の可能性が高いです。`;
  } else {
    signal = "中立";
    interpretation = `下落日と上昇日の出来高比は${ratio.toFixed(1)}倍で、偏りは軽微です。`;
  }

  return `
【出来高分析（直近${VOLUME_ANALYSIS.ANALYSIS_DAYS}日）】
- 判定: ${signal}
- 上昇日の平均出来高: ${Math.round(avgUpVolume).toLocaleString()}株（${upDayVolumes.length}日分）
- 下落日の平均出来高: ${Math.round(avgDownVolume).toLocaleString()}株（${downDayVolumes.length}日分）
- 下落日/上昇日 出来高比率: ${ratio.toFixed(2)}倍
- 解釈: ${interpretation}
`;
}

/**
 * タイミング補助指標コンテキスト文字列を生成する
 *
 * DBに保存済みの gapUpRate, volumeSpikeRate, turnoverValue を
 * AIプロンプト用にフォーマットする。
 */
export function buildTimingIndicatorsContext(
  gapUpRate: number | null,
  volumeSpikeRate: number | null,
  turnoverValue: number | null,
): string {
  const lines: string[] = [];

  if (gapUpRate !== null) {
    const sign = gapUpRate >= 0 ? "+" : "";
    let gapInterpretation: string;
    if (Math.abs(gapUpRate) >= 5) {
      gapInterpretation = "大きなギャップは過熱感の兆候。飛びつき買いに注意";
    } else if (gapUpRate >= 2 && gapUpRate < 5) {
      gapInterpretation = "好材料を反映した小幅ギャップ。引け強い+出来高が伴えば積極派にとって正のモメンタムシグナル";
    } else {
      gapInterpretation = "通常範囲の変動";
    }
    lines.push(
      `・ギャップアップ率: ${sign}${gapUpRate.toFixed(1)}%（前日引け→当日寄付きで${sign}${gapUpRate.toFixed(1)}%変動）`,
      `  → ${gapInterpretation}`,
    );
  }

  if (volumeSpikeRate !== null) {
    lines.push(
      `・出来高急増率: ${volumeSpikeRate.toFixed(1)}倍（20日平均比）`,
      `  → ${volumeSpikeRate >= 2.0 ? "出来高急増。材料出現の可能性あり" : volumeSpikeRate >= 1.5 ? "やや活発。注目度上昇中" : "通常範囲"}`,
    );
  }

  if (turnoverValue !== null) {
    const oku = turnoverValue / 100_000_000;
    const formatted = oku >= 1 ? `${oku.toFixed(1)}億円` : `${(turnoverValue / 10_000).toFixed(0)}万円`;
    lines.push(
      `・売買代金: ${formatted}`,
      `  → 流動性の目安。大きいほど売買しやすい`,
    );
  }

  if (lines.length === 0) return "";

  return `\n【タイミング補助指標】\n${lines.join("\n")}\n`;
}

/**
 * 相対強度コンテキスト文字列を生成する
 *
 * 銘柄の週間変化率を日経平均・セクター平均と比較し、
 * 「市場全体の下落に引きずられているだけ」か「銘柄固有の弱さがある」かを判定する。
 *
 * @param stockWeekChangeRate - 銘柄の週間変化率（%）
 * @param marketWeekChangeRate - 日経平均の週間変化率（%）
 * @param sectorAvgWeekChangeRate - セクター平均週間変化率（%）
 */
export function buildRelativeStrengthContext(
  stockWeekChangeRate: number | null,
  marketWeekChangeRate: number | null,
  sectorAvgWeekChangeRate: number | null,
): string {
  if (stockWeekChangeRate === null) return "";
  if (marketWeekChangeRate === null && sectorAvgWeekChangeRate === null)
    return "";

  const lines: string[] = [];

  let relVsMarket: number | null = null;
  if (marketWeekChangeRate !== null) {
    relVsMarket = stockWeekChangeRate - marketWeekChangeRate;
    let label: string;
    if (relVsMarket >= RELATIVE_STRENGTH.OUTPERFORM_THRESHOLD) {
      label = `アウトパフォーム（市場より+${relVsMarket.toFixed(1)}%強い）`;
    } else if (relVsMarket <= RELATIVE_STRENGTH.UNDERPERFORM_THRESHOLD) {
      label = `アンダーパフォーム（市場より${relVsMarket.toFixed(1)}%弱い）`;
    } else {
      label = `市場並み（差: ${relVsMarket >= 0 ? "+" : ""}${relVsMarket.toFixed(1)}%）`;
    }
    lines.push(
      `- 対日経平均: ${label}（銘柄${stockWeekChangeRate >= 0 ? "+" : ""}${stockWeekChangeRate.toFixed(1)}% / 市場${marketWeekChangeRate >= 0 ? "+" : ""}${marketWeekChangeRate.toFixed(1)}%）`,
    );
  }

  if (sectorAvgWeekChangeRate !== null) {
    const relVsSector = stockWeekChangeRate - sectorAvgWeekChangeRate;
    let label: string;
    if (relVsSector >= RELATIVE_STRENGTH.OUTPERFORM_THRESHOLD) {
      label = `セクター内で強い（+${relVsSector.toFixed(1)}%上回る）`;
    } else if (relVsSector <= RELATIVE_STRENGTH.UNDERPERFORM_THRESHOLD) {
      label = `セクター内で弱い（${relVsSector.toFixed(1)}%下回る）`;
    } else {
      label = `セクター並み（差: ${relVsSector >= 0 ? "+" : ""}${relVsSector.toFixed(1)}%）`;
    }
    lines.push(
      `- 対セクター: ${label}（セクター平均${sectorAvgWeekChangeRate >= 0 ? "+" : ""}${sectorAvgWeekChangeRate.toFixed(1)}%）`,
    );
  }

  // 下落局面での総合判定（AIが売り/ホールドを判断する最重要材料）
  let overallJudgment = "";
  if (stockWeekChangeRate < 0 && relVsMarket !== null) {
    if (relVsMarket >= RELATIVE_STRENGTH.OUTPERFORM_THRESHOLD) {
      overallJudgment = `\n- 総合判断: 市場下落に引きずられた地合い要因の可能性が高い。銘柄固有の弱さは限定的。`;
    } else if (relVsMarket <= RELATIVE_STRENGTH.UNDERPERFORM_THRESHOLD) {
      overallJudgment = `\n- 総合判断: 市場より大きく下落しており、銘柄固有の弱さがある可能性。構造的な下落を疑う材料あり。`;
    }
  }

  return `
【相対強度分析】
${lines.join("\n")}${overallJudgment}
※ 同じ下落でも「市場全体の地合い要因」か「銘柄固有の弱さ」かで保有継続の判断が変わります。
`;
}

/**
 * 上場廃止コンテキスト文字列を生成する
 * @param isDelisted - 上場廃止フラグ
 * @param fetchFailCount - 連続取得失敗回数
 */
export function buildDelistingContext(
  isDelisted: boolean,
  fetchFailCount: number,
): string {
  if (isDelisted) {
    return `
【重要: 上場廃止銘柄】
- この銘柄は上場廃止されています
- 表示されている株価は上場廃止前の最終価格であり、現在の取引価格ではありません
- 新規購入は不可能です。保有している場合は証券会社に確認してください
- 「上場廃止の心配はない」「問題ない」などの誤った安心を与える回答は絶対にしないでください
`;
  }

  if (fetchFailCount >= FETCH_FAIL_WARNING_THRESHOLD) {
    return `
【警告: 上場廃止の可能性】
- この銘柄は株価データの取得に${fetchFailCount}回連続で失敗しています
- 上場廃止された可能性があります
- 表示されている株価は最後に取得できた価格であり、最新ではない可能性があります
- 新規購入は推奨しません
`;
  }

  return "";
}

/**
 * 窓埋め判定コンテキスト文字列を生成する
 * @param prices - OHLCV データ（oldest-first）
 */
export function buildGapFillContext(prices: OHLCVData[]): string {
  if (prices.length < 2) return "";

  // detectGaps は新しい順を期待するので reverse
  const pricesNewestFirst = [...prices].reverse();
  const gap = detectGaps(pricesNewestFirst as any);

  if (!gap.type) return "";

  const typeLabel =
    gap.type === "up" ? "上昇窓（ギャップアップ）" : "下降窓（ギャップダウン）";
  const statusLabel = gap.isFilled ? "窓埋め完了" : "窓が空いたまま";
  const dateStr = gap.date ? `（${gap.date}）` : "";

  return `
【窓（ギャップ）判定】
- 種類: ${typeLabel}${dateStr}
- 水準: ${gap.price?.toLocaleString()}円
- 状態: ${statusLabel}
- 解説: ${
    gap.type === "up"
      ? gap.isFilled
        ? "上昇時の窓を埋めたため、達成感や押し目の完了が示唆されます。"
        : "上昇時の窓が空いており、将来的にこの水準（窓埋め）まで調整する可能性があります。"
      : gap.isFilled
        ? "下降時の窓を埋めたため、戻り売り圧力の消化や強さが示唆されます。"
        : "下降時の窓が残っており、リバウンド時の目標（窓埋め）になる可能性があります。"
  }
`;
}

/**
 * 支持線・抵抗線コンテキスト文字列を生成する
 * @param prices - OHLCV データ（oldest-first）
 */
export function buildSupportResistanceContext(prices: OHLCVData[]): string {
  if (prices.length < 20) return "";

  const pricesNewestFirst = [...prices].reverse();
  const { supports, resistances } = findSupportResistance(
    pricesNewestFirst as any,
  );

  if (supports.length === 0 && resistances.length === 0) return "";

  const supportText =
    supports.length > 0
      ? supports.map((s) => `${Math.round(s).toLocaleString()}円`).join("、")
      : "なし";
  const resistanceText =
    resistances.length > 0
      ? resistances.map((r) => `${Math.round(r).toLocaleString()}円`).join("、")
      : "なし";

  return `
【支持線・抵抗線（意識される価格帯）】
- 下値支持線（サポート）: ${supportText}
- 上値抵抗線（レジスタンス）: ${resistanceText}
- 解説: これらの価格帯は過去に売買が集中しており、反発や反落の目安になりやすい重要な水準です。
`;
}

/**
 * トレンドライン分析コンテキスト文字列を生成する
 * @param prices - OHLCV データ（oldest-first）
 */
export function buildTrendlineContext(prices: OHLCVData[]): string {
  if (prices.length < 15) return "";

  const result = detectTrendlines(prices);

  if (!result.support && !result.resistance) return "";

  const trendLabels: Record<string, string> = {
    uptrend: "上昇トレンド",
    downtrend: "下降トレンド",
    sideways: "横ばい（レンジ）",
  };

  const lines: string[] = [];
  lines.push(`- 全体トレンド: ${trendLabels[result.overallTrend]}`);

  if (result.support) {
    const dirLabel =
      result.support.direction === "up"
        ? "上昇"
        : result.support.direction === "down"
          ? "下降"
          : "水平";
    lines.push(
      `- サポートライン: ${dirLabel}方向（${result.support.touches}回接触、現在の予測価格: ${result.support.currentProjectedPrice.toLocaleString()}円）`,
    );
    if (result.support.broken) {
      lines.push(
        `  → サポートラインを下回りました。下落圧力が強まっている可能性があります`,
      );
    }
  }

  if (result.resistance) {
    const dirLabel =
      result.resistance.direction === "up"
        ? "上昇"
        : result.resistance.direction === "down"
          ? "下降"
          : "水平";
    lines.push(
      `- レジスタンスライン: ${dirLabel}方向（${result.resistance.touches}回接触、現在の予測価格: ${result.resistance.currentProjectedPrice.toLocaleString()}円）`,
    );
    if (result.resistance.broken) {
      lines.push(
        `  → レジスタンスラインを突破しました。上昇の勢いが強まっている可能性があります`,
      );
    }
  }

  return `
【トレンドライン分析】
${lines.join("\n")}
- 解説: トレンドラインは安値同士・高値同士を結んだ直線で、価格の方向性を示します。サポートラインを割り込むと下落加速、レジスタンスラインを突破すると上昇加速の傾向があります。
`;
}
