/**
 * 米株 ETF 戦略の月次ヘルスチェック
 *
 * 月次第1土曜 11:00 JST に走り、ETF 戦略の劣化を検知して Slack 通知:
 *   - 直近30日の TradingPosition (us_etf, closed) を集計
 *   - PF, 累計 NetRet, MaxDD, 最終シグナル日からの経過日数
 *   - 警戒ライン超過なら ⚠️ / 🚨 通知
 *   - 補完戦略性質上、サンプル少/発火ゼロは正常 → info レベルで通知
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { notifySlack } from "../lib/slack";

const LOOKBACK_DAYS = 30;
const MIN_SAMPLE = 5;

// 警戒ライン
const PF_WARN = 1.0;
const NETRET_WARN_PCT = -5;
const MAXDD_WARN_PCT = 8; // 絶対値
const MAXDD_CRITICAL_PCT = 10;

interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pf: number | null;
  totalReturnPct: number;
  maxDDPct: number;
  avgWinPct: number;
  avgLossPct: number;
}

function computeMetrics(positions: { entryPrice: number; exitPrice: number; quantity: number }[]): Metrics {
  if (positions.length === 0) {
    return { trades: 0, wins: 0, losses: 0, winRate: 0, pf: null, totalReturnPct: 0, maxDDPct: 0, avgWinPct: 0, avgLossPct: 0 };
  }
  const pnlPcts = positions.map((p) => ((p.exitPrice - p.entryPrice) / p.entryPrice) * 100);
  const wins = pnlPcts.filter((p) => p > 0);
  const losses = pnlPcts.filter((p) => p < 0);
  const gp = wins.reduce((s, p) => s + p, 0);
  const gl = Math.abs(losses.reduce((s, p) => s + p, 0));
  const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
  const totalReturnPct = pnlPcts.reduce((s, p) => s + p, 0);

  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const p of pnlPcts) {
    cum += p;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }

  return {
    trades: positions.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / positions.length) * 100,
    pf,
    totalReturnPct,
    maxDDPct: dd,
    avgWinPct: wins.length > 0 ? gp / wins.length : 0,
    avgLossPct: losses.length > 0 ? -gl / losses.length : 0,
  };
}

async function main() {
  const cutoff = dayjs().subtract(LOOKBACK_DAYS, "day").toDate();

  const closedPositions = await prisma.tradingPosition.findMany({
    where: {
      strategy: "us_etf",
      status: "closed",
      exitedAt: { gte: cutoff },
    },
    select: { entryPrice: true, exitPrice: true, quantity: true },
  });

  const positions = closedPositions
    .filter((p) => p.exitPrice != null)
    .map((p) => ({
      entryPrice: Number(p.entryPrice),
      exitPrice: Number(p.exitPrice!),
      quantity: p.quantity,
    }));

  const metrics = computeMetrics(positions);

  // シグナル発火状況
  const lastSignal = await prisma.usEtfSignal.findFirst({
    orderBy: { detectedDate: "desc" },
    select: { detectedDate: true, ticker: true },
  });
  const daysSinceLastSignal = lastSignal
    ? dayjs().diff(dayjs(lastSignal.detectedDate), "day")
    : null;

  console.log(`[us-etf-health] 直近${LOOKBACK_DAYS}日: ${metrics.trades}件決済`);
  console.log(metrics);
  console.log(`最終シグナル: ${lastSignal ? `${dayjs(lastSignal.detectedDate).format("YYYY-MM-DD")} (${daysSinceLastSignal}日前)` : "なし"}`);

  // 警戒判定
  const warnings: string[] = [];
  let level: "info" | "warning" | "critical" = "info";

  if (metrics.trades >= MIN_SAMPLE) {
    if (metrics.pf != null && metrics.pf < PF_WARN) {
      warnings.push(`PF ${metrics.pf.toFixed(2)} < ${PF_WARN} → 戦略劣化の可能性`);
      level = "warning";
    }
    if (metrics.totalReturnPct < NETRET_WARN_PCT) {
      warnings.push(`累計リターン ${metrics.totalReturnPct.toFixed(2)}% < ${NETRET_WARN_PCT}% → 損失累積`);
      level = "warning";
    }
    if (metrics.maxDDPct > MAXDD_CRITICAL_PCT) {
      warnings.push(`MaxDD -${metrics.maxDDPct.toFixed(2)}% > ${MAXDD_CRITICAL_PCT}% → 即停止検討`);
      level = "critical";
    } else if (metrics.maxDDPct > MAXDD_WARN_PCT) {
      warnings.push(`MaxDD -${metrics.maxDDPct.toFixed(2)}% > ${MAXDD_WARN_PCT}% → 注意`);
      if (level === "info") level = "warning";
    }
  }

  // 90日連続発火ゼロは補完戦略の性質、警告ではない
  if (daysSinceLastSignal != null && daysSinceLastSignal >= 90) {
    warnings.push(`最終シグナル ${daysSinceLastSignal}日前 (補完戦略のため正常範囲)`);
  }

  // Slack 通知
  const emoji = level === "critical" ? "🚨" : level === "warning" ? "⚠️" : "📊";
  const color = level === "critical" ? "danger" : level === "warning" ? "warning" : "#439FE0";

  const pfStr = metrics.pf == null ? "N/A" : metrics.pf === Infinity ? "∞" : metrics.pf.toFixed(2);
  const signalLine = lastSignal
    ? `最終シグナル: ${dayjs(lastSignal.detectedDate).format("YYYY-MM-DD")} (${daysSinceLastSignal}日前)`
    : "最終シグナル: なし (運用開始後シグナル未発火)";

  const body = [
    `直近${LOOKBACK_DAYS}日のクローズド ETF ポジション:`,
    `  決済数: ${metrics.trades} (勝${metrics.wins} / 負${metrics.losses})`,
    metrics.trades > 0
      ? `  勝率: ${metrics.winRate.toFixed(1)}%, PF: ${pfStr}`
      : "",
    metrics.trades > 0
      ? `  累計リターン: ${metrics.totalReturnPct >= 0 ? "+" : ""}${metrics.totalReturnPct.toFixed(2)}%, MaxDD: -${metrics.maxDDPct.toFixed(2)}%`
      : "",
    metrics.trades < MIN_SAMPLE
      ? `  ※ サンプル数 < ${MIN_SAMPLE} → 統計判定保留 (補完戦略のため正常)`
      : "",
    "",
    signalLine,
    warnings.length > 0 ? "\n警告:\n" + warnings.map((w) => `  • ${w}`).join("\n") : "",
  ].filter(Boolean).join("\n");

  await notifySlack({
    title: `${emoji} 米株ETF ヘルスチェック (${dayjs().format("YYYY-MM-DD")})`,
    message: body,
    color,
  });
}

main().catch((e) => {
  console.error("us-etf-health-check failed:", e);
  process.exit(1);
});
