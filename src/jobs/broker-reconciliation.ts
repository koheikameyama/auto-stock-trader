/**
 * ブローカー照合ジョブ（1日6回・市場時間中のみ）
 *
 * DBとブローカー実態の差異を検出・自動修正する。
 *
 * 【実行頻度】9:05:30 / 10:30:30 / 12:35:30 / 14:00:30 / 15:22:30 / 15:30:30
 * 立花証券のAPI高負荷警告（2026-03-10）を受けて、毎分ポーリングから1日6回に削減。
 * リアルタイム約定同期は EVENT I/F（WebSocket、`broker-event-stream.ts`）が主系として担う。
 * このジョブはWebSocket無音断（再接続時のイベント欠落）に対する保険として機能する。
 *
 * 【:30 秒オフセットの理由】
 * position-monitor の毎分 :00 実行と衝突しないよう半分ズラしている。
 *
 * 【場外での動作】
 * 場外（立会終了後〜翌日注文受付時間帯）は立花APIの getOrders/getHoldings が
 * 0件を返す仕様のため、このジョブは場中のみ実行する。場外のSL発注は
 * ensure-broker-sl ジョブが担当する。
 *
 * Phase 1: 注文ステータス同期
 * Phase 1.5: SL注文状態・値の整合性チェック (取消/失効 + トリガー価格/数量の乖離検出)
 * Phase 2: 見逃し約定リカバリ（WebSocket無音断の保険）
 * Phase 3: 保有株数照合（立花保有 vs DBオープンポジション）
 * Phase 4: 孤立買い注文キャンセル
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { prisma } from "../lib/prisma";
import { notifySlack } from "../lib/slack";
import { syncBrokerOrderStatuses, getHoldings, getOrderDetail, getOrders, extractFilledPrice } from "../core/broker-orders";
import { recoverMissedFills } from "../core/broker-fill-handler";
import { TACHIBANA_ORDER, TACHIBANA_ORDER_STATUS, BROKER_RECONCILIATION, isTachibanaProduction } from "../lib/constants/broker";
import { TIMEZONE } from "../lib/constants";
import { closePosition } from "../core/position-manager";
import { EXIT_REASON } from "../core/exit-reason";
import { cancelBrokerSL } from "../core/broker-sl-manager";

dayjs.extend(utc);
dayjs.extend(timezone);

// 約定直後はブローカーの保有反映が遅れるためスキップする猶予期間
const HOLDINGS_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5分

// SL注文が「まだ約定しておらず板に生きている」ステータス群。
// 現物の売り逆指値は保有株がないと板に残れないため、これらのステータス＝保有継続の証拠。
// このとき保有一覧（CLMGenbutuKabuList）が空なのは反映ラグであり実際の欠落ではない。
// FULLY_FILLED(10)/PARTIAL_FILLED(9) は株が売れているので含めない（約定＝別処理・警告対象）。
const SL_RESTING_STATUSES: readonly string[] = [
  TACHIBANA_ORDER_STATUS.WAITING_REVERSE, // 13 発注待ち（逆指値トリガー未発火）
  TACHIBANA_ORDER_STATUS.UNFILLED, // 1  未約定
  TACHIBANA_ORDER_STATUS.SWITCHING, // 15 切替注文中
  TACHIBANA_ORDER_STATUS.SWITCHED_UNFILLED, // 16 切替完了（未約定）
  TACHIBANA_ORDER_STATUS.SUBMITTING, // 50 発注中
];

export async function main(): Promise<void> {
  console.log("=== Broker Reconciliation 開始 ===");

  // Phase 1: 注文ステータス同期
  try {
    await syncBrokerOrderStatuses();
  } catch (e) {
    console.warn("[broker-reconciliation] syncBrokerOrderStatuses error (ignored):", e);
  }

  // Phase 1.5: SL注文取消/失効検出
  try {
    await syncBrokerSLStatuses();
  } catch (e) {
    console.warn("[broker-reconciliation] syncBrokerSLStatuses error (ignored):", e);
  }

  // Phase 2: 見逃し約定リカバリ
  try {
    await recoverMissedFills();
  } catch (e) {
    console.warn("[broker-reconciliation] recoverMissedFills error (ignored):", e);
  }

  // Phase 3: 保有株数照合
  try {
    await reconcileHoldings();
  } catch (e) {
    console.warn("[broker-reconciliation] reconcileHoldings error (ignored):", e);
  }

  // Phase 4: 孤立買い注文キャンセル
  try {
    await cancelOrphanedBuyOrders();
  } catch (e) {
    console.warn("[broker-reconciliation] cancelOrphanedBuyOrders error (ignored):", e);
  }

  console.log("=== Broker Reconciliation 完了 ===");
}

/**
 * SL注文の状態・値の整合性をチェックして不整合を修正する
 *
 * broker-sl-manager 経由で発注されたSL注文は TradingOrder レコードを持たないため
 * syncBrokerOrderStatuses の対象外。ここで専用にチェックする。
 *
 * 検出する不整合:
 *   (1) 取消・失効  → slBrokerOrderId をクリア（Phase 1.6 が再発注）
 *   (2) トリガー価格乖離 → cancelBrokerSL で取消（Phase 1.6 が DB値で再発注）
 *   (3) 数量乖離       → cancelBrokerSL で取消（同上）
 */
async function syncBrokerSLStatuses(): Promise<void> {
  if (!isTachibanaProduction) return;

  const positions = await prisma.tradingPosition.findMany({
    where: {
      status: "open",
      slBrokerOrderId: { not: null },
    },
    select: {
      id: true,
      slBrokerOrderId: true,
      slBrokerBusinessDay: true,
      stopLossPrice: true,
      quantity: true,
      stock: { select: { tickerCode: true } },
    },
  });
  if (positions.length === 0) return;

  // slBrokerBusinessDay を CLMOrderList の現在値に同期する。欠落（引け後発注で sEigyouDay 無し、
  // Issue #322 / KOH-532）と陳腐化（複数日逆指値が翌営業日以降に約定/失効して営業日が前進、KOH-587）
  // の両方を補正しないと、本関数・handleMissingHolding・cancelBrokerSL が古い営業日で照会して素通りする。
  await syncSLBusinessDays(positions);

  for (const pos of positions) {
    if (!pos.slBrokerOrderId || !pos.slBrokerBusinessDay) continue;

    const detail = await getOrderDetail(
      pos.slBrokerOrderId,
      pos.slBrokerBusinessDay,
    ).catch(() => null);

    if (!detail) continue;

    const brokerStatus = String(detail.sOrderStatusCode ?? detail.sOrderStatus ?? "");

    // 約定済み（全部/一部）は Phase 3（reconcileHoldings → handleMissingHolding）が実約定価格で
    // クローズする管轄。ここで残数量0を数量乖離と誤検知して cancelBrokerSL/クリアすると、約定確認
    // 経路を壊して「幻の保有」警告を招く（KOH-587）。約定は本フェーズ対象外なので早期スキップ。
    if (
      brokerStatus === TACHIBANA_ORDER_STATUS.FULLY_FILLED ||
      brokerStatus === TACHIBANA_ORDER_STATUS.PARTIAL_FILLED
    ) {
      continue;
    }

    // (1) 取消・失効の検出
    if (
      brokerStatus === TACHIBANA_ORDER_STATUS.CANCELLED ||
      brokerStatus === TACHIBANA_ORDER_STATUS.EXPIRED
    ) {
      const label = brokerStatus === TACHIBANA_ORDER_STATUS.CANCELLED ? "取消" : "失効";
      await prisma.tradingPosition.update({
        where: { id: pos.id },
        data: { slBrokerOrderId: null, slBrokerBusinessDay: null },
      });
      console.log(
        `[broker-reconciliation] ${pos.stock.tickerCode}: SL注文 ${pos.slBrokerOrderId} が${label}済み → slBrokerOrderId クリア`,
      );
      await notifySlack({
        title: `⚠️ SL注文${label}検出: ${pos.stock.tickerCode}`,
        message: `SL注文 ${pos.slBrokerOrderId} が立花側で${label}されました\n手動でSL注文を確認・再発注してください\npositionId: ${pos.id}`,
        color: "warning",
      }).catch(() => {});
      continue;
    }

    // (2)(3) 値の整合性チェック（まだ有効な注文のみ）
    const brokerTrigger = extractTriggerPrice(detail);
    const brokerQuantity = extractOrderQuantity(detail);
    const dbTrigger = pos.stopLossPrice ? Number(pos.stopLossPrice) : null;

    // デバッグ: 初回はレスポンス構造を記録（フィールド名確認用）
    if (brokerTrigger == null || brokerQuantity == null) {
      console.warn(
        `[broker-reconciliation] ${pos.stock.tickerCode}: SL詳細からトリガー/数量を抽出できず: ${JSON.stringify(detail).slice(0, 500)}`,
      );
      continue;
    }

    const triggerMismatch = dbTrigger != null && brokerTrigger !== dbTrigger;
    const quantityMismatch = brokerQuantity !== pos.quantity;

    if (triggerMismatch || quantityMismatch) {
      const details: string[] = [];
      if (triggerMismatch) details.push(`トリガー価格 DB=¥${dbTrigger} ブローカー=¥${brokerTrigger}`);
      if (quantityMismatch) details.push(`数量 DB=${pos.quantity} ブローカー=${brokerQuantity}`);

      console.warn(
        `[broker-reconciliation] ${pos.stock.tickerCode}: SL値乖離検出 ${details.join(" / ")} → 取消して次サイクルで再発注`,
      );
      await notifySlack({
        title: `⚠️ SL注文値乖離検出: ${pos.stock.tickerCode}`,
        message: `${details.join("\n")}\n立花SL注文を取消し、次サイクルで DB の値で再発注します`,
        color: "warning",
      }).catch(() => {});

      // 立花側をキャンセルするとsl*フィールドがクリアされる → Phase 1.6 が再発注
      await cancelBrokerSL(pos.id);
    }
  }
}

/**
 * SL注文の slBrokerBusinessDay を CLMOrderList の現在の実効営業日（sOrderSikkouDay）に同期する。
 * 2つのズレを扱う:
 *   (a) 欠落（null / 空文字）: 引け後発注で submitOrder 応答に sEigyouDay が無かった場合（KOH-532）
 *   (b) 陳腐化（保存値 ≠ 現在値）: 複数日逆指値が発注日より後の営業日に約定/失効すると立花側の実効
 *       営業日が前進する。保存された発注日のままだと getOrderDetail が古いインスタンス（失効）を返し、
 *       約定確認（handleMissingHolding）・状態判定（syncBrokerSLStatuses）・SL取消（cancelBrokerSL）が
 *       全て空振りし「幻の保有」警告＋自動クローズ失敗を招く（KOH-587）。
 * DB更新に加えて引数の positions 要素も直接書き換え、同一実行内の後続処理に反映する。
 * 安全のため営業日は前進方向のみ更新する（逆指値のロールは常に将来日。注文番号衝突による
 * 意図しない後退を防ぐ）。
 */
async function syncSLBusinessDays(
  positions: Array<{
    id: string;
    slBrokerOrderId: string | null;
    slBrokerBusinessDay: string | null;
    stock: { tickerCode: string };
  }>,
): Promise<void> {
  const withOrder = positions.filter((p) => p.slBrokerOrderId);
  if (withOrder.length === 0) return;

  const res = await getOrders({ statusFilter: "" }).catch(() => null);
  if (!res || res.sResultCode !== "0") return;

  const brokerOrders = (res.aOrderList as Record<string, unknown>[]) ?? [];
  const dayByOrderNum = new Map<string, string>();
  for (const bo of brokerOrders) {
    const orderNum = String(bo.sOrderOrderNumber ?? bo.sOrderNumber ?? "");
    const day = String(bo.sOrderSikkouDay ?? bo.sEigyouDay ?? "");
    if (orderNum && day) dayByOrderNum.set(orderNum, day);
  }

  for (const pos of withOrder) {
    const currentDay = dayByOrderNum.get(pos.slBrokerOrderId!);
    if (!currentDay) continue;
    const storedDay = pos.slBrokerBusinessDay ?? "";
    if (storedDay === currentDay) continue;
    // 前進のみ許可（欠落=storedDay空 は無条件、それ以外は currentDay > storedDay のみ）
    if (storedDay && currentDay <= storedDay) continue;

    await prisma.tradingPosition.update({
      where: { id: pos.id },
      data: { slBrokerBusinessDay: currentDay },
    });
    pos.slBrokerBusinessDay = currentDay;
    console.log(
      storedDay
        ? `[broker-reconciliation] ${pos.stock.tickerCode}: SL注文 ${pos.slBrokerOrderId} の営業日を ${storedDay} → ${currentDay} に同期（逆指値ロール検出、KOH-587）`
        : `[broker-reconciliation] ${pos.stock.tickerCode}: SL注文 ${pos.slBrokerOrderId} の欠落営業日を ${currentDay} でバックフィル（KOH-532）`,
    );
  }
}

// 立花レスポンスから逆指値トリガー価格を抽出（フィールド名の揺れに対応）
function extractTriggerPrice(detail: Record<string, unknown>): number | null {
  const candidates = [
    detail.sGyakusasiZyouken,
    detail.sOrderGyakusasiZyouken,
    detail.sOrderGyakusasiPrice,
  ];
  for (const v of candidates) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// 立花レスポンスから注文数量を抽出（フィールド名の揺れに対応）
function extractOrderQuantity(detail: Record<string, unknown>): number | null {
  const candidates = [
    detail.sOrderSuryou,
    detail.sOrderOrderSuryou,
    detail.sOrderZanSuryou,
  ];
  for (const v of candidates) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * ブローカー実保有 vs DBオープンポジションを照合する
 *
 * ブローカーに保有がないポジションを検出し、SL約定の有無を確認してDBをクローズする。
 * 数量が不一致の場合はSlackアラートを送信する。
 */
async function reconcileHoldings(): Promise<void> {
  if (!isTachibanaProduction) {
    console.log("[broker-reconciliation] デモ環境のため保有照合をスキップ");
    return;
  }

  // 9:05 JST以前は立花APIの保有データが未反映の可能性があるためスキップ
  const nowJST = dayjs().tz(TIMEZONE);
  const currentMinuteJST = nowJST.hour() * 60 + nowJST.minute();
  if (currentMinuteJST < BROKER_RECONCILIATION.HOLDINGS_CHECK_START_MINUTE_JST) {
    console.log("[broker-reconciliation] 保有照合: 9:05 JST以前のためスキップ");
    return;
  }

  const [brokerHoldings, openPositions] = await Promise.all([
    getHoldings(),
    prisma.tradingPosition.findMany({
      where: { status: "open" },
      include: { stock: true },
    }),
  ]);

  // APIエラー時（null）は照合をスキップ（誤爆による全ポジション自動クローズを防止）
  if (brokerHoldings === null) {
    console.warn("[broker-reconciliation] 保有一覧取得失敗 → 照合スキップ");
    return;
  }

  const holdingMap = new Map(brokerHoldings.map((h) => [h.ticker, h]));
  const openTickers = new Set(openPositions.map((p) => p.stock.tickerCode));

  // 孤立保有（約定したのにDB未認識）の検出用に in-flight（pending）買い注文の銘柄を把握する。
  // pending注文は EVENT I/F / recoverMissedFills が約定→ポジション生成を処理中なので孤立扱いしない。
  const pendingBuyOrders = await prisma.tradingOrder.findMany({
    where: { status: "pending", side: "buy" },
    include: { stock: { select: { tickerCode: true } } },
  });
  const inFlightTickers = new Set(pendingBuyOrders.map((o) => o.stock.tickerCode));

  const now = Date.now();

  for (const position of openPositions) {
    const ticker = position.stock.tickerCode;

    // 約定直後はブローカーの保有反映が遅れるためスキップ
    if (now - position.createdAt.getTime() < HOLDINGS_GRACE_PERIOD_MS) {
      console.log(`[broker-reconciliation] ${ticker}: 開設直後のためスキップ（猶予期間中）`);
      continue;
    }

    const holding = holdingMap.get(ticker);

    if (!holding) {
      // 引け成行約定は立花の保有一覧（CLMGenbutuKabuList）への反映が引け後しばらく遅れ、当日は
      // 載らないことがある。当日開設ポジションを場外照合で「保有なし」と誤判定しないようスキップする。
      // 当日約定ポジションが当日にSL約定することは構造上あり得ず（SLは翌営業日以降のみ約定）、本物の
      // 欠落（オーバーナイトSL約定・不整合）は翌営業日9:05以降の照合で保有反映後に検知する。
      // 5分の HOLDINGS_GRACE_PERIOD_MS は引け後の反映ラグに足りず、15:45 の場外照合で誤警報が出ていた。
      if (dayjs(position.createdAt).tz(TIMEZONE).isSame(nowJST, "day")) {
        console.log(
          `[broker-reconciliation] ${ticker}: 当日開設・ブローカー保有未反映（引け後の反映ラグ）とみなしスキップ`,
        );
        continue;
      }
      // ブローカーに保有なし → SL約定の可能性
      console.log(
        `[broker-reconciliation] ${ticker}: DBオープンポジションあり、ブローカー保有なし → SL約定を確認`,
      );
      await handleMissingHolding(position);
      continue;
    }

    // 数量不一致チェック（部分的な売却等の検出）
    if (holding.quantity !== position.quantity) {
      console.warn(
        `[broker-reconciliation] ${ticker}: 数量不一致 DB=${position.quantity} ブローカー=${holding.quantity}`,
      );
      await notifySlack({
        title: `⚠️ 保有数量不一致: ${ticker}`,
        message: `DB: ${position.quantity}株\nブローカー: ${holding.quantity}株\n手動確認が必要です\npositionId: ${position.id}`,
        color: "warning",
      }).catch(() => {});
    }
  }

  // 逆方向照合: ブローカー保有あり ⇄ DB open ポジション無し
  // 約定したのに TradingPosition が作られず無管理になった孤立保有を検出する（Issue #322 の穴を塞ぐ）。
  // 自動取り込みはせず通知のみ（entryPrice/strategy/SL の判断が必要なため。誤爆防止の既存方針に合わせる）。
  for (const holding of brokerHoldings) {
    if (holding.quantity <= 0) continue;
    if (openTickers.has(holding.ticker)) continue; // 管理下にある
    if (inFlightTickers.has(holding.ticker)) continue; // pending約定の処理待ち（EVENT I/F が生成中）

    console.warn(
      `[broker-reconciliation] ${holding.ticker}: ブローカー保有あり(${holding.quantity}株)だがDBにopenポジションなし → 孤立保有（無管理・SL未設定の恐れ）`,
    );
    await notifySlack({
      title: `🚨 要対応: 孤立保有を検出（無管理ポジション）`,
      message:
        `${holding.ticker} を ${holding.quantity}株 保有していますが、DBにopenポジションがありません。\n` +
        `SL/トレール/タイムストップが効かない無管理状態の可能性があります（Issue #322 と同型）。\n` +
        `概算簿価: ¥${holding.bookValuePerShare.toLocaleString()} / 評価額: ¥${holding.marketValue.toLocaleString()} / 評価損益: ¥${holding.unrealizedPnl.toLocaleString()}\n` +
        `DBへのポジション復元とSL手当てを確認してください。`,
      color: "danger",
    }).catch(() => {});
  }
}

/**
 * ブローカーに保有がないポジションを処理する
 *
 * slBrokerOrderId の約定詳細を確認し、FULLY_FILLED であれば
 * 約定価格を取得してDBポジションをクローズする。
 * 確認できない場合はSlackアラートを送信する。
 */
async function handleMissingHolding(position: {
  id: string;
  quantity: number;
  strategy: string;
  entryPrice: unknown;
  stopLossPrice: unknown;
  trailingStopPrice: unknown;
  slBrokerOrderId: string | null;
  slBrokerBusinessDay: string | null;
  stock: { tickerCode: string; name: string };
}): Promise<void> {
  const ticker = position.stock.tickerCode;

  if (position.slBrokerOrderId && position.slBrokerBusinessDay) {
    const detail = await getOrderDetail(
      position.slBrokerOrderId,
      position.slBrokerBusinessDay,
    ).catch(() => null);

    if (detail) {
      const brokerStatus = String(detail.sOrderStatusCode ?? detail.sOrderStatus ?? "");

      if (brokerStatus === TACHIBANA_ORDER_STATUS.FULLY_FILLED) {
        // SL約定 → 約定価格を計算してポジションクローズ
        console.log(
          `[broker-reconciliation] ${ticker}: raw exec data: ${JSON.stringify(detail.aYakuzyouSikkouList)}`,
        );
        const filledPrice = extractFilledPrice(detail) ?? 0;

        if (filledPrice > 0) {
          // 約定価格の異常値チェック
          const entryPrice = Number(position.entryPrice ?? 0);
          if (entryPrice > 0 && filledPrice < entryPrice * BROKER_RECONCILIATION.MIN_FILL_PRICE_RATIO) {
            console.error(
              `[broker-reconciliation] ${ticker}: SL約定価格が異常 (¥${filledPrice} << エントリー¥${entryPrice}) → 自動クローズ中止`,
            );
            await notifySlack({
              title: `🚨 SL約定価格異常: ${ticker}`,
              message: `SL注文 ${position.slBrokerOrderId} の約定価格が異常です\n約定価格: ¥${filledPrice.toLocaleString()}\nエントリー価格: ¥${entryPrice.toLocaleString()}\n自動クローズを中止しました。手動で確認してください\npositionId: ${position.id}`,
              color: "danger",
            }).catch(() => {});
            return;
          }

          await closePosition(position.id, filledPrice, {
            // 保存はコード（旧: "SL約定（ブローカー自律執行・照合リカバリ）"）。Slack 文言は下の notifySlack で日本語
            exitReason: EXIT_REASON.STOP_LOSS,
            exitPrice: filledPrice,
            marketContext: null,
          });
          console.log(
            `[broker-reconciliation] ${ticker}: SL約定リカバリ @ ¥${filledPrice} → ポジションクローズ`,
          );
          await notifySlack({
            title: `🔴 SL約定リカバリ: ${ticker}`,
            message: `SL注文 ${position.slBrokerOrderId} が約定済みを検出\n約定価格: ¥${filledPrice.toLocaleString()}\nDBポジションをクローズしました`,
            color: "danger",
          }).catch(() => {});
          return;
        }
      }

      // SL注文がまだ有効（発注待ち/未約定/切替中/発注中）→ 現物売り逆指値が板に生きている
      // ＝株はまだ保有されている。保有一覧が空なのは CLMGenbutuKabuList の反映ラグであり
      // 実際の欠落ではない。真の約定は EVENT I/F と次サイクルの Phase 2/3 が処理するため、
      // ここでは誤警報を出さず log のみに留める（KOH: reconciliation resting-SL 誤警報抑制）。
      if (SL_RESTING_STATUSES.includes(brokerStatus)) {
        console.log(
          `[broker-reconciliation] ${ticker}: SL注文 ${position.slBrokerOrderId} が有効（status=${brokerStatus}）→ 保有継続とみなし警告抑制（保有一覧の反映ラグ）`,
        );
        return;
      }
    }
  }

  // SL注文なし or 約定確認できず → 通知のみ（手動確認を促す）
  console.warn(
    `[broker-reconciliation] ${ticker}: ブローカー保有なし・約定未確認 → 通知のみ（自動クローズ停止中）`,
  );
  await notifySlack({
    title: `⚠️ 要確認: ブローカー保有なし ${ticker}`,
    message: `ブローカーに保有が見つかりません（SL約定未確認）\npositionId: ${position.id}\nSL注文: ${position.slBrokerOrderId ?? "なし"}\n手動で確認してください`,
    color: "warning",
  }).catch(() => {});
}


/**
 * DBに記録のないブローカー買い注文を検出してキャンセルする
 *
 * DBに対応するTradingOrderがない未約定買い注文は「孤立注文」として自動キャンセルする。
 * 約定するとSL・TP管理なしの野良ポジションになるため、キャンセルして安全側に倒す。
 */
async function cancelOrphanedBuyOrders(): Promise<void> {
  // ブローカーの未約定注文一覧を取得
  const res = await getOrders({ statusFilter: "" });
  if (!res || res.sResultCode !== "0") return;

  const brokerOrders = (res.aOrderList as Record<string, unknown>[]) ?? [];

  // DBに記録されているbrokerOrderIdのセットを作成
  const dbOrderIds = new Set(
    (
      await prisma.tradingOrder.findMany({
        where: { brokerOrderId: { not: null } },
        select: { brokerOrderId: true },
      })
    ).map((o) => o.brokerOrderId!),
  );

  for (const bo of brokerOrders) {
    const orderNum = String(bo.sOrderOrderNumber ?? bo.sOrderNumber ?? "");
    const businessDay = String(bo.sOrderSikkouDay ?? bo.sEigyouDay ?? "");
    const side = String(bo.sBaibaiKubun ?? bo.sOrderBaibaiKubun ?? "");
    const status = String(bo.sOrderStatusCode ?? bo.sOrderStatus ?? "");

    // 買い注文かつ未約定（UNFILLED or PARTIAL_FILLED）のみ対象
    if (side !== TACHIBANA_ORDER.SIDE.BUY) continue;
    if (
      status !== TACHIBANA_ORDER_STATUS.UNFILLED &&
      status !== TACHIBANA_ORDER_STATUS.PARTIAL_FILLED
    ) continue;
    if (!orderNum || !businessDay) continue;

    // DBに対応レコードがある場合はスキップ
    if (dbOrderIds.has(orderNum)) continue;

    // 孤立買い注文 → 通知のみ（自動キャンセル停止中）
    console.warn(
      `[broker-reconciliation] 孤立買い注文を検出: ${orderNum} (${businessDay}) → 通知のみ`,
    );
    await notifySlack({
      title: `⚠️ 要確認: 孤立買い注文を検出`,
      message: `注文番号: ${orderNum}\n営業日: ${businessDay}\nDBに記録のない買い注文が存在します\n手動で確認してください`,
      color: "warning",
    }).catch(() => {});
  }
}

// 単発実行（`npm run reconcile`）: WebSocket見逃し・reconciliation取りこぼしの手動復旧用。
// worker の cron を待たずに Phase1(注文同期→businessDayバックフィル)→Phase2(見逃し約定リカバリ)→
// Phase3(保有照合) を1回実行する。本番 .env で `tsx src/jobs/broker-reconciliation.ts`。
const isDirectRun = process.argv[1]?.includes("broker-reconciliation");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Broker Reconciliation エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
