// scripts/walk-forward-us-dual-momentum.ts
/**
 * Dual Momentum Walk-Forward 分析
 *
 * IS 12ヶ月 / OOS 6ヶ月 / 7ウィンドウ = 54ヶ月
 * モメンタム戦略は長期データが必要なため通常BTより長期間で検証
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import { fetchUSHistoricalFromDB } from "../src/backtest/us/us-data-fetcher";
import { runUSDualMomentumBacktest } from "../src/backtest/us/us-dual-momentum-simulation";
import {
  US_DUAL_MOMENTUM_DEFAULTS,
  generateUSDualMomentumParameterCombinations,
} from "../src/backtest/us/us-dual-momentum-config";
import type { USDualMomentumBacktestConfig } from "../src/backtest/us/us-dual-momentum-types";
import type { PerformanceMetrics } from "../src/backtest/types";

const IS_MONTHS = 12;
const OOS_MONTHS = 6;
const SLIDE_MONTHS = 6;
const NUM_WINDOWS = 7;
const TOTAL_MONTHS = IS_MONTHS + OOS_MONTHS + SLIDE_MONTHS * (NUM_WINDOWS - 1);
const MIN_IS_PF = 0.5;

interface WindowResult {
  windowIdx: number;
  isStart: string;
  isEnd: string;
  oosStart: string;
  oosEnd: string;
  bestIsParams: Partial<USDualMomentumBacktestConfig>;
  isMetrics: PerformanceMetrics;
  oosMetrics: PerformanceMetrics | null;
}

interface ComboResult {
  params: Partial<USDualMomentumBacktestConfig>;
  metrics: PerformanceMetrics;
}

function paramKey(p: Partial<USDualMomentumBacktestConfig>): string {
  return `lb${p.lookbackDays}_rb${p.rebalanceDays}_at${p.absoluteMomentumThreshold}`;
}

function selectBest(combos: Map<string, ComboResult>): ComboResult | null {
  let bestScore = -Infinity;
  let best: ComboResult | null = null;
  for (const r of combos.values()) {
    // Sharpe ベース選択（短期間サンプル少のため PF だけだとノイズ多い）
    const sharpe = r.metrics.sharpeRatio ?? 0;
    const pf = r.metrics.profitFactor === Infinity ? 5 : r.metrics.profitFactor;
    const score = sharpe + pf * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

function generateWindows(startDate: string) {
  const w = [];
  for (let i = 0; i < NUM_WINDOWS; i++) {
    const isStart = dayjs(startDate).add(i * SLIDE_MONTHS, "month").format("YYYY-MM-DD");
    const isEnd = dayjs(isStart).add(IS_MONTHS, "month").subtract(1, "day").format("YYYY-MM-DD");
    const oosStart = dayjs(isEnd).add(1, "day").format("YYYY-MM-DD");
    const oosEnd = dayjs(oosStart).add(OOS_MONTHS, "month").subtract(1, "day").format("YYYY-MM-DD");
    w.push({ isStart, isEnd, oosStart, oosEnd });
  }
  return w;
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
  console.log("Dual Momentum Walk-Forward 分析");
  console.log("=".repeat(70));
  console.log(`分析期間: ${startDate} → ${endDate} (${TOTAL_MONTHS}ヶ月)`);
  console.log(`IS: ${IS_MONTHS}ヶ月 / OOS: ${OOS_MONTHS}ヶ月\n`);

  const allTickers = [...US_DUAL_MOMENTUM_DEFAULTS.equityUniverse, US_DUAL_MOMENTUM_DEFAULTS.riskOffAsset];
  const dataStart = dayjs(startDate).subtract(300, "day").format("YYYY-MM-DD");
  const etfMap = await fetchUSHistoricalFromDB(allTickers, dataStart, endDate, 0);
  for (const t of allTickers) {
    console.log(`[data] ${t}: ${etfMap.get(t)?.length ?? 0}日`);
  }

  const paramCombos = generateUSDualMomentumParameterCombinations();
  console.log(`\nパラメータ組み合わせ: ${paramCombos.length}通り\n`);

  const windows = generateWindows(startDate);
  const results: WindowResult[] = [];

  for (let w = 0; w < windows.length; w++) {
    const { isStart, isEnd, oosStart, oosEnd } = windows[w];
    console.log(`━━━ Window ${w + 1}/${NUM_WINDOWS} ━━━`);
    console.log(`  IS:  ${isStart} → ${isEnd}`);
    console.log(`  OOS: ${oosStart} → ${oosEnd}`);

    const comboResults = new Map<string, ComboResult>();

    for (const params of paramCombos) {
      const config: USDualMomentumBacktestConfig = {
        ...US_DUAL_MOMENTUM_DEFAULTS,
        ...params,
        startDate: isStart,
        endDate: isEnd,
        verbose: false,
      };
      const result = runUSDualMomentumBacktest(config, etfMap);
      if (result.metrics.totalTrades < 1 && result.metrics.netReturnPct === 0) continue;
      comboResults.set(paramKey(params), { params, metrics: result.metrics });
    }

    const selected = selectBest(comboResults);
    if (!selected) {
      console.log("  ⚠ IS期間でトレード発生せず\n");
      continue;
    }

    const bestParams = selected.params;
    const bestIsMetrics = selected.metrics;

    if (bestIsMetrics.profitFactor < MIN_IS_PF && bestIsMetrics.netReturnPct < 0) {
      console.log(`  IS  最適PF: ${fmtPF(bestIsMetrics.profitFactor)} ret=${bestIsMetrics.netReturnPct.toFixed(1)}%`);
      console.log(`  ⏸ IS低PFまたは負リターン → OOS休止\n`);
      results.push({ windowIdx: w, isStart, isEnd, oosStart, oosEnd, bestIsParams: bestParams, isMetrics: bestIsMetrics, oosMetrics: null });
      continue;
    }

    const oosConfig: USDualMomentumBacktestConfig = {
      ...US_DUAL_MOMENTUM_DEFAULTS,
      ...bestParams,
      startDate: oosStart,
      endDate: oosEnd,
      verbose: false,
    };
    const oosResult = runUSDualMomentumBacktest(oosConfig, etfMap);

    results.push({ windowIdx: w, isStart, isEnd, oosStart, oosEnd, bestIsParams: bestParams, isMetrics: bestIsMetrics, oosMetrics: oosResult.metrics });

    console.log(`  IS  最適PF: ${fmtPF(bestIsMetrics.profitFactor)} ret=${bestIsMetrics.netReturnPct.toFixed(1)}% (${bestIsMetrics.totalTrades}tr)`);
    console.log(`  OOS PF:     ${fmtPF(oosResult.metrics.profitFactor)} ret=${oosResult.metrics.netReturnPct.toFixed(1)}% (${oosResult.metrics.totalTrades}tr)`);
    console.log(`  最適パラメータ: lb=${bestParams.lookbackDays}d, rb=${bestParams.rebalanceDays}d, at=${bestParams.absoluteMomentumThreshold}%\n`);
  }

  printSummary(results);
  await prisma.$disconnect();
}

function printSummary(results: WindowResult[]) {
  console.log("=".repeat(70));
  console.log("Dual Momentum Walk-Forward サマリー");
  console.log("=".repeat(70));

  if (!results.length) { console.log("結果なし"); return; }

  const active = results.filter((r) => r.oosMetrics !== null);
  const skipped = results.length - active.length;

  let oosTotalRet = 0;
  let oosWindowsPositive = 0;
  for (const r of active) {
    oosTotalRet += r.oosMetrics!.netReturnPct;
    if (r.oosMetrics!.netReturnPct > 0) oosWindowsPositive++;
  }
  const isAvgPF = results.reduce((s, r) => s + r.isMetrics.profitFactor, 0) / results.length;
  const oosAvgPF = active.length ? active.reduce((s, r) => s + r.oosMetrics!.profitFactor, 0) / active.length : 0;
  const ratio = oosAvgPF > 0 ? isAvgPF / oosAvgPF : Infinity;

  // OOS PF 集計（リターン率ベースで簡易計算）
  let oosGP = 0, oosGL = 0;
  for (const r of active) {
    const ret = r.oosMetrics!.netReturnPct;
    if (ret > 0) oosGP += ret;
    else oosGL += Math.abs(ret);
  }
  const oosWindowPF = oosGL > 0 ? oosGP / oosGL : oosGP > 0 ? Infinity : 0;

  console.log(`\nOOS集計:`);
  console.log(`  アクティブウィンドウ: ${active.length}/${results.length}（休止: ${skipped}）`);
  console.log(`  正リターン窓: ${oosWindowsPositive}/${active.length}`);
  console.log(`  OOS総リターン合計: ${oosTotalRet.toFixed(1)}%`);
  console.log(`  ウィンドウ別PF: ${fmtPF(oosWindowPF)}`);
  console.log(`  IS平均PF: ${fmtPF(isAvgPF)}`);
  console.log(`  OOS平均PF: ${fmtPF(oosAvgPF)}`);
  console.log(`  IS/OOS PF比: ${ratio.toFixed(2)}`);
  console.log(`\n${"━".repeat(30)}`);
  console.log(`判定: ${judge(oosWindowPF, ratio)}`);
  console.log(`${"━".repeat(30)}`);

  console.log("\n[ウィンドウ別]");
  console.log("Window | IS PF   | OOS PF  | OOS Ret%  | OOS MaxDD% | 最適パラメータ");
  console.log("-".repeat(95));
  for (const r of results) {
    const p = r.bestIsParams;
    const ps = `lb=${p.lookbackDays}, rb=${p.rebalanceDays}, at=${p.absoluteMomentumThreshold}`;
    if (r.oosMetrics === null) {
      console.log(`  ${r.windowIdx + 1}    | ${padPF(r.isMetrics.profitFactor)} |    休止 |        - |          - | ${ps}`);
    } else {
      const ret = r.oosMetrics.netReturnPct.toFixed(2).padStart(8);
      const dd = r.oosMetrics.maxDrawdown.toFixed(1).padStart(8);
      console.log(`  ${r.windowIdx + 1}    | ${padPF(r.isMetrics.profitFactor)} | ${padPF(r.oosMetrics.profitFactor)} | ${ret}% | ${dd}% | ${ps}`);
    }
  }

  console.log("\n[パラメータ安定性]");
  for (const key of ["lookbackDays", "rebalanceDays", "absoluteMomentumThreshold"] as const) {
    const v = active.map((r) => r.bestIsParams[key]);
    const u = [...new Set(v)];
    const stab = u.length === 1 ? "安定" : u.length <= 2 ? "やや安定" : "不安定";
    console.log(`  ${key}: ${u.join(", ")} → ${stab}`);
  }
}

main().catch((e) => { console.error("WF分析エラー:", e); process.exit(1); });
