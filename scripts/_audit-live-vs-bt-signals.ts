/**
 * ライブ発注(15:24スナップショット判定) vs BT(確定終値判定) のシグナル一致監査
 *
 * 目的: 「15:24 に判定して引けで約定する」構造により、確定終値では条件を満たさない
 * エントリーがどれだけ混入しているかを実データで測る（使い捨て / 本番影響なし）。
 */
import { prisma } from "../src/lib/prisma";
import { fetchHistoricalFromDB, fetchIndexFromDB } from "../src/backtest/data-fetcher";
import { precomputeSimData } from "../src/backtest/breakout-simulation";
import { precomputeGapUpDailySignals } from "../src/backtest/gapup-simulation";
import { precomputePSCDailySignals } from "../src/backtest/post-surge-consolidation-simulation";
import { GAPUP_BACKTEST_DEFAULTS } from "../src/backtest/gapup-config";
import { PSC_BACKTEST_DEFAULTS, PSC_PRODUCTION_PARAMS } from "../src/backtest/post-surge-consolidation-config";
import { getMaxBuyablePrice } from "../src/core/risk-manager";
import { POST_SURGE_CONSOLIDATION } from "../src/lib/constants/post-surge-consolidation";
import { GAPUP } from "../src/lib/constants/gapup";
import { analyzeTechnicals, type OHLCVData } from "../src/core/technical-analysis";
import { TECHNICAL_MIN_DATA } from "../src/lib/constants";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

const START = "2026-04-01";
const END = "2026-07-31";
const BUDGET = 500_000;

type LiveOrder = {
  ticker: string;
  date: string;
  strategy: string;
  referencePrice: number | null;
  filledPrice: number;
  snapshot: Record<string, unknown> | null;
};

async function main() {
  const orders = await prisma.tradingOrder.findMany({
    where: { side: "buy", status: "filled", strategy: { in: ["gapup", "post-surge-consolidation"] } },
    include: { stock: { select: { tickerCode: true } } },
    orderBy: { createdAt: "asc" },
  });

  const live: LiveOrder[] = orders.map((o) => ({
    ticker: o.stock.tickerCode,
    date: dayjs(o.createdAt).tz("Asia/Tokyo").format("YYYY-MM-DD"),
    strategy: o.strategy,
    referencePrice: o.referencePrice ? Number(o.referencePrice) : null,
    filledPrice: Number(o.filledPrice),
    snapshot: o.entrySnapshot as Record<string, unknown> | null,
  }));

  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  const tickerCodes = stocks.map((s) => s.tickerCode);
  console.log(`[data] ${tickerCodes.length}銘柄ロード中...`);

  const rawData = await fetchHistoricalFromDB(tickerCodes, START, END);
  const indexData = await fetchIndexFromDB("^N225", START, END);

  const dynamicMaxPrice = getMaxBuyablePrice(BUDGET);
  const guConfig = { ...GAPUP_BACKTEST_DEFAULTS, startDate: START, endDate: END, initialBudget: BUDGET, maxPrice: dynamicMaxPrice };
  const pscConfig = { ...PSC_BACKTEST_DEFAULTS, startDate: START, endDate: END, initialBudget: BUDGET, maxPrice: dynamicMaxPrice, ...PSC_PRODUCTION_PARAMS };

  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= dynamicMaxPrice && b.close > 0)) allData.set(ticker, bars);
  }
  console.log(`[data] ${allData.size}銘柄（maxPrice ${dynamicMaxPrice}）, N225 ${indexData.size}日`);

  const precomputed = precomputeSimData(
    START, END, allData, true, true,
    guConfig.indexTrendSmaPeriod ?? 50,
    indexData.size > 0 ? indexData : undefined,
    false, 60,
    guConfig.indexTrendOffBufferPct ?? 0,
    guConfig.indexTrendOnBufferPct ?? 0,
  );

  const gapupSignals = precomputeGapUpDailySignals(guConfig, allData, precomputed);
  const pscSignals = precomputePSCDailySignals(pscConfig, allData, precomputed);

  // 不一致の原因を層別に切り分ける
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
    if (avgVolume25 < cfg.minAvgVolume25) return `avgVol不足 ${Math.round(avgVolume25).toLocaleString()} < ${cfg.minAvgVolume25.toLocaleString()}`;
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

    // 共通: 陽線
    parts.push(`陽線 ${b.close > b.open ? "○" : "×"}(O${b.open}/C${b.close})`);

    // BT と同じ avgVolume（analyzeTechnicals の avgVolume20）を使う
    const window = bars.slice(Math.max(0, idx + 1 - 80), idx + 1);
    const summary = analyzeTechnicals([...window].reverse());
    const avgVol20 = summary.volumeAnalysis.avgVolume20 ?? 0;
    const volRatio = avgVol20 > 0 ? b.volume / avgVol20 : 0;

    if (o.strategy === "post-surge-consolidation") {
      const b20 = bars[idx - POST_SURGE_CONSOLIDATION.ENTRY.MOMENTUM_LOOKBACK_DAYS];
      const mom = b20 ? b.close / b20.close - 1 : NaN;
      const high20 = Math.max(...bars.slice(Math.max(0, idx - 19), idx + 1).map((x) => x.high));
      parts.push(`mom ${(mom * 100).toFixed(1)}% ${mom >= POST_SURGE_CONSOLIDATION.ENTRY.MOMENTUM_MIN_RETURN ? "○" : "×"}`);
      parts.push(`高値圏 ${((b.close / high20 - 1) * 100).toFixed(1)}% ${b.close >= high20 * (1 - POST_SURGE_CONSOLIDATION.ENTRY.MAX_HIGH_DISTANCE_PCT) ? "○" : "×"}`);
      parts.push(`vol ${volRatio.toFixed(2)}x ${volRatio >= POST_SURGE_CONSOLIDATION.ENTRY.VOL_SURGE_RATIO ? "○" : "×"}`);
    } else {
      const prev = bars[idx - 1];
      const gap = prev ? b.open / prev.close - 1 : NaN;
      const closeGap = prev ? b.close / prev.close - 1 : NaN;
      const eff = volRatio >= GAPUP.ENTRY.GAP_RELAX_VOL_THRESHOLD ? GAPUP.ENTRY.GAP_MIN_PCT_RELAXED : GAPUP.ENTRY.GAP_MIN_PCT;
      parts.push(`gap(始) ${(gap * 100).toFixed(1)}% ${gap > eff ? "○" : "×"}`);
      parts.push(`gap(終) ${(closeGap * 100).toFixed(1)}% ${closeGap > eff ? "○" : "×"}`);
      parts.push(`vol ${volRatio.toFixed(2)}x ${volRatio >= GAPUP.ENTRY.VOL_SURGE_RATIO ? "○" : "×"}`);
    }
    return parts.join(" / ");
  }

  console.log("\n================ ライブ発注 vs BT シグナル ================");
  let match = 0;
  const mismatches: LiveOrder[] = [];
  const causeCount = new Map<string, number>();
  const bump = (k: string) => causeCount.set(k, (causeCount.get(k) ?? 0) + 1);

  for (const o of live) {
    const set = o.strategy === "gapup" ? gapupSignals.get(o.date) : pscSignals.get(o.date);
    const hit = set?.some((s) => s.ticker === o.ticker) ?? false;
    if (hit) match++;
    else mismatches.push(o);

    const drift =
      o.referencePrice != null ? ((o.filledPrice / o.referencePrice - 1) * 100).toFixed(2) + "%" : "-";

    let detail = "";
    if (!hit) {
      // 層別: ①日次マーケットフィルター ②ユニバースゲート ③シグナル条件
      const dayReason = dayFilterReason(o.date);
      const uniReason = universeReason(o);
      if (dayReason) {
        bump("①日次マーケットフィルター");
        detail = `[①日次フィルター] ${dayReason}`;
      } else if (uniReason) {
        bump("②ユニバースゲート");
        detail = `[②ユニバース] ${uniReason}`;
      } else {
        bump("③シグナル条件");
        detail = `[③シグナル条件] ${conditionBreakdown(o)}`;
      }
    }

    console.log(
      `${hit ? "✅" : "❌"} ${o.date} ${o.ticker.padEnd(8)} ${o.strategy === "gapup" ? "GU " : "PSC"} ` +
      `15:24 ¥${o.referencePrice ?? "-"} → 引け ¥${o.filledPrice} (${drift})` +
      (hit ? "" : `\n      → ${detail}`),
    );
  }

  console.log(`\n一致 ${match}/${live.length} (${((match / live.length) * 100).toFixed(1)}%) / 不一致 ${mismatches.length}件`);
  console.log("不一致の原因内訳:");
  for (const [k, v] of [...causeCount].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}件`);

  // 戦略別
  for (const st of ["gapup", "post-surge-consolidation"]) {
    const sub = live.filter((o) => o.strategy === st);
    const bad = mismatches.filter((o) => o.strategy === st);
    if (sub.length) console.log(`  ${st}: 不一致 ${bad.length}/${sub.length} (${((bad.length / sub.length) * 100).toFixed(1)}%)`);
  }

  // 「BTでは出たがライブは取らなかった」側（枠・順位・cooldownの影響なので参考値）
  let btOnlyDays = 0;
  const liveByDate = new Map<string, Set<string>>();
  for (const o of live) {
    if (!liveByDate.has(o.date)) liveByDate.set(o.date, new Set());
    liveByDate.get(o.date)!.add(o.ticker);
  }
  for (const [date, sigs] of pscSignals) {
    if (date < "2026-04-17") continue;
    const taken = liveByDate.get(date);
    if (sigs.length && (!taken || !sigs.some((s) => taken.has(s.ticker)))) btOnlyDays++;
  }
  console.log(`\n(参考) PSC: BTシグナルがあったがライブが1件も取らなかった日 ${btOnlyDays}日`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
