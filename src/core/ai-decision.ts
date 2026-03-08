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
  sentiment: "bullish" | "neutral" | "bearish" | "crisis";
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
 */
export async function reviewStocks(
  assessment: MarketAssessmentResult,
  candidates: StockReviewCandidateInput[],
): Promise<StockReviewResult[]> {
  const openai = getOpenAIClient();

  const candidatesText = candidates
    .map(
      (c) => `
【${c.tickerCode} ${c.name}】
${c.scoreFormatted}${c.newsContext ? `\n【ニュース】\n${c.newsContext}` : ""}${c.riskContext ? `\n【リスクコンテキスト】\n${c.riskContext}` : ""}`,
    )
    .join("\n---\n");

  const userPrompt = `【市場評価】
- センチメント: ${assessment.sentiment}
- 理由: ${assessment.reasoning}

【ロジックが推薦した銘柄一覧】
${candidatesText}

各銘柄について、Go（承認）またはNo-Go（見送り）の判断をしてください。`;

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
