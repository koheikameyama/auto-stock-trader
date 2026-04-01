/**
 * 市場予想ジョブ
 *
 * - morning: 寄付前（8:00 JST）に当日の予測を生成
 * - evening: 大引け後（15:50 JST）に翌営業日の予測を生成
 *
 * 1. 市場指標データ取得（fetchMarketData）
 * 2. 当日のMarketAssessment読み込み
 * 3. N225 SMA50計算（StockDailyBarから）
 * 4. ニュースヘッドライン取得・DB保存
 * 5. OpenAI gpt-4o-miniで市場予想を生成
 * 6. MarketForecast テーブルにupsert
 * 7. Slack通知
 */

import dayjs from "dayjs";
import { readFileSync } from "fs";
import { resolve } from "path";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/date-utils";
import { fetchMarketData } from "../core/market-data";
import { fetchMarketNews, saveNewsToDb, getNewsFromDb } from "../core/news-fetcher";
import { chatCompletion } from "../lib/openai";
import { notifyMarketForecast } from "../lib/slack";
import { getNextTradingDay } from "../lib/market-calendar";
import { INDEX_TREND_HYSTERESIS } from "../lib/constants";

// ========================================
// 市場データスナップショット構築
// ========================================

interface MarketSnapshot {
  nikkei: { price: number; change: number } | null;
  vix: { price: number } | null;
  sp500: { change: number } | null;
  nasdaq: { change: number } | null;
  dow: { change: number } | null;
  sox: { change: number } | null;
  usdjpy: { price: number } | null;
  cmeFutures: { price: number } | null;
  assessment: { shouldTrade: boolean; sentiment: string; reasoning: string } | null;
  n225Sma50: { close: number; sma: number; filterOn: boolean } | null;
}

async function buildMarketSnapshot(): Promise<MarketSnapshot> {
  // 市場指標
  const marketData = await fetchMarketData();

  // 当日のMarketAssessment
  const assessment = await prisma.marketAssessment.findFirst({
    where: { date: getTodayForDB() },
  });

  // N225 SMA50 計算（market-assessment.ts と同じロジック）
  let n225Sma50: MarketSnapshot["n225Sma50"] = null;
  const { SMA_PERIOD, OFF_BUFFER_PCT, ON_BUFFER_PCT, WARMUP_DAYS } = INDEX_TREND_HYSTERESIS;

  const n225BarsDesc = await prisma.stockDailyBar.findMany({
    where: { tickerCode: "^N225" },
    orderBy: { date: "desc" },
    take: SMA_PERIOD + WARMUP_DAYS,
    select: { close: true },
  });
  const n225Bars = n225BarsDesc.reverse();

  if (n225Bars.length >= SMA_PERIOD) {
    let filterOn = true;
    let currentSma = 0;
    for (let i = SMA_PERIOD - 1; i < n225Bars.length; i++) {
      const close = n225Bars[i].close;
      let sum = 0;
      for (let j = i - SMA_PERIOD + 1; j <= i; j++) sum += n225Bars[j].close;
      const sma = sum / SMA_PERIOD;
      currentSma = sma;
      if (filterOn) {
        if (close < sma * (1 - OFF_BUFFER_PCT)) filterOn = false;
      } else {
        if (close > sma * (1 + ON_BUFFER_PCT)) filterOn = true;
      }
    }
    const recentClose = n225Bars[n225Bars.length - 1].close;
    n225Sma50 = { close: recentClose, sma: Math.round(currentSma), filterOn };
  }

  return {
    nikkei: marketData.nikkei ? { price: marketData.nikkei.price, change: marketData.nikkei.changePercent } : null,
    vix: marketData.vix ? { price: marketData.vix.price } : null,
    sp500: marketData.sp500 ? { change: marketData.sp500.changePercent } : null,
    nasdaq: marketData.nasdaq ? { change: marketData.nasdaq.changePercent } : null,
    dow: marketData.dow ? { change: marketData.dow.changePercent } : null,
    sox: marketData.sox ? { change: marketData.sox.changePercent } : null,
    usdjpy: marketData.usdjpy ? { price: marketData.usdjpy.price } : null,
    cmeFutures: marketData.cmeFutures ? { price: marketData.cmeFutures.price } : null,
    assessment: assessment ? {
      shouldTrade: assessment.shouldTrade,
      sentiment: assessment.sentiment,
      reasoning: assessment.reasoning,
    } : null,
    n225Sma50,
  };
}

// ========================================
// 仕様書読み込み
// ========================================

function loadStrategySpecs(): string {
  const specFiles = [
    "docs/prompts/strategy-rules.md",
  ];

  const specs: string[] = [];
  for (const file of specFiles) {
    try {
      const content = readFileSync(resolve(process.cwd(), file), "utf-8");
      specs.push(content);
    } catch {
      // ファイルが見つからない場合はスキップ
    }
  }
  return specs.join("\n\n---\n\n");
}

// ========================================
// プロンプト構築
// ========================================

type Timing = "morning" | "evening";

function buildSystemPrompt(timing: Timing): string {
  const target = timing === "morning"
    ? "本日の日本株市場（寄付前の予測）"
    : "翌営業日の日本株市場の見通し";

  const strategySpecs = loadStrategySpecs();

  return `あなたはプロの日本株トレーダーです。
提供された市場データとニュースヘッドラインに基づき、${target}を分析してください。

以下のJSON形式で回答してください:
{
  "outlook": "bullish" | "neutral" | "bearish",
  "confidence": 1〜5の整数（5が最も確信度が高い）,
  "summary": "2〜3文の予想サマリー（日本語）",
  "keyFactors": [{"factor": "要因の説明", "impact": "positive" | "negative" | "neutral"}],
  "risks": [{"risk": "リスクの説明", "severity": "high" | "medium" | "low"}],
  "tradingHints": "ブレイクアウト・ギャップアップ戦略のトレーダーへのヒント（日本語）"
}

分析のポイント:
- VIXの水準とトレンド（20未満=安定、20-25=やや不安定、25-30=高ボラ、30超=パニック）
- 日経225とSMA50の位置関係（参考情報。トレード可否の判断には使わない）
- 米国市場の前日の動き（翌日の日本市場に影響）
- CME先物の水準（ギャップの示唆）
- USD/JPYの動向（円安→輸出株に追い風、円高→逆風）
- ニュースヘッドラインから読み取れるイベントリスク
- 当日の市場評価（shouldTrade、sentiment）の文脈

=== 当システムの自動売買ルール（参考） ===
以下はシステムが自動的に適用するフィルター・ルールです。tradingHintsではこれらの自動化済みルールを繰り返さず、市場環境やニュースから読み取れる「自動化されていない」洞察を提供してください。
例: セクター別の注目点、特定イベントの影響、ボラティリティ環境での立ち回り方など。

${strategySpecs}`;
}

function buildUserPrompt(
  snapshot: MarketSnapshot,
  news: Array<{ title: string; source: string }>,
  targetDate: string,
): string {
  const lines: string[] = [];

  lines.push(`予想対象日: ${targetDate}`);
  lines.push("");
  lines.push("=== 市場指標 ===");

  if (snapshot.nikkei) {
    lines.push(`日経225: ¥${snapshot.nikkei.price.toLocaleString()} (${snapshot.nikkei.change >= 0 ? "+" : ""}${snapshot.nikkei.change.toFixed(2)}%)`);
  }
  if (snapshot.n225Sma50) {
    const smaRelation = snapshot.n225Sma50.close > snapshot.n225Sma50.sma ? "上" : "下";
    lines.push(`N225 SMA50: ¥${snapshot.n225Sma50.sma.toLocaleString()}（現値は SMA50 の${smaRelation}）`);
  }
  if (snapshot.vix) {
    lines.push(`VIX: ${snapshot.vix.price.toFixed(1)}`);
  }
  if (snapshot.usdjpy) {
    lines.push(`USD/JPY: ${snapshot.usdjpy.price.toFixed(2)}`);
  }
  if (snapshot.cmeFutures) {
    lines.push(`CME日経先物: ¥${snapshot.cmeFutures.price.toLocaleString()}`);
  }

  lines.push("");
  lines.push("=== 米国市場（前日） ===");
  if (snapshot.sp500) lines.push(`S&P500: ${snapshot.sp500.change >= 0 ? "+" : ""}${snapshot.sp500.change.toFixed(2)}%`);
  if (snapshot.nasdaq) lines.push(`NASDAQ: ${snapshot.nasdaq.change >= 0 ? "+" : ""}${snapshot.nasdaq.change.toFixed(2)}%`);
  if (snapshot.dow) lines.push(`ダウ: ${snapshot.dow.change >= 0 ? "+" : ""}${snapshot.dow.change.toFixed(2)}%`);
  if (snapshot.sox) lines.push(`SOX: ${snapshot.sox.change >= 0 ? "+" : ""}${snapshot.sox.change.toFixed(2)}%`);

  if (snapshot.assessment) {
    lines.push("");
    lines.push("=== 当日の市場評価 ===");
    lines.push(`取引判断: ${snapshot.assessment.shouldTrade ? "実行" : "見送り"}`);
    lines.push(`センチメント: ${snapshot.assessment.sentiment}`);
    lines.push(`理由: ${snapshot.assessment.reasoning}`);
  }

  if (news.length > 0) {
    lines.push("");
    lines.push("=== ニュースヘッドライン ===");
    for (const n of news) {
      lines.push(`- ${n.title}${n.source ? ` (${n.source})` : ""}`);
    }
  }

  return lines.join("\n");
}

// ========================================
// メインジョブ
// ========================================

interface ForecastResult {
  outlook: string;
  confidence: number;
  summary: string;
  keyFactors: Array<{ factor: string; impact: string }>;
  risks: Array<{ risk: string; severity: string }>;
  tradingHints?: string;
}

export async function main(timing: Timing = "evening"): Promise<void> {
  console.log(`=== Market Forecast 開始 (${timing}) ===`);

  // 1. 市場データスナップショット構築
  console.log("[1/4] 市場データ収集中...");
  const snapshot = await buildMarketSnapshot();

  // 2. ニュース取得 → DB保存 → DB読み込み
  console.log("[2/4] ニュースヘッドライン取得・保存中...");
  const freshNews = await fetchMarketNews(15);
  await saveNewsToDb(freshNews);
  const newsHeadlines = await getNewsFromDb(24);

  // 3. AI予想生成
  console.log("[3/4] AI予想生成中...");
  const forecastTargetDate = timing === "morning" ? getTodayForDB() : getNextTradingDay();
  const targetDateStr = dayjs(forecastTargetDate).format("YYYY-MM-DD");

  const systemPrompt = buildSystemPrompt(timing);
  const userPrompt = buildUserPrompt(
    snapshot,
    newsHeadlines.map((n) => ({ title: n.title, source: n.source })),
    targetDateStr,
  );

  const rawResponse = await chatCompletion([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  let forecast: ForecastResult;
  try {
    forecast = JSON.parse(rawResponse);
  } catch {
    console.error("[market-forecast] AI応答のJSON解析に失敗:", rawResponse);
    throw new Error("AI応答のJSON解析に失敗しました");
  }

  // バリデーション
  if (!["bullish", "neutral", "bearish"].includes(forecast.outlook)) {
    forecast.outlook = "neutral";
  }
  if (typeof forecast.confidence !== "number" || forecast.confidence < 1 || forecast.confidence > 5) {
    forecast.confidence = 3;
  }

  console.log(`  → outlook: ${forecast.outlook}, confidence: ${forecast.confidence}`);

  // 4. DB保存 + Slack通知
  console.log("[4/4] DB保存 + Slack通知...");
  await prisma.marketForecast.upsert({
    where: { date: forecastTargetDate },
    update: {
      marketData: snapshot,
      newsHeadlines: newsHeadlines,
      outlook: forecast.outlook,
      confidence: forecast.confidence,
      summary: forecast.summary,
      keyFactors: forecast.keyFactors ?? [],
      risks: forecast.risks ?? [],
      tradingHints: forecast.tradingHints ?? null,
    },
    create: {
      date: forecastTargetDate,
      marketData: snapshot,
      newsHeadlines: newsHeadlines,
      outlook: forecast.outlook,
      confidence: forecast.confidence,
      summary: forecast.summary,
      keyFactors: forecast.keyFactors ?? [],
      risks: forecast.risks ?? [],
      tradingHints: forecast.tradingHints ?? null,
    },
  });

  await notifyMarketForecast({
    targetDate: dayjs(forecastTargetDate).format("YYYY/M/D"),
    outlook: forecast.outlook,
    confidence: forecast.confidence,
    summary: forecast.summary,
    keyFactors: forecast.keyFactors ?? [],
    risks: forecast.risks ?? [],
    tradingHints: forecast.tradingHints,
    vix: snapshot.vix?.price ?? null,
    nikkeiPrice: snapshot.nikkei?.price ?? null,
    usdjpy: snapshot.usdjpy?.price ?? null,
  });

  console.log("=== Market Forecast 完了 ===");
}

const isDirectRun = process.argv[1]?.includes("market-forecast");
if (isDirectRun) {
  const timing: Timing = process.argv.includes("--morning") ? "morning" : "evening";
  main(timing)
    .catch((error) => {
      console.error("Market Forecast エラー:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
