/**
 * 市場スキャナー（8:30 JST / 平日）
 *
 * 1. 市場指標データ取得
 * 2. AI市場評価 → shouldTrade判定
 * 3. shouldTrade = false → Slack通知して終了
 * 4. shouldTrade = true → 銘柄選定
 *    a. 対象銘柄のヒストリカルデータ取得
 *    b. テクニカル分析
 *    c. AI銘柄選定
 *    d. MarketAssessment に結果を保存
 *    e. Slackに候補銘柄通知
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/date-utils";
import { SCREENING, YAHOO_FINANCE } from "../lib/constants";
import {
  fetchMarketData,
  fetchHistoricalData,
  fetchStockQuote,
} from "../core/market-data";
import { analyzeTechnicals, formatTechnicalForAI } from "../core/technical-analysis";
import { assessMarket, selectStocks } from "../core/ai-decision";
import type { MarketDataInput, StockCandidateInput } from "../core/ai-decision";
import {
  notifyMarketAssessment,
  notifyStockCandidates,
  notifyRiskAlert,
} from "../lib/slack";
import pLimit from "p-limit";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main() {
  console.log("=== Market Scanner 開始 ===");

  // 1. 市場指標データ取得
  console.log("[1/4] 市場指標データ取得中...");
  const marketData = await fetchMarketData();

  if (!marketData.nikkei || !marketData.vix) {
    console.error("市場データの取得に失敗しました");
    await notifyRiskAlert({
      type: "データ取得エラー",
      message: "市場指標データの取得に失敗しました。手動確認してください。",
    });
    process.exit(1);
  }

  // 2. AI市場評価
  console.log("[2/4] AI市場評価中...");
  const marketInput: MarketDataInput = {
    nikkeiPrice: marketData.nikkei.price,
    nikkeiChange: marketData.nikkei.changePercent,
    sp500Change: marketData.sp500?.changePercent ?? 0,
    vix: marketData.vix.price,
    usdJpy: marketData.usdjpy?.price ?? 0,
    cmeFuturesPrice: marketData.cmeFutures?.price ?? 0,
    cmeFuturesChange: marketData.cmeFutures?.changePercent ?? 0,
  };

  const assessment = await assessMarket(marketInput);
  console.log(
    `  → shouldTrade: ${assessment.shouldTrade}, sentiment: ${assessment.sentiment}`,
  );

  // Slack通知
  await notifyMarketAssessment({
    shouldTrade: assessment.shouldTrade,
    sentiment: assessment.sentiment,
    reasoning: assessment.reasoning,
    nikkeiChange: marketData.nikkei.changePercent,
    vix: marketData.vix.price,
  });

  // 3. shouldTrade = false → 保存して終了
  if (!assessment.shouldTrade) {
    console.log("取引見送り。MarketAssessment を保存して終了");
    await prisma.marketAssessment.create({
      data: {
        date: getTodayForDB(),
        nikkeiPrice: marketData.nikkei.price,
        nikkeiChange: marketData.nikkei.changePercent,
        sp500Change: marketData.sp500?.changePercent,
        vix: marketData.vix.price,
        usdjpy: marketData.usdjpy?.price,
        cmeFuturesPrice: marketData.cmeFutures?.price,
        sentiment: assessment.sentiment,
        shouldTrade: false,
        reasoning: assessment.reasoning,
        selectedStocks: [],
      },
    });
    console.log("=== Market Scanner 終了 ===");
    return;
  }

  // 4. 銘柄選定
  console.log("[3/4] 候補銘柄のテクニカル分析中...");

  // スクリーニング条件に合う銘柄を取得
  const stocks = await prisma.stock.findMany({
    where: {
      isDelisted: false,
      latestPrice: { not: null },
      latestVolume: { not: null },
    },
  });

  // スクリーニングフィルタ
  const candidates = stocks.filter((s) => {
    const price = Number(s.latestPrice);
    const volume = Number(s.latestVolume);
    const marketCap = s.marketCap ? Number(s.marketCap) : 0;
    return (
      price >= SCREENING.MIN_PRICE &&
      price <= SCREENING.MAX_PRICE &&
      volume >= SCREENING.MIN_DAILY_VOLUME &&
      marketCap >= SCREENING.MIN_MARKET_CAP
    );
  });

  console.log(`  スクリーニング通過: ${candidates.length}銘柄`);

  // テクニカル分析（並列、バッチ制御）
  const limit = pLimit(5);
  const analysisResults: StockCandidateInput[] = [];

  for (let i = 0; i < candidates.length; i += YAHOO_FINANCE.BATCH_SIZE) {
    const batch = candidates.slice(i, i + YAHOO_FINANCE.BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map((stock) =>
        limit(async () => {
          try {
            const historical = await fetchHistoricalData(stock.tickerCode);
            if (!historical || historical.length < 15) return null;

            const summary = analyzeTechnicals(historical);
            const formatted = formatTechnicalForAI(summary);

            return {
              tickerCode: stock.tickerCode,
              name: stock.name,
              technicalSummary: formatted,
            } as StockCandidateInput;
          } catch (error) {
            console.error(
              `  テクニカル分析エラー: ${stock.tickerCode}`,
              error,
            );
            return null;
          }
        }),
      ),
    );

    analysisResults.push(
      ...batchResults.filter((r): r is StockCandidateInput => r !== null),
    );

    if (i + YAHOO_FINANCE.BATCH_SIZE < candidates.length) {
      await sleep(YAHOO_FINANCE.RATE_LIMIT_DELAY_MS);
    }
  }

  console.log(`  テクニカル分析完了: ${analysisResults.length}銘柄`);

  // AI銘柄選定
  console.log("[4/4] AI銘柄選定中...");
  const selections = await selectStocks(assessment, analysisResults);
  console.log(`  → ${selections.length}銘柄選定`);

  // MarketAssessment に結果を保存
  await prisma.marketAssessment.create({
    data: {
      date: getTodayForDB(),
      nikkeiPrice: marketData.nikkei.price,
      nikkeiChange: marketData.nikkei.changePercent,
      sp500Change: marketData.sp500?.changePercent,
      vix: marketData.vix.price,
      usdjpy: marketData.usdjpy?.price,
      cmeFuturesPrice: marketData.cmeFutures?.price,
      sentiment: assessment.sentiment,
      shouldTrade: true,
      reasoning: assessment.reasoning,
      selectedStocks: JSON.parse(JSON.stringify(selections)),
    },
  });

  // Slack通知
  if (selections.length > 0) {
    await notifyStockCandidates(
      selections.map((s) => ({
        tickerCode: s.tickerCode,
        name: candidates.find((c) => c.tickerCode === s.tickerCode)?.name,
        strategy: s.strategy,
        score: s.score,
        reasoning: s.reasoning,
      })),
    );
  }

  console.log("=== Market Scanner 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("market-scanner");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Market Scanner エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
