# Morning SL Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** デモサーバーが毎日リセットされても、朝にSL注文を再発注してポジションを維持できるようにする。

**Architecture:**
デモサーバーは毎日リセットされるため、前日に発注したSL注文が消える。朝市場オープン前に `morning-sl-sync` バッチを実行し、DBのオープンポジション全件に対してSL注文を再発注する。併せて `reconcileHoldings`（Phase 3）をデモモードではスキップし、保有照合による誤クローズを防止する。

**Tech Stack:** TypeScript, Prisma, Tachibana Broker API, node-cron, cron-job.org

---

### Task 1: `src/jobs/morning-sl-sync.ts` を作成する

**Files:**
- Create: `src/jobs/morning-sl-sync.ts`

**Step 1: ファイルを作成する**

```typescript
/**
 * 朝のSL注文同期ジョブ（市場オープン前・毎営業日）
 *
 * デモサーバーは毎日データをリセットするため、前日に発注したSL注文が消える。
 * 市場オープン前にDBのオープンポジション全件のSL注文を再発注して状態を同期する。
 *
 * 本番環境でも実行可能（既存SL注文がある場合は上書き）。
 * Phase 4（reconcileSLOrders）は市場時間中の再発注をカバーするが、
 * このジョブはオープン直前のサーバーリセット対策として位置づける。
 */

import { prisma } from "../lib/prisma";
import { notifySlack } from "../lib/slack";
import { submitBrokerSL } from "../core/broker-sl-manager";

export async function main(): Promise<void> {
  console.log("=== Morning SL Sync 開始 ===");

  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: "open" },
    include: { stock: true },
  });

  if (!openPositions.length) {
    console.log("[morning-sl-sync] オープンポジションなし → スキップ");
    return;
  }

  console.log(`[morning-sl-sync] ${openPositions.length}件のポジションのSLを再発注`);

  let successCount = 0;
  let failCount = 0;

  for (const position of openPositions) {
    const ticker = position.stock.tickerCode;

    // 旧SL注文IDをクリア（デモリセット後は無効なIDなので上書き）
    if (position.slBrokerOrderId) {
      await prisma.tradingPosition.update({
        where: { id: position.id },
        data: { slBrokerOrderId: null, slBrokerBusinessDay: null },
      });
      console.log(`[morning-sl-sync] ${ticker}: 旧SL注文IDをクリア (${position.slBrokerOrderId})`);
    }

    // SL価格: trailingStopPrice 優先、なければ stopLossPrice
    const stopPrice =
      position.trailingStopPrice != null
        ? Number(position.trailingStopPrice)
        : Number(position.stopLossPrice ?? 0);

    if (stopPrice <= 0) {
      console.warn(`[morning-sl-sync] ${ticker}: SL価格が不明 → スキップ`);
      failCount++;
      continue;
    }

    try {
      await submitBrokerSL({
        positionId: position.id,
        ticker,
        quantity: position.quantity,
        stopTriggerPrice: stopPrice,
        strategy: position.strategy,
      });
      successCount++;
    } catch (err) {
      console.error(`[morning-sl-sync] ${ticker}: SL再発注失敗:`, err);
      failCount++;
    }
  }

  console.log(`=== Morning SL Sync 完了 (成功=${successCount}, 失敗=${failCount}) ===`);

  await notifySlack({
    title: `📋 朝のSL注文同期完了`,
    message: `${openPositions.length}件のポジションを処理\n✅ 成功: ${successCount}件\n${failCount > 0 ? `❌ 失敗: ${failCount}件` : ""}`,
    color: failCount > 0 ? "warning" : "good",
  }).catch(() => {});
}
```

**Step 2: 動作確認ポイント**
- `position.trailingStopPrice` → `position.stopLossPrice` のフォールバック順
- `submitBrokerSL` は成功時に `slBrokerOrderId`/`slBrokerBusinessDay` をDBに書き込む
- 失敗してもループを継続（1件の失敗で全体停止しない）

---

### Task 2: `reconcileHoldings` をデモモードでスキップする

**Files:**
- Modify: `src/jobs/broker-reconciliation.ts:62-100`

**Step 1: `reconcileHoldings` 関数の先頭にデモモードチェックを追加する**

```typescript
async function reconcileHoldings(): Promise<void> {
  // デモサーバーは毎日リセットされるため保有照合をスキップ
  // morning-sl-sync で SL 注文を再発注済みなので、ポジション管理は継続される
  if (process.env.TACHIBANA_ENV === "demo") {
    console.log("[broker-reconciliation] デモモード: 保有照合スキップ");
    return;
  }

  const [brokerHoldings, openPositions] = await Promise.all([
  // ...既存コード...
```

**Step 2: 変更後の動作確認ポイント**
- `TACHIBANA_ENV=demo` の場合: Phase 3 は即 return、Phase 4 のSL照合は継続
- `TACHIBANA_ENV=production` の場合: 従来通りの保有照合を実行

---

### Task 3: `src/web/routes/cron.ts` に登録する

**Files:**
- Modify: `src/web/routes/cron.ts`

**Step 1: import を追加する**

既存の import 群の末尾に追加:
```typescript
import { main as runMorningSLSync } from "../../jobs/morning-sl-sync";
```

**Step 2: JOBS マップに追加する**

```typescript
const JOBS: Record<string, JobDef> = {
  // ...既存エントリ...
  "morning-sl-sync": { fn: runMorningSLSync, requiresMarketDay: true },
};
```

---

### Task 4: cron-job.org にジョブを登録する（手動作業）

**実行タイミング:** 8:50 JST（市場オープン9:00の10分前）

**Step 1: 環境変数 `CRONJOB_API_KEY` を確認する**

```bash
echo $CRONJOB_API_KEY
```

**Step 2: cron-job.org API でジョブを作成する**

`APP_URL` と `CRON_SECRET` は環境に合わせて設定:

```bash
curl -s -X PUT -H "Authorization: Bearer $CRONJOB_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.cron-job.org/jobs" \
  -d '{
    "job": {
      "url": "'"$APP_URL"'/api/cron/morning-sl-sync",
      "title": "morning-sl-sync (SL注文朝再発注)",
      "enabled": true,
      "requestMethod": 1,
      "extendedData": {
        "headers": [{"name": "Authorization", "value": "Bearer '"$CRON_SECRET"'"}]
      },
      "schedule": {
        "timezone": "Asia/Tokyo",
        "hours": [8],
        "minutes": [50],
        "mdays": [-1],
        "months": [-1],
        "wdays": [1,2,3,4,5]
      }
    }
  }' | jq
```

**Step 3: 登録確認**

```bash
curl -s -H "Authorization: Bearer $CRONJOB_API_KEY" \
  "https://api.cron-job.org/jobs" | jq '.jobs[] | select(.title | contains("morning-sl-sync"))'
```

---

### Task 5: 仕様書を更新する

**Files:**
- Modify: `docs/specs/batch-processing.md`

`batch-processing.md` の「ワークフロー一覧」または「バッチ処理一覧」セクションに追記:

```markdown
### morning-sl-sync（朝のSL注文同期）

- **実行タイミング**: 毎営業日 8:50 JST（cron-job.org）
- **目的**: デモサーバーの毎日リセットによりSL注文が消えるため、市場オープン前に再発注する
- **処理内容**:
  1. DBのオープンポジション全件を取得
  2. 旧SL注文IDをクリア（デモリセット後は無効）
  3. trailingStopPrice または stopLossPrice で SL 注文を再発注
- **本番環境**: 稼働可能（既存SL注文の上書き再発注）
- **備考**: `reconcileHoldings`（Phase 3）はデモモードではスキップされる
```

---

### Task 6: 手動テスト

**Step 1: ローカルでジョブを直接実行する**

```bash
npx tsx -e "
import { main } from './src/jobs/morning-sl-sync';
main().then(() => process.exit(0)).catch(console.error);
"
```

期待する出力:
- オープンポジションがある場合: `Morning SL Sync 開始` → 各銘柄の再発注ログ → `Morning SL Sync 完了`
- オープンポジションがない場合: `オープンポジションなし → スキップ`

**Step 2: HTTP エンドポイントをcurlでテストする**

```bash
curl -X POST "http://localhost:3000/api/cron/morning-sl-sync" \
  -H "Authorization: Bearer $CRON_SECRET"
```

期待するレスポンス:
```json
{ "status": "completed", "jobName": "morning-sl-sync", ... }
```

**Step 3: デモモードの保有照合スキップを確認する**

```bash
# ログに以下が出力されることを確認
# [broker-reconciliation] デモモード: 保有照合スキップ
```

---

### 実装後の動作フロー（デモ環境）

```
毎営業日 8:50 JST
  └─ morning-sl-sync
       ├─ オープンポジション全件取得
       └─ 各ポジションのSL注文を再発注

毎営業日 9:00 JST〜（毎分）
  └─ broker-reconciliation
       ├─ Phase 1: 注文ステータス同期
       ├─ Phase 2: 見逃し約定リカバリ
       ├─ Phase 3: 保有照合 → デモモードはスキップ ✓
       └─ Phase 4: SL注文照合（失効・取消の再発注）
  └─ position-monitor（TP/SL/タイムストップ判定）
```
