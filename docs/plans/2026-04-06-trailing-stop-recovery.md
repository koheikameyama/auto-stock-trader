# Trailing Stop Recovery on Server Restart Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `morning-sl-sync` が毎朝 SL を再発注する前に、`StockDailyBar` の高値を使ってトレーリングストップを計算し直し、サーバーダウン中に取り逃がした追従分を回復する。

**Architecture:** 純粋関数 `computeRecoveredStop()` を `src/core/trailing-stop-recovery.ts` に切り出してテスト可能にする。`morning-sl-sync` では、ポジションごとに入場日以降の `StockDailyBar` を取得 → `computeRecoveredStop()` を呼び出し → 計算後の価格で SL を発注 → **発注成功後に** DB を更新する（発注失敗時はDB更新しない）。

**Tech Stack:** TypeScript, Prisma (StockDailyBar), vitest, 既存の `calculateTrailingStop()`

---

### Task 1: 純粋ヘルパー関数を作成してテストする

**Files:**
- Create: `src/core/trailing-stop-recovery.ts`
- Create: `src/core/__tests__/trailing-stop-recovery.test.ts`

**Step 1: テストを書く（まだ失敗する）**

`src/core/__tests__/trailing-stop-recovery.test.ts` を作成:

```typescript
import { describe, it, expect } from "vitest";
import { computeRecoveredStop } from "../trailing-stop-recovery";

const basePosition = {
  entryPrice: 2000,
  maxHighDuringHold: 2000,
  currentTrailingStop: null,
  stopLossPrice: 1940,
  entryAtr: 80,
  strategy: "breakout" as const,
};

describe("computeRecoveredStop", () => {
  it("barHighs が maxHighDuringHold を超えなければ improved=false", () => {
    const result = computeRecoveredStop(basePosition, [1990, 2000]);
    expect(result.improved).toBe(false);
    expect(result.newMaxHigh).toBe(2000);
  });

  it("barHighs が maxHighDuringHold を超えると newMaxHigh が更新される", () => {
    const result = computeRecoveredStop(basePosition, [2200, 2100]);
    expect(result.newMaxHigh).toBe(2200);
  });

  it("トレーリング発動後: newStopPrice = newMaxHigh - trailWidth (80)", () => {
    // BE = 2000 + 80*1.0 = 2080, maxHigh=2200 → 発動
    // trailWidth = 80, raw = 2200 - 80 = 2120
    const result = computeRecoveredStop(basePosition, [2200]);
    expect(result.newStopPrice).toBe(2120);
    expect(result.improved).toBe(true);
  });

  it("currentTrailingStop より低くなる場合はラチェット維持", () => {
    const position = { ...basePosition, currentTrailingStop: 2150 };
    // maxHigh=2200 → raw=2120 < 2150 → 2150 を維持
    const result = computeRecoveredStop(position, [2200]);
    expect(result.newStopPrice).toBe(2150);
    expect(result.improved).toBe(false); // 2150 === 2150, 改善なし
  });

  it("currentTrailingStop より高くなる場合は切り上げ", () => {
    const position = { ...basePosition, currentTrailingStop: 2050 };
    // maxHigh=2300 → raw=2220 > 2050 → 2220
    const result = computeRecoveredStop(position, [2300]);
    expect(result.newStopPrice).toBe(2220);
    expect(result.improved).toBe(true);
  });

  it("トレーリング未発動ならば stopLossPrice をそのまま返す", () => {
    // maxHigh=2050 < BE=2080 → 未発動
    const result = computeRecoveredStop(basePosition, [2050]);
    expect(result.newStopPrice).toBe(1940); // stopLossPrice
    expect(result.improved).toBe(false);
  });

  it("barHighs が空配列でも currentTrailingStop を保持", () => {
    const position = { ...basePosition, currentTrailingStop: 2100 };
    const result = computeRecoveredStop(position, []);
    expect(result.newStopPrice).toBe(2100);
    expect(result.improved).toBe(false);
  });
});
```

**Step 2: テストが失敗することを確認**

```bash
npx vitest run src/core/__tests__/trailing-stop-recovery.test.ts
```

期待: `Cannot find module '../trailing-stop-recovery'` でFAIL

**Step 3: 実装を書く**

`src/core/trailing-stop-recovery.ts` を作成:

```typescript
import { calculateTrailingStop } from "./trailing-stop";
import type { TradingStrategy } from "./market-regime";

export interface PositionForRecovery {
  entryPrice: number;
  maxHighDuringHold: number;
  currentTrailingStop: number | null;
  stopLossPrice: number;
  entryAtr: number | null;
  strategy: TradingStrategy;
}

export interface RecoveryResult {
  newMaxHigh: number;
  newStopPrice: number;
  improved: boolean;
}

/**
 * サーバーダウン中に取り逃がしたトレーリングストップの追従を回復する純粋関数。
 * DB操作は行わない。
 *
 * @param position ポジション情報
 * @param barHighs StockDailyBar の高値配列（入場日以降）
 */
export function computeRecoveredStop(
  position: PositionForRecovery,
  barHighs: number[],
): RecoveryResult {
  const newMaxHigh =
    barHighs.length > 0
      ? Math.max(position.maxHighDuringHold, ...barHighs)
      : position.maxHighDuringHold;

  const tsResult = calculateTrailingStop({
    entryPrice: position.entryPrice,
    maxHighDuringHold: newMaxHigh,
    currentTrailingStop: position.currentTrailingStop,
    originalStopLoss: position.stopLossPrice,
    originalTakeProfit: null,
    entryAtr: position.entryAtr,
    strategy: position.strategy,
  });

  const currentStop =
    position.currentTrailingStop ?? position.stopLossPrice;
  const newStopPrice = tsResult.trailingStopPrice ?? position.stopLossPrice;

  return {
    newMaxHigh,
    newStopPrice,
    improved: newStopPrice > currentStop,
  };
}
```

**Step 4: テストが通ることを確認**

```bash
npx vitest run src/core/__tests__/trailing-stop-recovery.test.ts
```

期待: 全テスト PASS

**Step 5: コミット**

```bash
git add src/core/trailing-stop-recovery.ts src/core/__tests__/trailing-stop-recovery.test.ts
git commit -m "feat: add computeRecoveredStop for trailing stop backfill"
```

---

### Task 2: morning-sl-sync に統合する

**Files:**
- Modify: `src/jobs/morning-sl-sync.ts`

現在の `morning-sl-sync` は SL 価格を以下で決定している:
```typescript
// src/jobs/morning-sl-sync.ts:49-52
const stopPrice =
  position.trailingStopPrice != null
    ? Number(position.trailingStopPrice)
    : Number(position.stopLossPrice ?? 0);
```

これを、`StockDailyBar` から高値を取得して `computeRecoveredStop()` で計算し直すように変更する。

**Step 1: `prisma.tradingPosition.findMany` のクエリを拡張する**

現在のクエリ（`src/jobs/morning-sl-sync.ts:23-27`）は `include: { stock: true }` のみ。
ポジションの全フィールドは自動で取得されるので追加不要だが、`createdAt` を使うことを確認。

**Step 2: ファイルを修正する**

`src/jobs/morning-sl-sync.ts` の `main()` を以下のように変更する:

```typescript
import { prisma } from "../lib/prisma";
import { notifySlack } from "../lib/slack";
import { submitBrokerSL } from "../core/broker-sl-manager";
import { isTachibanaProduction } from "../lib/constants/broker";
import { computeRecoveredStop } from "../core/trailing-stop-recovery";
import type { TradingStrategy } from "../core/market-regime";

export async function main(): Promise<void> {
  console.log("=== Morning SL Sync 開始 ===");

  if (!isTachibanaProduction) {
    console.log("[morning-sl-sync] デモ環境のためスキップ（価格ベース管理に移行）");
    return;
  }

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

    if (position.slBrokerOrderId) {
      await prisma.tradingPosition.update({
        where: { id: position.id },
        data: { slBrokerOrderId: null, slBrokerBusinessDay: null },
      });
      console.log(`[morning-sl-sync] ${ticker}: 旧SL注文IDをクリア (${position.slBrokerOrderId})`);
    }

    // ---- ここから変更 ----
    // StockDailyBar から入場日以降の高値を取得してトレーリングを回復
    const bars = await prisma.stockDailyBar.findMany({
      where: {
        tickerCode: ticker,
        date: { gte: position.createdAt },
      },
      select: { high: true },
    });

    const barHighs = bars.map((b) => b.high);
    const recovery = computeRecoveredStop(
      {
        entryPrice: Number(position.entryPrice),
        maxHighDuringHold: Number(position.maxHighDuringHold ?? position.entryPrice),
        currentTrailingStop: position.trailingStopPrice != null ? Number(position.trailingStopPrice) : null,
        stopLossPrice: Number(position.stopLossPrice ?? 0),
        entryAtr: position.entryAtr != null ? Number(position.entryAtr) : null,
        strategy: position.strategy as TradingStrategy,
      },
      barHighs,
    );

    const stopPrice = recovery.newStopPrice > 0 ? recovery.newStopPrice : Number(position.stopLossPrice ?? 0);
    // ---- ここまで変更 ----

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

      // SL発注成功後にDBを更新（発注失敗時はDB更新しない）
      if (recovery.improved) {
        await prisma.tradingPosition.update({
          where: { id: position.id },
          data: {
            maxHighDuringHold: recovery.newMaxHigh,
            trailingStopPrice: recovery.newStopPrice,
          },
        });
        console.log(
          `[morning-sl-sync] ${ticker}: トレーリング回復 maxHigh=${recovery.newMaxHigh} stop=${recovery.newStopPrice}`,
        );
      }
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

**Step 3: TypeScript コンパイルエラーがないか確認**

```bash
npx tsc --noEmit
```

期待: エラーなし

**Step 4: 全テストが通ることを確認**

```bash
npx vitest run
```

期待: 全テスト PASS

**Step 5: コミット**

```bash
git add src/jobs/morning-sl-sync.ts
git commit -m "feat: recover trailing stop from StockDailyBar in morning-sl-sync"
```

---

### Task 3: 仕様書を更新する

**Files:**
- Modify: `docs/specs/batch-processing.md`

`morning-sl-sync` のセクションに以下を追記:

> **トレーリングストップ回復**: SL再発注前に `StockDailyBar` から入場日以降の高値を取得し、`computeRecoveredStop()` でトレーリングストップを計算し直す。サーバーダウン中に取り逃がした追従分を毎朝自動で回復する。

**Step 1: 仕様書を更新する**

`docs/specs/batch-processing.md` を読んで `morning-sl-sync` のセクションに追記。

**Step 2: コミット**

```bash
git add docs/specs/batch-processing.md
git commit -m "docs: update batch-processing spec for trailing stop recovery"
```
