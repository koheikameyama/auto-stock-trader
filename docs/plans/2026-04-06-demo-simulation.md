# デモ環境価格ベース出口シミュレーション 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** デモ環境でもブローカー保有 API に依存せず、価格ベースで SL・trailing stop・time stop が正しく動作するようにする。

**Architecture:** `position-monitor.ts` の exit 処理に `isTachibanaProduction` 分岐を追加し、デモ時は約定通知を待たず即 `closePosition` する。`updateBrokerSL` と `morning-sl-sync` もデモ時はスキップ。

**Tech Stack:** TypeScript, vitest, prisma, 立花証券 API

---

## 背景

立花証券デモ環境の制約：
- `CLMGenbutuKabuList`（保有一覧）は固定値を返し、取引を反映しない → Phase 3 照合は実装済みでスキップ済み
- デモサーバーは毎日データをリセットするため、前日の SL 注文が消える
- WebSocket 約定通知の信頼性が不明

## 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/core/broker-sl-manager.ts` | `updateBrokerSL` にデモスキップを追加 |
| `src/jobs/morning-sl-sync.ts` | デモ環境では早期リターン |
| `src/jobs/position-monitor.ts` | exit 処理にデモ即クローズ分岐を追加 |

## テストファイル

| ファイル | 状態 |
|---------|------|
| `src/core/__tests__/broker-sl-manager.test.ts` | 既存 |
| `src/jobs/__tests__/morning-sl-sync.test.ts` | 既存 |
| `src/jobs/position-monitor.ts` のテスト | 存在しない（今回は追加しない） |

---

## Task 1: `updateBrokerSL` のデモスキップ

**Files:**
- Modify: `src/core/broker-sl-manager.ts` (L146-161)
- Test: `src/core/__tests__/broker-sl-manager.test.ts`

現在の `updateBrokerSL`（L146-161）：
```typescript
export async function updateBrokerSL(params: { ... }): Promise<void> {
  await cancelBrokerSL(params.positionId);
  await submitBrokerSL({ ... });
}
```

### Step 1: 失敗するテストを書く

`src/core/__tests__/broker-sl-manager.test.ts` の `updateBrokerSL` テストブロック末尾に追加：

```typescript
it("デモ環境（isTachibanaProduction=false）ではcancelBrokerSLとsubmitBrokerSLを呼ばない", async () => {
  mockBrokerConstants.isTachibanaProduction = false;

  await updateBrokerSL({
    positionId: "pos-1",
    ticker: "7203.T",
    quantity: 100,
    newStopTriggerPrice: 900,
    strategy: "breakout",
  });

  expect(mockCancelOrder).not.toHaveBeenCalled();
  expect(mockSubmitOrder).not.toHaveBeenCalled();
});
```

注意: `broker-sl-manager.test.ts` には `mockBrokerConstants` が存在しない場合、Task 1 の最初に hoisted mock と vi.mock を追加する必要がある。テストファイルの先頭の hoisted ブロックと vi.mock ブロックを確認し、なければ `broker-reconciliation.test.ts` と同じパターンで追加すること。

追加するモック（`vi.hoisted` ブロックに）：
```typescript
mockBrokerConstants: { isTachibanaProduction: true },
```

追加する `vi.mock`：
```typescript
vi.mock("../../lib/constants/broker", () => ({
  TACHIBANA_ORDER: {
    SIDE: { SELL: "1", BUY: "3" },
    MARKET_PRICE: "0",
    EXPIRE: { TODAY: "0" },
    EXCHANGE: { TSE: "00" },
    CONDITION: { NONE: "0" },
    MARGIN_TYPE: { CASH: "0" },
    REVERSE_ORDER_TYPE: { NORMAL: "0", REVERSE_ONLY: "1", NORMAL_AND_REVERSE: "2" },
    TAX_TYPE: { SPECIFIC: "1" },
  },
  TACHIBANA_ORDER_STATUS: { FULLY_FILLED: "10", CANCELLED: "7", EXPIRED: "12" },
  get isTachibanaProduction() { return mockBrokerConstants.isTachibanaProduction; },
}));
```

既存テストの `beforeEach` に追加：
```typescript
mockBrokerConstants.isTachibanaProduction = true;
```

### Step 2: テストを実行して失敗を確認

```bash
npx vitest run src/core/__tests__/broker-sl-manager.test.ts
```

期待: `updateBrokerSL` の新テストが FAIL（cancelBrokerSL が呼ばれる）

### Step 3: 実装

`src/core/broker-sl-manager.ts` の import に追加：
```typescript
import { isTachibanaProduction } from "../lib/constants/broker";
```

`updateBrokerSL` 関数冒頭に追加：
```typescript
export async function updateBrokerSL(params: { ... }): Promise<void> {
  if (!isTachibanaProduction) {
    console.log(`[broker-sl-manager] デモ環境のためupdateBrokerSLをスキップ: ${params.ticker}`);
    return;
  }
  await cancelBrokerSL(params.positionId);
  await submitBrokerSL({ ... });
}
```

### Step 4: テストを実行して通過を確認

```bash
npx vitest run src/core/__tests__/broker-sl-manager.test.ts
```

期待: 全テスト PASS

### Step 5: コミット

```bash
git add src/core/broker-sl-manager.ts src/core/__tests__/broker-sl-manager.test.ts
git commit -m "fix: デモ環境でupdateBrokerSLをスキップ（価格ベース管理に移行）"
```

---

## Task 2: `morning-sl-sync` のデモスキップ

**Files:**
- Modify: `src/jobs/morning-sl-sync.ts`
- Test: `src/jobs/__tests__/morning-sl-sync.test.ts`

### Step 1: 失敗するテストを書く

`src/jobs/__tests__/morning-sl-sync.test.ts` のテストブロックに追加：

まず hoisted ブロックと vi.mock を確認し、`broker-sl-manager.test.ts` と同様に `mockBrokerConstants` + `vi.mock("../../lib/constants/broker")` を追加。

テストを追加：
```typescript
it("デモ環境ではSL再発注をスキップしSlack通知もしない", async () => {
  mockBrokerConstants.isTachibanaProduction = false;
  mockPositionFindMany.mockResolvedValue([makePosition()]);

  await main();

  expect(mockSubmitBrokerSL).not.toHaveBeenCalled();
  expect(mockNotifySlack).not.toHaveBeenCalled();
});
```

### Step 2: テストを実行して失敗を確認

```bash
npx vitest run src/jobs/__tests__/morning-sl-sync.test.ts
```

期待: 新テストが FAIL（submitBrokerSL が呼ばれる）

### Step 3: 実装

`src/jobs/morning-sl-sync.ts` に import を追加：
```typescript
import { isTachibanaProduction } from "../lib/constants/broker";
```

`main()` 関数の冒頭（ログ出力の直後）に追加：
```typescript
export async function main(): Promise<void> {
  console.log("=== Morning SL Sync 開始 ===");

  if (!isTachibanaProduction) {
    console.log("[morning-sl-sync] デモ環境のためスキップ（価格ベース管理に移行）");
    return;
  }

  // ... 以降は既存コード
```

### Step 4: テストを実行して通過を確認

```bash
npx vitest run src/jobs/__tests__/morning-sl-sync.test.ts
```

期待: 全テスト PASS

### Step 5: コミット

```bash
git add src/jobs/morning-sl-sync.ts src/jobs/__tests__/morning-sl-sync.test.ts
git commit -m "fix: デモ環境でmorning-sl-syncをスキップ（SLブローカー依存を除去）"
```

---

## Task 3: `position-monitor.ts` の exit 処理（調査済み・変更不要）

**Files:**
- Modify: `src/jobs/position-monitor.ts` (L451-494 付近)

注意: `position-monitor.ts` にはテストが存在しない。変更は手動テストで確認する。

現在の exit 処理（L487-494 付近）：
```typescript
await cancelBrokerSL(position.id);
await submitOrder({
  ticker: position.stock.tickerCode,
  side: "sell",
  quantity: position.quantity,
  limitPrice: null,
}).catch((err) =>
  console.error(`[position-monitor] sell order error: ${err}`),
);

const closedPosition = await closePosition(
  position.id,
  exitPrice,
  exitSnapshot as object,
);
```

### Step 1: 実装

`src/jobs/position-monitor.ts` に import を追加：
```typescript
import { isTachibanaProduction } from "../lib/constants/broker";
```

exit 処理ブロック（`cancelBrokerSL` → `submitOrder` → `closePosition` の部分）を以下に変更：

```typescript
await cancelBrokerSL(position.id);
await submitOrder({
  ticker: position.stock.tickerCode,
  side: "sell",
  quantity: position.quantity,
  limitPrice: null,
}).catch((err) =>
  console.error(`[position-monitor] sell order error: ${err}`),
);

// デモ環境: 約定通知を待たず価格ベースで即クローズ
// 本番環境: pending order が作成され、約定通知で closePosition される
if (!isTachibanaProduction) {
  const closedPosition = await closePosition(
    position.id,
    exitPrice,
    exitSnapshot as object,
  );
  // 以降の closedPosition を使う処理（Slack通知等）はそのまま
```

注意: 既存の `closePosition` 呼び出しが本番では別の場所（約定通知フロー）にあるかを確認すること。`position-monitor.ts` の L487-494 付近のコードを正確に読み、既存の `closePosition` 呼び出しを `if (!isTachibanaProduction)` で囲む形に変更する。

### Step 2: TypeScript のビルドエラーがないか確認

```bash
npx tsc --noEmit
```

期待: エラーなし

### Step 3: コミット

```bash
git add src/jobs/position-monitor.ts
git commit -m "fix: デモ環境でposition-monitorの出口処理を価格ベース即クローズに変更"
```

---

## Task 4: 動作確認（デモ環境）

デモ環境で以下を確認：

1. ポジションが open 状態で存在する
2. `position-monitor` が起動し、SL 価格を下回る値が来た場合：
   - Slack に SL トリガーの通知が来る
   - DB のポジションが `closed` になる
   - 翌朝 `morning-sl-sync` が「デモ環境のためスキップ」とログ出力する

---

## 完了条件

- [ ] `updateBrokerSL` はデモ時に何もしない
- [ ] `morning-sl-sync` はデモ時に早期リターン
- [ ] `position-monitor` の exit 処理はデモ時に即 `closePosition`
- [ ] 全既存テストが PASS
- [ ] TypeScript ビルドエラーなし
