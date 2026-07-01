/**
 * チャート予測実験ランナー
 *
 * 「チャートから N営業日後の方向（上/下）を予測 → 実測と照合 → どういう条件だと
 *  当たりやすいかを統計的に抽出する」ための PoC バックテスト。
 *
 * Usage:
 *   npm run backtest:chart-prediction
 *   npm run backtest:chart-prediction -- --start 2025-01-01 --end 2026-06-30
 *   npm run backtest:chart-prediction -- --horizon 5 --max-price 2500
 *   npm run backtest:chart-prediction -- --csv /tmp/pred-log.csv   # 予測ログをCSV保存
 *   npm run backtest:chart-prediction -- --sample 3                # 銘柄を1/3にサンプリング（高速確認用）
 *   npm run backtest:chart-prediction -- --mine --depth 2          # 条件マイニング（方向の的中率）
 *   npm run backtest:chart-prediction -- --mine-payoff --depth 2   # ペイオフ条件マイニング（avgFwd/右裾）
 *
 * 設計原則（先読みバイアス排除）:
 *   - 予測特徴量は予測日 t までの足のみで計算（computeFeaturesAt）
 *   - ラベルは close[t+H] という「DBに実在する未来足」で付与
 *   - 予測日は [start, end] 内、かつ t+H が存在する行だけを対象にする
 *   - 出力CSVは予測時点のスナップショット。後から改変しないこと
 */

import { writeFileSync } from "node:fs";
import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import {
  fetchHistoricalFromDB,
  fetchVixFromDB,
  fetchIndexFromDB,
} from "./data-fetcher";
import type { OHLCVData } from "../core/technical-analysis";
import {
  computeFeaturesAt,
  smaAt,
  PREDICTORS,
  type Direction,
  type PredictionFeatures,
} from "./chart-prediction-features";

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

// ──────────────────────────────────────────
// 市場条件（予測日時点で取得可能なもの）
// ──────────────────────────────────────────

type VixRegime = "calm" | "normal" | "elevated" | "high" | "crisis";

function vixRegimeOf(v: number | null): VixRegime | "unknown" {
  if (v == null) return "unknown";
  if (v < 15) return "calm";
  if (v < 20) return "normal";
  if (v < 25) return "elevated";
  if (v < 35) return "high";
  return "crisis";
}

function breadthBandOf(b: number | null): string {
  if (b == null) return "unknown";
  if (b < 0.4) return "<40%";
  if (b < 0.54) return "40-54%";
  if (b < 0.7) return "54-70%";
  return ">=70%";
}

// ──────────────────────────────────────────
// 予測ログの1行
// ──────────────────────────────────────────

interface PredRow {
  date: string;
  ticker: string;
  price: number;
  features: PredictionFeatures;
  preds: Record<string, Direction | null>;
  label: Direction;
  fwdRet: number;
  // 市場条件
  breadth: number | null;
  breadthBand: string;
  vix: number | null;
  vixRegime: string;
  n225AboveSma50: boolean | null;
}

// ──────────────────────────────────────────
// 集計ユーティリティ
// ──────────────────────────────────────────

function pct(n: number, d: number): string {
  if (d === 0) return "  -  ";
  return `${((n / d) * 100).toFixed(1)}%`;
}

/** 予測器 × 部分集合 の的中率を計算 */
function hitRate(
  rows: PredRow[],
  predictorName: string,
): { n: number; hit: number; rate: number } {
  let n = 0;
  let hit = 0;
  for (const r of rows) {
    const p = r.preds[predictorName];
    if (p == null) continue;
    n++;
    if (p === r.label) hit++;
  }
  return { n, hit, rate: n === 0 ? 0 : hit / n };
}

/** majority-class（常に多数派方向を張る）の的中率 = max(P(up), P(down)) */
function majorityBaseline(rows: PredRow[]): {
  pUp: number;
  majority: number;
  majorityDir: Direction;
} {
  if (rows.length === 0) return { pUp: 0, majority: 0, majorityDir: "up" };
  const up = rows.filter((r) => r.label === "up").length;
  const pUp = up / rows.length;
  return {
    pUp,
    majority: Math.max(pUp, 1 - pUp),
    majorityDir: pUp >= 0.5 ? "up" : "down",
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ──────────────────────────────────────────
// メイン
// ──────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  const end = getArg(args, "--end") ?? dayjs().format("YYYY-MM-DD");
  const start =
    getArg(args, "--start") ??
    dayjs(end).subtract(18, "month").format("YYYY-MM-DD");
  const horizon = Number(getArg(args, "--horizon") ?? "5");
  const maxPrice = Number(getArg(args, "--max-price") ?? "2500");
  const sample = Number(getArg(args, "--sample") ?? "1");
  const csvPath = getArg(args, "--csv");
  const mine = args.includes("--mine");
  const minePayoffFlag = args.includes("--mine-payoff");
  const mineMinN = Number(getArg(args, "--min-n") ?? "2000");
  const mineDepth = Number(getArg(args, "--depth") ?? "2");

  console.log("=".repeat(64));
  console.log("チャート予測実験（N営業日後の方向 上/下）");
  console.log("=".repeat(64));
  console.log(`期間: ${start} → ${end}  / ホライズン: ${horizon}営業日`);
  console.log(`ユニバース: 価格 <= ¥${maxPrice.toLocaleString()}${sample > 1 ? ` / 1/${sample} サンプリング` : ""}`);

  // ── データ取得 ──
  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  let tickerCodes = stocks.length
    ? stocks.map((s) => s.tickerCode)
    : (
        await prisma.stockDailyBar.findMany({
          where: { market: "JP" },
          distinct: ["tickerCode"],
          select: { tickerCode: true },
        })
      ).map((s) => s.tickerCode);

  if (sample > 1) {
    // 決定論的サンプリング（ticker末尾数字の剰余）— 再現性のため乱数は使わない
    tickerCodes = tickerCodes.filter((t) => {
      let h = 0;
      for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      return h % sample === 0;
    });
  }
  console.log(`[data] ${tickerCodes.length}銘柄のデータ取得中...`);

  const rawData = await fetchHistoricalFromDB(tickerCodes, start, end);
  const vixData = await fetchVixFromDB(start, end);
  const indexData = await fetchIndexFromDB("^N225", start, end);

  // maxPrice フィルタ
  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPrice && b.close > 0)) {
      allData.set(ticker, bars);
    }
  }
  console.log(
    `[data] ${allData.size}銘柄（フィルタ後）, VIX ${vixData.size}日, N225 ${indexData.size}日`,
  );

  // ── 市場 breadth（各日 SMA25 上の銘柄割合）を全ユニバースから計算 ──
  const breadthAcc = new Map<string, { above: number; total: number }>();
  for (const bars of allData.values()) {
    for (let i = 0; i < bars.length; i++) {
      const sma25 = smaAt(bars, i, 25);
      if (sma25 == null) continue;
      const d = bars[i].date;
      const acc = breadthAcc.get(d) ?? { above: 0, total: 0 };
      acc.total++;
      if (bars[i].close > sma25) acc.above++;
      breadthAcc.set(d, acc);
    }
  }
  const breadthByDate = new Map<string, number>();
  for (const [d, acc] of breadthAcc) {
    if (acc.total >= 30) breadthByDate.set(d, acc.above / acc.total);
  }

  // ── N225 SMA50（各日、指数が SMA50 上か） ──
  const indexDates = [...indexData.keys()].sort();
  const indexAboveSma50 = new Map<string, boolean>();
  for (let i = 49; i < indexDates.length; i++) {
    let s = 0;
    for (let k = i - 49; k <= i; k++) s += indexData.get(indexDates[k])!;
    const sma50 = s / 50;
    indexAboveSma50.set(indexDates[i], indexData.get(indexDates[i])! > sma50);
  }

  // ── 予測ログ生成 ──
  const rows: PredRow[] = [];
  const startTs = dayjs(start);
  const endTs = dayjs(end);

  for (const [ticker, bars] of allData) {
    for (let i = 0; i < bars.length; i++) {
      const d = bars[i].date;
      const dTs = dayjs(d);
      if (dTs.isBefore(startTs) || dTs.isAfter(endTs)) continue;
      // ラベルに必要な未来足が存在するか
      const j = i + horizon;
      if (j >= bars.length) continue;
      // 価格帯フィルタ（予測日の終値）
      if (bars[i].close > maxPrice || bars[i].close <= 0) continue;

      const features = computeFeaturesAt(bars, i);
      // 主要特徴量が計算不能な行はスキップ（履歴不足）
      if (
        features.smaSlope25 == null ||
        features.mom20 == null ||
        features.rsi14 == null ||
        features.rangePos20 == null
      ) {
        continue;
      }

      const fwdRet = bars[j].close / bars[i].close - 1;
      const label: Direction = fwdRet > 0 ? "up" : "down";

      const preds: Record<string, Direction | null> = {};
      for (const p of PREDICTORS) preds[p.name] = p.predict(features);

      const breadth = breadthByDate.get(d) ?? null;
      const vix = vixData.get(d) ?? null;

      rows.push({
        date: d,
        ticker,
        price: bars[i].close,
        features,
        preds,
        label,
        fwdRet,
        breadth,
        breadthBand: breadthBandOf(breadth),
        vix,
        vixRegime: vixRegimeOf(vix),
        n225AboveSma50: indexAboveSma50.get(d) ?? null,
      });
    }
  }

  console.log(`[log] 予測サンプル数: ${rows.length.toLocaleString()}件\n`);
  if (rows.length === 0) {
    console.log("サンプルが0件です。期間・ユニバースを確認してください。");
    await prisma.$disconnect();
    return;
  }

  // ── A) ベースレート ──
  const base = majorityBaseline(rows);
  const avgFwd = rows.reduce((s, r) => s + r.fwdRet, 0) / rows.length;
  console.log("── A) ベースレート（無条件） ──");
  console.log(`P(up) = ${(base.pUp * 100).toFixed(1)}%  / P(down) = ${((1 - base.pUp) * 100).toFixed(1)}%`);
  console.log(
    `majority-class 的中率 = ${(base.majority * 100).toFixed(1)}%（常に「${base.majorityDir === "up" ? "上" : "下"}」と張るだけの素朴ベンチ）`,
  );
  console.log(`平均フォワードリターン(${horizon}日) = ${(avgFwd * 100).toFixed(2)}%`);
  console.log(
    "→ 予測器はこの majority-class を有意に超えて初めて「エッジあり」。以下の edge 列で判断する。\n",
  );

  // ── 条件マイニングモード ──
  if (mine || minePayoffFlag) {
    if (minePayoffFlag) {
      minePayoff(rows, { minN: mineMinN, depth: mineDepth, horizon });
    } else {
      mineConditions(rows, base.majority, {
        minN: mineMinN,
        depth: mineDepth,
        horizon,
      });
    }
    if (csvPath) {
      writeCsv(rows, csvPath);
      console.log(`\n[csv] 予測ログを書き出しました: ${csvPath}（${rows.length}行）`);
    }
    await prisma.$disconnect();
    return;
  }

  // ── B) 予測器スコアボード ──
  console.log("── B) 予測器スコアボード（全体） ──");
  console.log(
    `${"predictor".padEnd(22)}| ${"cover".padStart(6)} | ${"hit".padStart(6)} | ${"edge".padStart(7)} | 仮説`,
  );
  console.log("-".repeat(96));
  const scored = PREDICTORS.map((p) => {
    const hr = hitRate(rows, p.name);
    // その予測器がカバーする行だけで majority を測り、公平比較
    const covered = rows.filter((r) => r.preds[p.name] != null);
    const cbase = majorityBaseline(covered);
    return { p, hr, edge: hr.rate - cbase.majority, cover: hr.n };
  }).sort((a, b) => b.edge - a.edge);

  for (const s of scored) {
    const edgeStr = `${s.edge >= 0 ? "+" : ""}${(s.edge * 100).toFixed(1)}pp`;
    console.log(
      `${s.p.name.padEnd(22)}| ${pct(s.cover, rows.length).padStart(6)} | ${(s.hr.rate * 100).toFixed(1).padStart(5)}% | ${edgeStr.padStart(7)} | ${s.p.hypothesis}`,
    );
  }
  console.log(
    "\n※ edge = 予測器の的中率 − その予測器がカバーする行の majority-class 的中率。+なら素朴ベンチ超え。",
  );

  // ── C) 上位2予測器の条件別内訳 ──
  const top = scored.slice(0, 2);
  for (const s of top) {
    console.log(`\n── C) 条件別的中率: ${s.p.name}（edge ${(s.edge * 100).toFixed(1)}pp） ──`);
    printConditionBreakdown(rows, s.p.name);
  }

  // ── D) 特徴量ごとの方向バイアス（予測器に依存しない生のエッジ） ──
  console.log("\n── D) 特徴量 terciles ごとの P(up) と平均フォワードリターン ──");
  console.log("（P(up) が 50% から大きく外れる状態 = 方向を予測しやすいチャート状態）");
  printFeatureEdges(rows, horizon);

  // ── CSV 出力 ──
  if (csvPath) {
    writeCsv(rows, csvPath);
    console.log(`\n[csv] 予測ログを書き出しました: ${csvPath}（${rows.length}行）`);
  } else {
    console.log(
      "\n[csv] --csv <path> を付けると予測ログ全体をCSV保存できます（後日の再分析・LLM比較用）。",
    );
  }

  await prisma.$disconnect();
}

// ──────────────────────────────────────────
// C) 条件別内訳の印字
// ──────────────────────────────────────────

function printConditionBreakdown(rows: PredRow[], predictorName: string): void {
  const groupBy = (key: (r: PredRow) => string, order?: string[]) => {
    const groups = new Map<string, PredRow[]>();
    for (const r of rows) {
      const k = key(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    const keys = order
      ? order.filter((k) => groups.has(k))
      : [...groups.keys()].sort();
    for (const k of keys) {
      const g = groups.get(k)!;
      const hr = hitRate(g, predictorName);
      const b = majorityBaseline(g.filter((r) => r.preds[predictorName] != null));
      const edge = hr.rate - b.majority;
      console.log(
        `  ${k.padEnd(12)} n=${String(hr.n).padStart(6)}  hit=${(hr.rate * 100).toFixed(1).padStart(5)}%  base=${(b.majority * 100).toFixed(1).padStart(5)}%  edge=${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}pp`,
      );
    }
  };

  console.log(" [breadth帯]");
  groupBy((r) => r.breadthBand, ["<40%", "40-54%", "54-70%", ">=70%"]);
  console.log(" [VIXレジーム]");
  groupBy((r) => r.vixRegime, ["calm", "normal", "elevated", "high", "crisis"]);
  console.log(" [N225 vs SMA50]");
  groupBy((r) =>
    r.n225AboveSma50 == null ? "unknown" : r.n225AboveSma50 ? "above" : "below",
  );
}

// ──────────────────────────────────────────
// D) 特徴量エッジの印字
// ──────────────────────────────────────────

const FEATURE_KEYS: (keyof PredictionFeatures)[] = [
  "smaSlope25",
  "priceVsSma25",
  "priceVsSma75",
  "mom5",
  "mom20",
  "atrPct",
  "volRatio",
  "rangePos20",
  "distFromHigh20",
  "rsi14",
];

function printFeatureEdges(rows: PredRow[], horizon: number): void {
  console.log(
    `${"feature".padEnd(16)}| ${"bucket".padEnd(14)}| ${"n".padStart(6)} | ${"P(up)".padStart(6)} | ${`avgFwd${horizon}d`.padStart(9)}`,
  );
  console.log("-".repeat(64));
  for (const key of FEATURE_KEYS) {
    const vals = rows
      .map((r) => r.features[key])
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    if (vals.length < 30) continue;
    const q33 = quantile(vals, 1 / 3);
    const q66 = quantile(vals, 2 / 3);
    const buckets: { label: string; rows: PredRow[] }[] = [
      { label: `low <${q33.toFixed(3)}`, rows: [] },
      { label: "mid", rows: [] },
      { label: `high >${q66.toFixed(3)}`, rows: [] },
    ];
    for (const r of rows) {
      const v = r.features[key];
      if (v == null) continue;
      if (v <= q33) buckets[0].rows.push(r);
      else if (v <= q66) buckets[1].rows.push(r);
      else buckets[2].rows.push(r);
    }
    for (let bi = 0; bi < buckets.length; bi++) {
      const b = buckets[bi];
      if (b.rows.length === 0) continue;
      const up = b.rows.filter((r) => r.label === "up").length;
      const avgFwd =
        b.rows.reduce((s, r) => s + r.fwdRet, 0) / b.rows.length;
      console.log(
        `${(bi === 0 ? key : "").padEnd(16)}| ${b.label.padEnd(14)}| ${String(b.rows.length).padStart(6)} | ${pct(up, b.rows.length).padStart(6)} | ${(avgFwd * 100).toFixed(2).padStart(8)}%`,
      );
    }
  }
}

// ──────────────────────────────────────────
// 条件マイニング（subgroup discovery + 前後半 安定性チェック）
// ──────────────────────────────────────────

interface MineVar {
  name: string;
  of: (r: PredRow) => string | null;
}

interface Cell {
  n: number;
  up: number;
  fwd: number;
  n0: number;
  up0: number; // 前半
  n1: number;
  up1: number; // 後半
}

/** マイニング対象の特徴量（パネルDで方向バイアスが見えたものを中心に） */
const MINE_FEATURES: (keyof PredictionFeatures)[] = [
  "mom20",
  "rsi14",
  "priceVsSma25",
  "atrPct",
  "distFromHigh20",
  "volRatio",
];

/** 条件変数（市場3つ + 特徴量terciles）と前後半分割日を構築（方向/ペイオフ両マイニングで共通） */
function buildMineVars(rows: PredRow[]): {
  vars: MineVar[];
  splitDate: string;
} {
  const cut: Record<string, { q33: number; q66: number }> = {};
  for (const key of MINE_FEATURES) {
    const vals = rows
      .map((r) => r.features[key])
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    cut[key] = { q33: quantile(vals, 1 / 3), q66: quantile(vals, 2 / 3) };
  }
  const ter = (v: number | null, key: string): string | null =>
    v == null ? null : v <= cut[key].q33 ? "low" : v <= cut[key].q66 ? "mid" : "high";

  const vars: MineVar[] = [
    { name: "breadth", of: (r) => (r.breadthBand === "unknown" ? null : r.breadthBand) },
    { name: "vix", of: (r) => (r.vixRegime === "unknown" ? null : r.vixRegime) },
    {
      name: "n225",
      of: (r) => (r.n225AboveSma50 == null ? null : r.n225AboveSma50 ? "above" : "below"),
    },
    ...MINE_FEATURES.map((key) => ({
      name: key as string,
      of: (r: PredRow) => ter(r.features[key], key),
    })),
  ];

  const dates = rows.map((r) => r.date).sort();
  const splitDate = dates[Math.floor(dates.length / 2)];
  return { vars, splitDate };
}

/** 変数インデックスの組み合わせ（サイズ 1..depth） */
function enumerateVarCombos(nVars: number, depth: number): number[][] {
  const combos: number[][] = [];
  const rec = (startI: number, cur: number[]) => {
    if (cur.length >= 1) combos.push([...cur]);
    if (cur.length === depth) return;
    for (let i = startI; i < nVars; i++) {
      cur.push(i);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);
  return combos;
}

function mineConditions(
  rows: PredRow[],
  baseMajority: number,
  opts: { minN: number; depth: number; horizon: number },
): void {
  const { minN, depth } = opts;

  const { vars, splitDate } = buildMineVars(rows);
  const combos = enumerateVarCombos(vars.length, depth);

  // セル集計（1パス）
  const cells = new Map<string, Cell>();
  for (const r of rows) {
    const labels = vars.map((v) => v.of(r));
    const upv = r.label === "up" ? 1 : 0;
    const isFirstHalf = r.date <= splitDate;
    for (const combo of combos) {
      let ok = true;
      for (const idx of combo) {
        if (labels[idx] == null) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const key = combo.map((idx) => `${vars[idx].name}:${labels[idx]}`).join(" & ");
      let c = cells.get(key);
      if (!c) {
        c = { n: 0, up: 0, fwd: 0, n0: 0, up0: 0, n1: 0, up1: 0 };
        cells.set(key, c);
      }
      c.n++;
      c.up += upv;
      c.fwd += r.fwdRet;
      if (isFirstHalf) {
        c.n0++;
        c.up0 += upv;
      } else {
        c.n1++;
        c.up1 += upv;
      }
    }
  }

  // 評価
  interface Scored {
    key: string;
    depth: number;
    n: number;
    pUp: number;
    dir: Direction;
    condAcc: number;
    edge: number;
    avgFwd: number;
    pUp0: number;
    pUp1: number;
    stable: boolean;
  }
  const scored: Scored[] = [];
  for (const [key, c] of cells) {
    if (c.n < minN) continue;
    const pUp = c.up / c.n;
    const condAcc = Math.max(pUp, 1 - pUp);
    const dir: Direction = pUp >= 0.5 ? "up" : "down";
    const pUp0 = c.n0 > 0 ? c.up0 / c.n0 : NaN;
    const pUp1 = c.n1 > 0 ? c.up1 / c.n1 : NaN;
    // 安定 = 前後半で同方向 かつ 両半で majority ベンチ超え
    const halfMinN = Math.max(200, Math.floor(minN / 3));
    const sameDir =
      (pUp0 >= 0.5) === (pUp1 >= 0.5) && (pUp >= 0.5) === (pUp0 >= 0.5);
    const bothBeat =
      Math.max(pUp0, 1 - pUp0) > baseMajority &&
      Math.max(pUp1, 1 - pUp1) > baseMajority;
    const stable = c.n0 >= halfMinN && c.n1 >= halfMinN && sameDir && bothBeat;
    scored.push({
      key,
      depth: key.split(" & ").length,
      n: c.n,
      pUp,
      dir,
      condAcc,
      edge: condAcc - baseMajority,
      avgFwd: c.fwd / c.n,
      pUp0,
      pUp1,
      stable,
    });
  }

  console.log(
    `── 条件マイニング（depth<=${depth}, minN=${minN}, セル数=${scored.length} / 全生成=${cells.size}） ──`,
  );
  console.log(
    `ベンチ（無条件 majority-class）= ${(baseMajority * 100).toFixed(1)}%。edge>0 かつ stable=✓ のみ実用候補。`,
  );

  const fmtRow = (s: Scored) => {
    const edgeStr = `${s.edge >= 0 ? "+" : ""}${(s.edge * 100).toFixed(1)}pp`;
    return (
      `${s.stable ? "✓" : " "} ${s.dir === "up" ? "↑" : "↓"} ` +
      `n=${String(s.n).padStart(6)} ` +
      `acc=${(s.condAcc * 100).toFixed(1).padStart(5)}% ` +
      `edge=${edgeStr.padStart(7)} ` +
      `fwd=${(s.avgFwd * 100).toFixed(2).padStart(6)}% ` +
      `[前${(s.pUp0 * 100).toFixed(0)}%/後${(s.pUp1 * 100).toFixed(0)}% up] ` +
      `${s.key}`
    );
  };

  console.log("\n【1】edge 上位30（生の発見。stable✓でないものは前後半で崩れる＝偶然の可能性）");
  scored
    .slice()
    .sort((a, b) => b.edge - a.edge)
    .slice(0, 30)
    .forEach((s) => console.log("  " + fmtRow(s)));

  console.log("\n【2】安定セル（前後半とも同方向・ベンチ超え）を edge 順で上位20 = 信頼できる条件");
  const stableCells = scored.filter((s) => s.stable).sort((a, b) => b.edge - a.edge);
  if (stableCells.length === 0) {
    console.log("  該当なし。→ 単一チャート条件では前後半で再現する方向エッジは見つからず。");
  } else {
    stableCells.slice(0, 20).forEach((s) => console.log("  " + fmtRow(s)));
  }

  console.log(
    `\n※ 分割日=${splitDate}（前後半ほぼ同数）。stable は「前後半とも同方向 & 両半でベンチ超え」。` +
      "\n※ 多重検定に注意: 大量セルを試すと偶然の極端値が混じる。stable✓ かつ深さが浅い（条件が少ない）ものを優先。",
  );
}

// ──────────────────────────────────────────
// ペイオフ条件マイニング（的中率でなく avgFwd / 右裾で条件を探す）
// ──────────────────────────────────────────
//
// 損小利大の戦略にとって重要なのは「当たる確率」でなく「乗った時のリターンと
// 右裾（大勝ちの出やすさ）」。方向マイニングと同じセル列挙で、集計対象を
// フォワードリターン（buy&hold H日、ストップ未考慮のプロキシ）に差し替える。
//
// ※ これは "5日 buy&hold" の生の分布であり、実際の GU/PSC 出口（ATRストップ+
//    トレール）とは異なる。あくまで「どの条件で raw ドリフト/歪度が有利か」の
//    スクリーニング。採用判断は必ず combined BT + WF を通すこと。

interface PayoffCell {
  n: number;
  sum: number;
  win: number; // fwd > 0 の数
  n0: number;
  sum0: number; // 前半
  n1: number;
  sum1: number; // 後半
}

function minePayoff(
  rows: PredRow[],
  opts: { minN: number; depth: number; horizon: number },
): void {
  const { minN, depth, horizon } = opts;
  const { vars, splitDate } = buildMineVars(rows);
  const combos = enumerateVarCombos(vars.length, depth);

  const baseMean = rows.reduce((s, r) => s + r.fwdRet, 0) / rows.length;

  // Pass1: n / sum / win / 前後半（配列は持たず軽量）
  const cells = new Map<string, PayoffCell>();
  const cellPreds = new Map<string, { vi: number; val: string }[]>();
  for (const r of rows) {
    const labels = vars.map((v) => v.of(r));
    const isFirst = r.date <= splitDate;
    const win = r.fwdRet > 0 ? 1 : 0;
    for (const combo of combos) {
      let ok = true;
      for (const idx of combo) {
        if (labels[idx] == null) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const key = combo.map((idx) => `${vars[idx].name}:${labels[idx]}`).join(" & ");
      let c = cells.get(key);
      if (!c) {
        c = { n: 0, sum: 0, win: 0, n0: 0, sum0: 0, n1: 0, sum1: 0 };
        cells.set(key, c);
        cellPreds.set(
          key,
          combo.map((idx) => ({ vi: idx, val: labels[idx]! })),
        );
      }
      c.n++;
      c.sum += r.fwdRet;
      c.win += win;
      if (isFirst) {
        c.n0++;
        c.sum0 += r.fwdRet;
      } else {
        c.n1++;
        c.sum1 += r.fwdRet;
      }
    }
  }

  interface Scored {
    key: string;
    depth: number;
    n: number;
    mean: number;
    winRate: number;
    mean0: number;
    mean1: number;
    stable: boolean;
  }
  const survivors: Scored[] = [];
  for (const [key, c] of cells) {
    if (c.n < minN) continue;
    const mean = c.sum / c.n;
    const mean0 = c.n0 > 0 ? c.sum0 / c.n0 : NaN;
    const mean1 = c.n1 > 0 ? c.sum1 / c.n1 : NaN;
    const halfMinN = Math.max(200, Math.floor(minN / 3));
    // 安定 = 前後半とも「無条件平均リターンを上回る」かつ同符号
    const stable =
      c.n0 >= halfMinN &&
      c.n1 >= halfMinN &&
      mean0 > baseMean &&
      mean1 > baseMean &&
      mean0 > 0 === mean1 > 0;
    survivors.push({
      key,
      depth: key.split(" & ").length,
      n: c.n,
      mean,
      winRate: c.win / c.n,
      mean0,
      mean1,
      stable,
    });
  }

  // 印字対象（mean上位25 ∪ stable上位15）に限り、Pass2で分位点を計算
  const byMean = survivors.slice().sort((a, b) => b.mean - a.mean);
  const stableByMean = survivors.filter((s) => s.stable).sort((a, b) => b.mean - a.mean);
  const printKeys = new Set<string>([
    ...byMean.slice(0, 25).map((s) => s.key),
    ...stableByMean.slice(0, 15).map((s) => s.key),
  ]);

  // Pass2: 印字対象セルのみ fwdRet 配列を集めて p10/median/p90
  const arrs = new Map<string, number[]>();
  for (const k of printKeys) arrs.set(k, []);
  for (const r of rows) {
    const labels = vars.map((v) => v.of(r));
    for (const key of printKeys) {
      const preds = cellPreds.get(key)!;
      let ok = true;
      for (const p of preds) {
        if (labels[p.vi] !== p.val) {
          ok = false;
          break;
        }
      }
      if (ok) arrs.get(key)!.push(r.fwdRet);
    }
  }
  const stats = (key: string) => {
    const a = arrs.get(key)!.slice().sort((x, y) => x - y);
    return {
      p10: quantile(a, 0.1),
      median: quantile(a, 0.5),
      p90: quantile(a, 0.9),
    };
  };

  console.log(
    `── ペイオフ条件マイニング（depth<=${depth}, minN=${minN}, セル数=${survivors.length} / 全生成=${cells.size}） ──`,
  );
  console.log(
    `無条件 平均フォワード(${horizon}日)=${(baseMean * 100).toFixed(2)}%。mean が これを有意に上回り stable=✓ が実用候補。`,
  );

  const fmt = (s: Scored) => {
    const st = stats(s.key);
    const tail = st.p10 !== 0 ? st.p90 / Math.abs(st.p10) : NaN;
    return (
      `${s.stable ? "✓" : " "} ` +
      `n=${String(s.n).padStart(6)} ` +
      `mean=${(s.mean * 100).toFixed(2).padStart(6)}% ` +
      `med=${(st.median * 100).toFixed(2).padStart(6)}% ` +
      `win=${(s.winRate * 100).toFixed(0).padStart(3)}% ` +
      `p90=${(st.p90 * 100).toFixed(1).padStart(5)}% p10=${(st.p10 * 100).toFixed(1).padStart(6)}% ` +
      `tail=${Number.isFinite(tail) ? tail.toFixed(2) : "n/a"} ` +
      `[前${(s.mean0 * 100).toFixed(2)}%/後${(s.mean1 * 100).toFixed(2)}%] ` +
      `${s.key}`
    );
  };

  console.log("\n【1】平均フォワードリターン 上位25（右裾が太い＝損小利大で伸ばせる条件の候補）");
  byMean.slice(0, 25).forEach((s) => console.log("  " + fmt(s)));

  console.log("\n【2】安定セル（前後半とも無条件平均超え）を mean 順で上位15 = 信頼できる条件");
  if (stableByMean.length === 0) {
    console.log("  該当なし。→ 前後半で再現するペイオフ優位な条件は見つからず。");
  } else {
    stableByMean.slice(0, 15).forEach((s) => console.log("  " + fmt(s)));
  }

  console.log(
    `\n※ mean=平均フォワード, med=中央値, win=P(fwd>0), p90/p10=右裾/左裾, tail=p90/|p10|(>1で右肩上がり)。` +
      `\n※ これは ${horizon}日 buy&hold の生分布（ストップ未考慮）。実採用は combined BT + WF 必須（却下リスト参照）。` +
      `\n※ 分割日=${splitDate}。多重検定注意: stable✓ かつ浅い条件を優先。`,
  );
}

// ──────────────────────────────────────────
// CSV 出力
// ──────────────────────────────────────────

function writeCsv(rows: PredRow[], path: string): void {
  const featureKeys = Object.keys(rows[0].features) as (keyof PredictionFeatures)[];
  const predKeys = PREDICTORS.map((p) => p.name);
  const header = [
    "date",
    "ticker",
    "price",
    "label",
    "fwdRet",
    "breadth",
    "breadthBand",
    "vix",
    "vixRegime",
    "n225AboveSma50",
    ...featureKeys.map((k) => `f_${k}`),
    ...predKeys.map((k) => `p_${k}`),
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    const cells = [
      r.date,
      r.ticker,
      r.price,
      r.label,
      r.fwdRet.toFixed(5),
      r.breadth != null ? r.breadth.toFixed(4) : "",
      r.breadthBand,
      r.vix != null ? r.vix.toFixed(2) : "",
      r.vixRegime,
      r.n225AboveSma50 == null ? "" : r.n225AboveSma50 ? "1" : "0",
      ...featureKeys.map((k) => {
        const v = r.features[k];
        return v == null ? "" : v.toFixed(5);
      }),
      ...predKeys.map((k) => r.preds[k] ?? ""),
    ];
    lines.push(cells.join(","));
  }
  writeFileSync(path, lines.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
