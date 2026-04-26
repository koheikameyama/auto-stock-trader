// scripts/walk-forward-us-credit-spread.ts
/**
 * SPY Credit Spread Walk-Forward 分析
 *
 * IS（In-Sample）6ヶ月 / OOS（Out-of-Sample）3ヶ月
 * 3ヶ月スライド × 7ウィンドウ = 27ヶ月
 *
 * Usage:
 *   npm run walk-forward:us-credit-spread
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import { fetchSP500FromDB, fetchVixFromDB } from "../src/backtest/us/us-data-fetcher";
import { runUSCreditSpreadBacktest } from "../src/backtest/us/us-credit-spread-simulation";
import {
  US_CREDIT_SPREAD_DEFAULTS,
  generateUSCreditSpreadParameterCombinations,
  US_CREDIT_SPREAD_PARAMETER_GRID,
} from "../src/backtest/us/us-credit-spread-config";
import type { USCreditSpreadBacktestConfig } from "../src/backtest/us/us-credit-spread-types";
import type { PerformanceMetrics } from "../src/backtest/types";

const IS_MONTHS = 6;
const OOS_MONTHS = 3;
const SLIDE_MONTHS = 3;
const NUM_WINDOWS = 7;
const TOTAL_MONTHS = IS_MONTHS + OOS_MONTHS + SLIDE_MONTHS * (NUM_WINDOWS - 1);
const MIN_IS_PF = 0.5;

interface WindowResult {
  windowIdx: number;
  isStart: string;
  isEnd: string;
  oosStart: string;
  oosEnd: string;
  bestIsParams: Partial<USCreditSpreadBacktestConfig>;
  isMetrics: PerformanceMetrics;
  oosMetrics: PerformanceMetrics | null;
}

interface ComboResult {
  params: Partial<USCreditSpreadBacktestConfig>;
  metrics: PerformanceMetrics;
}

function paramComboKey(p: Partial<USCreditSpreadBacktestConfig>): string {
  return `pd${p.shortPutDelta}_dte${p.dte}_pt${p.profitTarget}`;
}

function calcMedian(vals: number[]): number {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function selectByRobustness(combos: Map<string, ComboResult>): ComboResult | null {
  const grids: readonly number[][] = [
    [...US_CREDIT_SPREAD_PARAMETER_GRID.shortPutDelta],
    [...US_CREDIT_SPREAD_PARAMETER_GRID.dte],
    [...US_CREDIT_SPREAD_PARAMETER_GRID.profitTarget],
  ];
  const sizes = grids.map((g) => g.length);

  let bestScore = -Infinity;
  let best: ComboResult | null = null;

  for (const r of combos.values()) {
    const p = r.params;
    const idx = [
      grids[0].indexOf(p.shortPutDelta!),
      grids[1].indexOf(p.dte!),
      grids[2].indexOf(p.profitTarget!),
    ];
    const ranges = idx.map((i, d) => {
      const v: number[] = [];
      for (let k = Math.max(0, i - 1); k <= Math.min(sizes[d] - 1, i + 1); k++) v.push(k);
      return v;
    });
    const neighborPFs: number[] = [];
    function recurse(dim: number, cur: number[]): void {
      if (dim === ranges.length) {
        const vals = cur.map((i, d) => grids[d][i]);
        const k = `pd${vals[0]}_dte${vals[1]}_pt${vals[2]}`;
        const nr = combos.get(k);
        if (nr) neighborPFs.push(nr.metrics.profitFactor);
        return;
      }
      for (const i of ranges[dim]) recurse(dim + 1, [...cur, i]);
    }
    recurse(0, []);
    const score = calcMedian(neighborPFs);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

function generateWindows(startDate: string) {
  const windows = [];
  for (let w = 0; w < NUM_WINDOWS; w++) {
    const isStart = dayjs(startDate).add(w * SLIDE_MONTHS, "month").format("YYYY-MM-DD");
    const isEnd = dayjs(isStart).add(IS_MONTHS, "month").subtract(1, "day").format("YYYY-MM-DD");
    const oosStart = dayjs(isEnd).add(1, "day").format("YYYY-MM-DD");
    const oosEnd = dayjs(oosStart).add(OOS_MONTHS, "month").subtract(1, "day").format("YYYY-MM-DD");
    windows.push({ isStart, isEnd, oosStart, oosEnd });
  }
  return windows;
}

function judge(oosPF: number, ratio: number): string {
  if (oosPF >= 1.3 && ratio <= 2.0) return "堅牢 ✓";
  if (oosPF >= 1.0 && ratio <= 3.0) return "要注意 △";
  return "過学習 ✗";
}

function fmtPF(pf: number): string {
  return pf === Infinity ? "∞" : pf.toFixed(2);
}

function padPF(pf: number): string {
  return fmtPF(pf).padStart(7);
}

async function main() {
  const endDate = dayjs().format("YYYY-MM-DD");
  const startDate = dayjs().subtract(TOTAL_MONTHS, "month").format("YYYY-MM-DD");

  console.log("=".repeat(70));
  console.log("SPY Credit Spread Walk-Forward 分析");
  console.log("=".repeat(70));
  console.log(`分析期間: ${startDate} → ${endDate} (${TOTAL_MONTHS}ヶ月)`);
  console.log(`IS: ${IS_MONTHS}ヶ月 / OOS: ${OOS_MONTHS}ヶ月 / スライド: ${SLIDE_MONTHS}ヶ月`);
  console.log(`ウィンドウ数: ${NUM_WINDOWS}`);
  console.log(`選択方式: ロバスト（近傍中央値PF）`);

  const paramCombos = generateUSCreditSpreadParameterCombinations();
  console.log(`パラメータ組み合わせ: ${paramCombos.length}通り\n`);

  console.log("[data] ^GSPC, VIX 取得中...");
  const gspc = await fetchSP500FromDB(startDate, endDate);
  const vix = await fetchVixFromDB(startDate, endDate);
  console.log(`[data] ^GSPC ${gspc.size}日, VIX ${vix.size}日\n`);

  const windows = generateWindows(startDate);
  const results: WindowResult[] = [];

  for (let w = 0; w < windows.length; w++) {
    const { isStart, isEnd, oosStart, oosEnd } = windows[w];
    console.log(`━━━ Window ${w + 1}/${NUM_WINDOWS} ━━━`);
    console.log(`  IS:  ${isStart} → ${isEnd}`);
    console.log(`  OOS: ${oosStart} → ${oosEnd}`);

    const comboResults = new Map<string, ComboResult>();

    for (const params of paramCombos) {
      const config: USCreditSpreadBacktestConfig = {
        ...US_CREDIT_SPREAD_DEFAULTS,
        ...params,
        startDate: isStart,
        endDate: isEnd,
        verbose: false,
      };
      const result = await runUSCreditSpreadBacktest(config, gspc, vix);
      if (result.metrics.totalTrades < 3) continue;
      comboResults.set(paramComboKey(params), {
        params,
        metrics: result.metrics,
      });
    }

    const selected = selectByRobustness(comboResults);
    if (!selected) {
      console.log("  ⚠ IS期間でトレードが発生しなかったためスキップ\n");
      continue;
    }

    const bestParams = selected.params;
    const bestIsMetrics = selected.metrics;

    if (bestIsMetrics.profitFactor < MIN_IS_PF) {
      console.log(`  IS  最適PF: ${fmtPF(bestIsMetrics.profitFactor)} (${bestIsMetrics.totalTrades}tr, 勝率${bestIsMetrics.winRate}%)`);
      console.log(`  ⏸ IS最適PF < ${MIN_IS_PF} → OOS休止\n`);
      results.push({
        windowIdx: w, isStart, isEnd, oosStart, oosEnd,
        bestIsParams: bestParams, isMetrics: bestIsMetrics, oosMetrics: null,
      });
      continue;
    }

    const oosConfig: USCreditSpreadBacktestConfig = {
      ...US_CREDIT_SPREAD_DEFAULTS,
      ...bestParams,
      startDate: oosStart,
      endDate: oosEnd,
      verbose: false,
    };
    const oosResult = await runUSCreditSpreadBacktest(oosConfig, gspc, vix);

    results.push({
      windowIdx: w, isStart, isEnd, oosStart, oosEnd,
      bestIsParams: bestParams, isMetrics: bestIsMetrics, oosMetrics: oosResult.metrics,
    });

    console.log(`  IS  最適PF: ${fmtPF(bestIsMetrics.profitFactor)} (${bestIsMetrics.totalTrades}tr, 勝率${bestIsMetrics.winRate}%)`);
    console.log(`  OOS PF:     ${fmtPF(oosResult.metrics.profitFactor)} (${oosResult.metrics.totalTrades}tr, 勝率${oosResult.metrics.winRate}%)`);
    console.log(`  最適パラメータ: shortPutDelta=${bestParams.shortPutDelta}, dte=${bestParams.dte}, profitTarget=${bestParams.profitTarget}\n`);
  }

  printSummary(results);
  await prisma.$disconnect();
}

function printSummary(results: WindowResult[]) {
  console.log("=".repeat(70));
  console.log("SPY Credit Spread Walk-Forward サマリー");
  console.log("=".repeat(70));

  if (!results.length) {
    console.log("結果なし");
    return;
  }

  const active = results.filter((r) => r.oosMetrics !== null);
  const skipped = results.length - active.length;

  let oosGP = 0, oosGL = 0, oosTrades = 0, oosWins = 0;
  for (const r of active) {
    const o = r.oosMetrics!;
    oosTrades += o.totalTrades;
    oosWins += o.wins;
    if (o.wins > 0) oosGP += o.avgWinPct * o.wins;
    if (o.losses > 0) oosGL += Math.abs(o.avgLossPct) * o.losses;
  }
  const oosPF = oosGL > 0 ? oosGP / oosGL : oosGP > 0 ? Infinity : 0;
  const oosWR = oosTrades > 0 ? (oosWins / oosTrades) * 100 : 0;
  const isAvgPF = results.reduce((s, r) => s + r.isMetrics.profitFactor, 0) / results.length;
  const oosAvgPF = active.length ? active.reduce((s, r) => s + r.oosMetrics!.profitFactor, 0) / active.length : 0;
  const ratio = oosAvgPF > 0 ? isAvgPF / oosAvgPF : Infinity;

  console.log(`\nOOS集計:`);
  console.log(`  アクティブウィンドウ: ${active.length}/${results.length}（休止: ${skipped}）`);
  console.log(`  総トレード: ${oosTrades}`);
  console.log(`  勝率: ${oosWR.toFixed(1)}%`);
  console.log(`  集計PF: ${fmtPF(oosPF)}`);
  console.log(`  IS平均PF: ${fmtPF(isAvgPF)}`);
  console.log(`  OOS平均PF: ${fmtPF(oosAvgPF)}`);
  console.log(`  IS/OOS PF比: ${ratio.toFixed(2)}`);
  console.log(`\n${"━".repeat(30)}`);
  console.log(`判定: ${judge(oosPF, ratio)}`);
  console.log(`${"━".repeat(30)}`);

  console.log("\n[ウィンドウ別]");
  console.log("Window | IS PF   | OOS PF  | OOS勝率 | OOSトレード | 最適パラメータ");
  console.log("-".repeat(90));
  for (const r of results) {
    const p = r.bestIsParams;
    const ps = `pd=${p.shortPutDelta}, dte=${p.dte}, pt=${p.profitTarget}`;
    if (r.oosMetrics === null) {
      console.log(`  ${r.windowIdx + 1}    | ${padPF(r.isMetrics.profitFactor)} |    休止 |      -  |           - | ${ps}`);
    } else {
      console.log(`  ${r.windowIdx + 1}    | ${padPF(r.isMetrics.profitFactor)} | ${padPF(r.oosMetrics.profitFactor)} | ${r.oosMetrics.winRate.toFixed(1).padStart(5)}%  | ${String(r.oosMetrics.totalTrades).padStart(11)} | ${ps}`);
    }
  }

  console.log("\n[パラメータ安定性]");
  for (const key of ["shortPutDelta", "dte", "profitTarget"] as const) {
    const v = active.map((r) => r.bestIsParams[key]);
    const u = [...new Set(v)];
    const stab = u.length === 1 ? "安定" : u.length <= 2 ? "やや安定" : "不安定";
    console.log(`  ${key}: ${u.join(", ")} → ${stab}`);
  }
}

main().catch((e) => {
  console.error("Walk-Forward分析エラー:", e);
  process.exit(1);
});
