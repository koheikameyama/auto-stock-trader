/**
 * 使い捨て検証スクリプト: 本番の「寄り35分バー」決済 vs BT の「フル日足バー」決済
 *
 * 問い: 本番 position-monitor の最初の tick (09:35) は当日の寄り35分ぶんの
 *   high/low しか知らない。一方 BT は1日1本のフル日足 (その日の最終的な high/low) で
 *   判定する。トレール = maxHigh - trail*ATR なので、本番のトレールは構造的に
 *   BT より低くなり、決済価格も低くなるはず。その差を実測する。
 *
 * 方法: 3シナリオを比較して差分を2成分に分解する。
 *   (C) 実約定       : ブローカー約定価格（本番が実際に取った値）
 *   (B) 建値シード    : maxHigh=建値スタート + 決済日フル日足 → 「バー切り詰め」だけの効果
 *   (A) BT忠実       : maxHigh=エントリー日の日足高値スタート + 決済日フル日足 → BTの実挙動
 *
 *   A vs B = 「BTがエントリー日の高値でトレールをシードしている」効果
 *   B vs C = 「本番の09:35は寄り35分ぶんのバーしか見ていない」効果
 *
 * ★重要な発見: BT (combined-simulation.ts:423-433) は holdingDays===0 の日に
 *   maxHighDuringHold = max(建値, その日の日足高値) をシードする。しかし GU/PSC は
 *   その日の「引け」でエントリーするので、その高値は**買う前**に付けた高値である。
 *   本番 position-monitor はこれを明示的に避けている
 *   （isEntryDay は current price のみ使用 + 猶予期間スキップ、position-monitor.ts:565/687）。
 *   つまり本番の方が正しく、BT はトレールを買う前の高値でシードしている疑いがある。
 *
 * 重要: PSC の trailMultiplier は 2026-07-15 13:22 に 0.5 → 0.3 へ変更された (9d29cc2a)。
 *   現行定数で回すと過去の決済を再現できないため、各トレードが実際に使った倍率を
 *   exitSnapshot から逆算する: trailMult = (maxHigh - finalTrailingStopPrice) / entryAtr
 *   （建値フロアがクランプした場合は逆算不能なので、その旨を出力して定数フォールバック）
 *
 * 先読みなし: 決済日の日足は決済時点では未確定だが、本スクリプトは「BTが見ていた情報」を
 *   再現するのが目的なので意図的に使う。本番ロジックの変更提案には使わない（測定のみ）。
 * 本番影響なし: 読み取り専用。
 *
 * 実行: DATABASE_URL=<prod> npx tsx src/backtest/_live-vs-bt-exit-bar.ts
 */
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { prisma } from "../lib/prisma";
import { checkPositionExit } from "../core/exit-checker";
import { TRAILING_STOP } from "../lib/constants";
import type { TradingStrategy } from "../core/market-regime";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Asia/Tokyo";

interface Row {
  ticker: string;
  strategy: string;
  exitJst: string;
  entry: number;
  atr: number;
  liveExit: number;
  liveReason: string;
  liveMaxHigh: number | null;
  liveTrail: number | null;
  trailMult: number | null;
  trailMultSource: string;
  btExit: number | null;
  btReason: string | null;
  btSeedHigh: number;
  seedEntryExit: number | null;
  seedEntryReason: string | null;
  entryDayHigh: number;
  dayHigh: number;
  dayLow: number;
  dayClose: number;
  qty: number;
}


async function main() {
  const positions = await prisma.tradingPosition.findMany({
    where: { status: "closed", exitPrice: { not: null }, exitedAt: { not: null } },
    include: { stock: { select: { tickerCode: true, name: true } } },
    orderBy: { exitedAt: "asc" },
  });

  console.log(`クローズ済みポジション: ${positions.length}件\n`);

  const rows: Row[] = [];
  const skipped: string[] = [];

  for (const p of positions) {
    const ticker = p.stock.tickerCode;
    const entry = Number(p.entryPrice);
    const liveExit = Number(p.exitPrice);
    const snap = (p.exitSnapshot ?? {}) as Record<string, unknown>;
    const liveReason = String(snap.exitReason ?? "?");

    // us_etf / panic は position-monitor のトレール対象外（固定SL + 専用モニター）
    if (p.strategy === "us_etf" || p.strategy === "panic") {
      skipped.push(`${ticker}: 戦略 ${p.strategy} はトレール対象外`);
      continue;
    }

    // 1泊保有 = 決済日の初期状態が「maxHigh = 建値」であるものだけがBTと同じ初期状態
    const maxHighStored = p.maxHighDuringHold ? Number(p.maxHighDuringHold) : entry;
    if (Math.abs(maxHighStored - entry) > 0.001) {
      skipped.push(`${ticker}: maxHighDuringHold(${maxHighStored}) != 建値(${entry}) = 複数日保有、初期状態を再現不能`);
      continue;
    }

    const atr = p.entryAtr ? Number(p.entryAtr) : NaN;
    if (!Number.isFinite(atr) || atr <= 0) {
      skipped.push(`${ticker}: entryAtr が無い（%フォールバックで動いていた）`);
      continue;
    }

    const exitJst = dayjs(p.exitedAt!).tz(TZ);
    const exitDateStr = exitJst.format("YYYY-MM-DD");
    const entryDateStr = dayjs(p.createdAt).tz(TZ).format("YYYY-MM-DD");

    // 決済日のフル日足
    const bar = await prisma.stockDailyBar.findFirst({
      where: { tickerCode: ticker, date: new Date(`${exitDateStr}T00:00:00Z`) },
    });
    if (!bar) {
      skipped.push(`${ticker} ${exitDateStr}: StockDailyBar なし（当日の足が未確定）`);
      continue;
    }

    // エントリー日のフル日足（BT が maxHigh をシードするのに使う足）
    const entryBar = await prisma.stockDailyBar.findFirst({
      where: { tickerCode: ticker, date: new Date(`${entryDateStr}T00:00:00Z`) },
    });
    if (!entryBar) {
      skipped.push(`${ticker} ${entryDateStr}: エントリー日の StockDailyBar なし`);
      continue;
    }
    // BT: combined-simulation.ts:423-433 と同じシード（買う前の高値を含む）
    const btSeedHigh = Math.max(entry, entryBar.high);

    // 実際に使われた trailMultiplier を snapshot から逆算
    const ts = (snap.trailingStop ?? {}) as Record<string, unknown>;
    const journey = (snap.priceJourney ?? {}) as Record<string, unknown>;
    const liveMaxHigh = typeof journey.maxHigh === "number" ? journey.maxHigh : null;
    const liveTrail =
      typeof ts.finalTrailingStopPrice === "number" ? ts.finalTrailingStopPrice : null;

    let trailMult: number | null = null;
    let trailMultSource = "定数フォールバック";
    if (liveMaxHigh !== null && liveTrail !== null) {
      const derived = (liveMaxHigh - liveTrail) / atr;
      // 建値フロアがクランプすると trail = 建値 になり逆算値が壊れるので、
      // フロアに張り付いていない場合のみ採用する
      if (derived > 0.01 && Math.abs(liveTrail - entry) > 0.5) {
        trailMult = Math.round(derived * 100) / 100;
        trailMultSource = "snapshot逆算";
      }
    }
    const effTrailMult =
      trailMult ?? TRAILING_STOP.TRAIL_ATR_MULTIPLIER[p.strategy as TradingStrategy];

    const runExit = (seedHigh: number, seedLow: number) =>
      checkPositionExit(
        {
          entryPrice: entry,
          takeProfitPrice: p.takeProfitPrice ? Number(p.takeProfitPrice) : entry * 1.1,
          stopLossPrice: p.stopLossPrice ? Number(p.stopLossPrice) : entry * 0.97,
          entryAtr: atr,
          maxHighDuringHold: seedHigh,
          minLowDuringHold: seedLow,
          currentTrailingStop: null,
          strategy: p.strategy as TradingStrategy,
          holdingBusinessDays: 1,
          trailMultiplierOverride: effTrailMult,
        },
        { open: bar.open, high: bar.high, low: bar.low, close: bar.close },
      );

    // (A) BT忠実: エントリー日の日足高値でシード（買う前の高値を含む）
    const btResult = runExit(btSeedHigh, Math.min(entry, entryBar.low));
    // (B) 建値シード: 本番と同じ初期状態 + フル日足 → バー切り詰めだけを分離
    const seedEntryResult = runExit(entry, entry);

    rows.push({
      ticker,
      strategy: p.strategy,
      exitJst: exitJst.format("MM-DD HH:mm"),
      entry,
      atr,
      liveExit,
      liveReason,
      liveMaxHigh,
      liveTrail,
      trailMult,
      trailMultSource,
      btExit: btResult.exitPrice,
      btReason: btResult.exitReason,
      btSeedHigh,
      seedEntryExit: seedEntryResult.exitPrice,
      seedEntryReason: seedEntryResult.exitReason,
      entryDayHigh: entryBar.high,
      dayHigh: bar.high,
      dayLow: bar.low,
      dayClose: bar.close,
      qty: p.quantity,
    });
  }

  console.log("=== スキップ ===");
  for (const s of skipped) console.log(`  - ${s}`);
  console.log(`\n=== 比較対象: ${rows.length}件 ===\n`);

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
  const pnl = (exit: number, r: Row) => (exit - r.entry) * r.qty;

  console.log(
    "銘柄     戦略  決済(JST)     建値  (C)実約定       (B)建値シード       (A)BT忠実          入日H  決日H  決日L  倍率",
  );
  for (const r of rows) {
    const f = (v: number | null, reason: string | null) =>
      v === null ? "   保有継続      " : `${String(v).padStart(6)} ${(reason ?? "").slice(0, 10).padEnd(10)}`;
    console.log(
      [
        r.ticker.padEnd(8),
        r.strategy.slice(0, 4).padEnd(5),
        r.exitJst.padEnd(13),
        String(r.entry).padStart(6),
        `${String(r.liveExit).padStart(6)} ${(r.liveReason.includes("トレーリング") ? "trail" : r.liveReason.includes("SL") || r.liveReason.includes("損切") ? "SL" : "?").padEnd(10)}`,
        f(r.seedEntryExit, r.seedEntryReason),
        f(r.btExit, r.btReason),
        String(r.entryDayHigh).padStart(6),
        String(r.dayHigh).padStart(6),
        String(r.dayLow).padStart(6),
        String(r.trailMult ?? `${r.trailMultSource === "snapshot逆算" ? "" : "定"}-`).padStart(5),
      ].join(" "),
    );
  }

  const comparable = rows.filter((r) => r.btExit !== null && r.seedEntryExit !== null);

  console.log(`\n=== 総損益 gross（比較可能 ${comparable.length}件）===`);
  const liveGross = sum(comparable.map((r) => pnl(r.liveExit, r)));
  const seedEntryGross = sum(comparable.map((r) => pnl(r.seedEntryExit!, r)));
  const btGross = sum(comparable.map((r) => pnl(r.btExit!, r)));
  console.log(`  (C) 実約定                        : ¥${liveGross.toFixed(0)}`);
  console.log(`  (B) 建値シード + フル日足          : ¥${seedEntryGross.toFixed(0)}`);
  console.log(`  (A) BT忠実(入日高値シード + 日足)  : ¥${btGross.toFixed(0)}`);

  console.log("\n=== 差分の分解 ===");
  const barEffect = comparable.map((r) => pnl(r.seedEntryExit!, r) - pnl(r.liveExit, r));
  const seedEffect = comparable.map((r) => pnl(r.btExit!, r) - pnl(r.seedEntryExit!, r));
  console.log(`  B−C「本番は寄り35分バーしか見ていない」効果 : ¥${sum(barEffect).toFixed(0)} (平均 ¥${mean(barEffect).toFixed(0)}/件)`);
  console.log(`    → BTが有利 ${barEffect.filter((d) => d > 0).length}件 / 本番が有利 ${barEffect.filter((d) => d < 0).length}件 / 同値 ${barEffect.filter((d) => d === 0).length}件`);
  console.log(`  A−B「BTが買う前の高値でトレールをシード」効果: ¥${sum(seedEffect).toFixed(0)} (平均 ¥${mean(seedEffect).toFixed(0)}/件)`);
  console.log(`    → BTが有利 ${seedEffect.filter((d) => d > 0).length}件 / 不利 ${seedEffect.filter((d) => d < 0).length}件 / 同値 ${seedEffect.filter((d) => d === 0).length}件`);

  const seedInflated = comparable.filter((r) => r.btSeedHigh > r.entry + 0.001);
  console.log(`\n  エントリー日の高値 > 建値 だった件数: ${seedInflated.length}/${comparable.length}件`);
  console.log(`    （この件数ぶん BT は買う前の高値でトレールをシードしている）`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
