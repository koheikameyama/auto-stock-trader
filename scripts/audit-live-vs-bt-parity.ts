/**
 * live↔BT パリティ監査 (月次定常運用版)
 *
 * 直近の本番約定済み買い注文を BT の precompute (確定終値ベースのシグナル判定) に
 * 通し、「本番が取ったエントリーを BT も出していたか」の一致率を測る。
 *
 * 背景: 2026-08-03 の使い捨て監査 (`_audit-live-vs-bt-signals.ts`) が一致 12/39 (30.8%)
 * を検出し、N225 SMA50 フィルターが本番だけ4ヶ月外れていた乖離 (Calmar -66% 相当) を
 * 発見した。この種の乖離は静かに再発するため、月次ヘルスチェックに常設する (KOH-606)。
 *
 * 不一致は3層に切り分ける:
 *   ①日次マーケットフィルター (breadth band / N225 SMA50) — SMA50型の系統的乖離
 *   ②ユニバースゲート (maxPrice / avgVolume / ATR% / 売買代金) — minAvgVolume型の乖離
 *   ③シグナル条件 (gap / vol / 陽線) — 15:24スナップショットと確定終値の差。少数は正常
 *
 * ①②は件数に関わらず系統的乖離の疑いとして扱う (severity 判定は Python 側)。
 *
 * Usage:
 *   npx tsx scripts/audit-live-vs-bt-parity.ts [--days 40] [--json parity-audit.json]
 */
import { prisma } from "../src/lib/prisma";
import { fetchHistoricalFromDB, fetchIndexFromDB } from "../src/backtest/data-fetcher";
import { precomputeSimData } from "../src/backtest/breakout-simulation";
import { precomputeGapUpDailySignals } from "../src/backtest/gapup-simulation";
import { precomputePSCDailySignals } from "../src/backtest/post-surge-consolidation-simulation";
import { GAPUP_BACKTEST_DEFAULTS } from "../src/backtest/gapup-config";
import {
  PSC_BACKTEST_DEFAULTS,
  PSC_PRODUCTION_PARAMS,
} from "../src/backtest/post-surge-consolidation-config";
import { getMaxBuyablePrice } from "../src/core/risk-manager";
import { STRATEGY_UNIVERSE_MAX_PRICE } from "../src/lib/constants/trading";
import { POST_SURGE_CONSOLIDATION } from "../src/lib/constants/post-surge-consolidation";
import { GAPUP } from "../src/lib/constants/gapup";
import { analyzeTechnicals, type OHLCVData } from "../src/core/technical-analysis";
import { TECHNICAL_MIN_DATA } from "../src/lib/constants";
import { writeFileSync } from "node:fs";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

// ウォームアップ: universeゲートの80本窓 + N225 SMA50 を確保する暦日バッファ
const WARMUP_CALENDAR_DAYS = 220;
// 閾値の較正元と同じ現運用規模 (maxPrice は STRATEGY_UNIVERSE_MAX_PRICE でどのみちキャップされる)
const BUDGET = 500_000;

const CAUSE_DAY_FILTER = "①日次マーケットフィルター";
const CAUSE_UNIVERSE = "②ユニバースゲート";
const CAUSE_SIGNAL = "③シグナル条件";

type LiveOrder = {
  ticker: string;
  date: string;
  strategy: string;
  referencePrice: number | null;
  filledPrice: number;
};

type AuditedOrder = LiveOrder & {
  hit: boolean;
  cause: string | null;
  detail: string | null;
  driftPct: number | null;
};

function parseArgs(): { days: number; jsonPath: string | null } {
  const args = process.argv.slice(2);
  let days = 40;
  let jsonPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days") days = Number(args[++i]);
    else if (args[i] === "--json") jsonPath = args[++i];
  }
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--days が不正: ${days}`);
  return { days, jsonPath };
}

async function main() {
  const { days, jsonPath } = parseArgs();

  const todayJst = dayjs().tz("Asia/Tokyo");
  const auditEnd = todayJst.format("YYYY-MM-DD");
  const auditStart = todayJst.subtract(days, "day").format("YYYY-MM-DD");
  const dataStart = todayJst
    .subtract(days + WARMUP_CALENDAR_DAYS, "day")
    .format("YYYY-MM-DD");

  console.log(`[parity] 監査窓: ${auditStart} 〜 ${auditEnd} (データ取得は ${dataStart} から)`);

  const orders = await prisma.tradingOrder.findMany({
    where: {
      side: "buy",
      status: "filled",
      strategy: { in: ["gapup", "post-surge-consolidation"] },
      createdAt: { gte: dayjs.tz(`${auditStart} 00:00`, "Asia/Tokyo").toDate() },
    },
    include: { stock: { select: { tickerCode: true } } },
    orderBy: { createdAt: "asc" },
  });

  const live: LiveOrder[] = orders.map((o) => ({
    ticker: o.stock.tickerCode,
    date: dayjs(o.createdAt).tz("Asia/Tokyo").format("YYYY-MM-DD"),
    strategy: o.strategy,
    referencePrice: o.referencePrice ? Number(o.referencePrice) : null,
    filledPrice: Number(o.filledPrice),
  }));

  const result = {
    auditStart,
    auditEnd,
    generatedAt: todayJst.format(),
    total: live.length,
    match: 0,
    matchRate: null as number | null,
    causes: {} as Record<string, number>,
    orders: [] as AuditedOrder[],
  };

  if (live.length === 0) {
    console.log("[parity] 監査窓に約定済み買い注文なし (エントリーゼロの月は正常)");
    if (jsonPath) writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    await prisma.$disconnect();
    return;
  }

  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  const tickerCodes = stocks.map((s) => s.tickerCode);
  console.log(`[data] ${tickerCodes.length}銘柄ロード中...`);

  const rawData = await fetchHistoricalFromDB(tickerCodes, dataStart, auditEnd);
  const indexData = await fetchIndexFromDB("^N225", dataStart, auditEnd);

  // 本番の gu-watchlist-builder と同じ min(動的上限, ¥2,500) キャップ (KOH-503)
  const dynamicMaxPrice = Math.min(getMaxBuyablePrice(BUDGET), STRATEGY_UNIVERSE_MAX_PRICE);
  const guConfig = {
    ...GAPUP_BACKTEST_DEFAULTS,
    startDate: dataStart,
    endDate: auditEnd,
    initialBudget: BUDGET,
    maxPrice: dynamicMaxPrice,
  };
  const pscConfig = {
    ...PSC_BACKTEST_DEFAULTS,
    startDate: dataStart,
    endDate: auditEnd,
    initialBudget: BUDGET,
    maxPrice: dynamicMaxPrice,
    ...PSC_PRODUCTION_PARAMS,
  };

  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= dynamicMaxPrice && b.close > 0)) allData.set(ticker, bars);
  }
  console.log(`[data] ${allData.size}銘柄（maxPrice ${dynamicMaxPrice}）, N225 ${indexData.size}日`);

  const precomputed = precomputeSimData(
    dataStart,
    auditEnd,
    allData,
    true,
    true,
    guConfig.indexTrendSmaPeriod ?? 50,
    indexData.size > 0 ? indexData : undefined,
    false,
    60,
    guConfig.indexTrendOffBufferPct ?? 0,
    guConfig.indexTrendOnBufferPct ?? 0,
  );

  const gapupSignals = precomputeGapUpDailySignals(guConfig, allData, precomputed);
  const pscSignals = precomputePSCDailySignals(pscConfig, allData, precomputed);

  const dateIndexMap = precomputed.dateIndexMap;
  const BREADTH_LO = pscConfig.marketTrendThreshold ?? 0.5;
  const BREADTH_HI = pscConfig.marketTrendUpperCap;

  /** 日次のマーケットフィルター（BT側）を評価。null=通過、文字列=棄却理由 */
  function dayFilterReason(date: string): string | null {
    const b = precomputed.dailyBreadth.get(date) ?? 0;
    if (b < BREADTH_LO) return `BT breadth ${(b * 100).toFixed(1)}% < ${(BREADTH_LO * 100).toFixed(0)}%`;
    if (BREADTH_HI != null && b > BREADTH_HI) return `BT breadth ${(b * 100).toFixed(1)}% > 上限`;
    if (!precomputed.dailyIndexAboveSma.get(date)) return "BT N225 < SMA50";
    return null;
  }

  /** ユニバースゲート（BT側）を評価。null=通過、文字列=棄却理由 */
  function universeReason(o: LiveOrder): string | null {
    const bars = allData.get(o.ticker);
    const idx = dateIndexMap.get(o.ticker)?.get(o.date);
    if (!bars || idx == null) return null;
    const window = bars.slice(Math.max(0, idx + 1 - 80), idx + 1);
    if (window.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) return `bar不足 ${window.length}本`;
    const summary = analyzeTechnicals([...window].reverse());
    if (summary.atr14 == null) return "atr14 null";
    const avgVolume25 = summary.volumeAnalysis.avgVolume20;
    if (avgVolume25 == null) return "avgVolume null";
    const b = bars[idx];
    const atrPct = (summary.atr14 / b.close) * 100;
    const cfg = o.strategy === "gapup" ? guConfig : pscConfig;
    if (b.close > cfg.maxPrice) return `maxPrice超 ¥${b.close} > ¥${cfg.maxPrice}`;
    if (avgVolume25 < cfg.minAvgVolume25)
      return `avgVol不足 ${Math.round(avgVolume25).toLocaleString()} < ${cfg.minAvgVolume25.toLocaleString()}`;
    if (atrPct < cfg.minAtrPct) return `ATR%不足 ${atrPct.toFixed(2)}% < ${cfg.minAtrPct}%`;
    if (cfg.minTurnover && b.close * avgVolume25 < cfg.minTurnover) return "売買代金不足";
    if (cfg.minPrice && b.close < cfg.minPrice) return "minPrice未満";
    return null;
  }

  function conditionBreakdown(o: LiveOrder): string {
    const bars = allData.get(o.ticker);
    const idx = dateIndexMap.get(o.ticker)?.get(o.date);
    if (!bars || idx == null) return "bar欠損";
    const b = bars[idx];
    const parts: string[] = [];

    parts.push(`陽線 ${b.close > b.open ? "○" : "×"}(O${b.open}/C${b.close})`);

    const window = bars.slice(Math.max(0, idx + 1 - 80), idx + 1);
    const summary = analyzeTechnicals([...window].reverse());
    const avgVol20 = summary.volumeAnalysis.avgVolume20 ?? 0;
    const volRatio = avgVol20 > 0 ? b.volume / avgVol20 : 0;

    if (o.strategy === "post-surge-consolidation") {
      const b20 = bars[idx - POST_SURGE_CONSOLIDATION.ENTRY.MOMENTUM_LOOKBACK_DAYS];
      const mom = b20 ? b.close / b20.close - 1 : NaN;
      const high20 = Math.max(...bars.slice(Math.max(0, idx - 19), idx + 1).map((x) => x.high));
      parts.push(`mom ${(mom * 100).toFixed(1)}% ${mom >= POST_SURGE_CONSOLIDATION.ENTRY.MOMENTUM_MIN_RETURN ? "○" : "×"}`);
      parts.push(
        `高値圏 ${((b.close / high20 - 1) * 100).toFixed(1)}% ${b.close >= high20 * (1 - POST_SURGE_CONSOLIDATION.ENTRY.MAX_HIGH_DISTANCE_PCT) ? "○" : "×"}`,
      );
      parts.push(`vol ${volRatio.toFixed(2)}x ${volRatio >= POST_SURGE_CONSOLIDATION.ENTRY.VOL_SURGE_RATIO ? "○" : "×"}`);
    } else {
      const prev = bars[idx - 1];
      const gap = prev ? b.open / prev.close - 1 : NaN;
      const closeGap = prev ? b.close / prev.close - 1 : NaN;
      const eff =
        volRatio >= GAPUP.ENTRY.GAP_RELAX_VOL_THRESHOLD
          ? GAPUP.ENTRY.GAP_MIN_PCT_RELAXED
          : GAPUP.ENTRY.GAP_MIN_PCT;
      parts.push(`gap(始) ${(gap * 100).toFixed(1)}% ${gap > eff ? "○" : "×"}`);
      parts.push(`gap(終) ${(closeGap * 100).toFixed(1)}% ${closeGap > eff ? "○" : "×"}`);
      parts.push(`vol ${volRatio.toFixed(2)}x ${volRatio >= GAPUP.ENTRY.VOL_SURGE_RATIO ? "○" : "×"}`);
    }
    return parts.join(" / ");
  }

  console.log("\n================ ライブ発注 vs BT シグナル ================");
  const bump = (k: string) => {
    result.causes[k] = (result.causes[k] ?? 0) + 1;
  };

  for (const o of live) {
    const set = o.strategy === "gapup" ? gapupSignals.get(o.date) : pscSignals.get(o.date);
    const hit = set?.some((s) => s.ticker === o.ticker) ?? false;
    if (hit) result.match++;

    let cause: string | null = null;
    let detail: string | null = null;
    if (!hit) {
      const dayReason = dayFilterReason(o.date);
      const uniReason = universeReason(o);
      if (dayReason) {
        cause = CAUSE_DAY_FILTER;
        detail = dayReason;
      } else if (uniReason) {
        cause = CAUSE_UNIVERSE;
        detail = uniReason;
      } else {
        cause = CAUSE_SIGNAL;
        detail = conditionBreakdown(o);
      }
      bump(cause);
    }

    const driftPct =
      o.referencePrice != null && o.referencePrice > 0
        ? Number(((o.filledPrice / o.referencePrice - 1) * 100).toFixed(2))
        : null;

    result.orders.push({ ...o, hit, cause, detail, driftPct });

    console.log(
      `${hit ? "✅" : "❌"} ${o.date} ${o.ticker.padEnd(8)} ${o.strategy === "gapup" ? "GU " : "PSC"} ` +
        `15:24 ¥${o.referencePrice ?? "-"} → 引け ¥${o.filledPrice} (${driftPct != null ? `${driftPct}%` : "-"})` +
        (hit ? "" : `\n      → [${cause}] ${detail}`),
    );
  }

  result.matchRate = Number(((result.match / result.total) * 100).toFixed(1));
  console.log(`\n一致 ${result.match}/${result.total} (${result.matchRate}%)`);
  if (Object.keys(result.causes).length > 0) {
    console.log("不一致の原因内訳:");
    for (const [k, v] of Object.entries(result.causes).sort((a, b) => b[1] - a[1]))
      console.log(`  ${k}: ${v}件`);
  }

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    console.log(`[parity] JSON出力: ${jsonPath}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
