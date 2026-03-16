/**
 * スコアリング精度分析（16:10 JST / 平日）
 *
 * スコアリングシステムの判断精度を4象限で評価する。
 *
 * 1. 今日の全ScoringRecordを取得（accepted + rejected）
 * 2. 終値をバッチ取得（fetchStockQuotes）
 * 3. 4象限に分類（TP/FP/FN/TN）+ Precision/Recall/F1算出
 * 4. FN銘柄（見逃し）のAI分析
 * 5. FP銘柄（誤買い）のAI分析
 * 6. 結果をDB更新 + Slack通知
 * 7. 前日レコードに翌日価格を記録
 * 8. 意思決定整合性評価
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB, getDaysAgoForDB } from "../lib/date-utils";
import { SCORING_ACCURACY, CONTRARIAN, OPENAI_CONFIG } from "../lib/constants";
import { fetchStockQuotes } from "../core/market-data";
import { getOpenAIClient } from "../lib/openai";
import {
  FN_ANALYSIS_SYSTEM_PROMPT,
  FN_ANALYSIS_SCHEMA,
  FP_ANALYSIS_SYSTEM_PROMPT,
  FP_ANALYSIS_SCHEMA,
} from "../prompts/scoring-accuracy";
import { notifyScoringAccuracy, notifyContrarianWinners } from "../lib/slack";
import {
  isNoTradeDay,
  getTodayContrarianWinners,
  getContrarianHistoryBatch,
} from "../core/contrarian-analyzer";
import pLimit from "p-limit";

interface AnalysisResult {
  misjudgmentType: string;
  analysis: string;
  recommendation: string;
  reasoning: string;
}

interface RecordWithPnl {
  id: string;
  tickerCode: string;
  totalScore: number;
  rank: string;
  rejectionReason: string | null;
  aiDecision: string | null;
  aiReasoning: string | null;
  trendQualityBreakdown: unknown;
  entryTimingBreakdown: unknown;
  riskQualityBreakdown: unknown;
  sectorMomentumScore: number;
  entryPrice: number;
  closingPrice: number;
  pnlPct: number;
}

function buildFnAnalysisPrompt(record: {
  tickerCode: string;
  totalScore: number;
  rank: string;
  rejectionReason: string | null;
  aiReasoning: string | null;
  trendQualityBreakdown: unknown;
  entryTimingBreakdown: unknown;
  riskQualityBreakdown: unknown;
  sectorMomentumScore: number;
  entryPrice: number;
  closingPrice: number;
  pnlPct: number;
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
  トレンド品質: ${JSON.stringify(record.trendQualityBreakdown)}
  エントリータイミング: ${JSON.stringify(record.entryTimingBreakdown)}
  リスク品質: ${JSON.stringify(record.riskQualityBreakdown)}
  セクターモメンタム: ${record.sectorMomentumScore}/5
【スコアリング時株価】¥${record.entryPrice.toLocaleString()}
【終値】¥${record.closingPrice.toLocaleString()}
【仮想損益】+${record.pnlPct.toFixed(2)}%

この銘柄について偽陰性分析を行ってください。`;
}

function buildFpAnalysisPrompt(record: {
  tickerCode: string;
  totalScore: number;
  rank: string;
  aiReasoning: string | null;
  trendQualityBreakdown: unknown;
  entryTimingBreakdown: unknown;
  riskQualityBreakdown: unknown;
  sectorMomentumScore: number;
  entryPrice: number;
  closingPrice: number;
  pnlPct: number;
}): string {
  return `以下の銘柄は自動売買システムが買いと判断しましたが、実際には下落しました。

【銘柄】${record.tickerCode}
【スコア】${record.totalScore}/100（${record.rank}ランク）
${record.aiReasoning ? `【AIの承認理由】${record.aiReasoning}` : ""}
【スコア内訳】
  トレンド品質: ${JSON.stringify(record.trendQualityBreakdown)}
  エントリータイミング: ${JSON.stringify(record.entryTimingBreakdown)}
  リスク品質: ${JSON.stringify(record.riskQualityBreakdown)}
  セクターモメンタム: ${record.sectorMomentumScore}/5
【スコアリング時株価】¥${record.entryPrice.toLocaleString()}
【終値】¥${record.closingPrice.toLocaleString()}
【損益】${record.pnlPct.toFixed(2)}%

この銘柄について偽陽性分析を行ってください。`;
}

async function runAiAnalysis(
  records: RecordWithPnl[],
  type: "fn" | "fp",
): Promise<Array<{ id: string; tickerCode: string; result: AnalysisResult }>> {
  if (records.length === 0) return [];

  const openai = getOpenAIClient();
  const aiLimit = pLimit(SCORING_ACCURACY.AI_CONCURRENCY);

  const systemPrompt =
    type === "fn" ? FN_ANALYSIS_SYSTEM_PROMPT : FP_ANALYSIS_SYSTEM_PROMPT;
  const schema = type === "fn" ? FN_ANALYSIS_SCHEMA : FP_ANALYSIS_SCHEMA;
  const buildPrompt = type === "fn" ? buildFnAnalysisPrompt : buildFpAnalysisPrompt;

  const analyses = await Promise.all(
    records.map((record) =>
      aiLimit(async () => {
        try {
          const response = await openai.chat.completions.create({
            model: OPENAI_CONFIG.MODEL,
            temperature: OPENAI_CONFIG.TEMPERATURE,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: buildPrompt(record) },
            ],
            response_format: schema,
          });

          const result = JSON.parse(
            response.choices[0].message.content!,
          ) as AnalysisResult;
          return { id: record.id, tickerCode: record.tickerCode, result };
        } catch (error) {
          console.error(`  AI ${type.toUpperCase()} 分析エラー: ${record.tickerCode}`, error);
          return null;
        }
      }),
    ),
  );

  return analyses.filter((a): a is NonNullable<typeof a> => a !== null);
}

export async function main() {
  console.log("=== スコアリング精度分析 開始 ===");

  const today = getTodayForDB();

  // 1. 今日の全ScoringRecordを取得（accepted + rejected）
  console.log("[1/8] ScoringRecord取得中...");
  const allRecords = await prisma.scoringRecord.findMany({
    where: {
      date: today,
      entryPrice: { not: null },
    },
  });

  if (allRecords.length === 0) {
    console.log("  スコアリングデータなし。終了します。");
    console.log("=== スコアリング精度分析 終了 ===");
    return;
  }

  const acceptedCount = allRecords.filter((r) => r.rejectionReason === null).length;
  const rejectedCount = allRecords.filter((r) => r.rejectionReason !== null).length;
  console.log(`  全銘柄: ${allRecords.length}件（accepted: ${acceptedCount}, rejected: ${rejectedCount}）`);

  // 2. 終値をバッチ取得
  console.log("[2/8] 終値取得中...");
  const tickerCodes = allRecords.map((r) => r.tickerCode);
  const quotes = await fetchStockQuotes(tickerCodes);

  const priceMap = new Map<string, number>();
  for (let i = 0; i < tickerCodes.length; i++) {
    const quote = quotes[i];
    if (quote) {
      priceMap.set(tickerCodes[i], quote.price);
    }
  }

  console.log(`  終値取得: ${priceMap.size}/${tickerCodes.length}件`);

  // 3. 全銘柄の損益算出
  console.log("[3/8] 損益算出中...");
  const allRecordsWithPnl: RecordWithPnl[] = allRecords
    .filter((r) => priceMap.has(r.tickerCode) && r.entryPrice)
    .map((r) => {
      const entryPrice = Number(r.entryPrice);
      const closingPrice = priceMap.get(r.tickerCode)!;
      const pnlPct = ((closingPrice - entryPrice) / entryPrice) * 100;

      return {
        id: r.id,
        tickerCode: r.tickerCode,
        totalScore: r.totalScore,
        rank: r.rank,
        rejectionReason: r.rejectionReason,
        aiDecision: r.aiDecision,
        aiReasoning: r.aiReasoning,
        trendQualityBreakdown: r.trendQualityBreakdown,
        entryTimingBreakdown: r.entryTimingBreakdown,
        riskQualityBreakdown: r.riskQualityBreakdown,
        sectorMomentumScore: r.sectorMomentumScore,
        entryPrice,
        closingPrice,
        pnlPct,
      };
    });

  // accepted / rejected に分離
  const acceptedRecords = allRecordsWithPnl.filter((r) => r.rejectionReason === null);
  const rejectedRecords = allRecordsWithPnl.filter((r) => r.rejectionReason !== null);

  // 4象限分類
  const tp = acceptedRecords.filter((r) => r.pnlPct > 0);
  const fp = acceptedRecords.filter((r) => r.pnlPct <= 0);
  const fn = rejectedRecords.filter((r) => r.pnlPct > 0);
  const tn = rejectedRecords.filter((r) => r.pnlPct <= 0);

  const precision =
    tp.length + fp.length > 0
      ? (tp.length / (tp.length + fp.length)) * 100
      : null;
  const recall =
    tp.length + fn.length > 0
      ? (tp.length / (tp.length + fn.length)) * 100
      : null;
  const f1 =
    precision != null && recall != null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  console.log(
    `  4象限: TP=${tp.length} FP=${fp.length} FN=${fn.length} TN=${tn.length}`,
  );
  console.log(
    `  Precision=${precision?.toFixed(1) ?? "N/A"}% Recall=${recall?.toFixed(1) ?? "N/A"}% F1=${f1?.toFixed(1) ?? "N/A"}%`,
  );

  // 4. DB更新（全銘柄の終値 + 損益）
  console.log("[4/8] DB更新中...");
  const updateLimit = pLimit(10);
  await Promise.all(
    allRecordsWithPnl.map((r) =>
      updateLimit(() =>
        prisma.scoringRecord.update({
          where: { id: r.id },
          data: {
            closingPrice: r.closingPrice,
            ghostProfitPct: r.pnlPct,
          },
        }),
      ),
    ),
  );

  console.log(`  DB更新: ${allRecordsWithPnl.length}件`);

  // 5. FN分析（見逃し銘柄のAI分析）
  console.log("[5/8] FN分析中...");
  const fnTargets = fn
    .filter((r) => r.pnlPct >= SCORING_ACCURACY.MIN_PROFIT_PCT_FOR_FN_ANALYSIS)
    .sort((a, b) => b.pnlPct - a.pnlPct)
    .slice(0, SCORING_ACCURACY.MAX_AI_FN_ANALYSIS);

  const fnResults = await runAiAnalysis(fnTargets, "fn");
  const dbLimit = pLimit(10);
  await Promise.all(
    fnResults.map((a) =>
      dbLimit(() =>
        prisma.scoringRecord.update({
          where: { id: a.id },
          data: { ghostAnalysis: JSON.stringify(a.result) },
        }),
      ),
    ),
  );
  console.log(
    fnTargets.length > 0
      ? `  FN分析完了: ${fnResults.length}件`
      : `  FN分析対象なし（利益率${SCORING_ACCURACY.MIN_PROFIT_PCT_FOR_FN_ANALYSIS}%以上の銘柄なし）`,
  );

  // 6. FP分析（誤買い銘柄のAI分析）
  console.log("[6/8] FP分析中...");
  const fpTargets = fp
    .filter((r) => r.pnlPct <= -SCORING_ACCURACY.MIN_LOSS_PCT_FOR_FP_ANALYSIS)
    .sort((a, b) => a.pnlPct - b.pnlPct)
    .slice(0, SCORING_ACCURACY.MAX_AI_FP_ANALYSIS);

  const fpResults = await runAiAnalysis(fpTargets, "fp");
  await Promise.all(
    fpResults.map((a) =>
      dbLimit(() =>
        prisma.scoringRecord.update({
          where: { id: a.id },
          data: { ghostAnalysis: JSON.stringify(a.result) },
        }),
      ),
    ),
  );
  console.log(
    fpTargets.length > 0
      ? `  FP分析完了: ${fpResults.length}件`
      : `  FP分析対象なし（損失率${SCORING_ACCURACY.MIN_LOSS_PCT_FOR_FP_ANALYSIS}%以上の銘柄なし）`,
  );

  // 7. Slack通知
  console.log("[7/8] Slack通知中...");
  const fnAnalysisMap = new Map(fnResults.map((a) => [a.tickerCode, a.result]));
  const fpAnalysisMap = new Map(fpResults.map((a) => [a.tickerCode, a.result]));

  // ランク別精度
  const byRank: Record<string, { tp: number; fp: number; fn: number; tn: number; precision: number | null }> = {};
  for (const r of allRecordsWithPnl) {
    if (!byRank[r.rank]) {
      byRank[r.rank] = { tp: 0, fp: 0, fn: 0, tn: 0, precision: null };
    }
    const bucket = byRank[r.rank];
    if (r.rejectionReason === null) {
      if (r.pnlPct > 0) bucket.tp++;
      else bucket.fp++;
    } else {
      if (r.pnlPct > 0) bucket.fn++;
      else bucket.tn++;
    }
  }
  for (const v of Object.values(byRank)) {
    v.precision =
      v.tp + v.fp > 0 ? (v.tp / (v.tp + v.fp)) * 100 : null;
  }

  await notifyScoringAccuracy({
    confusionMatrix: {
      tp: tp.length,
      fp: fp.length,
      fn: fn.length,
      tn: tn.length,
      precision,
      recall,
      f1,
    },
    byRank,
    fpList: fp
      .sort((a, b) => a.pnlPct - b.pnlPct)
      .slice(0, 10)
      .map((r) => ({
        tickerCode: r.tickerCode,
        score: r.totalScore,
        rank: r.rank,
        profitPct: r.pnlPct,
        misjudgmentType: fpAnalysisMap.get(r.tickerCode)?.misjudgmentType,
      })),
    fnList: fn
      .sort((a, b) => b.pnlPct - a.pnlPct)
      .slice(0, 10)
      .map((r) => ({
        tickerCode: r.tickerCode,
        score: r.totalScore,
        rank: r.rank,
        profitPct: r.pnlPct,
        rejectionReason: r.rejectionReason ?? "unknown",
        misjudgmentType: fnAnalysisMap.get(r.tickerCode)?.misjudgmentType,
      })),
  });

  // 8. 前日レコードの翌日価格を記録
  console.log("[8/8] 前日レコードに翌日価格を記録中...");
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

  // 意思決定整合性評価
  console.log("[8.5/9] 意思決定整合性評価中...");
  try {
    const todayAssessment = await prisma.marketAssessment.findUnique({
      where: { date: today },
    });

    const allTodayRecords = await prisma.scoringRecord.findMany({
      where: { date: today },
      select: { aiDecision: true, rejectionReason: true, rank: true },
    });
    const aiGoCount = allTodayRecords.filter((r) => r.aiDecision === "go").length;
    const rankCounts = allTodayRecords.reduce(
      (acc, r) => { acc[r.rank] = (acc[r.rank] || 0) + 1; return acc; },
      {} as Record<string, number>,
    );

    const marketHaltedToday = rejectedRecords.filter((r) => r.rejectionReason === "market_halted");
    const aiNoGoToday = rejectedRecords.filter((r) => r.rejectionReason === "ai_no_go");
    const belowThresholdToday = rejectedRecords.filter((r) => r.rejectionReason === "below_threshold");

    const mhRising = marketHaltedToday.filter((r) => r.pnlPct > 0);
    const aiRising = aiNoGoToday.filter((r) => r.pnlPct > 0);
    const btRising = belowThresholdToday.filter((r) => r.pnlPct > 0);

    const auditData = {
      scoringSummary: {
        totalScored: allTodayRecords.length,
        aiApproved: aiGoCount,
        rankBreakdown: rankCounts,
      },
      marketHalt: todayAssessment
        ? {
            wasHalted: !todayAssessment.shouldTrade,
            sentiment: todayAssessment.sentiment,
            nikkeiChange: todayAssessment.nikkeiChange
              ? Number(todayAssessment.nikkeiChange)
              : null,
            totalScored: marketHaltedToday.length,
            risingCount: mhRising.length,
            risingRate:
              marketHaltedToday.length > 0
                ? Math.round((mhRising.length / marketHaltedToday.length) * 100)
                : null,
          }
        : null,
      aiRejection: {
        total: aiNoGoToday.length,
        correctlyRejected: aiNoGoToday.length - aiRising.length,
        falselyRejected: aiRising.length,
        accuracy:
          aiNoGoToday.length > 0
            ? Math.round(((aiNoGoToday.length - aiRising.length) / aiNoGoToday.length) * 100)
            : null,
      },
      scoreThreshold: {
        total: belowThresholdToday.length,
        rising: btRising.length,
        avgRisingPct:
          btRising.length > 0
            ? btRising.reduce((s, r) => s + r.pnlPct, 0) / btRising.length
            : null,
      },
      // 4象限メトリクス
      confusionMatrix: {
        tp: tp.length,
        fp: fp.length,
        fn: fn.length,
        tn: tn.length,
        precision,
        recall,
        f1,
      },
      byRank,
      fpAnalysis: fpResults.map((a) => {
        const record = fp.find((r) => r.id === a.id)!;
        return {
          tickerCode: a.tickerCode,
          score: record.totalScore,
          rank: record.rank,
          profitPct: record.pnlPct,
          misjudgmentType: a.result.misjudgmentType,
        };
      }),
      overallVerdict: "",
    };

    // AI verdict 生成
    const rankSummary = Object.entries(auditData.scoringSummary.rankBreakdown)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rank, count]) => `${rank}=${count}`)
      .join(", ");

    const verdictPrompt = `本日の自動売買システムの意思決定を評価してください。

【スコアリング全体像】
- 総スコアリング銘柄: ${auditData.scoringSummary.totalScored}件（${rankSummary}）
- AI承認（go）: ${auditData.scoringSummary.aiApproved}件
- AI却下（no_go）: ${auditData.aiRejection.total}件

【4象限精度】
- Precision: ${precision?.toFixed(1) ?? "N/A"}% | Recall: ${recall?.toFixed(1) ?? "N/A"}% | F1: ${f1?.toFixed(1) ?? "N/A"}%
- TP=${tp.length} FP=${fp.length} FN=${fn.length} TN=${tn.length}

【市場停止判断】
${auditData.marketHalt ? `- 判定: ${auditData.marketHalt.wasHalted ? "取引停止" : "取引実行"}（センチメント: ${auditData.marketHalt.sentiment}）
- 日経変化率: ${auditData.marketHalt.nikkeiChange != null ? `${auditData.marketHalt.nikkeiChange.toFixed(2)}%` : "不明"}
- 市場停止による見送り: ${auditData.marketHalt.totalScored}件のうち上昇 ${auditData.marketHalt.risingCount}件 (${auditData.marketHalt.risingRate ?? "-"}%)` : "- 市場評価データなし"}

【AI却下精度】
${auditData.aiRejection.total > 0 ? `- 却下銘柄: ${auditData.aiRejection.total}件
- 正確な却下: ${auditData.aiRejection.correctlyRejected}件
- 誤却下: ${auditData.aiRejection.falselyRejected}件
- 精度: ${auditData.aiRejection.accuracy}%` : "- AI却下銘柄なし"}

200文字以内で本日の意思決定の整合性を評価してください。`;

    try {
      const openai = getOpenAIClient();
      const verdictResponse = await openai.chat.completions.create({
        model: OPENAI_CONFIG.MODEL,
        temperature: 0.3,
        messages: [{ role: "user", content: verdictPrompt }],
        max_tokens: 200,
      });
      auditData.overallVerdict = verdictResponse.choices[0].message.content ?? "";
    } catch (e) {
      console.error("  AI verdict 生成エラー:", e);
    }

    await prisma.tradingDailySummary.upsert({
      where: { date: today },
      create: {
        date: today,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        portfolioValue: 0,
        cashBalance: 0,
        decisionAudit: auditData as object,
      },
      update: { decisionAudit: auditData as object },
    });

    console.log(
      `  整合性評価保存: Precision=${precision?.toFixed(1) ?? "N/A"}% Recall=${recall?.toFixed(1) ?? "N/A"}%`,
    );
  } catch (error) {
    console.error("  意思決定整合性評価エラー:", error);
  }

  // 逆行ウィナー分析（市場停止日のみ）
  const noTrade = await isNoTradeDay();
  if (noTrade) {
    console.log("[9/9] 逆行ウィナー分析中...");
    const winners = await getTodayContrarianWinners();

    if (winners.length > 0) {
      const historyMap = await getContrarianHistoryBatch(
        winners.map((w) => w.tickerCode),
      );

      const totalHalted = rejectedRecords.filter(
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

  console.log("=== スコアリング精度分析 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("scoring-accuracy");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("スコアリング精度分析エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
