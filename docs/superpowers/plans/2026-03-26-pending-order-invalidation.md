# Pending注文の有効期限設定 + ブレイクアウト前提崩壊キャンセル Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ブレイクアウト戦略のpending注文にexpiresAtを設定し、勢いが消えた注文を自動キャンセルする

**Architecture:** entry-executorにexpiresAt設定と新関数`invalidateStalePendingOrders`を追加。breakout-monitorのスキャンループ内で毎分呼び出し、scannerの既存データ（surgeRatio・quotes）を再利用して追加API呼び出しゼロで前提崩壊を検出する。

**Tech Stack:** TypeScript, Prisma, Vitest

---

## File Structure

| ファイル | 変更種別 | 責務 |
|---------|---------|------|
| `src/core/breakout/entry-executor.ts` | Modify | expiresAt設定 + `invalidateStalePendingOrders` 関数追加 |
| `src/jobs/breakout-monitor.ts` | Modify | `invalidateStalePendingOrders` の呼び出し追加 |
| `src/core/breakout/__tests__/entry-executor.test.ts` | Modify | expiresAtテスト + invalidateテスト追加 |

---

### Task 1: expiresAt設定のテストと実装

**Files:**
- Modify: `src/core/breakout/__tests__/entry-executor.test.ts`
- Modify: `src/core/breakout/entry-executor.ts:14,128-154`

- [ ] **Step 1: executeEntryのexpiresAtテストを書く**

`src/core/breakout/__tests__/entry-executor.test.ts` の `describe("executeEntry")` ブロック末尾に追加:

```typescript
it("expiresAtが5日後の15:00に設定される", async () => {
  const result = await executeEntry(makeTrigger(), "simulation");

  expect(result.success).toBe(true);

  const createCall = mockPrisma.tradingOrder.create.mock.calls[0][0];
  const expiresAt: Date = createCall.data.expiresAt;
  expect(expiresAt).toBeInstanceOf(Date);

  // 現在から4〜6日後の範囲であること（テスト実行タイミングの揺れを許容）
  const now = new Date();
  const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  expect(diffDays).toBeGreaterThan(4);
  expect(diffDays).toBeLessThan(6);

  // 時刻が15:00であること（JST→UTCで6:00）
  expect(expiresAt.getUTCHours()).toBe(6);
  expect(expiresAt.getUTCMinutes()).toBe(0);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/core/breakout/__tests__/entry-executor.test.ts --reporter=verbose`
Expected: 新テスト「expiresAtが5日後の15:00に設定される」がFAIL（`expiresAt` が `undefined`）

- [ ] **Step 3: entry-executorにexpiresAt設定を実装**

`src/core/breakout/entry-executor.ts` に以下の変更を加える。

importセクション（14行目付近）に `dayjs` と `ORDER_EXPIRY` を追加:

```typescript
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { STOP_LOSS, POSITION_SIZING, UNIT_SHARES, TIMEZONE } from "../../lib/constants";
import { ORDER_EXPIRY } from "../../lib/constants/jobs";

dayjs.extend(utc);
dayjs.extend(timezone);
```

注: 既存の `import { STOP_LOSS, POSITION_SIZING, UNIT_SHARES } from "../../lib/constants";` を上記に置き換える（`TIMEZONE` を追加）。

`prisma.tradingOrder.create` の `data` オブジェクト（128-154行目）に `expiresAt` フィールドを追加:

```typescript
const newOrder = await prisma.tradingOrder.create({
  data: {
    stockId: stock.id,
    side: "buy",
    orderType: "limit",
    strategy: "breakout",
    limitPrice: currentPrice,
    takeProfitPrice,
    stopLossPrice,
    quantity,
    status: "pending",
    expiresAt: dayjs().tz(TIMEZONE).add(ORDER_EXPIRY.SWING_DAYS, "day").hour(15).minute(0).second(0).toDate(),
    reasoning: `ブレイクアウトトリガー: 出来高サージ比率 ${trigger.volumeSurgeRatio.toFixed(2)}x, 20日高値 ¥${trigger.high20} 突破`,
    entrySnapshot: {
      trigger: {
        ticker: trigger.ticker,
        currentPrice: trigger.currentPrice,
        volumeSurgeRatio: trigger.volumeSurgeRatio,
        high20: trigger.high20,
        atr14: trigger.atr14,
        triggeredAt: trigger.triggeredAt.toISOString(),
      },
      slClamped: isSLClamped,
      riskPct: POSITION_SIZING.RISK_PER_TRADE_PCT,
    },
  },
});
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/core/breakout/__tests__/entry-executor.test.ts --reporter=verbose`
Expected: 全テストPASS

- [ ] **Step 5: コミット**

```bash
git add src/core/breakout/entry-executor.ts src/core/breakout/__tests__/entry-executor.test.ts
git commit -m "feat: breakout pending注文にexpiresAt（5日後15:00）を設定"
```

---

### Task 2: invalidateStalePendingOrdersのテストと実装

**Files:**
- Modify: `src/core/breakout/__tests__/entry-executor.test.ts`
- Modify: `src/core/breakout/entry-executor.ts`

- [ ] **Step 1: invalidateStalePendingOrdersのテストを書く**

`src/core/breakout/__tests__/entry-executor.test.ts` に新しい `describe` ブロックを追加。

ファイル先頭のモック設定で、`prisma` モックに `tradingOrder.findMany` と `tradingOrder.updateMany` を追加:

```typescript
vi.mock("../../../lib/prisma", () => ({
  prisma: {
    marketAssessment: {
      findUnique: vi.fn(),
    },
    stock: {
      findUnique: vi.fn(),
    },
    tradingOrder: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    tradingConfig: {
      findFirst: vi.fn(),
    },
    tradingPosition: {
      findMany: vi.fn(),
    },
  },
}));
```

ファイル先頭のimportセクションに追加:

```typescript
import { invalidateStalePendingOrders } from "../entry-executor";
import type { QuoteData } from "../breakout-scanner";
```

broker-ordersモックに `cancelOrder` を追加:

```typescript
vi.mock("../../broker-orders", () => ({
  submitOrder: vi.fn(),
  cancelOrder: vi.fn(),
}));
```

importにも追加:

```typescript
import { submitOrder as submitBrokerOrder, cancelOrder } from "../../broker-orders";
const mockCancelOrder = vi.mocked(cancelOrder);
```

ファイル末尾に以下のテストブロックを追加:

```typescript
describe("invalidateStalePendingOrders", () => {
  function makePendingOrder(ticker: string, high20: number, overrides: Record<string, unknown> = {}) {
    return {
      id: `order-${ticker}`,
      side: "buy",
      status: "pending",
      strategy: "breakout",
      brokerOrderId: null,
      brokerBusinessDay: null,
      stock: { tickerCode: ticker },
      entrySnapshot: {
        trigger: { high20 },
      },
      ...overrides,
    };
  }

  function makeQuotes(data: Array<{ ticker: string; price: number }>): QuoteData[] {
    return data.map((d) => ({ ticker: d.ticker, price: d.price, volume: 100_000 }));
  }

  function makeSurgeRatios(data: Array<{ ticker: string; ratio: number }>): Map<string, number> {
    return new Map(data.map((d) => [d.ticker, d.ratio]));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockCancelOrder.mockResolvedValue({ success: true, isDryRun: false });
  });

  it("出来高萎縮（surgeRatio < 1.2）でpending注文をキャンセルする", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 990),
    ]);

    await invalidateStalePendingOrders(
      makeQuotes([{ ticker: "7203", price: 1000 }]),
      makeSurgeRatios([{ ticker: "7203", ratio: 0.8 }]),
      "simulation",
    );

    expect(mockPrisma.tradingOrder.update).toHaveBeenCalledWith({
      where: { id: "order-7203" },
      data: { status: "cancelled" },
    });
  });

  it("高値割り込み（price <= high20）でpending注文をキャンセルする", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 1000),
    ]);

    await invalidateStalePendingOrders(
      makeQuotes([{ ticker: "7203", price: 995 }]),
      makeSurgeRatios([{ ticker: "7203", ratio: 2.5 }]),
      "simulation",
    );

    expect(mockPrisma.tradingOrder.update).toHaveBeenCalledWith({
      where: { id: "order-7203" },
      data: { status: "cancelled" },
    });
  });

  it("条件を満たさない場合はキャンセルしない", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 990),
    ]);

    await invalidateStalePendingOrders(
      makeQuotes([{ ticker: "7203", price: 1000 }]),
      makeSurgeRatios([{ ticker: "7203", ratio: 2.5 }]),
      "simulation",
    );

    expect(mockPrisma.tradingOrder.update).not.toHaveBeenCalled();
  });

  it("quoteが取得できない銘柄はスキップする", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 990),
    ]);

    await invalidateStalePendingOrders(
      makeQuotes([]),
      makeSurgeRatios([{ ticker: "7203", ratio: 0.5 }]),
      "simulation",
    );

    expect(mockPrisma.tradingOrder.update).not.toHaveBeenCalled();
  });

  it("surgeRatioが取得できない銘柄はスキップする", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 990),
    ]);

    await invalidateStalePendingOrders(
      makeQuotes([{ ticker: "7203", price: 1000 }]),
      makeSurgeRatios([]),
      "simulation",
    );

    expect(mockPrisma.tradingOrder.update).not.toHaveBeenCalled();
  });

  it("liveモードでブローカー注文がある場合はcancelOrderを呼ぶ", async () => {
    mockPrisma.tradingOrder.findMany.mockResolvedValue([
      makePendingOrder("7203", 1000, {
        brokerOrderId: "B001",
        brokerBusinessDay: "20260326",
      }),
    ]);

    await invalidateStalePendingOrders(
      makeQuotes([{ ticker: "7203", price: 995 }]),
      makeSurgeRatios([{ ticker: "7203", ratio: 2.5 }]),
      "live",
    );

    expect(mockCancelOrder).toHaveBeenCalledWith("B001", "20260326");
    expect(mockPrisma.tradingOrder.update).toHaveBeenCalledWith({
      where: { id: "order-7203" },
      data: { status: "cancelled" },
    });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/core/breakout/__tests__/entry-executor.test.ts --reporter=verbose`
Expected: `invalidateStalePendingOrders` が存在しないためFAIL

- [ ] **Step 3: invalidateStalePendingOrders関数を実装**

`src/core/breakout/entry-executor.ts` の `resizePendingOrders` 関数の後（ファイル末尾）に以下を追加:

```typescript
import type { QuoteData } from "./breakout-scanner";
```

（importセクションに追加）

```typescript
/**
 * ブレイクアウト前提が崩壊したpending買い注文をキャンセルする
 *
 * 以下のいずれかを満たした場合にキャンセル:
 * - 出来高萎縮: surgeRatio < COOL_DOWN_THRESHOLD (1.2)
 * - 高値割り込み: currentPrice <= entrySnapshot.trigger.high20（フェイクアウト）
 *
 * @param quotes breakout-monitorが取得済みの時価データ
 * @param surgeRatios scannerのlastSurgeRatiosマップ
 * @param brokerMode ブローカーモード
 */
export async function invalidateStalePendingOrders(
  quotes: QuoteData[],
  surgeRatios: ReadonlyMap<string, number>,
  brokerMode: string,
): Promise<void> {
  const pendingOrders = await prisma.tradingOrder.findMany({
    where: { side: "buy", status: "pending", strategy: "breakout" },
    include: { stock: { select: { tickerCode: true } } },
  });

  if (pendingOrders.length === 0) return;

  const quoteMap = new Map(quotes.map((q) => [q.ticker, q]));

  for (const order of pendingOrders) {
    const ticker = order.stock.tickerCode;
    const quote = quoteMap.get(ticker);
    if (!quote) continue;

    const surgeRatio = surgeRatios.get(ticker);
    if (surgeRatio === undefined) continue;

    const snapshot = order.entrySnapshot as { trigger?: { high20?: number } } | null;
    const high20 = snapshot?.trigger?.high20;
    if (high20 === undefined) continue;

    const reasons: string[] = [];

    if (surgeRatio < BREAKOUT.VOLUME_SURGE.COOL_DOWN_THRESHOLD) {
      reasons.push(
        `出来高萎縮（サージ比率 ${surgeRatio.toFixed(1)}x < ${BREAKOUT.VOLUME_SURGE.COOL_DOWN_THRESHOLD}x）`,
      );
    }

    if (quote.price <= high20) {
      reasons.push(
        `高値割り込み（¥${quote.price.toLocaleString()} <= 20日高値 ¥${high20.toLocaleString()}）`,
      );
    }

    if (reasons.length === 0) continue;

    // ブローカー注文がある場合は取消
    if (order.brokerOrderId && order.brokerBusinessDay && brokerMode !== "simulation") {
      const result = await cancelOrder(order.brokerOrderId, order.brokerBusinessDay);
      if (!result.success) {
        console.warn(
          `[invalidate-pending] ${ticker} ブローカー取消失敗: ${result.error}`,
        );
        continue;
      }
    }

    await prisma.tradingOrder.update({
      where: { id: order.id },
      data: { status: "cancelled" },
    });

    const reasonText = reasons.join(" / ");
    console.log(`[invalidate-pending] ${ticker} 前提崩壊キャンセル: ${reasonText}`);

    await notifySlack({
      title: `前提崩壊キャンセル: ${ticker}`,
      message: reasonText,
      color: "warning",
    });
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/core/breakout/__tests__/entry-executor.test.ts --reporter=verbose`
Expected: 全テストPASS

- [ ] **Step 5: コミット**

```bash
git add src/core/breakout/entry-executor.ts src/core/breakout/__tests__/entry-executor.test.ts
git commit -m "feat: ブレイクアウト前提崩壊時のpending注文自動キャンセル"
```

---

### Task 3: breakout-monitorからの呼び出し追加

**Files:**
- Modify: `src/jobs/breakout-monitor.ts:13,127-131`

- [ ] **Step 1: breakout-monitorのimportに`invalidateStalePendingOrders`を追加**

`src/jobs/breakout-monitor.ts` 13行目のimportを修正:

```typescript
import { executeEntry, resizePendingOrders, invalidateStalePendingOrders } from "../core/breakout/entry-executor";
```

- [ ] **Step 2: main関数内で`invalidateStalePendingOrders`を呼び出す**

`src/jobs/breakout-monitor.ts` の `resizePendingOrders(brokerMode)` 呼び出し（131行目付近）の後に追加:

```typescript
  // 6.5 既存pending注文の株数チェック（資金変動対応）
  await resizePendingOrders(brokerMode);

  // 6.6 ブレイクアウト前提崩壊チェック（出来高萎縮・高値割り込み）
  await invalidateStalePendingOrders(
    quotes,
    scanner.getState().lastSurgeRatios,
    brokerMode,
  );
```

- [ ] **Step 3: テストが通ることを確認**

Run: `npx vitest run src/core/breakout/__tests__/entry-executor.test.ts --reporter=verbose`
Expected: 全テストPASS

- [ ] **Step 4: コミット**

```bash
git add src/jobs/breakout-monitor.ts
git commit -m "feat: breakout-monitorにpending注文の前提崩壊チェックを追加"
```

---

### Task 4: 設計ドキュメント削除 + 最終確認

**Files:**
- Delete: `docs/superpowers/specs/2026-03-26-pending-order-invalidation-design.md`
- Delete: `docs/superpowers/plans/2026-03-26-pending-order-invalidation.md`

- [ ] **Step 1: 全テスト実行**

Run: `npx vitest run src/core/breakout/__tests__/ --reporter=verbose`
Expected: 全テストPASS

- [ ] **Step 2: TypeScriptコンパイルチェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 3: 設計ドキュメント削除**

```bash
rm docs/superpowers/specs/2026-03-26-pending-order-invalidation-design.md
rm docs/superpowers/plans/2026-03-26-pending-order-invalidation.md
```

- [ ] **Step 4: 最終コミット**

```bash
git add -A
git commit -m "chore: 実装済み設計ドキュメントを削除"
```
