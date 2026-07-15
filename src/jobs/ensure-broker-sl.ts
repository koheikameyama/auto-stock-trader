/**
 * SL未発注ポジション保険ジョブ
 *
 * status="open" かつ slBrokerOrderId=null のポジションに対し、
 * DBの stopLossPrice を使って逆指値売り注文をブローカーに発注する。
 *
 * 立会終了後〜翌朝前場開始前の「翌日注文受付時間帯」をカバーする目的。
 * position-monitor は取引時間内のみ動作するため、その時間帯はこのジョブが
 * SL抜けを防ぐ。quote を使わず trail再計算もしないため、取引時間外でも安全。
 *
 * リトライ上限（MAX_SL_RETRIES）を設け、超過時は自動再発注を停止し通知のみにする。
 * これにより、ブローカー側で繰り返しSLが取消される場合の無限ループを防止する。
 *
 * ⚠️ カウントするのは **連続失敗数** であって、そのポジションで再発注した通算回数ではない
 * （KOH-555）。立花の `sOrderExpireDay` は最大10営業日なので、20営業日保有する固定SL戦略
 * （buyback/panic）の逆指値は**正常系でも期限が来て再発注される**。通算で数えると、
 * 正常な期限更新を数回こなしただけで上限に達し、以後そのポジションが恒久的に SL 無しになる。
 */

import { prisma } from "../lib/prisma";
import { submitBrokerSL } from "../core/broker-sl-manager";
import { notifySlack } from "../lib/slack";

/** 同一ポジションのSL再発注の**連続失敗**上限（プロセスライフタイム内。成功でリセット） */
const MAX_SL_RETRIES = 3;
const consecutiveFailures = new Map<string, number>();

/** 連続失敗カウンタをリセットする（テスト用） */
export function resetSLFailureCounts(): void {
  consecutiveFailures.clear();
}

/** DB一時障害向けの簡易リトライ（接続不可・タイムアウトのみ対象） */
async function withDbRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 3;
  const baseDelayMs = 1000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isConnError =
        msg.includes("Can't reach database server") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("Connection terminated");
      if (!isConnError || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `[ensure-broker-sl] DB接続失敗 (${label}, attempt ${attempt}/${maxAttempts}): ${msg} → ${delay}ms後に再試行`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export async function main(): Promise<void> {
  const tag = "[ensure-broker-sl]";

  const targets = await withDbRetry(
    () =>
      prisma.tradingPosition.findMany({
        where: { status: "open", slBrokerOrderId: null },
        include: { stock: { select: { tickerCode: true } } },
      }),
    "findMany",
  );

  if (!targets.length) return;

  console.log(`${tag} SL未発注ポジション ${targets.length}件を処理`);

  for (const pos of targets) {
    if (!pos.stopLossPrice) {
      console.warn(
        `${tag} ${pos.stock.tickerCode} (${pos.id}): stopLossPrice が未設定のためスキップ`,
      );
      continue;
    }

    const failures = consecutiveFailures.get(pos.id) ?? 0;
    if (failures >= MAX_SL_RETRIES) {
      console.warn(
        `${tag} ${pos.stock.tickerCode} (${pos.id}): 連続失敗上限(${MAX_SL_RETRIES})到達 → 通知のみ`,
      );
      await notifySlack({
        title: `🚨 SL再発注リトライ上限: ${pos.stock.tickerCode}`,
        message: `SL注文の自動再発注が${MAX_SL_RETRIES}回連続で失敗しました\npositionId: ${pos.id}\nSLトリガー: ¥${Number(pos.stopLossPrice).toLocaleString()}\n手動でSL注文を確認・再発注してください`,
        color: "danger",
      }).catch(() => {});
      continue;
    }

    if (failures > 0) {
      await notifySlack({
        title: `⚠️ SL自動再発注 (${failures + 1}/${MAX_SL_RETRIES}): ${pos.stock.tickerCode}`,
        message: `SL注文を自動再発注します\npositionId: ${pos.id}\nSLトリガー: ¥${Number(pos.stopLossPrice).toLocaleString()}`,
        color: "warning",
      }).catch(() => {});
    }

    const ok = await submitBrokerSL({
      positionId: pos.id,
      ticker: pos.stock.tickerCode,
      quantity: pos.quantity,
      stopTriggerPrice: Number(pos.stopLossPrice),
      strategy: pos.strategy,
    });

    // 成功したらカウンタを捨てる。固定SL戦略(20営業日)は立花の期限上限(10営業日)を超えるため
    // 正常系でも期限更新の再発注が入る。通算で数えると数回の正常更新で上限に達し、以後
    // そのポジションが恒久的に SL 無しになる (KOH-555)。
    if (ok) consecutiveFailures.delete(pos.id);
    else consecutiveFailures.set(pos.id, failures + 1);
  }
}
