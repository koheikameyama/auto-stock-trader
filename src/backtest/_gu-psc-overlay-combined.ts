/**
 * 使い捨て検証: PSC 条件を GU の「エントリーフィルター」として combined に乗せる
 * (KOH-601 / 却下#59 角度C の本測定)
 *
 * `_gu-psc-overlay-study.ts` のトレード層別で、GU の中で
 *   ② 20日高値の -5% 圏内（GU銘柄では実質「その日の高値近くで引けたか」）
 * が 勝率 48.3% vs 31.6% と一貫した差を見せた。ただし除外候補は
 * **期待値 +0.14% ≒ ゼロで、平均勝ちはむしろ高い（+8.69% vs +7.96%）= 宝くじ**。
 * 却下#55（上がりすぎveto）が「平均ゼロ近辺の領域を切ると右裾も一緒に捨て、
 * MaxDD は下がるが NetRet が削られて Calmar は悪化する」と実測した形と同じなので、
 * トレード層別では採否を決められない。ポートフォリオに乗せて測る。
 *
 * ★エンジン改変なし: precompute した GU シグナルのマップをフィルタしてから
 *   runCombinedSimulation に渡すだけ。エントリーフィルターと数学的に等価で、
 *   baseline アームは無フィルタなので完全不変（検算として KOH-600 の記録と突き合わせる）。
 *
 * アーム: baseline / ②のみ / ①+②（PSC条件フル）
 * 窓: fullcycle + 年代別3期（却下#57 と同じ3分割。各窓を独立に precompute して
 *     KOH-600 記録の baseline と比較できるようにする）
 * 判定: Calmar =（NetRet ÷ 年数）÷ MaxDD（本ファイル群の一貫した定義）。
 *       NetRet 単独では見ない（却下#46 の教訓）。
 *
 * 実行: npx tsx src/backtest/_gu-psc-overlay-combined.ts
 */
import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { GAPUP_BACKTEST_DEFAULTS } from "./gapup-config";
import { PSC_BACKTEST_DEFAULTS, PSC_PRODUCTION_PARAMS } from "./post-surge-consolidation-config";
import { getMaxBuyablePrice } from "../core/risk-manager";
import { precomputeSimData } from "./breakout-simulation";
import { precomputeGapUpDailySignals, type PrecomputedGapUpSignals } from "./gapup-simulation";
import { precomputePSCDailySignals } from "./post-surge-consolidation-simulation";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "./data-fetcher";
import { runCombinedSimulation, type PositionLimits } from "./combined-simulation";
import { calculateCapitalUtilization } from "./metrics";
import { POST_SURGE_CONSOLIDATION } from "../lib/constants/post-surge-consolidation";
import type { OHLCVData } from "../core/technical-analysis";
import type { GapUpBacktestConfig, PostSurgeConsolidationBacktestConfig } from "./types";

const LOOKBACK = POST_SURGE_CONSOLIDATION.ENTRY.MOMENTUM_LOOKBACK_DAYS; // 20
const MOM_MIN = POST_SURGE_CONSOLIDATION.ENTRY.MOMENTUM_MIN_RETURN;     // 0.15
const HIGH_DIST = POST_SURGE_CONSOLIDATION.ENTRY.MAX_HIGH_DISTANCE_PCT; // 0.05

const WINDOWS: { label: string; start: string; end: string }[] = [
  { label: "fullcycle 2018-04〜2026-07", start: "2018-04-01", end: "2026-07-31" },
  { label: "era1 2018-04〜2020-12", start: "2018-04-01", end: "2020-12-31" },
  { label: "era2 2021-01〜2023-12", start: "2021-01-01", end: "2023-12-31" },
  { label: "era3 2024-01〜2026-07", start: "2024-01-01", end: "2026-07-31" },
];

type ArmKey = "baseline" | "high20" | "pscFull";
const ARMS: { key: ArmKey; label: string }[] = [
  { key: "baseline", label: "★baseline (GU3単独)" },
  { key: "high20", label: "+②高値-5%圏内のみ" },
  { key: "pscFull", label: "+①+②(PSC条件フル)" },
];

function getArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const budget = Number(getArg(args, "--budget") ?? "500000");
  const maxPrice = Number(getArg(args, "--max-price") ?? getMaxBuyablePrice(budget));
  const onlyWindow = getArg(args, "--window");

  console.log("=".repeat(120));
  console.log("PSC条件を GU のエントリーフィルターとして combined に乗せる（角度C 本測定）");
  console.log("=".repeat(120));
  console.log(`予算: ¥${budget.toLocaleString()}  maxPrice: ¥${maxPrice.toLocaleString()}`);

  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  const tickerCodes = stocks.map((s) => s.tickerCode);

  const windows = onlyWindow ? WINDOWS.filter((w) => w.label.includes(onlyWindow)) : WINDOWS;
  const summary: { window: string; arm: string; trades: number; pf: number; maxDd: number; netRet: number; calmar: number; util: number }[] = [];

  for (const win of windows) {
    const { label, start: startDate, end: endDate } = win;
    console.log("\n" + "=".repeat(120));
    console.log(`■ ${label}`);
    console.log("=".repeat(120));

    const guConfig: GapUpBacktestConfig = {
      ...GAPUP_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, maxPrice, verbose: false,
    };
    const pscConfigUngated: PostSurgeConsolidationBacktestConfig = {
      ...PSC_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, maxPrice, verbose: false,
      ...PSC_PRODUCTION_PARAMS, marketTrendFilter: false, indexTrendFilter: false,
    };

    const rawData = await fetchHistoricalFromDB(tickerCodes, startDate, endDate);
    const vixData = await fetchVixFromDB(startDate, endDate);
    const indexData = await fetchIndexFromDB("^N225", startDate, endDate);
    const allData = new Map<string, OHLCVData[]>();
    for (const [ticker, bars] of rawData) {
      if (bars.some((b) => b.close <= maxPrice && b.close > 0)) allData.set(ticker, bars);
    }

    const precomputed = precomputeSimData(
      startDate, endDate, allData, true, true,
      guConfig.indexTrendSmaPeriod ?? 50,
      indexData.size > 0 ? indexData : undefined,
      false, 60,
      guConfig.indexTrendOffBufferPct ?? 0, guConfig.indexTrendOnBufferPct ?? 0,
    );
    const gapupSignals = precomputeGapUpDailySignals(guConfig, allData, precomputed);
    const pscSignalsUngated = precomputePSCDailySignals(pscConfigUngated, allData, precomputed);
    console.log(`[data] ${allData.size}銘柄 / 営業日 ${precomputed.tradingDays.length}日`);

    const pscByDay = new Map<string, Set<string>>();
    for (const [day, sigs] of pscSignalsUngated) pscByDay.set(day, new Set(sigs.map((s) => s.ticker)));

    const { dateIndexMap } = precomputed;
    /** entryDate 終値時点で既知の 20日高値距離（先読みなし） */
    function nearHigh20(ticker: string, date: string): boolean {
      const bars = allData.get(ticker);
      const idx = dateIndexMap.get(ticker)?.get(date);
      if (!bars || idx == null) return false;
      const recent = bars.slice(Math.max(0, idx - 19), idx + 1);
      const high20 = Math.max(...recent.map((b) => b.high));
      const c = bars[idx]?.close;
      if (!high20 || !c) return false;
      return (high20 - c) / high20 <= HIGH_DIST;
    }
    function momOk(ticker: string, date: string): boolean {
      const bars = allData.get(ticker);
      const idx = dateIndexMap.get(ticker)?.get(date);
      if (!bars || idx == null || idx < LOOKBACK) return false;
      const c0 = bars[idx - LOOKBACK]?.close;
      const c = bars[idx]?.close;
      if (!c0 || !c || c0 <= 0) return false;
      return c / c0 - 1 >= MOM_MIN;
    }

    function filterSignals(arm: ArmKey): PrecomputedGapUpSignals {
      if (arm === "baseline") return gapupSignals;
      const out: PrecomputedGapUpSignals = new Map();
      for (const [day, sigs] of gapupSignals) {
        const kept = sigs.filter((s) =>
          arm === "high20"
            ? nearHigh20(s.ticker, day)
            : pscByDay.get(day)?.has(s.ticker) === true || (momOk(s.ticker, day) && nearHigh20(s.ticker, day)),
        );
        if (kept.length > 0) out.set(day, kept);
      }
      return out;
    }

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const limits: PositionLimits = { boMax: 0, guMax: 3, pscMax: 0 };

    console.log(
      `\n${"アーム".padEnd(24)}| ${"GUシグナル".padStart(9)} | ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ` +
      `${"PF".padStart(5)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(9)} | ${"Calmar".padStart(7)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(120));

    for (const arm of ARMS) {
      const sig = filterSignals(arm.key);
      let sigCount = 0;
      for (const s of sig.values()) sigCount += s.length;

      const ctx = {
        guConfig, pscConfig: pscConfigUngated, pscSignals: pscSignalsUngated,
        budget, verbose: false, allData, precomputed, gapupSignals: sig,
        vixData: vixData.size > 0 ? vixData : undefined,
        monthlyAddAmount: 0, equityCurveSmaPeriod: 0,
        indexData: indexData.size > 0 ? indexData : undefined,
      };
      const result = runCombinedSimulation(ctx, limits);
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const calmar = m.maxDrawdown > 0 ? (m.netReturnPct / years) / m.maxDrawdown : 0;
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      console.log(
        `${arm.label.padEnd(24)}| ${String(sigCount).padStart(9)} | ${String(m.totalTrades).padStart(6)} | ` +
        `${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ` +
        `${m.netReturnPct.toFixed(1).padStart(8)}% | ${calmar.toFixed(2).padStart(7)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      summary.push({
        window: label, arm: arm.label, trades: m.totalTrades, pf: m.profitFactor,
        maxDd: m.maxDrawdown, netRet: m.netReturnPct, calmar, util: util.capitalUtilizationPct,
      });
    }
  }

  console.log("\n" + "=".repeat(120));
  console.log("【まとめ】Calmar（baseline 比）");
  console.log("=".repeat(120));
  console.log(`${"窓".padEnd(28)}|` + ARMS.map((a) => ` ${a.label.padStart(22)} |`).join(""));
  console.log("-".repeat(120));
  for (const win of windows) {
    const rows = summary.filter((s) => s.window === win.label);
    const base = rows.find((r) => r.arm === ARMS[0].label);
    const cells = ARMS.map((a) => {
      const r = rows.find((x) => x.arm === a.label);
      if (!r) return "—".padStart(22);
      if (!base || a.key === "baseline") return r.calmar.toFixed(2).padStart(22);
      const d = base.calmar > 0 ? ((r.calmar - base.calmar) / base.calmar) * 100 : 0;
      return `${r.calmar.toFixed(2)} (${d >= 0 ? "+" : ""}${d.toFixed(0)}%)`.padStart(22);
    });
    console.log(`${win.label.padEnd(28)}|` + cells.map((c) => ` ${c} |`).join(""));
  }

  console.log("\n判定基準: 全窓（とくに年代別3期）で baseline を一貫して上回るか。");
  console.log("  fullcycle だけ good は複利加重の罠（却下#57 が ETF で踏んだ）。");
  console.log("  MaxDD だけ改善して NetRet が削られるなら却下#55 と同じ結末。");
  console.log(`\n実行: ${dayjs().format("YYYY-MM-DD HH:mm:ss")}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("エラー:", err);
  await prisma.$disconnect();
  process.exit(1);
});
