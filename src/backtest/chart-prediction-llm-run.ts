/**
 * チャート予測実験（LLM版）
 *
 * 「人間的なチャート分析（LLM）は、機械的な数値ベースライン＋レジームを超える
 *  独立した予測力を持つか？」を検証する。
 *
 * 設計（バイアス排除）:
 *   - LLM には銘柄コード・日付を一切渡さない（匿名化）。直近60本の OHLCV と
 *     指標スナップショットだけを見せる → 学習知識でのカンニングを封じる
 *   - 予測日 t までの足しか見せない（未来足ゼロ）。ラベルは close[t+H] で付与
 *   - 数値ベースライン（chart-prediction-features.ts の PREDICTORS）と
 *     「同一サンプル」で的中率を突き合わせる
 *
 * Usage:
 *   npm run backtest:chart-prediction-llm -- --n 300
 *   npm run backtest:chart-prediction-llm -- --n 300 --model gpt-4o --start 2025-01-01 --end 2026-06-30
 *   npm run backtest:chart-prediction-llm -- --n 200 --csv /tmp/llm-pred.csv
 */

import { writeFileSync } from "node:fs";
import dayjs from "dayjs";
import pLimit from "p-limit";
import { prisma } from "../lib/prisma";
import { chatCompletion } from "../lib/openai";
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
} from "./chart-prediction-features";

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

// 決定論的 PRNG（再現性のため。通常の tsx 実行では Math.random 可だが seed 固定で再現可能に）
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function vixRegimeOf(v: number | null): string {
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
// 匿名化チャートテキストの生成
// ──────────────────────────────────────────

/**
 * 直近 lookback 本の OHLCV を匿名化テキスト化する。
 * 銘柄名・日付は出さず、相対インデックス t-59..t0 で表現。
 */
function formatChartText(
  bars: OHLCVData[],
  i: number,
  lookback: number,
): string {
  const start = Math.max(0, i - lookback + 1);
  const lines: string[] = [];
  lines.push("直近営業日のOHLCV（t0=最新、古い順→新しい順、価格は円、Vは出来高）:");
  for (let k = start; k <= i; k++) {
    const rel = i - k; // 0 = 最新
    lines.push(
      `t-${String(rel).padStart(2, "0")}: O=${bars[k].open} H=${bars[k].high} L=${bars[k].low} C=${bars[k].close} V=${bars[k].volume}`,
    );
  }
  // 指標スナップショット（予測日 t までで計算）
  const f = computeFeaturesAt(bars, i);
  const sma5 = smaAt(bars, i, 5);
  const sma25 = smaAt(bars, i, 25);
  const sma75 = smaAt(bars, i, 75);
  const pctOrNa = (v: number | null, digits = 1) =>
    v == null ? "n/a" : `${(v * 100).toFixed(digits)}%`;
  lines.push("");
  lines.push("指標スナップショット（最新時点）:");
  lines.push(`  終値=${bars[i].close}  SMA5=${sma5?.toFixed(1) ?? "n/a"}  SMA25=${sma25?.toFixed(1) ?? "n/a"}  SMA75=${sma75?.toFixed(1) ?? "n/a"}`);
  lines.push(`  RSI14=${f.rsi14?.toFixed(1) ?? "n/a"}  ATR%=${pctOrNa(f.atrPct)}  出来高比(25日)=${f.volRatio?.toFixed(2) ?? "n/a"}x`);
  lines.push(`  5日モメンタム=${pctOrNa(f.mom5)}  20日モメンタム=${pctOrNa(f.mom20)}`);
  lines.push(`  SMA25乖離=${pctOrNa(f.priceVsSma25)}  20日高値からの距離=${pctOrNa(f.distFromHigh20)}  20日レンジ内位置=${f.rangePos20 != null ? (f.rangePos20 * 100).toFixed(0) + "%" : "n/a"}`);
  return lines.join("\n");
}

const SYSTEM_PROMPT =
  "あなたは経験豊富なプロの日本株スイングトレーダーです。" +
  "匿名化されたチャート情報（直近のOHLCVと指標）だけを見て、この銘柄が『最新の終値』から5営業日後に上昇するか下落するかを予測してください。" +
  "銘柄名・日付・業種は与えられません。チャートの形状・トレンド・モメンタム・出来高・位置関係のみで判断してください。" +
  "必ず up か down のどちらかを選びます。中立は許されません。" +
  'JSONのみで {"direction":"up"|"down","confidence":0.50-1.00,"reason":"25字以内"} を返してください。';

type LlmStatus = "ok" | "parse_fail" | "api_fail";

interface LlmResult {
  direction: Direction | null;
  confidence: number | null;
  status: LlmStatus;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function predictWithLlm(
  chartText: string,
  model: string,
  maxRetries = 5,
): Promise<LlmResult> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let raw: string;
    try {
      raw = await chatCompletion(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: chartText },
        ],
        { temperature: 0, maxTokens: 400, model },
      );
    } catch {
      // API エラー（レート制限429/5xx等）→ 指数バックオフでリトライ
      if (attempt === maxRetries)
        return { direction: null, confidence: null, status: "api_fail" };
      const backoff = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 400;
      await sleep(backoff);
      continue;
    }
    // API 応答は得られた → パース
    try {
      const parsed = JSON.parse(raw);
      const dir =
        parsed.direction === "up" || parsed.direction === "down"
          ? (parsed.direction as Direction)
          : null;
      if (dir == null)
        return { direction: null, confidence: null, status: "parse_fail" };
      const conf =
        typeof parsed.confidence === "number" ? parsed.confidence : null;
      return { direction: dir, confidence: conf, status: "ok" };
    } catch {
      return { direction: null, confidence: null, status: "parse_fail" };
    }
  }
  return { direction: null, confidence: null, status: "api_fail" };
}

// ──────────────────────────────────────────
// サンプル行
// ──────────────────────────────────────────

interface SampleRow {
  ticker: string;
  date: string;
  price: number;
  label: Direction;
  fwdRet: number;
  numericPreds: Record<string, Direction | null>;
  breadthBand: string;
  vixRegime: string;
  n225AboveSma50: boolean | null;
  chartText: string;
  llm: LlmResult;
}

function hitRateOf(
  rows: SampleRow[],
  pick: (r: SampleRow) => Direction | null,
): { n: number; rate: number } {
  let n = 0;
  let hit = 0;
  for (const r of rows) {
    const d = pick(r);
    if (d == null) continue;
    n++;
    if (d === r.label) hit++;
  }
  return { n, rate: n === 0 ? 0 : hit / n };
}

// ──────────────────────────────────────────
// メイン
// ──────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const end = getArg(args, "--end") ?? "2026-06-30";
  const start = getArg(args, "--start") ?? "2025-01-01";
  const horizon = Number(getArg(args, "--horizon") ?? "5");
  const maxPrice = Number(getArg(args, "--max-price") ?? "2500");
  const n = Number(getArg(args, "--n") ?? "300");
  const model = getArg(args, "--model") ?? "gpt-4o";
  const concurrency = Number(getArg(args, "--concurrency") ?? "3");
  const seed = Number(getArg(args, "--seed") ?? "42");
  const lookback = Number(getArg(args, "--lookback") ?? "60");
  const csvPath = getArg(args, "--csv");

  console.log("=".repeat(64));
  console.log("チャート予測実験（LLM版・テキストチャート）");
  console.log("=".repeat(64));
  console.log(`期間: ${start} → ${end} / ホライズン: ${horizon}日 / モデル: ${model}`);
  console.log(`サンプル: ${n}件 / 匿名化チャート ${lookback}本 / seed=${seed}`);

  // ── データ取得 ──
  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
    orderBy: { tickerCode: "asc" }, // 銘柄順を固定してサンプリングを決定論化（seed再現性）
  });
  const tickerCodes = stocks.length
    ? stocks.map((s) => s.tickerCode)
    : (
        await prisma.stockDailyBar.findMany({
          where: { market: "JP" },
          distinct: ["tickerCode"],
          select: { tickerCode: true },
        })
      ).map((s) => s.tickerCode);

  const rawData = await fetchHistoricalFromDB(tickerCodes, start, end);
  const vixData = await fetchVixFromDB(start, end);
  const indexData = await fetchIndexFromDB("^N225", start, end);

  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPrice && b.close > 0)) {
      allData.set(ticker, bars);
    }
  }
  console.log(`[data] ${allData.size}銘柄（フィルタ後）, VIX ${vixData.size}日, N225 ${indexData.size}日`);

  // breadth / index SMA50
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
  for (const [d, acc] of breadthAcc)
    if (acc.total >= 30) breadthByDate.set(d, acc.above / acc.total);

  const indexDates = [...indexData.keys()].sort();
  const indexAboveSma50 = new Map<string, boolean>();
  for (let i = 49; i < indexDates.length; i++) {
    let s = 0;
    for (let k = i - 49; k <= i; k++) s += indexData.get(indexDates[k])!;
    indexAboveSma50.set(indexDates[i], indexData.get(indexDates[i])! > s / 50);
  }

  // ── 適格 (ticker, i) を軽量列挙（i>=80 で主要特徴量が計算可能） ──
  const startTs = dayjs(start);
  const endTs = dayjs(end);
  const eligible: { ticker: string; i: number }[] = [];
  for (const [ticker, bars] of allData) {
    for (let i = 80; i < bars.length; i++) {
      const d = bars[i].date;
      const dTs = dayjs(d);
      if (dTs.isBefore(startTs) || dTs.isAfter(endTs)) continue;
      if (i + horizon >= bars.length) continue;
      if (bars[i].close > maxPrice || bars[i].close <= 0) continue;
      eligible.push({ ticker, i });
    }
  }
  console.log(`[sample] 適格サンプル ${eligible.length.toLocaleString()}件から ${n}件を抽出`);

  // ── 決定論的サンプリング（seed 固定 Fisher-Yates で先頭 n 件） ──
  const rng = mulberry32(seed);
  for (let k = eligible.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [eligible[k], eligible[j]] = [eligible[j], eligible[k]];
  }
  const picked = eligible.slice(0, Math.min(n, eligible.length));

  // ── サンプル行を構築（LLM呼び出し前の準備） ──
  const rows: SampleRow[] = picked.map(({ ticker, i }) => {
    const bars = allData.get(ticker)!;
    const features = computeFeaturesAt(bars, i);
    const fwdRet = bars[i + horizon].close / bars[i].close - 1;
    const d = bars[i].date;
    const numericPreds: Record<string, Direction | null> = {};
    for (const p of PREDICTORS) numericPreds[p.name] = p.predict(features);
    return {
      ticker,
      date: d,
      price: bars[i].close,
      label: fwdRet > 0 ? "up" : "down",
      fwdRet,
      numericPreds,
      breadthBand: breadthBandOf(breadthByDate.get(d) ?? null),
      vixRegime: vixRegimeOf(vixData.get(d) ?? null),
      n225AboveSma50: indexAboveSma50.get(d) ?? null,
      chartText: formatChartText(bars, i, lookback),
      llm: { direction: null, confidence: null, status: "api_fail" as LlmStatus },
    };
  });

  // ── LLM 予測（並列） ──
  console.log(`[llm] ${model} で ${rows.length}件を予測中（並列 ${concurrency}）...`);
  const limit = pLimit(concurrency);
  let done = 0;
  await Promise.all(
    rows.map((r) =>
      limit(async () => {
        r.llm = await predictWithLlm(r.chartText, model);
        done++;
        if (done % 25 === 0) console.log(`  ...${done}/${rows.length}`);
      }),
    ),
  );

  // ── 集計 ──
  const parsed = rows.filter((r) => r.llm.status === "ok");
  const apiFails = rows.filter((r) => r.llm.status === "api_fail").length;
  const parseFails = rows.filter((r) => r.llm.status === "parse_fail").length;
  const pUp = rows.filter((r) => r.label === "up").length / rows.length;
  const baseMajority = Math.max(pUp, 1 - pUp);
  const majorityDir: Direction = pUp >= 0.5 ? "up" : "down";

  console.log("\n" + "=".repeat(64));
  console.log("結果");
  console.log("=".repeat(64));
  console.log(`サンプル ${rows.length}件 / 有効(ok) ${parsed.length}件 / APIエラー ${apiFails}件 / パース失敗 ${parseFails}件`);
  console.log(`P(up)=${(pUp * 100).toFixed(1)}%  majority-class ベンチ=${(baseMajority * 100).toFixed(1)}%（常に「${majorityDir === "up" ? "上" : "下"}」）`);

  // LLM 的中率（パース成功行のみ）
  const llmHr = hitRateOf(parsed, (r) => r.llm.direction);
  // 同一パース成功行での majority ベンチ
  const parsedPUp = parsed.filter((r) => r.label === "up").length / parsed.length;
  const parsedBase = Math.max(parsedPUp, 1 - parsedPUp);

  console.log("\n── 的中率スコアボード（LLMがパースできた同一サンプル上で比較） ──");
  const board: { name: string; hr: { n: number; rate: number } }[] = [
    { name: `LLM(${model})`, hr: llmHr },
    ...PREDICTORS.map((p) => ({
      name: p.name,
      hr: hitRateOf(parsed, (r) => r.numericPreds[p.name]),
    })),
  ].sort((a, b) => b.hr.rate - a.hr.rate);

  console.log(`${"predictor".padEnd(22)}| ${"cover".padStart(6)} | ${"hit".padStart(6)} | ${"edge".padStart(7)}`);
  console.log("-".repeat(50));
  for (const b of board) {
    const edge = b.hr.rate - parsedBase;
    console.log(
      `${b.name.padEnd(22)}| ${String(b.hr.n).padStart(6)} | ${(b.hr.rate * 100).toFixed(1).padStart(5)}% | ${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}pp`.padEnd(4),
    );
  }
  console.log(`\n※ edge = 的中率 − majority-class(${(parsedBase * 100).toFixed(1)}%)。LLMがこれを有意に超えれば「数値ベンチを超えるチャート読解力あり」。`);

  // LLM vs 最強数値予測器 の直接対決（意見が割れた行で誰が正しいか）
  const bestNumeric = board.find((b) => !b.name.startsWith("LLM"))!;
  const disagree = parsed.filter(
    (r) => r.llm.direction !== r.numericPreds[bestNumeric.name] && r.numericPreds[bestNumeric.name] != null,
  );
  if (disagree.length > 0) {
    const llmWins = disagree.filter((r) => r.llm.direction === r.label).length;
    console.log(
      `\n── LLM vs ${bestNumeric.name}（意見が割れた ${disagree.length}件） ──`,
    );
    console.log(
      `  LLM正解 ${llmWins}件 / ${bestNumeric.name}正解 ${disagree.length - llmWins}件（LLM勝率 ${((llmWins / disagree.length) * 100).toFixed(1)}%）`,
    );
  }

  // 条件別 LLM 的中率
  console.log("\n── 条件別 LLM 的中率 ──");
  const groupHit = (key: (r: SampleRow) => string, order?: string[]) => {
    const groups = new Map<string, SampleRow[]>();
    for (const r of parsed) {
      const k = key(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    const keys = order ? order.filter((k) => groups.has(k)) : [...groups.keys()].sort();
    for (const k of keys) {
      const g = groups.get(k)!;
      const hr = hitRateOf(g, (r) => r.llm.direction);
      const gp = g.filter((r) => r.label === "up").length / g.length;
      const gb = Math.max(gp, 1 - gp);
      console.log(
        `  ${k.padEnd(10)} n=${String(hr.n).padStart(4)}  LLM=${(hr.rate * 100).toFixed(1).padStart(5)}%  base=${(gb * 100).toFixed(1).padStart(5)}%  edge=${hr.rate - gb >= 0 ? "+" : ""}${((hr.rate - gb) * 100).toFixed(1)}pp`,
      );
    }
  };
  console.log(" [VIXレジーム]");
  groupHit((r) => r.vixRegime, ["calm", "normal", "elevated", "high", "crisis"]);
  console.log(" [breadth帯]");
  groupHit((r) => r.breadthBand, ["<40%", "40-54%", "54-70%", ">=70%"]);

  // 信頼度キャリブレーション
  console.log("\n── LLM信頼度 別 的中率（キャリブレーション） ──");
  const confBuckets = [
    { label: "0.50-0.60", lo: 0.5, hi: 0.6 },
    { label: "0.60-0.70", lo: 0.6, hi: 0.7 },
    { label: "0.70-0.80", lo: 0.7, hi: 0.8 },
    { label: "0.80-1.00", lo: 0.8, hi: 1.01 },
  ];
  for (const b of confBuckets) {
    const g = parsed.filter(
      (r) => r.llm.confidence != null && r.llm.confidence >= b.lo && r.llm.confidence < b.hi,
    );
    if (g.length === 0) continue;
    const hr = hitRateOf(g, (r) => r.llm.direction);
    console.log(`  conf ${b.label}  n=${String(hr.n).padStart(4)}  的中=${(hr.rate * 100).toFixed(1)}%`);
  }

  // CSV
  if (csvPath) {
    const header = [
      "ticker",
      "date",
      "price",
      "label",
      "fwdRet",
      "vixRegime",
      "breadthBand",
      "n225AboveSma50",
      "llm_dir",
      "llm_conf",
      ...PREDICTORS.map((p) => `p_${p.name}`),
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.ticker,
          r.date,
          r.price,
          r.label,
          r.fwdRet.toFixed(5),
          r.vixRegime,
          r.breadthBand,
          r.n225AboveSma50 == null ? "" : r.n225AboveSma50 ? "1" : "0",
          r.llm.direction ?? "",
          r.llm.confidence ?? "",
          ...PREDICTORS.map((p) => r.numericPreds[p.name] ?? ""),
        ].join(","),
      );
    }
    writeFileSync(csvPath, lines.join("\n"));
    console.log(`\n[csv] LLM予測ログを書き出しました: ${csvPath}（${rows.length}行）`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
