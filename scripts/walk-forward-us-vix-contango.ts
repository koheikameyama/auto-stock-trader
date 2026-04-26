// scripts/walk-forward-us-vix-contango.ts
/**
 * VIX Contango Walk-Forward 分析
 *
 * IS 6ヶ月 / OOS 3ヶ月 / 7ウィンドウ = 27ヶ月
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import { fetchUSHistoricalFromDB, fetchVixFromDB } from "../src/backtest/us/us-data-fetcher";
import { runUSVixContangoBacktest } from "../src/backtest/us/us-vix-contango-simulation";
import {
  US_VIX_CONTANGO_DEFAULTS,
  generateUSVixContangoParameterCombinations,
} from "../src/backtest/us/us-vix-contango-config";
import type { USVixContangoBacktestConfig } from "../src/backtest/us/us-vix-contango-types";
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
  bestIsParams: Partial<USVixContangoBacktestConfig>;
  isMetrics: PerformanceMetrics;
  oosMetrics: PerformanceMetrics | null;
}

interface ComboResult {
  params: Partial<USVixContangoBacktestConfig>;
  metrics: PerformanceMetrics;
}

function paramKey(p: Partial<USVixContangoBacktestConfig>): string {
  return `ve${p.vixEntryUpperBound}_vx${p.vixExitUpperBound}_sl${p.stopLossPct}`;
}

function selectByRobustness(combos: Map<string, ComboResult>): ComboResult | null {
  let bestScore = -Infinity;
  let best: ComboResult | null = null;
  for (const r of combos.values()) {
    // 簡易: PF と トレード数で評価（PFのみだとサンプル少のノイズ拾う）
    const score = r.metrics.profitFactor * Math.log(1 + r.metrics.totalTrades);
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
  console.log("VIX Contango Walk-Forward 分析");
  console.log("=".repeat(70));
  console.log(`分析期間: ${startDate} → ${endDate} (${TOTAL_MONTHS}ヶ月)`);
  console.log(`IS: ${IS_MONTHS}ヶ月 / OOS: ${OOS_MONTHS}ヶ月\n`);

  const ticker = US_VIX_CONTANGO_DEFAULTS.underlyingTicker;
  const etfMap = await fetchUSHistoricalFromDB([ticker], startDate, endDate);
  const etfData = etfMap.get(ticker) ?? [];
  const vixData = await fetchVixFromDB(startDate, endDate);
  console.log(`[data] ${ticker}: ${etfData.length}日, VIX: ${vixData.size}日\n`);

  if (!etfData.length) {
    console.error(`No ${ticker} data`);
    process.exit(1);
  }

  const paramCombos = generateUSVixContangoParameterCombinations();
  console.log(`パラメータ組み合わせ: ${paramCombos.length}通り\n`);

  const windows = generateWindows(startDate);
  const results: WindowResult[] = [];

  for (let w = 0; w < windows.length; w++) {
    const { isStart, isEnd, oosStart, oosEnd } = windows[w];
    console.log(`━━━ Window ${w + 1}/${NUM_WINDOWS} ━━━`);
    console.log(`  IS:  ${isStart} → ${isEnd}`);
    console.log(`  OOS: ${oosStart} → ${oosEnd}`);

    const comboResults = new Map<string, ComboResult>();

    for (const params of paramCombos) {
      const config: USVixContangoBacktestConfig = {
        ...US_VIX_CONTANGO_DEFAULTS,
        ...params,
        startDate: isStart,
        endDate: isEnd,
        verbose: false,
      };
      const result = runUSVixContangoBacktest(config, etfData, vixData);
      if (result.metrics.totalTrades < 1) continue;
      comboResults.set(paramKey(params), { params, metrics: result.metrics });
    }

    const selected = selectByRobustness(comboResults);
    if (!selected) {
      console.log("  ⚠ IS期間でトレード発生せず\n");
      continue;
    }

    const bestParams = selected.params;
    const bestIsMetrics = selected.metrics;

    if (bestIsMetrics.profitFactor < MIN_IS_PF) {
      console.log(`  IS  最適PF: ${fmtPF(bestIsMetrics.profitFactor)} (${bestIsMetrics.totalTrades}tr)`);
      console.log(`  ⏸ IS最適PF < ${MIN_IS_PF} → OOS休止\n`);
      results.push({ windowIdx: w, isStart, isEnd, oosStart, oosEnd, bestIsParams: bestParams, isMetrics: bestIsMetrics, oosMetrics: null });
      continue;
    }

    const oosConfig: USVixContangoBacktestConfig = {
      ...US_VIX_CONTANGO_DEFAULTS,
      ...bestParams,
      startDate: oosStart,
      endDate: oosEnd,
      verbose: false,
    };
    const oosResult = runUSVixContangoBacktest(oosConfig, etfData, vixData);

    results.push({ windowIdx: w, isStart, isEnd, oosStart, oosEnd, bestIsParams: bestParams, isMetrics: bestIsMetrics, oosMetrics: oosResult.metrics });

    console.log(`  IS  最適PF: ${fmtPF(bestIsMetrics.profitFactor)} (${bestIsMetrics.totalTrades}tr, 勝率${bestIsMetrics.winRate}%)`);
    console.log(`  OOS PF:     ${fmtPF(oosResult.metrics.profitFactor)} (${oosResult.metrics.totalTrades}tr, 勝率${oosResult.metrics.winRate}%)`);
    console.log(`  最適パラメータ: ve=${bestParams.vixEntryUpperBound}, vx=${bestParams.vixExitUpperBound}, sl=${bestParams.stopLossPct}\n`);
  }

  printSummary(results);
  await prisma.$disconnect();
}

function printSummary(results: WindowResult[]) {
  console.log("=".repeat(70));
  console.log("VIX Contango Walk-Forward サマリー");
  console.log("=".repeat(70));

  if (!results.length) { console.log("結果なし"); return; }

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
    const ps = `ve=${p.vixEntryUpperBound}, vx=${p.vixExitUpperBound}, sl=${p.stopLossPct}`;
    if (r.oosMetrics === null) {
      console.log(`  ${r.windowIdx + 1}    | ${padPF(r.isMetrics.profitFactor)} |    休止 |      -  |           - | ${ps}`);
    } else {
      console.log(`  ${r.windowIdx + 1}    | ${padPF(r.isMetrics.profitFactor)} | ${padPF(r.oosMetrics.profitFactor)} | ${r.oosMetrics.winRate.toFixed(1).padStart(5)}%  | ${String(r.oosMetrics.totalTrades).padStart(11)} | ${ps}`);
    }
  }

  console.log("\n[パラメータ安定性]");
  for (const key of ["vixEntryUpperBound", "vixExitUpperBound", "stopLossPct"] as const) {
    const v = active.map((r) => r.bestIsParams[key]);
    const u = [...new Set(v)];
    const stab = u.length === 1 ? "安定" : u.length <= 2 ? "やや安定" : "不安定";
    console.log(`  ${key}: ${u.join(", ")} → ${stab}`);
  }
}

main().catch((e) => { console.error("WF分析エラー:", e); process.exit(1); });
