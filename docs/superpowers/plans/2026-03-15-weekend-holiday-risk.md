# 週末・連休リスク管理 実装計画

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 金曜日のポジションサイズ50%制限と、連休前のトレーリングストップ引き締めを実装する

**Architecture:** `market-calendar.ts` に非営業日カウント関数を追加。ジョブ層（`order-manager.ts`, `position-monitor.ts`）がカレンダーを参照してbudget調整・TS引き締めを行う。コア計算関数（`entry-calculator.ts`, `trailing-stop.ts`）は変更しない。バックテスト `simulation-engine.ts` にも同じロジックを適用。

**Tech Stack:** TypeScript, dayjs, @holiday-jp/holiday_jp, vitest

**Spec:** `docs/superpowers/specs/2026-03-15-weekend-holiday-risk-design.md`

---

## Chunk 1: 基盤（カレンダー拡張 + 定数）

### Task 1: `countNonTradingDaysAhead()` のテスト

**Files:**
- Create: `src/lib/__tests__/market-calendar.test.ts`
- Reference: `src/lib/market-calendar.ts`

- [ ] **Step 1: テストファイル作成**

```typescript
import { describe, it, expect } from "vitest";
import { countNonTradingDaysAhead } from "../market-calendar";

// テスト用ヘルパー: YYYY-MM-DD → Date（JST基準）
function jstDate(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00+09:00");
}

describe("countNonTradingDaysAhead", () => {
  it("月曜日（翌日が火曜=営業日）→ 0", () => {
    // 2026-03-16 = 月曜日
    expect(countNonTradingDaysAhead(jstDate("2026-03-16"))).toBe(0);
  });

  it("水曜日（翌日が木曜=営業日）→ 0", () => {
    // 2026-03-18 = 水曜日
    expect(countNonTradingDaysAhead(jstDate("2026-03-18"))).toBe(0);
  });

  it("金曜日（土日を挟む）→ 2", () => {
    // 2026-03-20 = 金曜日、翌営業日は3/23月曜
    expect(countNonTradingDaysAhead(jstDate("2026-03-20"))).toBe(2);
  });

  it("金曜 + 月曜祝日（3連休）→ 3", () => {
    // 2026-07-17 = 金曜、7/20 = 海の日（月曜祝日）
    // → 土日月で3日、翌営業日は7/21火曜
    expect(countNonTradingDaysAhead(jstDate("2026-07-17"))).toBe(3);
  });

  it("年末（12/30水 → 1/4月）→ 4", () => {
    // 2026-12-30 = 水曜
    // 12/31(木)=TSE休場, 1/1(金)=祝日, 1/2(土)=週末, 1/3(日)=週末
    // → 4日、翌営業日は1/4(月)
    expect(countNonTradingDaysAhead(jstDate("2026-12-30"))).toBe(4);
  });

  it("GW前（複数祝日が連続）→ 正しい日数", () => {
    // 2026-04-28 = 火曜
    // 4/29(水)=昭和の日, 4/30(木)=平日, → 翌営業日は4/30
    // → 1日
    expect(countNonTradingDaysAhead(jstDate("2026-04-28"))).toBe(1);
  });

  it("引数なしで現在日付を使用（エラーにならない）", () => {
    const result = countNonTradingDaysAhead();
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(30);
  });
});
```

- [ ] **Step 2: テスト実行 → FAIL確認**

Run: `npx vitest run src/lib/__tests__/market-calendar.test.ts`
Expected: FAIL（`countNonTradingDaysAhead` がexportされていない）

- [ ] **Step 3: コミット（失敗テスト）**

```bash
git add src/lib/__tests__/market-calendar.test.ts
git commit -m "test: countNonTradingDaysAhead の失敗テスト追加"
```

### Task 2: `countNonTradingDaysAhead()` の実装

**Files:**
- Modify: `src/lib/market-calendar.ts`

- [ ] **Step 1: 実装を追加**

`src/lib/market-calendar.ts` の末尾に追加:

```typescript
const MAX_LOOKAHEAD_DAYS = 30;

/**
 * 指定日の翌日から次の営業日までの連続非営業日数を返す
 *
 * @param date - 判定日（デフォルト: 現在のJST日付）
 * @returns 連続非営業日数（0 = 翌日が営業日）
 */
export function countNonTradingDaysAhead(date?: Date): number {
  const d = dayjs(date).tz(JST);
  let count = 0;
  let check = d.add(1, "day");

  while (count < MAX_LOOKAHEAD_DAYS) {
    if (isMarketDay(check.toDate())) {
      return count;
    }
    count++;
    check = check.add(1, "day");
  }

  return count;
}
```

- [ ] **Step 2: テスト実行 → PASS確認**

Run: `npx vitest run src/lib/__tests__/market-calendar.test.ts`
Expected: ALL PASS

- [ ] **Step 3: コミット**

```bash
git add src/lib/market-calendar.ts
git commit -m "feat: countNonTradingDaysAhead() 追加"
```

### Task 3: `WEEKEND_RISK` 定数追加

**Files:**
- Modify: `src/lib/constants/trading.ts`

- [ ] **Step 1: 定数を追加**

`src/lib/constants/trading.ts` の末尾に追加:

```typescript
// ========================================
// 週末・連休リスク管理
// ========================================

export const WEEKEND_RISK = {
  SIZE_REDUCTION_THRESHOLD: 2,       // 非営業日N日以上でポジションサイズ縮小
  POSITION_SIZE_MULTIPLIER: 0.5,     // ポジションサイズ50%

  TRAILING_TIGHTEN_THRESHOLD: 3,     // 非営業日N日以上でトレーリングストップ引き締め
  TRAILING_TIGHTEN_MULTIPLIER: 0.7,  // ATR倍率を70%に縮小（例: 2.0 → 1.4）
} as const;
```

- [ ] **Step 2: ビルド確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add src/lib/constants/trading.ts
git commit -m "feat: WEEKEND_RISK 定数追加"
```

---

## Chunk 2: 本番ジョブ統合

### Task 4: order-manager.ts に金曜ポジションサイズ縮小を追加

**Files:**
- Modify: `src/jobs/order-manager.ts`

- [ ] **Step 1: import追加**

`src/jobs/order-manager.ts` の先頭importに追加:

```typescript
import { countNonTradingDaysAhead } from "../lib/market-calendar";
```

`WEEKEND_RISK` はconstantsのimportに追加:

```typescript
import {
  TRADING_SCHEDULE,
  ORDER_EXPIRY,
  TECHNICAL_MIN_DATA,
  JOB_CONCURRENCY,
  DEFENSIVE_MODE,
  WEEKEND_RISK,          // ← 追加
} from "../lib/constants";
```

- [ ] **Step 2: 並列分析ループの前で非営業日を1回だけ判定**

`order-manager.ts` のフェーズ1 `console.log` の後（`const limit = pLimit(...)` の前あたり）に以下を追加:

```typescript
  // 週末リスク: 金曜/連休前はポジションサイズを縮小
  const nonTradingDays = countNonTradingDaysAhead();
  const isWeekendRisk = nonTradingDays >= WEEKEND_RISK.SIZE_REDUCTION_THRESHOLD;
  if (isWeekendRisk) {
    console.log(
      `  週末リスク: ポジションサイズ50%に縮小（非営業日: ${nonTradingDays}日）`,
    );
  }
```

- [ ] **Step 3: 並列分析ループ内でbudget調整**

`calculateEntryCondition()` 呼び出し（現在 `cashBalance` を渡している箇所）の直前に以下を追加し、引数を変更:

```typescript
        const budgetForSizing = isWeekendRisk
          ? cashBalance * WEEKEND_RISK.POSITION_SIZE_MULTIPLIER
          : cashBalance;

        const entryCondition = calculateEntryCondition(
          quote.price,
          techSummary,
          score,
          strategy,
          budgetForSizing,  // ← cashBalance から変更
          maxPositionPct,
          historical,
        );
```

- [ ] **Step 4: ビルド確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/jobs/order-manager.ts
git commit -m "feat: 金曜/連休前のポジションサイズ50%縮小"
```

### Task 5: position-monitor.ts に連休前トレーリングストップ引き締めを追加

**Files:**
- Modify: `src/jobs/position-monitor.ts`

- [ ] **Step 1: import追加**

`src/jobs/position-monitor.ts` の先頭importに追加:

```typescript
import { countNonTradingDaysAhead } from "../lib/market-calendar";
```

既存のconstants importに `WEEKEND_RISK` と `TRAILING_STOP` を追加:

```typescript
import {
  TRADING_SCHEDULE,
  POSITION_DEFAULTS,
  DEFENSIVE_MODE,
  STOP_LOSS,
  WEEKEND_RISK,          // ← 追加
  TRAILING_STOP,         // ← 追加
} from "../lib/constants";
```

- [ ] **Step 2: ポジション監視ループの前に非営業日判定を追加**

`[2/3] ポジション利確/損切りチェック...` の `for (const position of openPositions)` ループの**前**に以下を追加:

```typescript
  // 連休前リスク管理: トレーリングストップ引き締め判定
  const nonTradingDays = countNonTradingDaysAhead();
  const isPreLongHoliday = nonTradingDays >= WEEKEND_RISK.TRAILING_TIGHTEN_THRESHOLD;
  if (isPreLongHoliday) {
    const tightenedMultiplier = TRAILING_STOP.TRAIL_ATR_MULTIPLIER.swing * WEEKEND_RISK.TRAILING_TIGHTEN_MULTIPLIER;
    console.log(
      `  連休前リスク管理: トレーリングストップ引き締め（ATR倍率 ${TRAILING_STOP.TRAIL_ATR_MULTIPLIER.swing} → ${tightenedMultiplier.toFixed(1)}、非営業日: ${nonTradingDays}日）`,
    );
  }
```

- [ ] **Step 3: `checkPositionExit()` 呼び出しに `trailMultiplierOverride` を追加**

ループ内の `checkPositionExit()` 呼び出しを修正。現在:

```typescript
    const exitResult = checkPositionExit(
      {
        entryPrice: entryPriceNum,
        takeProfitPrice: originalTP,
        stopLossPrice: originalSL,
        entryAtr,
        maxHighDuringHold: position.maxHighDuringHold
          ? Number(position.maxHighDuringHold)
          : entryPriceNum,
        currentTrailingStop: position.trailingStopPrice
          ? Number(position.trailingStopPrice)
          : null,
        strategy: position.strategy as "day_trade" | "swing",
        holdingBusinessDays,
      },
      { open: quote.open, high: quote.high, low: quote.low, close: quote.price },
    );
```

`trailMultiplierOverride` を追加:

```typescript
    // スイングポジションのみ引き締め（デイトレは当日決済のため不要）
    const trailOverride =
      isPreLongHoliday && position.strategy === "swing"
        ? TRAILING_STOP.TRAIL_ATR_MULTIPLIER.swing * WEEKEND_RISK.TRAILING_TIGHTEN_MULTIPLIER
        : undefined;

    const exitResult = checkPositionExit(
      {
        entryPrice: entryPriceNum,
        takeProfitPrice: originalTP,
        stopLossPrice: originalSL,
        entryAtr,
        maxHighDuringHold: position.maxHighDuringHold
          ? Number(position.maxHighDuringHold)
          : entryPriceNum,
        currentTrailingStop: position.trailingStopPrice
          ? Number(position.trailingStopPrice)
          : null,
        strategy: position.strategy as "day_trade" | "swing",
        holdingBusinessDays,
        trailMultiplierOverride: trailOverride,
      },
      { open: quote.open, high: quote.high, low: quote.low, close: quote.price },
    );
```

- [ ] **Step 4: ビルド確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/jobs/position-monitor.ts
git commit -m "feat: 連休前トレーリングストップ引き締め"
```

---

## Chunk 3: バックテスト対応

### Task 6: simulation-engine.ts にバックテスト対応を追加

**Files:**
- Modify: `src/backtest/simulation-engine.ts`

- [ ] **Step 1: import追加**

`src/backtest/simulation-engine.ts` の先頭importに追加:

```typescript
import { countNonTradingDaysAhead } from "../lib/market-calendar";
```

既存のconstants importに `WEEKEND_RISK` と `TRAILING_STOP` を追加:

```typescript
import { TECHNICAL_MIN_DATA, DEFENSIVE_MODE, DAILY_BACKTEST, WEEKEND_RISK, TRAILING_STOP } from "../lib/constants";
```

- [ ] **Step 2: エントリー部分にbudget縮小を追加**

`calculateEntryCondition()` の呼び出し（L614付近、`cash` を渡している箇所）の直前に以下を追加:

```typescript
    // 週末リスク: 金曜/連休前はポジションサイズを縮小
    const simDate = new Date(tradingDays[dayIdx] + "T00:00:00+09:00");
    const nonTradingDays = countNonTradingDaysAhead(simDate);
    const budgetForSizing = nonTradingDays >= WEEKEND_RISK.SIZE_REDUCTION_THRESHOLD
      ? cash * WEEKEND_RISK.POSITION_SIZE_MULTIPLIER
      : cash;
```

そして `calculateEntryCondition()` の `cash` 引数を `budgetForSizing` に変更:

```typescript
    const entry = calculateEntryCondition(
      latest.close,
      summary,
      score as any,
      config.strategy,
      budgetForSizing,  // ← cash から変更
      maxPositionPct,
      config.gapRiskEnabled ? newestFirst : undefined,
    );
```

- [ ] **Step 3: 出口判定にトレーリングストップ引き締めを追加**

`checkPositionExit()` の呼び出し（L167付近）を修正。`trailMultiplierOverride: config.trailMultiplier` を以下のロジックに変更:

```typescript
      // 連休前リスク管理: 感度分析の固定値がなければ週末リスクで引き締め
      const posSimDate = new Date(tradingDays[dayIdx] + "T00:00:00+09:00");
      const posNonTradingDays = countNonTradingDaysAhead(posSimDate);
      const isPreLongHoliday = posNonTradingDays >= WEEKEND_RISK.TRAILING_TIGHTEN_THRESHOLD;

      let trailOverride = config.trailMultiplier;
      if (trailOverride == null && isPreLongHoliday && config.strategy === "swing") {
        trailOverride = TRAILING_STOP.TRAIL_ATR_MULTIPLIER.swing * WEEKEND_RISK.TRAILING_TIGHTEN_MULTIPLIER;
      }
```

そして `checkPositionExit()` の `trailMultiplierOverride` を `trailOverride` に変更:

```typescript
      const exitResult = checkPositionExit(
        {
          entryPrice: pos.entryPrice,
          takeProfitPrice: pos.takeProfitPrice,
          stopLossPrice: pos.stopLossPrice,
          entryAtr: pos.entryAtr,
          maxHighDuringHold: pos.maxHighDuringHold,
          currentTrailingStop: pos.trailingStopPrice,
          strategy: config.strategy,
          holdingBusinessDays: holdingDays,
          activationMultiplierOverride: config.trailingActivationMultiplier,
          trailMultiplierOverride: trailOverride,  // ← config.trailMultiplier から変更
          maxHoldingDaysOverride: config.maxHoldingDays,
        },
        { open: todayBar.open, high: todayBar.high, low: todayBar.low, close: todayBar.close },
      );
```

- [ ] **Step 4: ビルド確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/backtest/simulation-engine.ts
git commit -m "feat: バックテストに週末・連休リスク管理を適用"
```

---

## Chunk 4: 仕上げ

### Task 7: 全テスト実行 + 既存テスト確認

**Files:** なし（テスト実行のみ）

- [ ] **Step 1: 全テスト実行**

Run: `npx vitest run`
Expected: ALL PASS（既存テストが壊れていないこと）

- [ ] **Step 2: ビルド確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

### Task 8: 設計ファイル削除 + 最終コミット

**Files:**
- Delete: `docs/superpowers/specs/2026-03-15-weekend-holiday-risk-design.md`
- Delete: `docs/superpowers/plans/2026-03-15-weekend-holiday-risk.md`

- [ ] **Step 1: 設計ファイルを削除**

```bash
rm docs/superpowers/specs/2026-03-15-weekend-holiday-risk-design.md
rm docs/superpowers/plans/2026-03-15-weekend-holiday-risk.md
```

- [ ] **Step 2: 最終コミット**

```bash
git add -A
git commit -m "chore: 設計ファイル削除"
```

### Task 9: PR作成

- [ ] **Step 1: Linearタスクを In Progress に変更**

- [ ] **Step 2: PRを作成**

PR本文に `Fixes KOH-332` を含める。

タイトル例: `feat: 週末・連休リスクの考慮（金曜エントリー制限）`

本文に含める内容:
- 金曜日のポジションサイズ50%制限
- 3連休以上前のトレーリングストップ引き締め（ATR倍率×0.7）
- バックテスト対応
