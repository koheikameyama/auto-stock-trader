/**
 * ゴースト・トレーディング分析（16:10 JST / 平日）
 *
 * 「見送った銘柄がその日どうなったか」を追跡し、
 * 偽陰性（False Negative）のパターンを特定する。
 *
 * 1. 今日のScoringRecordからrejected銘柄を取得
 * 2. 終値をバッチ取得（fetchStockQuotes）
 * 3. 仮想損益を算出
 * 4. 利益が出ていた上位銘柄にAI「後悔分析」を実行
 * 5. 結果をDB更新 + Slack通知
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB, getDaysAgoForDB } from "../lib/date-utils";
import { GHOST_TRADING, CONTRARIAN, OPENAI_CONFIG } from "../lib/constants";
import { fetchStockQuotes } from "../core/market-data";
import { getOpenAIClient } from "../lib/openai";
import {
  GHOST_ANALYSIS_SYSTEM_PROMPT,
  GHOST_ANALYSIS_SCHEMA,
} from "../prompts/ghost-analysis";
import { notifyGhostReview, notifyContrarianWinners } from "../lib/slack";
import {
  isNoTradeDay,
  getTodayContrarianWinners,
  getContrarianHistoryBatch,
} from "../core/contrarian-analyzer";
import pLimit from "p-limit";

interface GhostAnalysisResult {
  misjudgmentType: string;
  analysis: string;
  recommendation: string;
  reasoning: string;
}

function buildGhostAnalysisPrompt(record: {
  tickerCode: string;
  totalScore: number;
  rank: string;
  rejectionReason: string | null;
  aiReasoning: string | null;
  technicalBreakdown: unknown;
  patternBreakdown: unknown;
  liquidityBreakdown: unknown;
  entryPrice: number;
  closingPrice: number;
  ghostProfitPct: number;
}): string {
  const reasonLabel: Record<string, string> = {
    below_threshold: "スコアが閾値未達（AI審査に送られなかった）",
    ai_no_go: "AIが定性的リスクを理由に否決",
    market_halted: "市場環境により取引停止（シャドウスコアリング）",
  };

  return `以下の銘柄は自動売買システムが見送りましたが、実際には利益が出ていました。

【銘柄】${record.tickerCode}
【スコア】${record.totalScore}/100（${record.rank}ランク）
【見送り理由】${reasonLabel[record.rejectionReason ?? ""] ?? record.rejectionReason}
${record.aiReasoning ? `【AIの否決理由】${record.aiReasoning}` : ""}
【スコア内訳】
  テクニカル: ${JSON.stringify(record.technicalBreakdown)}
  パターン: ${JSON.stringify(record.patternBreakdown)}
  流動性: ${JSON.stringify(record.liquidityBreakdown)}
【スコアリング時株価】¥${record.entryPrice.toLocaleString()}
【終値】¥${record.closingPrice.toLocaleString()}
【仮想損益】+${record.ghostProfitPct.toFixed(2)}%

この銘柄について偽陰性分析を行ってください。`;
}

export async function main() {
  console.log("=== Ghost Review 開始 ===");

  const today = getTodayForDB();

  // 1. 今日のrejected銘柄を取得
  console.log("[1/5] Rejected銘柄取得中...");
  const rejectedRecords = await prisma.scoringRecord.findMany({
    where: {
      date: today,
      rejectionReason: { not: null },
      entryPrice: { not: null },
    },
  });

  if (rejectedRecords.length === 0) {
    console.log("  見送り銘柄なし。終了します。");
    console.log("=== Ghost Review 終了 ===");
    return;
  }

  console.log(`  見送り銘柄: ${rejectedRecords.length}件`);

  // 2. 終値をバッチ取得
  console.log("[2/5] 終値取得中...");
  const tickerCodes = rejectedRecords.map((r) => r.tickerCode);
  const quotes = await fetchStockQuotes(tickerCodes);

  const priceMap = new Map<string, number>();
  for (let i = 0; i < tickerCodes.length; i++) {
    const quote = quotes[i];
    if (quote) {
      priceMap.set(tickerCodes[i], quote.price);
    }
  }

  console.log(`  終値取得: ${priceMap.size}/${tickerCodes.length}件`);

  // 3. 仮想損益を算出
  console.log("[3/5] 仮想損益算出中...");
  const recordsWithPnl = rejectedRecords
    .filter((r) => priceMap.has(r.tickerCode) && r.entryPrice)
    .map((r) => {
      const entryPrice = Number(r.entryPrice);
      const closingPrice = priceMap.get(r.tickerCode)!;
      const ghostProfitPct =
        ((closingPrice - entryPrice) / entryPrice) * 100;

      return {
        ...r,
        entryPriceNum: entryPrice,
        closingPriceNum: closingPrice,
        ghostProfitPctNum: ghostProfitPct,
      };
    });

  // 4. DB更新（終値 + 仮想損益）
  console.log("[4/5] DB更新中...");
  const updateLimit = pLimit(10);
  await Promise.all(
    recordsWithPnl.map((r) =>
      updateLimit(() =>
        prisma.scoringRecord.update({
          where: { id: r.id },
          data: {
            closingPrice: r.closingPriceNum,
            ghostProfitPct: r.ghostProfitPctNum,
          },
        }),
      ),
    ),
  );

  console.log(`  DB更新: ${recordsWithPnl.length}件`);

  // 統計
  const profitable = recordsWithPnl.filter(
    (r) => r.ghostProfitPctNum > 0,
  );
  const loss = recordsWithPnl.filter((r) => r.ghostProfitPctNum <= 0);
  const avgProfitPct =
    profitable.length > 0
      ? profitable.reduce((sum, r) => sum + r.ghostProfitPctNum, 0) /
        profitable.length
      : 0;

  console.log(
    `  統計: 利益${profitable.length}件 / 損失${loss.length}件 / 平均利益率+${avgProfitPct.toFixed(2)}%`,
  );

  // 5. AI後悔分析（利益率が高い上位銘柄のみ）
  console.log("[5/5] AI後悔分析中...");
  const topProfitable = profitable
    .filter(
      (r) =>
        r.ghostProfitPctNum >= GHOST_TRADING.MIN_PROFIT_PCT_FOR_ANALYSIS,
    )
    .sort((a, b) => b.ghostProfitPctNum - a.ghostProfitPctNum)
    .slice(0, GHOST_TRADING.MAX_AI_REGRET_ANALYSIS);

  const analysisResults: Array<{
    id: string;
    tickerCode: string;
    result: GhostAnalysisResult;
  }> = [];

  if (topProfitable.length > 0) {
    console.log(`  AI分析対象: ${topProfitable.length}件`);
    const aiLimit = pLimit(GHOST_TRADING.AI_CONCURRENCY);
    const openai = getOpenAIClient();

    const analyses = await Promise.all(
      topProfitable.map((record) =>
        aiLimit(async () => {
          try {
            const response = await openai.chat.completions.create({
              model: OPENAI_CONFIG.MODEL,
              temperature: OPENAI_CONFIG.TEMPERATURE,
              messages: [
                {
                  role: "system",
                  content: GHOST_ANALYSIS_SYSTEM_PROMPT,
                },
                {
                  role: "user",
                  content: buildGhostAnalysisPrompt({
                    tickerCode: record.tickerCode,
                    totalScore: record.totalScore,
                    rank: record.rank,
                    rejectionReason: record.rejectionReason,
                    aiReasoning: record.aiReasoning,
                    technicalBreakdown: record.technicalBreakdown,
                    patternBreakdown: record.patternBreakdown,
                    liquidityBreakdown: record.liquidityBreakdown,
                    entryPrice: record.entryPriceNum,
                    closingPrice: record.closingPriceNum,
                    ghostProfitPct: record.ghostProfitPctNum,
                  }),
                },
              ],
              response_format: GHOST_ANALYSIS_SCHEMA,
            });

            const result = JSON.parse(
              response.choices[0].message.content!,
            ) as GhostAnalysisResult;
            return {
              id: record.id,
              tickerCode: record.tickerCode,
              result,
            };
          } catch (error) {
            console.error(
              `  AI分析エラー: ${record.tickerCode}`,
              error,
            );
            return null;
          }
        }),
      ),
    );

    for (const a of analyses) {
      if (!a) continue;
      analysisResults.push(a);
      await prisma.scoringRecord.update({
        where: { id: a.id },
        data: { ghostAnalysis: JSON.stringify(a.result) },
      });
    }

    console.log(`  AI分析完了: ${analysisResults.length}件`);
  } else {
    console.log(
      `  AI分析対象なし（利益率${GHOST_TRADING.MIN_PROFIT_PCT_FOR_ANALYSIS}%以上の銘柄なし）`,
    );
  }

  // Slack通知
  const analysisMap = new Map(
    analysisResults.map((a) => [a.tickerCode, a.result]),
  );

  await notifyGhostReview({
    totalRejected: recordsWithPnl.length,
    totalProfitable: profitable.length,
    totalLoss: loss.length,
    avgProfitPct,
    topMissed: profitable
      .sort((a, b) => b.ghostProfitPctNum - a.ghostProfitPctNum)
      .slice(0, 10)
      .map((r) => ({
        tickerCode: r.tickerCode,
        score: r.totalScore,
        rank: r.rank,
        rejectionReason: r.rejectionReason ?? "unknown",
        ghostProfitPct: r.ghostProfitPctNum,
        misjudgmentType: analysisMap.get(r.tickerCode)?.misjudgmentType,
      })),
  });

  // 前日レコードの翌日価格を記録（今日の株価を使って前日の nextDayClosingPrice を埋める）
  console.log("[5.5/6] 前日レコードに翌日価格を記録中...");
  const yesterday = getDaysAgoForDB(1);
  const prevDayRecords = await prisma.scoringRecord.findMany({
    where: {
      date: yesterday,
      closingPrice: { not: null },
      nextDayClosingPrice: null,
    },
    select: { id: true, tickerCode: true, closingPrice: true },
  });

  if (prevDayRecords.length > 0) {
    const prevTickers = prevDayRecords.map((r) => r.tickerCode);
    const prevQuotes = await fetchStockQuotes(prevTickers);
    const nextDayPriceMap = new Map<string, number>();
    for (let i = 0; i < prevTickers.length; i++) {
      const quote = prevQuotes[i];
      if (quote) nextDayPriceMap.set(prevTickers[i], quote.price);
    }

    const nextDayLimit = pLimit(10);
    await Promise.all(
      prevDayRecords
        .filter((r) => nextDayPriceMap.has(r.tickerCode))
        .map((r) =>
          nextDayLimit(() => {
            const nextDayPrice = nextDayPriceMap.get(r.tickerCode)!;
            const prevClose = Number(r.closingPrice);
            const nextDayProfitPct =
              prevClose > 0
                ? ((nextDayPrice - prevClose) / prevClose) * 100
                : 0;
            return prisma.scoringRecord.update({
              where: { id: r.id },
              data: { nextDayClosingPrice: nextDayPrice, nextDayProfitPct },
            });
          }),
        ),
    );
    console.log(`  翌日価格記録: ${nextDayPriceMap.size}/${prevDayRecords.length}件`);
  } else {
    console.log("  前日レコードなし（スキップ）");
  }

  // 逆行ウィナー分析（市場停止日のみ）
  const noTrade = await isNoTradeDay();
  if (noTrade) {
    console.log("[6/6] 逆行ウィナー分析中...");
    const winners = await getTodayContrarianWinners();

    if (winners.length > 0) {
      const historyMap = await getContrarianHistoryBatch(
        winners.map((w) => w.tickerCode),
      );

      const totalHalted = recordsWithPnl.filter(
        (r) => r.rejectionReason === "market_halted",
      ).length;

      await notifyContrarianWinners({
        totalHalted,
        winners: winners
          .slice(0, CONTRARIAN.MAX_REPORT_WINNERS)
          .map((w) => ({
            tickerCode: w.tickerCode,
            score: w.totalScore,
            rank: w.rank,
            ghostProfitPct: w.ghostProfitPct,
            contrarianWins: historyMap.get(w.tickerCode)?.wins,
          })),
      });

      console.log(`  逆行ウィナー: ${winners.length}銘柄通知`);
    } else {
      console.log("  逆行ウィナーなし");
    }
  }

  console.log("=== Ghost Review 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("ghost-review");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Ghost Review エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
