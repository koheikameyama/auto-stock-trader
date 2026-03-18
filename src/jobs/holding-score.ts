/**
 * 保有継続スコアリング
 *
 * オープンポジションの銘柄に対して日次スコアリングを実行し、
 * スコア悪化時にトレーリングストップの引き締めを適用する。
 * market-scanner のレジーム判定後に呼び出される（前日終値ベース + レジーム情報 → 当日のTS引き締めに反映）。
 */

import pLimit from "p-limit";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/date-utils";
import { fetchHistoricalData, fetchMarketData } from "../core/market-data";
import { analyzeTechnicals } from "../core/technical-analysis";
import { calculateSectorMomentum } from "../core/sector-analyzer";
import { getSectorGroup } from "../lib/constants";
import { getOpenPositions } from "../core/position-manager";
import { scoreHolding } from "../core/scoring/holding";
import { HOLDING_SCORE, SECTOR_MOMENTUM_SCORING } from "../lib/constants/scoring";
import { TRAILING_STOP } from "../lib/constants";
import { notifySlack, notifyRiskAlert } from "../lib/slack";
import type { HoldingScore, HoldingRank } from "../core/scoring/types";
import type { MarketRegime } from "../core/market-regime";

const limit = pLimit(HOLDING_SCORE.CONCURRENCY);

interface PositionScoreResult {
  positionId: string;
  tickerCode: string;
  score: HoldingScore;
  currentPrice: number;
  unrealizedPnlPct: number;
  holdingDays: number;
  previousScore: number | null;
}

export async function main(regime?: MarketRegime) {
  const regimeLevel = regime?.level ?? "normal";
  console.log(`=== Holding Score 開始 (レジーム: ${regimeLevel}) ===`);

  // 1. オープンポジション一括取得
  const positions = await getOpenPositions();
  if (positions.length === 0) {
    console.log("  オープンポジションなし → スキップ");
    return;
  }
  console.log(`  対象ポジション: ${positions.length}件`);

  // 2. セクターモメンタム一括計算
  let sectorMomentumMap: Map<
    string,
    { relativeStrength: number; stockCount: number }
  > = new Map();
  try {
    const marketData = await fetchMarketData();
    const nikkeiWeekChange = marketData.nikkei?.changePercent ?? 0;
    const sectorMomentum = await calculateSectorMomentum(nikkeiWeekChange);
    sectorMomentumMap = new Map(
      sectorMomentum.map((s) => [
        s.sectorGroup,
        { relativeStrength: s.relativeStrength, stockCount: s.stockCount },
      ]),
    );
  } catch (error) {
    console.warn("  セクターモメンタム取得失敗（ニュートラルで継続）:", error);
  }

  // 3. 前日スコア一括取得（急落検出用）
  const today = getTodayForDB();
  const previousScores = await prisma.holdingScoreRecord.findMany({
    where: {
      positionId: { in: positions.map((p) => p.id) },
      date: { lt: today },
    },
    orderBy: { date: "desc" },
    distinct: ["positionId"],
    select: { positionId: true, totalScore: true },
  });
  const prevScoreMap = new Map(
    previousScores.map((s) => [s.positionId, s.totalScore]),
  );

  // 4. 各ポジションを並列処理
  const results: PositionScoreResult[] = [];
  const tasks = positions.map((position) =>
    limit(async () => {
      try {
        const tickerCode = position.stock.tickerCode;

        // 株価データ取得
        const historical = await fetchHistoricalData(tickerCode);
        if (!historical || historical.length < 50) {
          console.warn(`  ${tickerCode}: 株価データ不足 → スキップ`);
          return;
        }

        // テクニカル分析
        const summary = analyzeTechnicals(historical);

        // セクター相対強度
        const sectorGroup = getSectorGroup(
          position.stock.jpxSectorName ?? "",
        );
        const sectorInfo = sectorGroup
          ? sectorMomentumMap.get(sectorGroup)
          : null;
        const sectorRelativeStrength =
          sectorInfo &&
          sectorInfo.stockCount >= SECTOR_MOMENTUM_SCORING.MIN_SECTOR_STOCK_COUNT
            ? sectorInfo.relativeStrength
            : null;

        // スコアリング
        const latestPrice = historical[0].close;
        const score = scoreHolding({
          historicalData: historical,
          latestPrice,
          latestVolume: historical[0].volume,
          weeklyVolatility: position.stock.volatility
            ? Number(position.stock.volatility)
            : null,
          nextEarningsDate: position.stock.nextEarningsDate,
          exDividendDate: position.stock.exDividendDate,
          avgVolume25: summary.volumeAnalysis.avgVolume20,
          summary,
          sectorRelativeStrength,
        });

        // 含み損益%
        const entryPrice = Number(position.entryPrice);
        const unrealizedPnlPct =
          ((latestPrice - entryPrice) / entryPrice) * 100;

        // 保有営業日数（createdAtから今日まで）
        const holdingDays = countBusinessDaysBetween(
          position.createdAt,
          new Date(),
        );

        results.push({
          positionId: position.id,
          tickerCode,
          score,
          currentPrice: latestPrice,
          unrealizedPnlPct,
          holdingDays,
          previousScore: prevScoreMap.get(position.id) ?? null,
        });

        console.log(
          `  ${tickerCode}: ${score.totalScore}/${HOLDING_SCORE.TOTAL_MAX} (${score.holdingRank})` +
            `  P&L: ${unrealizedPnlPct >= 0 ? "+" : ""}${unrealizedPnlPct.toFixed(2)}%` +
            `  ${score.alerts.length > 0 ? `⚠️ ${score.alerts.length}件` : ""}`,
        );
      } catch (error) {
        console.error(
          `  ${position.stock.tickerCode}: スコアリング失敗:`,
          error,
        );
      }
    }),
  );
  await Promise.all(tasks);

  if (results.length === 0) {
    console.log("  スコアリング結果なし");
    return;
  }

  // 5. DB保存（冪等性: deleteMany + createMany）
  await prisma.holdingScoreRecord.deleteMany({ where: { date: today } });
  await prisma.holdingScoreRecord.createMany({
    data: results.map((r) => ({
      date: today,
      positionId: r.positionId,
      tickerCode: r.tickerCode,
      totalScore: r.score.totalScore,
      holdingRank: r.score.holdingRank as string,
      trendQualityScore: r.score.trendQuality.total,
      riskQualityScore: r.score.riskQuality.total,
      sectorMomentumScore: r.score.sectorMomentumScore,
      trendQualityBreakdown: {
        maAlignment: r.score.trendQuality.maAlignment,
        weeklyTrend: r.score.trendQuality.weeklyTrend,
        trendContinuity: r.score.trendQuality.trendContinuity,
      } as Prisma.InputJsonValue,
      riskQualityBreakdown: {
        atrStability: r.score.riskQuality.atrStability,
        rangeContraction: r.score.riskQuality.rangeContraction,
        volumeStability: r.score.riskQuality.volumeStability,
      } as Prisma.InputJsonValue,
      gateResult: {
        passed: r.score.gate.passed,
        failedGate: r.score.gate.failedGate,
      } as Prisma.InputJsonValue,
      alerts:
        r.score.alerts.length > 0
          ? (r.score.alerts.map((a) => ({
              type: a.type,
              severity: a.severity,
              message: a.message,
            })) as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      currentPrice: r.currentPrice,
      unrealizedPnlPct: r.unrealizedPnlPct,
      holdingDays: r.holdingDays,
      actionTaken: getActionTaken(r.score.holdingRank),
    })),
  });

  // 6. アクション適用（holdingScoreTrailOverride）
  for (const r of results) {
    const trailOverride = computeTrailOverride(r.score.holdingRank, regimeLevel);
    await prisma.tradingPosition.update({
      where: { id: r.positionId },
      data: { holdingScoreTrailOverride: trailOverride },
    });
  }

  // 7. 急落検出
  const dropAlerts: PositionScoreResult[] = [];
  for (const r of results) {
    if (r.previousScore != null) {
      const drop = r.previousScore - r.score.totalScore;
      if (drop >= HOLDING_SCORE.ACTIONS.SCORE_DROP_ALERT_THRESHOLD) {
        dropAlerts.push(r);
      }
    }
  }

  // 8. Slack通知
  await sendSlackSummary(results, dropAlerts, regimeLevel);

  console.log("=== Holding Score 完了 ===");
}

/**
 * ランクに応じたTS引き締めアクションを返す
 */
function getActionTaken(rank: HoldingRank): string | null {
  switch (rank) {
    case "weakening":
    case "deteriorating":
    case "critical":
      return "ts_tightened";
    default:
      return null;
  }
}

/**
 * ランク + レジームに応じたトレーリングストップATR倍率を計算
 * position-monitor が読み取る実際のATR倍率値を返す
 *
 * ランク倍率とレジーム倍率の小さい方（より引き締める方）を採用:
 *   normal + healthy → null(2.0)  |  elevated + healthy → 1.7
 *   normal + weakening → 1.4      |  crisis + healthy → 1.0
 */
function computeTrailOverride(rank: HoldingRank, regimeLevel: string = "normal"): number | null {
  const normalTrail = TRAILING_STOP.TRAIL_ATR_MULTIPLIER.swing;

  // ランクベースの倍率
  let rankMultiplier: number;
  switch (rank) {
    case "weakening":
      rankMultiplier = HOLDING_SCORE.ACTIONS.TS_TIGHTEN_MULTIPLIER_WEAKENING;
      break;
    case "deteriorating":
    case "critical":
      rankMultiplier = HOLDING_SCORE.ACTIONS.TS_TIGHTEN_MULTIPLIER_DETERIORATING;
      break;
    default:
      rankMultiplier = 1.0; // strong/healthy
  }

  // レジームベースの倍率
  const regimeMultiplier = HOLDING_SCORE.REGIME_TS_MULTIPLIER[regimeLevel] ?? 1.0;

  // より引き締める方を採用
  const effectiveMultiplier = Math.min(rankMultiplier, regimeMultiplier);

  if (effectiveMultiplier >= 1.0) {
    return null; // 引き締め不要
  }
  return normalTrail * effectiveMultiplier;
}

/**
 * 2つの日付間の営業日数を数える（簡易版）
 */
function countBusinessDaysBetween(start: Date, end: Date): number {
  let count = 0;
  const current = new Date(start);
  while (current < end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }
  return count;
}

/**
 * Slack通知
 */
async function sendSlackSummary(
  results: PositionScoreResult[],
  dropAlerts: PositionScoreResult[],
  regimeLevel: string,
): Promise<void> {
  const lines: string[] = [];
  const regimeTag = regimeLevel !== "normal" ? ` [レジーム: ${regimeLevel}]` : "";
  lines.push(`📊 *保有継続スコアリング* （${results.length}銘柄）${regimeTag}`);
  lines.push("");

  for (const r of results) {
    const rankEmoji = getRankEmoji(r.score.holdingRank);
    const pnlSign = r.unrealizedPnlPct >= 0 ? "+" : "";
    const dropNote =
      r.previousScore != null
        ? ` (前日比: ${r.score.totalScore - r.previousScore >= 0 ? "+" : ""}${r.score.totalScore - r.previousScore})`
        : "";
    lines.push(
      `${rankEmoji} *${r.tickerCode}*: ${r.score.totalScore}/${HOLDING_SCORE.TOTAL_MAX} ${r.score.holdingRank}${dropNote}  P&L: ${pnlSign}${r.unrealizedPnlPct.toFixed(1)}%  (${r.holdingDays}日目)`,
    );

    if (r.score.alerts.length > 0) {
      for (const alert of r.score.alerts) {
        lines.push(`  ⚠️ ${alert.message}`);
      }
    }

    const override = computeTrailOverride(r.score.holdingRank, regimeLevel);
    if (override != null) {
      lines.push(
        `  → TS引き締め（ATR×${override.toFixed(1)}）`,
      );
    }
  }

  await notifySlack({
    title: "📊 保有継続スコアリング",
    message: lines.join("\n"),
  });

  // 急落アラート
  for (const r of dropAlerts) {
    await notifyRiskAlert({
      type: "スコア急落",
      message: `${r.tickerCode}: ${r.previousScore} → ${r.score.totalScore} (${r.previousScore! - r.score.totalScore}pt低下)`,
    });
  }

  // criticalアラート
  const criticals = results.filter((r) => r.score.holdingRank === "critical");
  for (const r of criticals) {
    await notifyRiskAlert({
      type: "保有スコア危機",
      message: `${r.tickerCode}: スコア ${r.score.totalScore}/${HOLDING_SCORE.TOTAL_MAX} (critical)\n${r.score.alerts.map((a) => a.message).join(", ")}`,
    });
  }
}

function getRankEmoji(rank: HoldingRank): string {
  switch (rank) {
    case "strong":
      return "🟢";
    case "healthy":
      return "🔵";
    case "weakening":
      return "🟡";
    case "deteriorating":
      return "🟠";
    case "critical":
      return "🔴";
  }
}
