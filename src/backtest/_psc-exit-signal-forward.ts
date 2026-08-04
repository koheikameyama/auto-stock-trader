/**
 * 使い捨て検証: 「PSC シグナルを GU の出口シグナルとして使えるか」(KOH-601 の続き / 却下#59 の残り角度A)
 *
 * 問い: GU は平均保有1.1日で手仕舞う。その決済日に PSC シグナル
 *       (20日+15%急騰 × 高値圏 × 陽線 × 出来高サージ) が出ている銘柄は、
 *       「再加速中なのに切っている」のではないか。だとすれば PSC を
 *       並列戦略ではなく **GU のトレール緩和 / タイムストップ延長のシグナル**
 *       として使える（新規ポジションを建てないので資金も枠も1円も奪わない）。
 *
 * 却下#38 (_post-exit-forward.ts) の枠組みを流用し、層別軸だけ差し替えた。
 * #38 は「全 Exit を無条件に」測って「売った銘柄は決済後も続落する」と結論したが、
 * **「後で PSC シグナルが出た銘柄」という条件付き部分集合は一度も測っていない**。
 *
 * 層別（相互排他、決済時点で既知かどうかで分ける）:
 *   A. 決済日に PSC シグナル      → 決済時点で既知 = ルール化できる（本命）
 *   B. 保有中に出たが決済日には無し → 決済時点で既知だが古い情報
 *   D. 保有中〜決済日に一度も無し  → 対照群
 *   C. 決済後1-5営業日に出た       → **決済時点で未知 = 後知恵。診断のみ、ルール化不可**
 *
 * ゲートの扱い: PSC シグナルは市場ゲート (breadth band + N225 SMA50) を外して
 *   precompute し、日次でゲート通過/不通過を後から交差させる。出口ルールとして使うなら
 *   市場ゲートは必須ではないため、ungated を主・gated を副で両方出す。
 *
 * 先読みなし: シグナルは当日終値まで、フォワードは exitDate より後の足。
 * baseline は GU3単独 / 総資産基準サイジング（2026-08-03〜04 の新 baseline）。
 * 本番影響なし: 検証専用、エンジン無改変。
 *
 * 実行: npx tsx src/backtest/_psc-exit-signal-forward.ts --start 2018-04-01 --end 2026-07-31
 */
import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { GAPUP_BACKTEST_DEFAULTS } from "./gapup-config";
import { PSC_BACKTEST_DEFAULTS, PSC_PRODUCTION_PARAMS } from "./post-surge-consolidation-config";
import { getMaxBuyablePrice } from "../core/risk-manager";
import { precomputeSimData } from "./breakout-simulation";
import { precomputeGapUpDailySignals } from "./gapup-simulation";
import { precomputePSCDailySignals } from "./post-surge-consolidation-simulation";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "./data-fetcher";
import { runCombinedSimulation, type PositionLimits } from "./combined-simulation";
import { MARKET_BREADTH } from "../lib/constants";
import type { OHLCVData } from "../core/technical-analysis";
import type { GapUpBacktestConfig, PostSurgeConsolidationBacktestConfig } from "./types";

const HORIZONS = [1, 3, 5, 10, 20] as const;
/** 決済後に PSC シグナルを探す営業日数（層別C用） */
const POST_EXIT_LOOKAHEAD = 5;

function getArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function pctPositive(xs: number[]): number {
  return xs.length ? (xs.filter((x) => x > 0).length / xs.length) * 100 : 0;
}

function forwardClose(bars: OHLCVData[], idxMap: Map<string, number>, date: string, h: number): number | null {
  const i = idxMap.get(date);
  if (i == null) return null;
  const j = i + h;
  if (j >= bars.length) return null;
  return bars[j]?.close ?? null;
}
function forwardMaxHigh(bars: OHLCVData[], idxMap: Map<string, number>, date: string, h: number): number | null {
  const i = idxMap.get(date);
  if (i == null) return null;
  let mx = -Infinity;
  for (let k = i + 1; k <= i + h && k < bars.length; k++) {
    const hi = bars[k]?.high;
    if (hi != null && hi > mx) mx = hi;
  }
  return mx === -Infinity ? null : mx;
}

interface Row {
  n: number;
  raw: Record<number, number[]>;
  excess: Record<number, number[]>;
  /** ★決済日の終値をアンカーにした超過リターン（= 引けで買い戻す形。実際に取れる唯一の形） */
  excessFromClose: Record<number, number[]>;
  mfe20: number[];
  pnlPct: number[];
  /** exitPrice → 決済日終値 の乖離%（アンカー偏りの正体を可視化する） */
  exitToClose: number[];
}
function emptyRow(): Row {
  const raw: Record<number, number[]> = {};
  const excess: Record<number, number[]> = {};
  const excessFromClose: Record<number, number[]> = {};
  for (const h of HORIZONS) {
    raw[h] = [];
    excess[h] = [];
    excessFromClose[h] = [];
  }
  return { n: 0, raw, excess, excessFromClose, mfe20: [], pnlPct: [], exitToClose: [] };
}
function printRow(label: string, r: Row) {
  const cells = HORIZONS.map((h) => {
    const rm = mean(r.raw[h]);
    const em = mean(r.excess[h]);
    const pp = pctPositive(r.excess[h]);
    return `${(rm >= 0 ? "+" : "") + rm.toFixed(2)}% / ${(em >= 0 ? "+" : "") + em.toFixed(2)}% / ${pp.toFixed(0)}%`;
  });
  console.log(
    `${label.padEnd(26)}| ${String(r.n).padStart(5)} |` +
      cells.map((c) => ` ${c.padStart(22)} |`).join("") +
      ` ${("+" + mean(r.mfe20).toFixed(2) + "%").padStart(8)}`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const startDate = getArg(args, "--start") ?? "2018-04-01";
  const endDate = getArg(args, "--end") ?? "2026-07-31";
  const budget = Number(getArg(args, "--budget") ?? "500000");
  const maxPrice = Number(getArg(args, "--max-price") ?? getMaxBuyablePrice(budget));

  console.log("=".repeat(110));
  console.log("PSC シグナルを GU の出口シグナルとして使えるか（決済後フォワード・層別）");
  console.log("=".repeat(110));
  console.log(`期間: ${startDate} → ${endDate}  予算: ¥${budget.toLocaleString()}  maxPrice: ¥${maxPrice.toLocaleString()}`);

  const guConfig: GapUpBacktestConfig = {
    ...GAPUP_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, maxPrice, verbose: false,
  };
  // ★市場ゲートを外した PSC シグナル（出口ルールとして使うならゲートは必須でない）
  const pscConfigUngated: PostSurgeConsolidationBacktestConfig = {
    ...PSC_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, maxPrice, verbose: false,
    ...PSC_PRODUCTION_PARAMS,
    marketTrendFilter: false, indexTrendFilter: false,
  };

  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  const rawData = await fetchHistoricalFromDB(stocks.map((s) => s.tickerCode), startDate, endDate);
  const vixData = await fetchVixFromDB(startDate, endDate);
  const indexData = await fetchIndexFromDB("^N225", startDate, endDate);

  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPrice && b.close > 0)) allData.set(ticker, bars);
  }
  console.log(`[data] ${allData.size}銘柄, VIX ${vixData.size}日, N225 ${indexData.size}日`);

  const precomputed = precomputeSimData(
    startDate, endDate, allData, true, true,
    guConfig.indexTrendSmaPeriod ?? 50,
    indexData.size > 0 ? indexData : undefined,
    false, 60,
    guConfig.indexTrendOffBufferPct ?? 0, guConfig.indexTrendOnBufferPct ?? 0,
  );
  console.log(`[precompute] 営業日 ${precomputed.tradingDays.length}日`);

  console.log("[precompute] GU シグナル...");
  const gapupSignals = precomputeGapUpDailySignals(guConfig, allData, precomputed);
  console.log("[precompute] PSC シグナル（市場ゲートなし）...");
  const pscSignalsUngated = precomputePSCDailySignals(pscConfigUngated, allData, precomputed);

  const { tradingDayIndex, tradingDays, dateIndexMap, dailyBreadth, dailyIndexAboveSma } = precomputed;

  // 日次ゲート通過判定（gated = 本番 PSC が実際に撃てる日）
  const gatedDay = new Map<string, boolean>();
  for (const day of tradingDays) {
    const b = dailyBreadth.get(day) ?? 0;
    gatedDay.set(day, b >= MARKET_BREADTH.THRESHOLD && b <= MARKET_BREADTH.UPPER_CAP && dailyIndexAboveSma.get(day) === true);
  }

  // ticker → PSCシグナル日(Set)
  const pscDaysByTicker = new Map<string, Set<string>>();
  let ungatedTotal = 0;
  let gatedTotal = 0;
  for (const [day, sigs] of pscSignalsUngated) {
    for (const s of sigs) {
      let set = pscDaysByTicker.get(s.ticker);
      if (!set) { set = new Set(); pscDaysByTicker.set(s.ticker, set); }
      set.add(day);
      ungatedTotal++;
      if (gatedDay.get(day)) gatedTotal++;
    }
  }
  console.log(`[precompute] PSCシグナル ungated ${ungatedTotal}件 / うちゲート通過 ${gatedTotal}件`);

  // baseline: GU3単独（総資産基準サイジングは SimContext の既定 true）
  const ctx = {
    guConfig,
    pscConfig: pscConfigUngated,
    pscSignals: pscSignalsUngated, // pscMax=0 なので未使用
    budget, verbose: false, allData, precomputed, gapupSignals,
    vixData: vixData.size > 0 ? vixData : undefined,
    monthlyAddAmount: 0, equityCurveSmaPeriod: 0,
    indexData: indexData.size > 0 ? indexData : undefined,
  };
  const limits: PositionLimits = { boMax: 0, guMax: 3, pscMax: 0 };

  console.log("\n[sim] baseline (GU3単独) 実行中...");
  const result = runCombinedSimulation(ctx, limits);
  const m = result.totalMetrics;
  console.log(
    `[baseline] Trades ${m.totalTrades}, WinRate ${m.winRate.toFixed(1)}%, PF ${m.profitFactor.toFixed(2)}, ` +
    `NetRet ${m.netReturnPct.toFixed(1)}%, MaxDD ${m.maxDrawdown.toFixed(1)}%`,
  );

  const idxClose = (date: string): number | null => indexData.get(date) ?? null;
  const closed = result.allTrades.filter(
    (t) => t.exitReason && t.exitReason !== "still_open" && t.exitDate && t.exitPrice != null && t.exitPrice > 0,
  );

  const buckets = {
    all: emptyRow(),
    A_atExit: emptyRow(),
    A_atExitGated: emptyRow(),
    B_duringHold: emptyRow(),
    D_none: emptyRow(),
    C_postExit: emptyRow(),
  };

  for (const t of closed) {
    const bars = allData.get(t.ticker);
    const idxMap = dateIndexMap.get(t.ticker);
    if (!bars || !idxMap || !t.exitDate || t.exitPrice == null) continue;
    const anchor = t.exitPrice;
    const exitDayIdx = tradingDayIndex.get(t.exitDate);
    if (exitDayIdx == null) continue;

    const sigDays = pscDaysByTicker.get(t.ticker) ?? new Set<string>();
    const atExit = sigDays.has(t.exitDate);
    // 保有中（エントリー翌日〜決済前日）
    let duringHold = false;
    const entryIdx = tradingDayIndex.get(t.entryDate);
    if (entryIdx != null) {
      for (let k = entryIdx + 1; k < exitDayIdx; k++) {
        if (sigDays.has(tradingDays[k])) { duringHold = true; break; }
      }
    }
    // 決済後 1..POST_EXIT_LOOKAHEAD（後知恵）
    let postExit = false;
    for (let k = exitDayIdx + 1; k <= exitDayIdx + POST_EXIT_LOOKAHEAD && k < tradingDays.length; k++) {
      if (sigDays.has(tradingDays[k])) { postExit = true; break; }
    }

    const rows: Row[] = [buckets.all];
    if (atExit) {
      rows.push(buckets.A_atExit);
      if (gatedDay.get(t.exitDate)) rows.push(buckets.A_atExitGated);
    } else if (duringHold) {
      rows.push(buckets.B_duringHold);
    } else {
      rows.push(buckets.D_none);
    }
    if (postExit) rows.push(buckets.C_postExit);

    // ★決済日の終値（= PSC が実際にエントリーする価格。引けで買い戻す形のアンカー）
    const exitBarIdx = idxMap.get(t.exitDate);
    const exitDayClose = exitBarIdx != null ? bars[exitBarIdx]?.close ?? null : null;
    if (exitDayClose != null && exitDayClose > 0) {
      for (const row of rows) row.exitToClose.push(((exitDayClose - anchor) / anchor) * 100);
    }

    let counted = false;
    for (const h of HORIZONS) {
      const fc = forwardClose(bars, idxMap, t.exitDate, h);
      if (fc == null) continue;
      const rawRet = ((fc - anchor) / anchor) * 100;
      let idxRet = 0;
      const futDate = tradingDays[exitDayIdx + h];
      const c0 = idxClose(t.exitDate);
      const c1 = futDate ? idxClose(futDate) : null;
      if (c0 != null && c1 != null && c0 > 0) idxRet = ((c1 - c0) / c0) * 100;
      for (const row of rows) { row.raw[h].push(rawRet); row.excess[h].push(rawRet - idxRet); }
      // 終値アンカー版（h=0 は定義上ゼロなので h>=1 のみ意味を持つ）
      if (exitDayClose != null && exitDayClose > 0) {
        const rawFromClose = ((fc - exitDayClose) / exitDayClose) * 100;
        for (const row of rows) row.excessFromClose[h].push(rawFromClose - idxRet);
      }
      counted = true;
    }
    const mfeHigh = forwardMaxHigh(bars, idxMap, t.exitDate, 20);
    if (mfeHigh != null) {
      const mfe = ((mfeHigh - anchor) / anchor) * 100;
      for (const row of rows) row.mfe20.push(mfe);
    }
    if (counted) for (const row of rows) { row.n++; row.pnlPct.push(t.pnlPct ?? 0); }
  }

  const header =
    `\n${"層別".padEnd(26)}| ${"n".padStart(5)} |` +
    HORIZONS.map((h) => ` ${("+" + h + "d 生/超過/超過+%").padStart(22)} |`).join("") +
    ` ${"MFE20".padStart(8)}`;

  console.log("\n" + "=".repeat(110));
  console.log("決済価格を起点にした「持ち続けた場合」のフォワードリターン");
  console.log("  各セル = 生平均% / N225超過平均% / 超過がプラスの割合%");
  console.log("=".repeat(110));
  console.log(header);
  console.log("-".repeat(header.length));
  printRow("全体(GU決済)", buckets.all);
  printRow("A 決済日にPSC(ungated)", buckets.A_atExit);
  printRow("A' 同・ゲート通過日のみ", buckets.A_atExitGated);
  printRow("B 保有中のみPSC", buckets.B_duringHold);
  printRow("D PSCなし(対照)", buckets.D_none);
  console.log("-".repeat(header.length));
  printRow("C 決済後1-5dにPSC★", buckets.C_postExit);
  console.log("  ★C は決済時点で未知 = 後知恵。ルール化できない診断用");

  console.log("\n[+5d / +10d 超過リターンの 平均 vs 中央値 vs 勝敗内訳]");
  const rowsForDetail: [string, Row][] = [
    ["全体(GU決済)", buckets.all],
    ["A 決済日にPSC", buckets.A_atExit],
    ["A' 同・ゲート通過", buckets.A_atExitGated],
    ["B 保有中のみPSC", buckets.B_duringHold],
    ["D PSCなし(対照)", buckets.D_none],
    ["C 決済後1-5d★", buckets.C_postExit],
  ];
  console.log(
    `${"層別".padEnd(26)}| ${"n".padStart(5)} |` +
      ` ${"+5d 平均".padStart(9)} | ${"+5d 中央".padStart(9)} | ${"+5d ↑/↓".padStart(11)} |` +
      ` ${"+10d 平均".padStart(9)} | ${"+10d 中央".padStart(9)} | ${"+10d ↑/↓".padStart(11)} |` +
      ` ${"元trade平均".padStart(10)}`,
  );
  const f = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  const wl = (xs: number[]) => `${xs.filter((x) => x > 0).length}/${xs.filter((x) => x <= 0).length}`;
  for (const [label, r] of rowsForDetail) {
    if (r.n === 0) { console.log(`${label.padEnd(26)}| ${"0".padStart(5)} | サンプルなし`); continue; }
    console.log(
      `${label.padEnd(26)}| ${String(r.n).padStart(5)} |` +
        ` ${f(mean(r.excess[5])).padStart(9)} | ${f(median(r.excess[5])).padStart(9)} | ${wl(r.excess[5]).padStart(11)} |` +
        ` ${f(mean(r.excess[10])).padStart(9)} | ${f(median(r.excess[10])).padStart(9)} | ${wl(r.excess[10]).padStart(11)} |` +
        ` ${f(mean(r.pnlPct)).padStart(10)}`,
    );
  }

  // ★★ アンカー偏りの検算 + 実際に取れる形（引けで買い戻す）での再測定
  console.log("\n" + "=".repeat(110));
  console.log("★ アンカー偏りの検算と「引けで買い戻す」形での再測定");
  console.log("  exitPrice起点は PSCシグナル日=陽線・高値圏 ゆえ構造的に有利になる（決済は場中・シグナルは終値確定）。");
  console.log("  さらに『決済日にPSCが出るか』は場中の決済判断時点では未知 = そのままでは先読み。");
  console.log("  実際に取れるのは『引け（=PSCのエントリー価格）で買い戻す』形だけなので、終値アンカーで測り直す。");
  console.log("=".repeat(110));
  console.log(
    `${"層別".padEnd(26)}| ${"n".padStart(5)} | ${"決済→終値乖離".padStart(12)} |` +
      HORIZONS.map((h) => ` ${("+" + h + "d 終値起点超過").padStart(14)} |`).join(""),
  );
  for (const [label, r] of rowsForDetail) {
    if (r.n === 0) { console.log(`${label.padEnd(26)}| ${"0".padStart(5)} | サンプルなし`); continue; }
    console.log(
      `${label.padEnd(26)}| ${String(r.n).padStart(5)} | ${f(mean(r.exitToClose)).padStart(12)} |` +
        HORIZONS.map((h) => ` ${f(mean(r.excessFromClose[h])).padStart(14)} |`).join(""),
    );
  }

  console.log("\n解釈:");
  console.log("  終値アンカーでも A > D かつ A が正 → 『引けで買い戻す』に価値あり → ルール化して combined BT へ");
  console.log("  終値アンカーで A ≈ 0 or 負       → exitPrice起点の優位はアンカー偏りの artifact → 却下#38/#39 が条件付きでも成立");
  console.log(`\n実行: ${dayjs().format("YYYY-MM-DD HH:mm:ss")}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("エラー:", err);
  await prisma.$disconnect();
  process.exit(1);
});
