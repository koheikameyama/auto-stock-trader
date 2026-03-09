/**
 * 昼休み再評価（12:15 JST / 平日）
 *
 * 1. 今日のMarketAssessmentを取得
 * 2. 市場指標データを再取得（前場終了時点）
 * 3. AIで再評価
 * 4. センチメント悪化判定（sentinel: 悪化方向のみ適用）
 * 5. 悪化時 → MarketAssessment.sentiment を更新（→ position-monitorのディフェンシブモードが自動発動）
 * 6. 未約定買い注文のキャンセル判定
 * 7. Slack通知
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/date-utils";
import { DEFENSIVE_MODE } from "../lib/constants";
import { fetchMarketData } from "../core/market-data";
import { reassessMarketMidday } from "../core/ai-decision";
import { notifySlack, notifyRiskAlert } from "../lib/slack";

/** センチメントの深刻度（大きいほど悪い） */
const SENTIMENT_SEVERITY: Record<string, number> = {
  bullish: 0,
  neutral: 1,
  bearish: 2,
  crisis: 3,
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
  console.log("[1/4] 市場指標データ再取得中...");
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

  // 3. AI再評価
  console.log("[2/4] AI再評価中...");
  const morningNikkeiPrice = assessment.nikkeiPrice
    ? Number(assessment.nikkeiPrice)
    : 0;
  const morningVix = assessment.vix ? Number(assessment.vix) : 0;

  const result = await reassessMarketMidday({
    morningSentiment: assessment.sentiment,
    morningReasoning: assessment.reasoning,
    morningNikkeiPrice,
    morningVix,
    currentNikkeiPrice: marketData.nikkei.price,
    currentNikkeiChange: marketData.nikkei.changePercent,
    currentVix: marketData.vix.price,
    currentSp500Change: marketData.sp500?.changePercent ?? 0,
    currentUsdJpy: marketData.usdjpy?.price ?? 0,
  });

  console.log(
    `  → AI再評価: ${result.sentiment}（朝: ${assessment.sentiment}）`,
  );

  // 4. Sentinel判定: 悪化方向のみ適用
  console.log("[3/4] センチメント比較...");
  const morningSeverity = SENTIMENT_SEVERITY[assessment.sentiment] ?? 0;
  const middaySeverity = SENTIMENT_SEVERITY[result.sentiment] ?? 0;
  const sentimentWorsened = middaySeverity > morningSeverity;

  const updateData: Record<string, unknown> = {
    middaySentiment: result.sentiment,
    middayReasoning: result.reasoning,
    middayReassessedAt: new Date(),
    middayNikkeiPrice: marketData.nikkei.price,
    middayNikkeiChange: marketData.nikkei.changePercent,
    middayVix: marketData.vix.price,
  };

  if (sentimentWorsened) {
    updateData.sentiment = result.sentiment;
    console.log(
      `  → センチメント悪化: ${assessment.sentiment} → ${result.sentiment}（主フィールドを更新）`,
    );
  } else {
    console.log(
      `  → センチメント維持: ${assessment.sentiment}（昼は${result.sentiment}だが悪化していないため維持）`,
    );
  }

  await prisma.marketAssessment.update({
    where: { date: getTodayForDB() },
    data: updateData,
  });

  // 5. 未約定注文キャンセル判定
  console.log("[4/4] 未約定注文キャンセル判定...");
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

  // 6. Slack通知
  if (sentimentWorsened) {
    await notifyRiskAlert({
      type: "昼休み再評価（悪化）",
      message: [
        `センチメント: ${assessment.sentiment} → ${result.sentiment}`,
        `理由: ${result.reasoning}`,
        cancelledCount > 0
          ? `キャンセル注文: ${cancelledCount}件（${cancelledTickers.join(", ")}）`
          : "キャンセル対象注文なし",
      ].join("\n"),
    });
  } else {
    await notifySlack({
      title: "昼休み再評価: 変更なし",
      message: [
        `朝のセンチメント: ${assessment.sentiment}（維持）`,
        `昼の評価: ${result.sentiment}`,
        `理由: ${result.reasoning}`,
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
