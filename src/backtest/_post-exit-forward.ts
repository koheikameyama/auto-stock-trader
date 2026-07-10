/**
 * 使い捨て検証スクリプト: 決済後フォワードリターン分析 (post-exit forward return)
 *
 * 目的: 「トレール/タイムストップが早すぎて利を伸ばしきれていないか」を数値化する。
 *   本番のライブ追跡ではサンプルが薄く後知恵バイアスに陥るため、combined BT の
 *   全 Exit を対象に「決済価格から N 営業日後まで持ち続けたら何%だったか」を集計する。
 *
 * 設計:
 *   - baseline (GU3+PSC2) を1回だけ走らせて allTrades を取得（本番エンジン無改変）
 *   - 各 Exit について exitPrice を起点に +1/+3/+5/+10/+20 営業日の close 変化率を計算
 *   - 生リターン と N225超過リターン の両方を集計（生は universe の上方ドリフトを含むため）
 *   - MFE(20日): 決済後20日以内の最大 high が exitPrice からどれだけ上振れたか
 *   - exitReason 別・勝ち/負けトレード別に層別
 *
 * 解釈:
 *   - フォワード超過が系統的に + → 決済が早い（トレール過タイト）候補
 *   - フォワード超過が ~0 / − → 決済は妥当〜もっと遅くてよい（切って正解）
 *
 * 先読みなし: exitDate の close まで既知の情報のみ。フォワードは exitDate より後の足。
 * 本番影響なし: このファイルは検証専用、baseline エンジンを一切変更しない。
 *
 * 実行: npx tsx src/backtest/_post-exit-forward.ts [--start 2024-03-01] [--end 2026-07-01] [--budget 500000]
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
import type { OHLCVData } from "../core/technical-analysis";
import type {
  GapUpBacktestConfig,
  PostSurgeConsolidationBacktestConfig,
} from "./types";

const HORIZONS = [1, 3, 5, 10, 20] as const;

function getArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function pctPositive(xs: number[]): number {
  return xs.length ? (xs.filter((x) => x > 0).length / xs.length) * 100 : 0;
}

/** ticker の bars 内で date より h 営業日後の close を返す（範囲外は null）。生フォワード用。 */
function forwardClose(
  bars: OHLCVData[],
  idxMap: Map<string, number>,
  date: string,
  h: number,
): number | null {
  const i = idxMap.get(date);
  if (i == null) return null;
  const j = i + h;
  if (j >= bars.length) return null;
  return bars[j]?.close ?? null;
}

/** ticker の bars 内で date+1..date+h の最大 high（MFE用）。 */
function forwardMaxHigh(
  bars: OHLCVData[],
  idxMap: Map<string, number>,
  date: string,
  h: number,
): number | null {
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
  mfe20: number[];
}
function emptyRow(): Row {
  const raw: Record<number, number[]> = {};
  const excess: Record<number, number[]> = {};
  for (const h of HORIZONS) {
    raw[h] = [];
    excess[h] = [];
  }
  return { n: 0, raw, excess, mfe20: [] };
}

function printRow(label: string, r: Row) {
  const cells = HORIZONS.map((h) => {
    const rm = mean(r.raw[h]);
    const em = mean(r.excess[h]);
    const pp = pctPositive(r.excess[h]);
    return `${(rm >= 0 ? "+" : "") + rm.toFixed(2)}% / ${(em >= 0 ? "+" : "") + em.toFixed(2)}% / ${pp.toFixed(0)}%`;
  });
  const mfe = mean(r.mfe20);
  console.log(
    `${label.padEnd(18)}| ${String(r.n).padStart(5)} |` +
      cells.map((c) => ` ${c.padStart(22)} |`).join("") +
      ` ${("+" + mfe.toFixed(2) + "%").padStart(8)}`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const startDate = getArg(args, "--start") ?? "2024-03-01";
  const endDate = getArg(args, "--end") ?? dayjs().format("YYYY-MM-DD");
  const budget = Number(getArg(args, "--budget") ?? "500000");

  const dynamicMaxPrice = getMaxBuyablePrice(budget);
  const guConfig: GapUpBacktestConfig = {
    ...GAPUP_BACKTEST_DEFAULTS,
    startDate,
    endDate,
    initialBudget: budget,
    maxPrice: dynamicMaxPrice,
    verbose: false,
  };
  const pscConfig: PostSurgeConsolidationBacktestConfig = {
    ...PSC_BACKTEST_DEFAULTS,
    startDate,
    endDate,
    initialBudget: budget,
    maxPrice: dynamicMaxPrice,
    verbose: false,
    ...PSC_PRODUCTION_PARAMS,
  };

  console.log("=".repeat(60));
  console.log("決済後フォワードリターン分析 (post-exit forward)");
  console.log("=".repeat(60));
  console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);

  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  const tickerCodes = stocks.map((s) => s.tickerCode);

  const rawData = await fetchHistoricalFromDB(tickerCodes, startDate, endDate);
  const vixData = await fetchVixFromDB(startDate, endDate);
  const indexData = await fetchIndexFromDB("^N225", startDate, endDate);

  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= dynamicMaxPrice && b.close > 0)) {
      allData.set(ticker, bars);
    }
  }
  console.log(`[data] ${allData.size}銘柄, VIX ${vixData.size}日, N225 ${indexData.size}日`);

  const precomputed = precomputeSimData(
    startDate,
    endDate,
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

  const ctx = {
    guConfig,
    pscConfig,
    pscSignals,
    budget,
    verbose: false,
    allData,
    precomputed,
    gapupSignals,
    vixData: vixData.size > 0 ? vixData : undefined,
    monthlyAddAmount: 0,
    equityCurveSmaPeriod: 0,
    indexData: indexData.size > 0 ? indexData : undefined,
  };
  const limits: PositionLimits = { boMax: 0, guMax: 3, pscMax: 2 };

  const result = runCombinedSimulation(ctx, limits);
  const m = result.totalMetrics;
  console.log(
    `[baseline] Trades ${m.totalTrades}, WinRate ${m.winRate.toFixed(1)}%, PF ${m.profitFactor.toFixed(2)}, NetRet ${m.netReturnPct.toFixed(1)}%, MaxDD ${m.maxDrawdown.toFixed(1)}%`,
  );

  const { tradingDayIndex, tradingDays, dateIndexMap } = precomputed;

  // N225 の date→close は indexData。フォワードは tradingDays でステップ。
  const idxClose = (date: string): number | null => indexData.get(date) ?? null;

  const closed = result.allTrades.filter(
    (t) => t.exitReason && t.exitReason !== "still_open" && t.exitDate && t.exitPrice != null && t.exitPrice > 0,
  );

  const overall = emptyRow();
  const byReason = new Map<string, Row>();
  const winners = emptyRow();
  const losers = emptyRow();

  for (const t of closed) {
    const bars = allData.get(t.ticker);
    const idxMap = dateIndexMap.get(t.ticker);
    if (!bars || !idxMap || !t.exitDate || t.exitPrice == null) continue;
    const anchor = t.exitPrice;
    const exitDayIdx = tradingDayIndex.get(t.exitDate);

    const reasonRow = byReason.get(t.exitReason!) ?? emptyRow();
    const winRow = (t.pnlPct ?? 0) > 0 ? winners : losers;

    let counted = false;
    for (const h of HORIZONS) {
      const fc = forwardClose(bars, idxMap, t.exitDate, h);
      if (fc == null) continue;
      const rawRet = ((fc - anchor) / anchor) * 100;

      // N225 超過: 同じ営業日ステップの日経リターンを引く
      let excess = rawRet;
      if (exitDayIdx != null) {
        const futDate = tradingDays[exitDayIdx + h];
        const c0 = idxClose(t.exitDate);
        const c1 = futDate ? idxClose(futDate) : null;
        if (c0 != null && c1 != null && c0 > 0) {
          const idxRet = ((c1 - c0) / c0) * 100;
          excess = rawRet - idxRet;
        }
      }

      for (const row of [overall, reasonRow, winRow]) {
        row.raw[h].push(rawRet);
        row.excess[h].push(excess);
      }
      counted = true;
    }

    const mfeHigh = forwardMaxHigh(bars, idxMap, t.exitDate, 20);
    if (mfeHigh != null) {
      const mfe = ((mfeHigh - anchor) / anchor) * 100;
      for (const row of [overall, reasonRow, winRow]) row.mfe20.push(mfe);
    }

    if (counted) {
      overall.n++;
      reasonRow.n++;
      winRow.n++;
    }
    byReason.set(t.exitReason!, reasonRow);
  }

  const header =
    `\n${"層別".padEnd(18)}| ${"n".padStart(5)} |` +
    HORIZONS.map((h) => ` ${("+" + h + "d 生/超過/超過+%").padStart(22)} |`).join("") +
    ` ${"MFE20".padStart(8)}`;
  console.log("\n決済価格を起点にした「持ち続けた場合」のフォワードリターン");
  console.log("  各セル = 生平均% / N225超過平均% / 超過がプラスの割合%");
  console.log("  MFE20 = 決済後20営業日以内の最大 high の上振れ平均%");
  console.log(header);
  console.log("-".repeat(header.length));
  printRow("全体", overall);

  console.log("\n[出口理由別]");
  console.log(header);
  console.log("-".repeat(header.length));
  const REASON_ORDER = ["trailing_profit", "time_stop", "stop_loss", "take_profit", "defensive_exit", "rotation_exit", "regime_exit"];
  for (const reason of REASON_ORDER) {
    const r = byReason.get(reason);
    if (r && r.n > 0) printRow(reason, r);
  }

  console.log("\n[勝ち/負けトレード別]");
  console.log(header);
  console.log("-".repeat(header.length));
  printRow("勝ち(pnl>0)", winners);
  printRow("負け(pnl<=0)", losers);

  console.log("\n解釈ガイド:");
  console.log("  超過平均が系統的に + かつ 超過+%>50 → トレール/タイムが早すぎる候補（利を残している）");
  console.log("  超過平均が ~0 / − → 決済は妥当〜もっと遅くてよい（切って正解、続落を回避）");
  console.log("  ※生リターンは universe の上方ドリフトを含むため、判断は N225 超過で行う");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
