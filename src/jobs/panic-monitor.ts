/**
 * パニック底反発 (1321) のエントリー / タイムストップ Exit 監視 (KOH-531 検証 / KOH-554 本番化)
 *
 * worker.ts の node-cron から 15:24 に呼ばれる（15:24:00/20/40 の3段リトライ）。
 * GU/PSC/us-etf と同じ「場中15:24 に評価 → 引け成行で当日引けに約定」方式。
 *
 * - エントリー: VIX(前日終値)>25 × breadth<40% × N225連続下落≥3日（エピソード初日のみ）で
 *   1321 を引け成行買い。枠1、risk 2%、-12% 固定SL。
 * - Exit: strategy="panic" の open ポジが 20営業日経過なら引け成行売り（タイムストップ）。
 * - SL: 自前で発注しない。TradingOrder.stopLossPrice に -12% を載せるだけで、約定後に
 *   broker-fill-handler が売り逆指値を別建てする（GU/PSC/us-etf と同じパス）。
 *
 * ## 判定はすべて前営業日の確定終値（ライブ時価を叩かない）
 *
 * 本番 15:24 時点で当日の breadth は取得不能なので、live で再現できるのは
 * 「D-1 の終値で判定 → D の引けで買う」のみ。BT もこの定義（`--entry-lag 1`）で
 * 3ゲート通過を確認済み（KOH-554 Phase 1）。詳細は `src/core/panic/market-state.ts`。
 *
 * ## この戦略に触ってはいけないもの
 *
 * - **トレーリング/汎用タイムストップ**: position-monitor の汎用出口ループから除外している。
 *   当てると辛抱型ドリフトが死ぬ（却下リスト: buyback にタイトATRトレールを当てて
 *   勝率56%→21%・PF 0.79 に崩壊）。
 * - **VIX>30/crisis の防御決済**: 同じく除外（BT の `etfCrisisBypass` の移植）。
 *   この戦略は定義上その日に買うので、防御決済は「底で強制売却」になる。
 *   ⚠️ 除外されるのは裁量的な成行決済だけで、**-12% の逆指値SLは板に生きている**。
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { prisma } from "../lib/prisma";
import { getTodayForDB, countTradingDaysBetween } from "../lib/market-date";
import { tachibanaFetchQuotesBatch } from "../lib/tachibana-price-client";
import { submitOrder } from "../core/broker-orders";
import { TACHIBANA_ORDER } from "../lib/constants/broker";
import { calculateDrawdownStatus } from "../core/drawdown-manager";
import { detectPanicSignal } from "../core/panic/entry-conditions";
import { getPanicMarketState } from "../core/panic/market-state";
import { PANIC } from "../lib/constants/panic";
import { GAPUP } from "../lib/constants/gapup";
import { TIMEZONE } from "../lib/constants";
import { notifySlack } from "../lib/slack";

dayjs.extend(utc);
dayjs.extend(timezone);

/** スキャン済みフラグ（1日1回制限）。retryable 失敗の時のみ未セットで次分リトライ */
let lastScanDate: string | null = null;

const tag = "[panic-monitor]";

/**
 * パニック底反発モニターのメイン処理（worker.ts 15:24 node-cron から呼ばれる）
 */
export async function main(): Promise<void> {
  // 時刻チェック: 15:24以降のみ実行（gapup / us-etf と同じガード）
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

  const today = jstNow.format("YYYY-MM-DD");
  if (lastScanDate === today) {
    return;
  }

  // Exit（タイムストップ）はシグナルと独立に常に評価する。
  // pending 売り注文の重複チェックでべき等なので3段リトライでも二重発注しない。
  const exitRetryable = await runTimeStopExits();

  let entryRetryable = false;
  if (PANIC.ENTRY_ENABLED) {
    entryRetryable = await runEntry();
  } else {
    console.log(`${tag} PANIC_ENTRY_ENABLED=false → エントリースキップ（Exit のみ）`);
  }

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
async function runEntry(): Promise<boolean> {
  // --- 判定入力（すべて前営業日以前の確定終値。立花APIは叩かない）---
  const state = await getPanicMarketState();
  if ("unavailable" in state) {
    console.log(`${tag} エントリースキップ: ${state.reason}`);
    // 鮮度不足は次分リトライしても直らない（17:00 の backfill は来ない）ので retryable にしない
    await notifySlack({
      title: "⚠️ パニック底反発: 判定不能",
      message: `${state.reason}\nこの日はエントリーを見送ります（SLは既存ポジで有効）`,
      color: "warning",
    }).catch(() => {});
    return false;
  }

  const signal = detectPanicSignal({
    prevVixClose: state.prevVixClose,
    breadth: state.breadth,
    nikkeiDownStreak: state.nikkeiDownStreak,
    // 前営業日の時点でも3条件が揃っていたか = エピソード継続日の判定。
    // 確定バーから毎回計算するので状態を持たない（再起動・再デプロイでも同じ答えになる）。
    prevDayConditionsMet: detectPanicSignal({
      prevVixClose: state.prevDayVixClose,
      breadth: state.prevDayBreadth,
      nikkeiDownStreak: state.prevDayNikkeiDownStreak,
      prevDayConditionsMet: false,
    }).conditionsMet,
  });

  const stateLabel =
    `判定日 ${dayjs(state.conditionDate).format("YYYY-MM-DD")} | ` +
    `VIX ${state.prevVixClose.toFixed(1)} (${dayjs(state.vixAsOf).format("MM-DD")}) | ` +
    `breadth ${(state.breadth * 100).toFixed(1)}% (全JP ${(state.breadthAllJp * 100).toFixed(1)}%) | ` +
    `N225連続下落 ${state.nikkeiDownStreak}日`;

  if (!signal.triggered) {
    console.log(`${tag} ─ 不発 | ${stateLabel} | ${signal.rejectReasons.join(" / ")}`);
    await recordSignal(state, signal.conditionsMet, signal.isEpisodeFirstDay, {
      skipReason: signal.rejectReasons.join(" / "),
    });
    return false;
  }

  // --- 発注可否のガード ---

  // 二重発注防止: panic ポジ（open/ordered）+ 当日の pending panic 買い注文
  const openPanic = await prisma.tradingPosition.findMany({
    where: { strategy: PANIC.STRATEGY, status: { in: ["open", "ordered"] } },
    select: { id: true },
  });
  const pendingBuys = await prisma.tradingOrder.findFirst({
    where: { strategy: PANIC.STRATEGY, side: "buy", status: "pending" },
    select: { id: true },
  });
  if (openPanic.length >= PANIC.MAX_POSITIONS || pendingBuys) {
    console.log(`${tag} エントリースキップ: 既に保有/発注中（枠 ${PANIC.MAX_POSITIONS}）`);
    await recordSignal(state, true, true, { skipReason: "枠上限（既に保有/発注中）" });
    return false;
  }

  // DDハルト: BT は panic レッグにも週次5%/月次10%ハルトを掛けている
  // （combined-simulation.ts の `etfShouldTrade = ddHalt.shouldTrade`）。暴落3日目はまさに
  // DDが出ている局面なので、これを見ないと BT が撃たない日に本番だけ撃つ。
  // MarketAssessment.shouldTrade は breadth<54% で常に false になるため流用できない。
  const drawdown = await calculateDrawdownStatus();
  if (drawdown.shouldHaltTrading) {
    console.log(`${tag} エントリースキップ: DDハルト（${drawdown.reason}）`);
    await recordSignal(state, true, true, { skipReason: `DDハルト: ${drawdown.reason}` });
    return false;
  }

  // --- 参照価格（発注サイズ算出用。ここで初めて立花を叩く）---
  const quotes = await tachibanaFetchQuotesBatch([PANIC.TICKER]);
  const quote = quotes.find((q) => q !== null && q.price > 0);
  if (!quote) {
    console.log(`${tag} 時価取得失敗（次分リトライ）`);
    return true;
  }

  const refPrice = quote.price;
  const slPrice = refPrice * (1 - PANIC.SL_PCT);
  const riskAmount = PANIC.BUDGET * PANIC.RISK_PCT;
  const slDistance = refPrice - slPrice;
  // 1321 は1株単位。-12%SL / risk2% なので BUDGET の約16.7%のポジションになる
  const qty = slDistance > 0 ? Math.floor(riskAmount / slDistance) : 0;

  if (qty < 1) {
    const reason = `qty<1（refPrice ¥${refPrice.toLocaleString()}, riskAmount ¥${riskAmount.toLocaleString()}）`;
    console.log(`${tag} エントリースキップ: ${reason}`);
    await recordSignal(state, true, true, { skipReason: reason });
    return false;
  }

  const stock = await prisma.stock.findUnique({
    where: { tickerCode: PANIC.TICKER },
    select: { id: true, name: true },
  });
  if (!stock) {
    const reason = `Stock テーブルに ${PANIC.TICKER} が未登録`;
    console.error(`${tag} ${reason}`);
    await notifySlack({
      title: "🚨 パニック底反発: 発注不可",
      message: `${reason}\nシグナルは発火しています: ${stateLabel}`,
      color: "danger",
    }).catch(() => {});
    return false;
  }

  console.log(`${tag} 🚀 発火 | ${stateLabel} → ${qty}株 引け成行買い (SL ¥${slPrice.toFixed(0)})`);

  const brokerResult = await submitOrder({
    ticker: PANIC.TICKER,
    side: "buy",
    quantity: qty,
    limitPrice: null,
    condition: TACHIBANA_ORDER.CONDITION.CLOSE,
  });

  if (!brokerResult.success || !brokerResult.orderNumber) {
    const reason = brokerResult.error ?? "注文番号未返却";
    // サブコード（"[sub:"）= 業務リジェクト（資金不足等）→ 非リトライ。それ以外 → retryable
    const retryable = !reason.startsWith("[sub:");
    console.error(`${tag} 発注失敗 ${reason} (retryable=${retryable})`);
    if (!retryable) {
      await recordSignal(state, true, true, { skipReason: `発注失敗: ${reason}` });
      await notifySlack({
        title: "🚨 パニック底反発: 発注失敗",
        message: `${stateLabel}\n${reason}`,
        color: "danger",
      }).catch(() => {});
    }
    return retryable;
  }

  await prisma.tradingOrder.create({
    data: {
      updatedAt: new Date(),
      stockId: stock.id,
      side: "buy",
      orderType: "market",
      strategy: PANIC.STRATEGY,
      limitPrice: null,
      takeProfitPrice: null,
      stopLossPrice: slPrice,
      quantity: qty,
      status: "pending",
      reasoning: `パニック底反発(引け成行): ${stateLabel}`,
      brokerOrderId: brokerResult.orderNumber,
      brokerBusinessDay: brokerResult.businessDay,
      referencePrice: refPrice,
      // ⚠️ ATR を入れないこと。入れると broker-fill-handler の validateStopLoss が
      //    ATR ベースで SL を動かす（固定SL戦略はバイパスするが、二重に安全側へ倒す）
      entrySnapshot: {
        conditionDate: dayjs(state.conditionDate).format("YYYY-MM-DD"),
        prevVixClose: state.prevVixClose,
        vixAsOf: dayjs(state.vixAsOf).format("YYYY-MM-DD"),
        breadth: state.breadth,
        breadthAllJp: state.breadthAllJp,
        nikkeiDownStreak: state.nikkeiDownStreak,
        timeStopDays: PANIC.TIME_STOP_DAYS,
        appliedRiskPct: PANIC.RISK_PCT,
      },
    },
  });

  await recordSignal(state, true, true, {
    executed: true,
    entryPrice: refPrice,
    slPrice,
    brokerOrderNumber: brokerResult.orderNumber,
  });

  await notifySlack({
    title: `🚨 パニック底反発: ${qty}株 発注`,
    message:
      `${stateLabel}\n` +
      `1321 を ${qty}株 引け成行買い（参照価格 ¥${refPrice.toLocaleString()}）\n` +
      `SL ¥${slPrice.toFixed(0)} (-${(PANIC.SL_PCT * 100).toFixed(0)}%, 約定後に逆指値を別建て) / ${PANIC.TIME_STOP_DAYS}営業日タイムストップ\n` +
      `注文番号=${brokerResult.orderNumber}`,
    color: "good",
  }).catch(() => {});

  return false;
}

/** PanicSignal に記録する（不発日も残す。年2回未満なので「なぜ撃たなかったか」の監査価値が高い） */
async function recordSignal(
  state: { conditionDate: Date; breadth: number; breadthAllJp: number; nikkeiDownStreak: number; prevVixClose: number },
  conditionsMet: boolean,
  isEpisodeFirstDay: boolean,
  extra: {
    executed?: boolean;
    entryPrice?: number;
    slPrice?: number;
    brokerOrderNumber?: string;
    skipReason?: string;
  },
): Promise<void> {
  // 条件が1つも揃っていない平常日まで毎日書くとノイズなので、何か1つでも引っかかった日だけ残す
  if (!conditionsMet && state.breadth >= PANIC.BREADTH_MAX && state.nikkeiDownStreak < PANIC.MIN_DOWN_STREAK) {
    return;
  }
  await prisma.panicSignal
    .upsert({
      where: { detectedDate_ticker: { detectedDate: getTodayForDB(), ticker: PANIC.TICKER } },
      create: {
        detectedDate: getTodayForDB(),
        ticker: PANIC.TICKER,
        conditionDate: state.conditionDate,
        prevVixClose: state.prevVixClose,
        breadth: state.breadth,
        breadthAllJp: state.breadthAllJp,
        nikkeiDownStreak: state.nikkeiDownStreak,
        conditionsMet,
        isEpisodeFirstDay,
        entryPrice: extra.entryPrice ?? null,
        slPrice: extra.slPrice ?? null,
        executed: extra.executed ?? false,
        executedAt: extra.executed ? new Date() : null,
        brokerOrderNumber: extra.brokerOrderNumber ?? null,
        skipReason: extra.skipReason ?? null,
      },
      update: {
        conditionsMet,
        isEpisodeFirstDay,
        entryPrice: extra.entryPrice ?? undefined,
        slPrice: extra.slPrice ?? undefined,
        executed: extra.executed ?? undefined,
        executedAt: extra.executed ? new Date() : undefined,
        brokerOrderNumber: extra.brokerOrderNumber ?? undefined,
        skipReason: extra.skipReason ?? null,
      },
    })
    .catch((e) => console.error(`${tag} PanicSignal 記録失敗:`, e));
}

/**
 * タイムストップ Exit（20営業日経過の panic ポジを引け成行売り）。
 * pending 売り注文の重複チェックでべき等（3段リトライでも二重発注しない）。
 * @returns retryable な失敗があったか
 */
async function runTimeStopExits(): Promise<boolean> {
  const positions = await prisma.tradingPosition.findMany({
    where: { strategy: PANIC.STRATEGY, status: "open" },
    include: { stock: { select: { id: true, tickerCode: true, name: true } } },
  });
  if (positions.length === 0) return false;

  const now = new Date();
  let anyRetryable = false;

  for (const pos of positions) {
    const ticker = pos.stock.tickerCode;
    const daysHeld = countTradingDaysBetween(pos.createdAt, now);
    if (daysHeld < PANIC.TIME_STOP_DAYS) {
      console.log(`${tag} ${ticker}: ${daysHeld}日経過 (< ${PANIC.TIME_STOP_DAYS}日) → 継続保有`);
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

    console.log(`${tag} ${ticker}: ${daysHeld}日経過 ≥ ${PANIC.TIME_STOP_DAYS}日 → タイムストップ引け成行売り`);
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
      else {
        await notifySlack({
          title: `🚨 パニック底反発: タイムストップ売り失敗 ${ticker}`,
          message: `${daysHeld}営業日経過\n${reason}`,
          color: "danger",
        }).catch(() => {});
      }
      continue;
    }

    await prisma.tradingOrder.create({
      data: {
        updatedAt: new Date(),
        stockId: pos.stock.id,
        side: "sell",
        orderType: "market",
        strategy: PANIC.STRATEGY,
        limitPrice: null,
        quantity: pos.quantity,
        status: "pending",
        reasoning: `パニック底反発 タイムストップ(引け成行): ${daysHeld}営業日経過 (limit ${PANIC.TIME_STOP_DAYS})`,
        brokerOrderId: brokerResult.orderNumber,
        brokerBusinessDay: brokerResult.businessDay,
        positionId: pos.id,
      },
    });

    await notifySlack({
      title: `📤 パニック底反発 タイムストップ: ${ticker}`,
      message: `${daysHeld}営業日経過 → 引け成行売り (注文番号=${brokerResult.orderNumber})`,
      color: "warning",
    }).catch(() => {});
  }

  return anyRetryable;
}

/** スキャン済みフラグをリセットする（テスト用） */
export function resetScanner(): void {
  lastScanDate = null;
}
