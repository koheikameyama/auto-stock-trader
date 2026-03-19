/**
 * 昼休み再評価（12:15 JST / 平日）
 *
 * 1. 今日のMarketAssessmentを取得
 * 2. 市場指標データを再取得（前場終了時点）
 * 3. ニュース再取得 & AI再分析
 * 4. セクターモメンタム再計算
 * 5. AI再評価 + センチメント比較（悪化方向のみ適用）
 * 6. 未約定買い注文のキャンセル判定
 * 7. Slack通知
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/date-utils";
import { DEFENSIVE_MODE } from "../lib/constants";
import { fetchMarketData } from "../core/market-data";
import { reassessMarketMidday } from "../core/ai-decision";
import { notifySlack, notifyRiskAlert } from "../lib/slack";
import { collectAndAnalyzeNews } from "./news-collector";
import { calculateSectorMomentum } from "../core/sector-analyzer";

/** センチメントの深刻度（大きいほど悪い） */
const SENTIMENT_SEVERITY: Record<string, number> = {
  bullish: 0,
  neutral: 1,
  cautious: 2,
  bearish: 3,
  crisis: 4,
};

export async function main() {
  console.log("=== Midday Reassessment 開始 ===");

  // 1. 今日のMarketAssessmentを取得
  const assessment = await prisma.marketAssessment.findUnique({
    where: { date: getTodayForDB() },
  });

  if (!assessment) {
    console.log(
      "今日のMarketAssessmentがありません。スキップします。",
    );
    return;
  }

  if (assessment.middayReassessedAt) {
    console.log("既に昼休み再評価済みです。スキップします。");
    return;
  }

  // 2. 市場指標データを再取得
  console.log("[1/6] 市場指標データ再取得中...");
  const marketData = await fetchMarketData();

  if (!marketData.nikkei || !marketData.vix) {
    console.error("市場データの取得に失敗しました");
    await notifyRiskAlert({
      type: "昼休み再評価エラー",
      message:
        "市場指標データの取得に失敗しました。朝の評価を維持します。",
    });
    return;
  }

  // 3. ニュース再取得 & AI再分析
  console.log("[3/6] ニュース再取得 & AI再分析中...");
  let newsSummary: string | undefined;
  let newsArticleCount = 0;
  try {
    const newsResult = await collectAndAnalyzeNews();
    newsArticleCount = newsResult.newArticleCount;
    if (newsResult.analysis) {
      const sectorText = newsResult.analysis.sectorImpacts
        .map((s) => `  - ${s.sector}: ${s.impact} — ${s.summary}`)
        .join("\n");

      newsSummary = `- 地政学リスクレベル: ${newsResult.analysis.geopoliticalRiskLevel}/5
- ${newsResult.analysis.geopoliticalSummary}
- 市場インパクト: ${newsResult.analysis.marketImpact}
- ${newsResult.analysis.marketImpactSummary}
- 主要イベント: ${newsResult.analysis.keyEvents}
- セクター別影響:
${sectorText || "  特になし"}`;

      console.log(
        `  ニュース再取得完了（新着: ${newsArticleCount}件, 地政学リスク: ${newsResult.analysis.geopoliticalRiskLevel}/5, 市場: ${newsResult.analysis.marketImpact}）`,
      );
    } else {
      console.log("  新着ニュースなし");
    }
  } catch (error) {
    console.error("  ニュース再取得エラー（スキップして続行）:", error);
  }

  // 4. セクターモメンタム再計算
  console.log("[4/6] セクターモメンタム再計算中...");
  let sectorContext: string | undefined;
  try {
    const nikkeiWeekChange = marketData.nikkei.changePercent;
    const sectorMomentum = await calculateSectorMomentum(nikkeiWeekChange);
    const weakSectors = sectorMomentum.filter((s) => s.isWeak);
    const strongSectors = sectorMomentum.filter((s) => s.isStrong);

    if (weakSectors.length > 0 || strongSectors.length > 0) {
      const parts: string[] = [];
      if (weakSectors.length > 0) {
        parts.push(
          `弱体化セクター: ${weakSectors.map((s) => `${s.sectorGroup}（日経比${s.relativeStrength.toFixed(1)}%）`).join(", ")}`,
        );
      }
      if (strongSectors.length > 0) {
        parts.push(
          `好調セクター: ${strongSectors.map((s) => `${s.sectorGroup}（日経比+${s.relativeStrength.toFixed(1)}%）`).join(", ")}`,
        );
      }
      sectorContext = parts.join("\n");
      console.log(`  ${sectorContext}`);
    } else {
      console.log("  セクター動向: 特筆すべき偏りなし");
    }
  } catch (error) {
    console.error("  セクターモメンタム計算エラー（スキップして続行）:", error);
  }

  // 5. AI再評価
  console.log("[5/6] AI再評価中...");
  const morningNikkeiPrice = assessment.nikkeiPrice
    ? Number(assessment.nikkeiPrice)
    : 0;
  const morningVix = assessment.vix
    ? Number(assessment.vix)
    : null;

  const currentVix = marketData.vix?.price ?? null;

  const result = await reassessMarketMidday({
    morningSentiment: assessment.sentiment,
    morningReasoning: assessment.reasoning,
    morningNikkeiPrice,
    morningVix,
    currentNikkeiPrice: marketData.nikkei.price,
    currentNikkeiChange: marketData.nikkei.changePercent,
    currentVix,
    currentSp500Change: marketData.sp500?.changePercent ?? 0,
    currentUsdJpy: marketData.usdjpy?.price ?? 0,
    newsSummary,
    sectorContext,
  });

  console.log(
    `  → AI再評価: ${result.sentiment}（朝: ${assessment.sentiment}）`,
  );

  // センチメント比較
  const morningSeverity = SENTIMENT_SEVERITY[assessment.sentiment] ?? 0;
  const middaySeverity = SENTIMENT_SEVERITY[result.sentiment] ?? 0;
  const sentimentWorsened = middaySeverity > morningSeverity;

  const updateData: Record<string, unknown> = {
    middaySentiment: result.sentiment,
    middayReasoning: result.reasoning,
    middayReassessedAt: new Date(),
    middayNikkeiPrice: marketData.nikkei.price,
    middayNikkeiChange: marketData.nikkei.changePercent,
    middayVix: marketData.vix?.price,
  };

  if (sentimentWorsened) {
    updateData.sentiment = result.sentiment;
    console.log(
      `  → センチメント悪化: ${assessment.sentiment} → ${result.sentiment}（主フィールドを更新）`,
    );

    // cautious悪化時: 戦略をday_tradeに強制切替
    if (result.sentiment === "cautious") {
      updateData.tradingStrategy = "day_trade";
      console.log(`  → cautious: 戦略をday_tradeに切替`);

      // 既存swingポジションをday_tradeに変換
      const converted = await prisma.tradingPosition.updateMany({
        where: { status: "open", strategy: "swing" },
        data: { strategy: "day_trade" },
      });
      if (converted.count > 0) {
        console.log(`  → cautious: ${converted.count}件のスイングポジションをday_tradeに切替`);
      }
    }
  } else {
    console.log(
      `  → センチメント維持: ${assessment.sentiment}（昼は${result.sentiment}だが悪化していないため維持）`,
    );
  }

  await prisma.marketAssessment.update({
    where: { date: getTodayForDB() },
    data: updateData,
  });

  // 6. 未約定注文キャンセル判定
  console.log("[6/6] 未約定注文キャンセル判定...");
  const effectiveSentiment = sentimentWorsened
    ? result.sentiment
    : assessment.sentiment;

  const pendingBuyOrders = await prisma.tradingOrder.findMany({
    where: {
      status: "pending",
      side: "buy",
    },
    include: { stock: true },
  });

  let cancelledCount = 0;
  const cancelledTickers: string[] = [];

  for (const order of pendingBuyOrders) {
    let shouldCancel = false;
    let cancelReason = "";

    if (order.strategy === "day_trade") {
      // デイトレ注文は12:15まで未約定ならエントリー窓を逸失
      shouldCancel = true;
      cancelReason =
        "昼休み時点で未約定のデイトレ注文（エントリー窓逸失）";
    } else if (
      order.strategy === "swing" &&
      DEFENSIVE_MODE.ENABLED_SENTIMENTS.includes(effectiveSentiment)
    ) {
      // bearish/crisis環境ではスイング新規買いもキャンセル
      shouldCancel = true;
      cancelReason = `${effectiveSentiment}環境でのスイング買い注文キャンセル`;
    } else if (
      order.strategy === "swing" &&
      effectiveSentiment === "cautious"
    ) {
      // cautious環境: swing注文はday_tradeパラメータと不整合のためキャンセル
      shouldCancel = true;
      cancelReason = "cautious環境でのスイング買い注文キャンセル（day_trade切替のため）";
    }

    if (shouldCancel) {
      await prisma.tradingOrder.update({
        where: { id: order.id },
        data: { status: "cancelled" },
      });
      cancelledCount++;
      cancelledTickers.push(order.stock.tickerCode);
      console.log(`  → ${order.stock.tickerCode}: ${cancelReason}`);
    }
  }

  // Slack通知
  if (sentimentWorsened) {
    await notifyRiskAlert({
      type: "昼休み再評価（悪化）",
      message: [
        `センチメント: ${assessment.sentiment} → ${result.sentiment}`,
        `理由: ${result.reasoning}`,
        newsArticleCount > 0
          ? `新着ニュース: ${newsArticleCount}件`
          : "",
        sectorContext ? `セクター動向: ${sectorContext}` : "",
        cancelledCount > 0
          ? `キャンセル注文: ${cancelledCount}件（${cancelledTickers.join(", ")}）`
          : "キャンセル対象注文なし",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  } else {
    await notifySlack({
      title: "昼休み再評価: 変更なし",
      message: [
        `朝のセンチメント: ${assessment.sentiment}（維持）`,
        `昼の評価: ${result.sentiment}`,
        `理由: ${result.reasoning}`,
        newsArticleCount > 0
          ? `新着ニュース: ${newsArticleCount}件`
          : "",
        sectorContext ? `セクター動向: ${sectorContext}` : "",
        cancelledCount > 0
          ? `キャンセル注文: ${cancelledCount}件（${cancelledTickers.join(", ")}）`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      color: cancelledCount > 0 ? "warning" : "good",
    });
  }

  console.log(
    `=== Midday Reassessment 終了（${sentimentWorsened ? "悪化→更新" : "維持"}、キャンセル: ${cancelledCount}件） ===`,
  );

}

const isDirectRun = process.argv[1]?.includes("midday-reassessment");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Midday Reassessment エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
