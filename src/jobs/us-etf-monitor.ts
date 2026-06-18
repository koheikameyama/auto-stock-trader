/**
 * 米株 ETF (1547, 1545) のエントリー / タイムストップ Exit 監視
 *
 * worker.ts の node-cron から 15:24 に呼ばれる（15:24:00/20/40 の3段リトライ）。
 * GU/PSC の gapup-monitor / psc-monitor と同じ
 * 「場中15:24・立花リアルタイム値で評価 → 引け成行で当日引けに約定」方式に統一し、
 * バックテスト前提（_us-etf-backtest-mvp.ts: entryPrice = today.close）と一致させる。
 *
 * - エントリー: 日本株 breadth < 54%(idle帯) のみ。gap≥0.5% + vol≥1.5x + 陽線で引け成行買い。
 * - Exit: strategy="us_etf" の open ポジが 5営業日経過なら引け成行売り(タイムストップ)。
 * - 約定 → TradingPosition 作成 + SL逆指値の別建ては既存 broker-fill-handler が処理（不変）。
 *
 * 旧 us-etf-entry-executor (翌朝寄付成行・GitHub Actions) / us-etf-position-monitor を統合・置換する。
 * MVP: 連敗スロットル/集中度/VIX scale は適用しない（ETF は補完戦略）。
 *      資金は環境変数 ETF_TRADING_BUDGET（デフォルト ¥500K）。
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/market-date";
import { tachibanaFetchQuotesBatch } from "../lib/tachibana-price-client";
import { submitOrder } from "../core/broker-orders";
import { TACHIBANA_ORDER } from "../lib/constants/broker";
import {
  detectUSEtfSignal,
  US_ETF_RISK_PARAMS,
  US_ETF_SIGNAL_DEFAULTS,
} from "../core/us-etf/entry-conditions";
import { MARKET_BREADTH } from "../lib/constants/trading";
import { GAPUP } from "../lib/constants/gapup";
import { TIMEZONE } from "../lib/constants";
import { notifySlack } from "../lib/slack";

dayjs.extend(utc);
dayjs.extend(timezone);

// `??` ではなく `||` で空文字列も fallback 対象にする（未設定 secret は "" になるため）
const BUDGET = parseInt(process.env.ETF_TRADING_BUDGET || "500000", 10);
const MAX_POSITION_PCT = 0.4; // 1ポジ最大40%
const VOL_LOOKBACK = 25;
const TICKERS = US_ETF_RISK_PARAMS.tickers;

/** スキャン済みフラグ（1日1回制限）。エントリーが retryable 失敗の時のみ未セットで次分リトライ */
let lastScanDate: string | null = null;

const tag = "[us-etf-monitor]";

/**
 * 米株ETFモニターのメイン処理（worker.ts 15:24 node-cron から呼ばれる）
 */
export async function main(): Promise<void> {
  // 戦略レベル ENTRY_ENABLED フラグ（エントリーのみ無効化。Exit は常に実行）
  const entryEnabled = US_ETF_RISK_PARAMS.entryEnabled;

  // 時刻チェック: 15:24以降のみ実行（gapup と同じガード）
  const jstNow = dayjs().tz(TIMEZONE);
  const scanStart = jstNow
    .clone()
    .hour(GAPUP.GUARD.SCAN_HOUR)
    .minute(GAPUP.GUARD.SCAN_MINUTE)
    .second(0)
    .millisecond(0);
  if (jstNow.isBefore(scanStart)) {
    return;
  }

  // 1日1回制限
  const today = jstNow.format("YYYY-MM-DD");
  if (lastScanDate === today) {
    return;
  }

  // Exit（タイムストップ）は breadth/シグナルと独立に常に評価する。
  // pending 売り注文の重複チェックでべき等なので 3段リトライでも二重発注しない。
  const exitRetryable = await runTimeStopExits();

  // エントリー評価
  let entryRetryable = false;
  if (entryEnabled) {
    entryRetryable = await runEntries();
  } else {
    console.log(`${tag} entryEnabled=false → エントリースキップ（Exit のみ）`);
  }

  // retryable な失敗が無ければ当日フラグを立てて以降のリトライをスキップ
  if (!exitRetryable && !entryRetryable) {
    lastScanDate = today;
  } else {
    console.log(`${tag} retryable 失敗あり（exit=${exitRetryable}, entry=${entryRetryable}）→ 次分リトライ`);
  }
}

/**
 * エントリー評価＋引け成行発注。
 * @returns retryable な失敗があったか（true なら次分リトライ）
 */
async function runEntries(): Promise<boolean> {
  // idle帯チェック: 日本株 breadth < 54% のみ動作（GU/PSC が休む時にだけ動く）
  const assessment = await prisma.marketAssessment.findUnique({
    where: { date: getTodayForDB() },
  });
  const breadth = assessment?.breadth != null ? Number(assessment.breadth) : null;
  if (breadth === null) {
    console.log(`${tag} エントリースキップ: MarketAssessment.breadth 未確定`);
    return false;
  }
  if (breadth >= MARKET_BREADTH.THRESHOLD) {
    console.log(
      `${tag} エントリースキップ: breadth ${(breadth * 100).toFixed(1)}% >= ${(MARKET_BREADTH.THRESHOLD * 100).toFixed(0)}%（idle帯外＝GU/PSC稼働中）`,
    );
    return false;
  }

  // 二重発注防止: 保有/発注中ティッカー（open/ordered ポジ + 当日の pending us_etf 買い注文）
  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: { in: ["open", "ordered"] } },
    include: { stock: { select: { tickerCode: true } } },
  });
  const heldTickers = new Set(openPositions.map((p) => p.stock.tickerCode));
  const pendingBuys = await prisma.tradingOrder.findMany({
    where: { strategy: "us_etf", side: "buy", status: "pending" },
    include: { stock: { select: { tickerCode: true } } },
  });
  for (const o of pendingBuys) heldTickers.add(o.stock.tickerCode);

  const candidates = TICKERS.filter((t) => !heldTickers.has(t));
  if (candidates.length === 0) {
    console.log(`${tag} エントリー対象なし（全ティッカー保有/発注中）`);
    return false;
  }

  // 立花リアルタイム時価を一括取得
  const quotesRaw = await tachibanaFetchQuotesBatch([...candidates]);
  const quotes = new Map(
    quotesRaw
      .filter((q): q is NonNullable<typeof q> => q !== null && q.open > 0 && q.volume > 0)
      .map((q) => [q.tickerCode, q]),
  );
  if (quotes.size === 0) {
    // 時価取得ゼロ件（API障害の可能性）→ retryable
    console.log(`${tag} エントリースキップ: 時価取得0件（次分リトライ）`);
    return true;
  }

  const executed: { ticker: string; qty: number; price: number; slPrice: number; orderNumber?: string }[] = [];
  const failed: { ticker: string; reason: string }[] = [];
  let anyRetryable = false;

  for (const ticker of candidates) {
    const quote = quotes.get(ticker);
    if (!quote) continue;

    // 過去25日の StockDailyBar から prevClose / avgVol25 を算出
    // （当日バーは引け後に作られるため、場中は最新が前営業日 = prevClose）
    const bars = await prisma.stockDailyBar.findMany({
      where: { tickerCode: ticker, market: "JP", date: { lte: getTodayForDB() } },
      orderBy: { date: "desc" },
      take: VOL_LOOKBACK,
    });
    if (bars.length < VOL_LOOKBACK) {
      console.log(`${ticker}: バー不足 (${bars.length} < ${VOL_LOOKBACK})、スキップ`);
      continue;
    }
    const prevClose = bars[0].close;
    const avgVol25 = bars.reduce((a, b) => a + Number(b.volume), 0) / VOL_LOOKBACK;

    const signal = detectUSEtfSignal(
      {
        ticker,
        todayOpen: quote.open,
        todayHigh: quote.high,
        todayLow: quote.low,
        todayClose: quote.price, // 15:24 現在値 ≈ 引け値
        todayVolume: quote.volume,
        prevClose,
        avgVolume25: avgVol25,
        japanBreadth: breadth,
      },
      US_ETF_SIGNAL_DEFAULTS,
    );

    if (!signal.triggered) {
      console.log(`${ticker}: ─ 不発 | ${signal.rejectReasons.join(" / ")}`);
      continue;
    }

    // ロット計算（参照価格 = 現在値）
    const refPrice = quote.price;
    const slPrice = refPrice * (1 - US_ETF_RISK_PARAMS.slPct);
    const riskAmount = BUDGET * US_ETF_RISK_PARAMS.riskPct;
    const slDistance = refPrice - slPrice;
    const qtyByRisk = slDistance > 0 ? Math.floor(riskAmount / slDistance) : 0;
    const qtyByBalance = Math.floor((BUDGET * MAX_POSITION_PCT) / refPrice);
    const qty = Math.max(0, Math.min(qtyByRisk, qtyByBalance));

    if (qty < 1) {
      console.log(`${ticker}: スキップ qty<1 (qtyByRisk=${qtyByRisk}, qtyByBalance=${qtyByBalance})`);
      continue;
    }

    const stock = await prisma.stock.findUnique({
      where: { tickerCode: ticker },
      select: { id: true, name: true },
    });
    if (!stock) {
      console.error(`${ticker}: Stock テーブルに未登録、スキップ`);
      failed.push({ ticker, reason: "Stock 未登録" });
      continue;
    }

    console.log(
      `${ticker} ${stock.name}: 🚀 発火 gap+${(signal.gap * 100).toFixed(2)}% vol ${signal.volSurge.toFixed(2)}x breadth ${(breadth * 100).toFixed(1)}% → ${qty}株 引け成行買い (SL ¥${slPrice.toFixed(0)})`,
    );

    // 立花API: 引け成行買い（当日引けに約定 = BT前提一致）。
    // SL は約定後に broker-fill-handler が売り逆指値を別建て発注（既存 GU/PSC と同じパス）。
    const brokerResult = await submitOrder({
      ticker,
      side: "buy",
      quantity: qty,
      limitPrice: null,
      condition: TACHIBANA_ORDER.CONDITION.CLOSE,
    });

    if (!brokerResult.success || !brokerResult.orderNumber) {
      const reason = brokerResult.error ?? "注文番号未返却";
      // サブコード（"[sub:"）= 業務リジェクト（資金不足等）→ 非リトライ。それ以外 → retryable
      const retryable = !reason.startsWith("[sub:");
      console.error(`${ticker}: 発注失敗 ${reason} (retryable=${retryable})`);
      if (retryable) anyRetryable = true;
      else failed.push({ ticker, reason });
      continue;
    }

    // TradingOrder 作成（約定通知 → broker-fill-handler が TradingPosition 作成）
    await prisma.tradingOrder.create({
      data: {
        updatedAt: new Date(),
        stockId: stock.id,
        side: "buy",
        orderType: "market",
        strategy: "us_etf",
        limitPrice: null,
        takeProfitPrice: null,
        stopLossPrice: slPrice,
        quantity: qty,
        status: "pending",
        reasoning: `ETF idle帯シグナル(引け成行): gap+${(signal.gap * 100).toFixed(2)}%, vol ${signal.volSurge.toFixed(2)}x, 日本株breadth ${(breadth * 100).toFixed(1)}%`,
        brokerOrderId: brokerResult.orderNumber,
        brokerBusinessDay: brokerResult.businessDay,
        referencePrice: refPrice,
        entrySnapshot: {
          gap: signal.gap,
          volSurge: signal.volSurge,
          japanBreadth: breadth,
          timeStopDays: US_ETF_RISK_PARAMS.timeStopDays,
          appliedRiskPct: US_ETF_RISK_PARAMS.riskPct,
        },
      },
    });

    // UsEtfSignal を履歴として記録（@@unique([detectedDate, ticker]) で upsert）
    await prisma.usEtfSignal.upsert({
      where: { detectedDate_ticker: { detectedDate: getTodayForDB(), ticker } },
      create: {
        detectedDate: getTodayForDB(),
        ticker,
        todayClose: refPrice,
        gap: signal.gap,
        volSurge: signal.volSurge,
        japanBreadth: breadth,
        slPrice,
        executed: true,
        executedAt: new Date(),
        brokerOrderNumber: brokerResult.orderNumber,
      },
      update: {
        executed: true,
        executedAt: new Date(),
        brokerOrderNumber: brokerResult.orderNumber,
        skipReason: null,
      },
    });

    executed.push({ ticker, qty, price: refPrice, slPrice, orderNumber: brokerResult.orderNumber });
  }

  // Slack 通知
  if (executed.length > 0 || failed.length > 0) {
    const lines: string[] = [];
    if (executed.length > 0) {
      lines.push("*✅ 引け成行買い発注（SLは約定後に別建て）*");
      for (const e of executed) {
        lines.push(
          `  ${e.ticker}: ${e.qty}株 @ ¥${e.price.toLocaleString()} (SL ¥${e.slPrice.toFixed(0)})${e.orderNumber ? ` 注文番号=${e.orderNumber}` : ""}`,
        );
      }
    }
    if (failed.length > 0) {
      lines.push("*⚠️ 発注スキップ/失敗*");
      for (const f of failed) lines.push(`  ${f.ticker}: ${f.reason}`);
    }
    await notifySlack({
      title: `📈 ETF monitor: 発注${executed.length}件 / 失敗${failed.length}件`,
      message: lines.join("\n"),
      color: executed.length > 0 ? "good" : "warning",
    });
  } else {
    console.log(`${tag} エントリーシグナルなし（breadth ${(breadth * 100).toFixed(1)}% idle帯）`);
  }

  return anyRetryable;
}

/**
 * タイムストップ Exit（5営業日経過の us_etf ポジを引け成行売り）。
 * pending 売り注文の重複チェックでべき等（3段リトライでも二重発注しない）。
 * @returns retryable な失敗があったか
 */
async function runTimeStopExits(): Promise<boolean> {
  const positions = await prisma.tradingPosition.findMany({
    where: { strategy: "us_etf", status: "open" },
    include: { stock: { select: { id: true, tickerCode: true, name: true } } },
  });
  if (positions.length === 0) return false;

  const now = new Date();
  const closed: { ticker: string; daysHeld: number; orderNumber?: string }[] = [];
  const errors: { ticker: string; reason: string }[] = [];
  let anyRetryable = false;

  for (const pos of positions) {
    const ticker = pos.stock.tickerCode;
    const daysHeld = computeHoldingBusinessDays(pos.createdAt, now);
    const limit = US_ETF_RISK_PARAMS.timeStopDays;
    if (daysHeld < limit) {
      console.log(`${tag} ${ticker}: ${daysHeld}日経過 (< ${limit}日) → 継続保有`);
      continue;
    }

    // べき等性: 既に pending 売り注文があればスキップ（3段リトライでの二重売り防止）
    const existingSell = await prisma.tradingOrder.findFirst({
      where: { positionId: pos.id, side: "sell", status: "pending" },
    });
    if (existingSell) {
      console.log(`${tag} ${ticker}: 既に売り注文 pending → スキップ`);
      continue;
    }

    console.log(`${tag} ${ticker}: ${daysHeld}日経過 ≥ ${limit}日 → タイムストップ引け成行売り`);
    const brokerResult = await submitOrder({
      ticker,
      side: "sell",
      quantity: pos.quantity,
      limitPrice: null,
      condition: TACHIBANA_ORDER.CONDITION.CLOSE,
    });

    if (!brokerResult.success || !brokerResult.orderNumber) {
      const reason = brokerResult.error ?? "注文番号未返却";
      const retryable = !reason.startsWith("[sub:");
      console.error(`${tag} ${ticker}: 売り発注失敗 ${reason} (retryable=${retryable})`);
      if (retryable) anyRetryable = true;
      else errors.push({ ticker, reason });
      continue;
    }

    await prisma.tradingOrder.create({
      data: {
        updatedAt: new Date(),
        stockId: pos.stock.id,
        side: "sell",
        orderType: "market",
        strategy: "us_etf",
        limitPrice: null,
        quantity: pos.quantity,
        status: "pending",
        reasoning: `ETF タイムストップ(引け成行): ${daysHeld}営業日経過 (limit ${limit})`,
        brokerOrderId: brokerResult.orderNumber,
        brokerBusinessDay: brokerResult.businessDay,
        positionId: pos.id,
      },
    });

    closed.push({ ticker, daysHeld, orderNumber: brokerResult.orderNumber });
  }

  if (closed.length > 0 || errors.length > 0) {
    const lines: string[] = [];
    if (closed.length > 0) {
      lines.push("*⏰ タイムストップ引け成行売り*");
      for (const c of closed) {
        lines.push(`  ${c.ticker}: ${c.daysHeld}営業日経過${c.orderNumber ? ` (注文番号=${c.orderNumber})` : ""}`);
      }
    }
    if (errors.length > 0) {
      lines.push("*⚠️ 売り発注失敗*");
      for (const e of errors) lines.push(`  ${e.ticker}: ${e.reason}`);
    }
    await notifySlack({
      title: `📤 ETF タイムストップ: ${closed.length}件売却`,
      message: lines.join("\n"),
      color: closed.length > 0 ? "warning" : "danger",
    });
  }

  return anyRetryable;
}

/** エントリー約定日(createdAt)から現在までの経過営業日数（土日除外、当日含む） */
function computeHoldingBusinessDays(entryAt: Date, now: Date): number {
  const entryDate = dayjs(entryAt).tz(TIMEZONE);
  const todayJst = dayjs(now).tz(TIMEZONE);
  let days = 0;
  let d = entryDate.add(1, "day");
  while (d.isBefore(todayJst, "day") || d.isSame(todayJst, "day")) {
    const dow = d.day();
    if (dow !== 0 && dow !== 6) days++;
    d = d.add(1, "day");
  }
  return days;
}

/** スキャン済みフラグをリセットする（テスト用） */
export function resetScanner(): void {
  lastScanDate = null;
}
