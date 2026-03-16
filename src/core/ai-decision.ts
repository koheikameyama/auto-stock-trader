/**
 * AI意思決定モジュール
 *
 * OpenAI GPT-4o を使用して市場評価・銘柄レビュー・売買レビューを行う
 *
 * 「ロジックが主役、AIが最終審判」:
 * - assessMarket: 市場全体の評価（AI主導 - 変更なし）
 * - reviewStocks: ロジックが推薦した銘柄のGo/No-Go判断（レビュー型）
 * - reviewTrade: ロジックが算出したエントリー条件の承認/修正/却下（レビュー型）
 */

import { getOpenAIClient } from "../lib/openai";
import { OPENAI_CONFIG } from "../lib/constants";
import {
  MARKET_ASSESSMENT_SYSTEM_PROMPT,
  MARKET_ASSESSMENT_SCHEMA,
} from "../prompts/market-assessment";
import {
  STOCK_REVIEW_SYSTEM_PROMPT,
  STOCK_REVIEW_SCHEMA,
} from "../prompts/stock-selection";
import {
  TRADE_REVIEW_SYSTEM_PROMPT,
  TRADE_REVIEW_SCHEMA,
} from "../prompts/trade-decision";
import {
  MIDDAY_REASSESSMENT_SYSTEM_PROMPT,
  MIDDAY_REASSESSMENT_SCHEMA,
} from "../prompts/midday-reassessment";

// ========================================
// 入力型
// ========================================

export interface MarketDataInput {
  nikkeiPrice: number;
  nikkeiChange: number;
  sp500Change: number;
  vix: number;
  usdJpy: number;
  cmeFuturesPrice: number;
  cmeFuturesChange: number;
  newsSummary?: string;
}

export interface StockReviewCandidateInput {
  tickerCode: string;
  name: string;
  scoreFormatted: string; // formatScoreForAI の出力
  newsContext?: string;
  riskContext?: string; // セクター・レジーム・ドローダウンコンテキスト
}

export interface TradeReviewInput {
  tickerCode: string;
  name: string;
  price: number;
  sector: string;
  scoreFormatted: string;
  newsContext?: string;
}

export interface PositionInput {
  tickerCode: string;
  quantity: number;
  averagePrice: number;
  strategy: "day_trade" | "swing";
}

// ========================================
// 出力型
// ========================================

export interface MarketAssessmentResult {
  shouldTrade: boolean;
  sentiment: "bullish" | "neutral" | "cautious" | "bearish" | "crisis";
  reasoning: string;
}

export interface StockReviewResult {
  tickerCode: string;
  decision: "go" | "no_go";
  strategy: "day_trade" | "swing";
  reasoning: string;
  riskFlags: string[];
}

export interface TradeReviewResult {
  decision: "approve" | "approve_with_modification" | "reject";
  reasoning: string;
  modification: {
    adjustLimitPrice: number | null;
    adjustTakeProfitPrice: number | null;
    adjustStopLossPrice: number | null;
    adjustQuantity: number | null;
  } | null;
  riskFlags: string[];
}

// ========================================
// 1. 市場評価（変更なし - AIの仕事）
// ========================================

export async function assessMarket(
  data: MarketDataInput,
): Promise<MarketAssessmentResult> {
  const openai = getOpenAIClient();

  let userPrompt = `以下の市場データに基づいて、今日の日本株取引を行うべきか評価してください。

【市場指標】
- 日経225: ${data.nikkeiPrice.toLocaleString()}円（前日比: ${data.nikkeiChange >= 0 ? "+" : ""}${data.nikkeiChange.toFixed(2)}%）
- S&P500 前日比: ${data.sp500Change >= 0 ? "+" : ""}${data.sp500Change.toFixed(2)}%
- VIX: ${data.vix.toFixed(2)}
- USD/JPY: ${data.usdJpy.toFixed(2)}
- CME日経先物: ${data.cmeFuturesPrice.toLocaleString()}円（前日比: ${data.cmeFuturesChange >= 0 ? "+" : ""}${data.cmeFuturesChange.toFixed(2)}%）`;

  if (data.newsSummary) {
    userPrompt += `\n\n${data.newsSummary}`;
  }

  const response = await openai.chat.completions.create({
    model: OPENAI_CONFIG.MODEL,
    temperature: OPENAI_CONFIG.TEMPERATURE,
    messages: [
      { role: "system", content: MARKET_ASSESSMENT_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: MARKET_ASSESSMENT_SCHEMA,
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("[ai-decision] assessMarket: Empty response from OpenAI");
  }

  return JSON.parse(content) as MarketAssessmentResult;
}

// ========================================
// 2. 銘柄レビュー（レビュー型）
// ========================================

/**
 * ロジックが推薦した銘柄を AI がレビューし、Go/No-Go を判断する
 *
 * @param strategy - システムが市場環境に基づいて決定した戦略（全銘柄共通）
 */
export async function reviewStocks(
  assessment: MarketAssessmentResult,
  candidates: StockReviewCandidateInput[],
  strategy: "day_trade" | "swing",
): Promise<StockReviewResult[]> {
  const openai = getOpenAIClient();

  const candidatesText = candidates
    .map(
      (c) => `
【${c.tickerCode} ${c.name}】
${c.scoreFormatted}${c.newsContext ? `\n【ニュース】\n${c.newsContext}` : ""}${c.riskContext ? `\n【リスクコンテキスト】\n${c.riskContext}` : ""}`,
    )
    .join("\n---\n");

  const strategyLabel = strategy === "day_trade" ? "デイトレード" : "スイングトレード";

  const userPrompt = `【市場評価】
- センチメント: ${assessment.sentiment}
- 理由: ${assessment.reasoning}

【本日の取引戦略】${strategyLabel}（${strategy}）
※ システムが市場環境（VIX・CME乖離率）に基づいて決定済み

【ロジックが推薦した銘柄一覧】
${candidatesText}

各銘柄について、Go（承認）またはNo-Go（見送り）の判断をしてください。
承認する銘柄のstrategyには「${strategy}」を設定してください。`;

  const response = await openai.chat.completions.create({
    model: OPENAI_CONFIG.MODEL,
    temperature: OPENAI_CONFIG.TEMPERATURE,
    messages: [
      { role: "system", content: STOCK_REVIEW_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: STOCK_REVIEW_SCHEMA,
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("[ai-decision] reviewStocks: Empty response from OpenAI");
  }

  const parsed = JSON.parse(content) as { stocks: StockReviewResult[] };

  // AIがstrategyを変えてしまった場合に備え、システム決定値で上書き
  for (const stock of parsed.stocks) {
    stock.strategy = strategy;
  }

  return parsed.stocks;
}

// ========================================
// 3. 売買レビュー（レビュー型）
// ========================================

/**
 * ロジックが算出したエントリー条件を AI がレビューし、承認/修正/却下する
 */
export async function reviewTrade(
  stock: TradeReviewInput,
  entryCondition: {
    limitPrice: number;
    takeProfitPrice: number;
    stopLossPrice: number;
    quantity: number;
    riskRewardRatio: number;
    strategy: "day_trade" | "swing";
  },
  assessment: MarketAssessmentResult,
): Promise<TradeReviewResult> {
  const openai = getOpenAIClient();

  const takeProfitPct = (
    ((entryCondition.takeProfitPrice - entryCondition.limitPrice) /
      entryCondition.limitPrice) *
    100
  ).toFixed(1);
  const stopLossPct = (
    ((entryCondition.limitPrice - entryCondition.stopLossPrice) /
      entryCondition.limitPrice) *
    100
  ).toFixed(1);

  let userPrompt = `ロジックが以下のエントリー条件を算出しました:

【銘柄】${stock.tickerCode}（${stock.name}）
【セクター】${stock.sector}
【現在価格】¥${stock.price.toLocaleString()}

【テクニカル評価】
${stock.scoreFormatted}

【エントリー条件（ロジック算出）】
- 指値: ¥${entryCondition.limitPrice.toLocaleString()}
- 利確: ¥${entryCondition.takeProfitPrice.toLocaleString()}（+${takeProfitPct}%）
- 損切: ¥${entryCondition.stopLossPrice.toLocaleString()}（-${stopLossPct}%）
- リスクリワード比: 1:${entryCondition.riskRewardRatio}
- 数量: ${entryCondition.quantity}株
- 戦略: ${entryCondition.strategy}

【市場評価】
- センチメント: ${assessment.sentiment}
- 理由: ${assessment.reasoning}

このトレードを承認しますか？`;

  if (stock.newsContext) {
    userPrompt += `\n\n【関連ニュース】\n${stock.newsContext}`;
  }

  const response = await openai.chat.completions.create({
    model: OPENAI_CONFIG.MODEL,
    temperature: OPENAI_CONFIG.TEMPERATURE,
    messages: [
      { role: "system", content: TRADE_REVIEW_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: TRADE_REVIEW_SCHEMA,
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("[ai-decision] reviewTrade: Empty response from OpenAI");
  }

  return JSON.parse(content) as TradeReviewResult;
}

// ========================================
// 4. 昼休み再評価（前場実績に基づくセンチメント再判定）
// ========================================

export interface MiddayReassessmentInput {
  morningSentiment: string;
  morningReasoning: string;
  morningNikkeiPrice: number;
  morningVix: number | null;
  currentNikkeiPrice: number;
  currentNikkeiChange: number;
  currentVix: number | null;
  currentSp500Change: number;
  currentUsdJpy: number;
  newsSummary?: string; // 最新ニュース分析サマリー
  sectorContext?: string; // セクター動向コンテキスト
}

export interface MiddayReassessmentResult {
  sentiment: "bullish" | "neutral" | "cautious" | "bearish" | "crisis";
  reasoning: string;
}

/**
 * 前場終了後にセンチメントを再評価する
 */
export async function reassessMarketMidday(
  data: MiddayReassessmentInput,
): Promise<MiddayReassessmentResult> {
  const openai = getOpenAIClient();

  const morningSessionChange =
    ((data.currentNikkeiPrice - data.morningNikkeiPrice) /
      data.morningNikkeiPrice) *
    100;

  let additionalContext = "";
  if (data.newsSummary) {
    additionalContext += `\n【前場中の最新ニュース分析】\n${data.newsSummary}\n`;
  }
  if (data.sectorContext) {
    additionalContext += `\n【セクター動向】\n${data.sectorContext}\n`;
  }

  const morningVixText = data.morningVix != null
    ? data.morningVix.toFixed(2)
    : "取得不可";
  const currentVixText = data.currentVix != null
    ? data.currentVix.toFixed(2)
    : "取得不可";
  const vixCompareText = data.currentVix != null && data.morningVix != null
    ? `（朝比: ${data.currentVix > data.morningVix ? "上昇" : data.currentVix < data.morningVix ? "低下" : "横ばい"}）`
    : "";

  const userPrompt = `【朝の市場評価（前場開始前）】
- センチメント: ${data.morningSentiment}
- 理由: ${data.morningReasoning}
- 日経225（朝時点）: ${data.morningNikkeiPrice.toLocaleString()}円
- VIX（朝時点）: ${morningVixText}

【前場終了時点の市場データ】
- 日経225: ${data.currentNikkeiPrice.toLocaleString()}円（朝比: ${morningSessionChange >= 0 ? "+" : ""}${morningSessionChange.toFixed(2)}%、前日比: ${data.currentNikkeiChange >= 0 ? "+" : ""}${data.currentNikkeiChange.toFixed(2)}%）
- VIX: ${currentVixText}${vixCompareText}
- S&P500 前日比: ${data.currentSp500Change >= 0 ? "+" : ""}${data.currentSp500Change.toFixed(2)}%
- USD/JPY: ${data.currentUsdJpy.toFixed(2)}
${additionalContext}
朝の評価と前場の実績を比較して、センチメントを再評価してください。`;

  const response = await openai.chat.completions.create({
    model: OPENAI_CONFIG.MODEL,
    temperature: OPENAI_CONFIG.TEMPERATURE,
    messages: [
      { role: "system", content: MIDDAY_REASSESSMENT_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: MIDDAY_REASSESSMENT_SCHEMA,
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error(
      "[ai-decision] reassessMarketMidday: Empty response from OpenAI",
    );
  }

  return JSON.parse(content) as MiddayReassessmentResult;
}
