# Broker Reconciliation Job Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** DBとブローカー実態の差異を毎分自動検出・修正する専用ジョブを新設し、position-monitorから照合処理を分離する。

**Architecture:** `src/jobs/broker-reconciliation.ts` を新設し、現在 position-monitor 内で行っている `syncBrokerOrderStatuses()` / `recoverMissedFills()` をここに移管する。加えて、保有株数照合（getHoldings vs DBオープンポジション）とSL注文照合（失効検出・再発注）を追加する。worker.ts では reconciliation → position-monitor の順にシーケンシャル実行を保証する。

**Tech Stack:** TypeScript, Prisma, Tachibana broker API (`getHoldings`, `getOrderDetail`, `syncBrokerOrderStatuses`, `recoverMissedFills`), Slack通知

---

### Task 1: broker-reconciliation.ts を新規作成

**Files:**
- Create: `src/jobs/broker-reconciliation.ts`

**Step 1: ファイルを作成する**

```typescript
/**
 * ブローカー照合ジョブ（毎分・市場時間中）
 *
 * DBとブローカー実態の差異を検出・自動修正する。
 * position-monitor より先に実行されることを前提とする。
 *
 * Phase 1: 注文ステータス同期    (syncBrokerOrderStatuses から移管)
 * Phase 2: 見逃し約定リカバリ   (recoverMissedFills から移管)
 * Phase 3: 保有株数照合         (NEW) ブローカー保有 vs DBオープンポジション
 * Phase 4: SL注文照合           (NEW) 失効・取消SLの再発注
 */

import { prisma } from "../lib/prisma";
import { notifySlack } from "../lib/slack";
import { syncBrokerOrderStatuses, getHoldings, getOrderDetail } from "../core/broker-orders";
import { recoverMissedFills } from "../core/broker-fill-handler";
import { closePosition } from "../core/position-manager";
import { submitBrokerSL } from "../core/broker-sl-manager";
import { TACHIBANA_ORDER_STATUS } from "../lib/constants/broker";

export async function main(): Promise<void> {
  console.log("=== Broker Reconciliation 開始 ===");

  // Phase 1: 注文ステータス同期
  try {
    await syncBrokerOrderStatuses();
  } catch (e) {
    console.warn("[broker-reconciliation] syncBrokerOrderStatuses error (ignored):", e);
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

  // Phase 4: SL注文照合
  try {
    await reconcileSLOrders();
  } catch (e) {
    console.warn("[broker-reconciliation] reconcileSLOrders error (ignored):", e);
  }

  console.log("=== Broker Reconciliation 完了 ===");
}

/**
 * ブローカー実保有 vs DBオープンポジションを照合する
 *
 * ブローカーに保有がないポジションを検出し、SL約定の有無を確認してDBをクローズする。
 * 数量が不一致の場合はSlackアラートを送信する。
 */
async function reconcileHoldings(): Promise<void> {
  const [brokerHoldings, openPositions] = await Promise.all([
    getHoldings(),
    prisma.tradingPosition.findMany({
      where: { status: "open" },
      include: { stock: true },
    }),
  ]);

  if (!openPositions.length) return;

  const holdingMap = new Map(brokerHoldings.map((h) => [h.ticker, h]));

  for (const position of openPositions) {
    const ticker = position.stock.tickerCode;
    const holding = holdingMap.get(ticker);

    if (!holding) {
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
        const execList =
          (detail.aYakuzyouSikkouList as Record<string, unknown>[]) ?? [];
        let filledPrice = 0;

        if (execList.length > 0) {
          let totalAmount = 0;
          let totalQuantity = 0;
          for (const exec of execList) {
            const price = Number(exec.sYakuzyouPrice ?? exec.sExecPrice ?? 0);
            const qty = Number(exec.sYakuzyouSuryou ?? exec.sExecQuantity ?? 0);
            totalAmount += price * qty;
            totalQuantity += qty;
          }
          filledPrice = totalQuantity > 0 ? Math.round(totalAmount / totalQuantity) : 0;
        }

        if (filledPrice > 0) {
          await closePosition(position.id, filledPrice, {
            exitReason: "SL約定（ブローカー自律執行・照合リカバリ）",
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
    }
  }

  // SL注文なし or 約定確認できず → 手動対応を要請
  await notifySlack({
    title: `⚠️ ポジション照合エラー: ${ticker}`,
    message: `DBにオープンポジションがありますがブローカー保有が見つかりません\npositionId: ${position.id}\nSL注文: ${position.slBrokerOrderId ?? "なし"}\n手動確認が必要です`,
    color: "danger",
  }).catch(() => {});
}

/**
 * SL注文の状態を照合する
 *
 * オープンポジションのSL注文が失効・取消されている場合は再発注する。
 * SL約定（FULLY_FILLED）は Phase 3 の保有照合で処理済みのためここではスキップ。
 */
async function reconcileSLOrders(): Promise<void> {
  const openPositions = await prisma.tradingPosition.findMany({
    where: {
      status: "open",
      slBrokerOrderId: { not: null },
      slBrokerBusinessDay: { not: null },
    },
    include: { stock: true },
  });

  if (!openPositions.length) return;

  for (const position of openPositions) {
    if (!position.slBrokerOrderId || !position.slBrokerBusinessDay) continue;

    const detail = await getOrderDetail(
      position.slBrokerOrderId,
      position.slBrokerBusinessDay,
    ).catch(() => null);

    if (!detail) continue;

    const brokerStatus = String(detail.sOrderStatusCode ?? detail.sOrderStatus ?? "");
    const ticker = position.stock.tickerCode;

    // 失効・取消の場合は再発注（約定は Phase 3 で処理済み）
    if (
      brokerStatus === TACHIBANA_ORDER_STATUS.EXPIRED ||
      brokerStatus === TACHIBANA_ORDER_STATUS.CANCELLED
    ) {
      const reason = brokerStatus === TACHIBANA_ORDER_STATUS.EXPIRED ? "失効" : "取消";
      console.warn(
        `[broker-reconciliation] ${ticker}: SL注文 ${position.slBrokerOrderId} が${reason} → 再発注`,
      );

      // SL IDをクリアしてから再発注
      await prisma.tradingPosition.update({
        where: { id: position.id },
        data: { slBrokerOrderId: null, slBrokerBusinessDay: null },
      });

      // 最新のSL価格（trailingStop優先）で再発注
      const stopPrice =
        position.trailingStopPrice != null
          ? Number(position.trailingStopPrice)
          : Number(position.stopLossPrice ?? 0);

      if (stopPrice > 0) {
        await submitBrokerSL({
          positionId: position.id,
          ticker,
          quantity: position.quantity,
          stopTriggerPrice: stopPrice,
          strategy: position.strategy,
        });
        await notifySlack({
          title: `⚠️ SL注文再発注: ${ticker}`,
          message: `SL注文 ${position.slBrokerOrderId} が${reason}されたため再発注しました\nトリガー価格: ¥${stopPrice.toLocaleString()}`,
          color: "warning",
        }).catch(() => {});
      } else {
        await notifySlack({
          title: `❌ SL注文再発注失敗: ${ticker}`,
          message: `SL注文 ${position.slBrokerOrderId} が${reason}されましたが、SL価格が不明なため再発注できません\npositionId: ${position.id}\n手動対応が必要です`,
          color: "danger",
        }).catch(() => {});
      }
    }
  }
}
```

**Step 2: TypeScriptのコンパイルエラーがないか確認する**

```bash
cd /Users/kohei.kameyama/develop/auto-stock-trader
npx tsc --noEmit 2>&1 | head -30
```

Expected: エラーなし

**Step 3: Commit**

```bash
git add src/jobs/broker-reconciliation.ts
git commit -m "feat: ブローカー照合ジョブを新設（保有照合・SL照合）"
```

---

### Task 2: position-monitor から syncBrokerOrderStatuses / recoverMissedFills を削除

**Files:**
- Modify: `src/jobs/position-monitor.ts:48-49,77-87`

position-monitor の以下のセクションを削除する：

**削除対象（import行）:**
```typescript
import { syncBrokerOrderStatuses, cancelOrder, submitOrder } from "../core/broker-orders";
import { recoverMissedFills } from "../core/broker-fill-handler";
```
→ `syncBrokerOrderStatuses` と `recoverMissedFills` のimportを削除する。
`cancelOrder` と `submitOrder` は position-monitor 内で引き続き使用しているため、`broker-orders` のimportは残す。

**削除対象（main関数内）:**
```typescript
  // 0. ブローカー注文ステータス同期 + WebSocket見逃し約定リカバリ
  try {
    await syncBrokerOrderStatuses();
  } catch (e) {
    console.warn("[position-monitor] Broker sync error (ignored):", e);
  }
  try {
    await recoverMissedFills();
  } catch (e) {
    console.warn("[position-monitor] Fill recovery error (ignored):", e);
  }
```
→ このブロック全体（コメントも含む）を削除する。

**Step 1: import行を修正する**

`syncBrokerOrderStatuses` のimportを削除し、`cancelOrder, submitOrder` のみ残す：

```typescript
import { cancelOrder, submitOrder } from "../core/broker-orders";
```

そして `recoverMissedFills` のimport行を削除する。

**Step 2: main関数内のステップ0ブロックを削除する**

**Step 3: コンパイルエラーがないか確認する**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: エラーなし

**Step 4: Commit**

```bash
git add src/jobs/position-monitor.ts
git commit -m "refactor: syncBrokerOrderStatuses/recoverMissedFillsをbroker-reconciliationに移管"
```

---

### Task 3: worker.ts を修正して reconciliation → position-monitor の順に実行

**Files:**
- Modify: `src/worker.ts`

**Step 1: import を追加する**

```typescript
import { main as runBrokerReconciliation } from "./jobs/broker-reconciliation";
```

**Step 2: schedules 配列の position-monitor エントリを書き換える**

現在の position-monitor スケジュール定義を、reconciliation → monitor をシーケンシャルに実行するラッパーに変更する。

`worker.ts` の schedules 配列定義の前に以下を追加する：

```typescript
// 市場時間の毎分tick: reconciliation → position-monitor の順に実行
async function runMarketTick() {
  await runJob("broker-reconciliation", runBrokerReconciliation, true);
  await runJob("position-monitor", runMonitor, true);
}
```

schedules 配列の position-monitor エントリを `runMarketTick` に置き換える：

```typescript
  // 9:00-11:30, 12:30-15:30 毎分 ポジション監視（平日・市場時間）
  { cron: "0-59 9 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "* 10 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "0-30 11 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "30-59 12 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "* 13-14 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "0-30 15 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
```

> **注意:** `requiresMarketDay: false` にする理由は、`runJob` 内の休場日チェック・システム停止チェックを `runMarketTick` レベルではなく、内部の `runJob("broker-reconciliation", ...)` と `runJob("position-monitor", ...)` それぞれで行わせるため。各サブジョブの `requiresMarketDay: true` は変えない。

`runMarketTick` 自体は `runJob` でラップしないので、二重ラップにならないよう注意。

schedules 配列は以下のようになる（breakout-monitor は変更なし）：

```typescript
const schedules = [
  // 市場時間の毎分tick（reconciliation → position-monitor の順）
  { cron: "0-59 9 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "* 10 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "0-30 11 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "30-59 12 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "* 13-14 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "0-30 15 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  // 9:00-11:30, 12:30-15:25 毎分 ブレイクアウト監視（変更なし）
  { cron: "0-59 9 * * 1-5", job: runBreakoutMonitor, name: "breakout-monitor", requiresMarketDay: true },
  { cron: "* 10 * * 1-5", job: runBreakoutMonitor, name: "breakout-monitor", requiresMarketDay: true },
  { cron: "0-30 11 * * 1-5", job: runBreakoutMonitor, name: "breakout-monitor", requiresMarketDay: true },
  { cron: "30-59 12 * * 1-5", job: runBreakoutMonitor, name: "breakout-monitor", requiresMarketDay: true },
  { cron: "* 13-14 * * 1-5", job: runBreakoutMonitor, name: "breakout-monitor", requiresMarketDay: true },
  { cron: "0-25 15 * * 1-5", job: runBreakoutMonitor, name: "breakout-monitor", requiresMarketDay: true },
];
```

また、`holidaySkipLogged` のリセット対象に `broker-reconciliation` を追加する：

```typescript
  () => {
    for (const task of cronTasks) task.start();
    holidaySkipLogged.delete("position-monitor:inactive");
    holidaySkipLogged.delete("broker-reconciliation:inactive");
    holidaySkipLogged.delete("breakout-monitor:inactive");
    console.log(`[${nowJST()}] cron タスク再開（${cronTasks.length}件）`);
  },
```

**Step 3: コンパイルエラーがないか確認する**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: エラーなし

**Step 4: Commit**

```bash
git add src/worker.ts
git commit -m "feat: worker.tsでreconciliation→position-monitorのシーケンシャル実行を保証"
```
