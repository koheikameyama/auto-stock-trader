# 週末・連休リスクの考慮（金曜エントリー制限）

Linear: KOH-332

## 背景

スイングポジションを週末/連休に持ち越す場合のギャップリスクが考慮されていない。金曜引け→月曜寄付きのギャップリスクは平日の2-3倍で、3連休ならさらに増大する。現状は曜日に関係なく同じ条件でエントリーしている。

## スコープ

- 金曜日（通常週末前）: 新規エントリーのポジションサイズを50%に縮小
- 3連休以上前: 既存ポジションのトレーリングストップをATR倍率70%に引き締め
- 海外イベント（FOMC、雇用統計等）: 今回はスコープ外（別タスクで対応）

## 設計

### 1. 市場カレンダー拡張

`src/lib/market-calendar.ts` に「次の営業日までの連続非営業日数」を算出する関数を追加する。

```typescript
/**
 * 指定日の翌日から次の営業日までの連続非営業日数を返す
 *
 * 例:
 * - 月〜木（翌日が営業日）: 0
 * - 金曜（土日を挟む）: 2
 * - 金曜 + 月曜祝日（3連休）: 3
 * - GW前: 最大9程度
 *
 * @param date - 判定日（デフォルト: 現在のJST日付）
 * @returns 連続非営業日数
 */
export function countNonTradingDaysAhead(date?: Date): number
```

実装: 翌日から順にループし、`isMarketDay()` が `true` を返すまでカウントする。上限30日で打ち切り（無限ループ防止）。

### 2. 定数定義

`src/lib/constants/trading.ts` に追加:

```typescript
export const WEEKEND_RISK = {
  // 非営業日がN日以上連続する場合にポジションサイズを縮小
  SIZE_REDUCTION_THRESHOLD: 2,       // 通常の週末（土日）= 2日
  POSITION_SIZE_MULTIPLIER: 0.5,     // ポジションサイズ50%

  // 非営業日がN日以上連続する場合にトレーリングストップを引き締め
  TRAILING_TIGHTEN_THRESHOLD: 3,     // 3連休以上
  TRAILING_TIGHTEN_MULTIPLIER: 0.7,  // ATR倍率を70%に縮小（例: 2.0 → 1.4）
} as const;
```

### 3. エントリー制限（ポジションサイズ50%）

**変更ファイル**: `src/core/entry-calculator.ts`

`calculateEntryCondition()` 内で、`countNonTradingDaysAhead()` を呼び出し、非営業日が `SIZE_REDUCTION_THRESHOLD` 以上の場合、`calculatePositionSize()` に渡す `availableBudget` を `POSITION_SIZE_MULTIPLIER` 倍にする。

```typescript
// entry-calculator.ts
import { countNonTradingDaysAhead } from "../lib/market-calendar";
import { WEEKEND_RISK } from "../lib/constants";

// calculateEntryCondition() 内、数量算出の手前:
const nonTradingDays = countNonTradingDaysAhead();
const budgetForSizing = nonTradingDays >= WEEKEND_RISK.SIZE_REDUCTION_THRESHOLD
  ? availableBudget * WEEKEND_RISK.POSITION_SIZE_MULTIPLIER
  : availableBudget;

const quantity = calculatePositionSize(
  limitPrice,
  budgetForSizing,  // ← 変更点
  maxPositionPct,
  stopLossPrice,
  gapRiskPct,
);
```

**設計判断**: `calculatePositionSize()` の引数（budget）を変えるだけで内部ロジックの変更は不要。RRフィルタ・SL検証は通常通り。entry-calculatorの責務内で完結する。

**適用対象**: スイング・デイトレ両方。デイトレは金曜中に決済されるが、万が一のための安全措置として適用。

### 4. トレーリングストップ引き締め（連休前）

**変更ファイル**: `src/jobs/position-monitor.ts`

オープンポジション監視ループ内で、`countNonTradingDaysAhead()` を呼び出し、非営業日が `TRAILING_TIGHTEN_THRESHOLD` 以上の場合、`checkPositionExit()` に `trailMultiplierOverride` を渡す。

```typescript
// position-monitor.ts
import { countNonTradingDaysAhead } from "../lib/market-calendar";
import { WEEKEND_RISK, TRAILING_STOP } from "../lib/constants";

// オープンポジション監視ループ内（checkPositionExit 呼び出し前）:
const nonTradingDays = countNonTradingDaysAhead();
const isPreLongHoliday = nonTradingDays >= WEEKEND_RISK.TRAILING_TIGHTEN_THRESHOLD;

// スイングポジションのみ引き締め（デイトレは当日決済のため不要）
const trailOverride =
  isPreLongHoliday && position.strategy === "swing"
    ? TRAILING_STOP.TRAIL_ATR_MULTIPLIER.swing * WEEKEND_RISK.TRAILING_TIGHTEN_MULTIPLIER
    : undefined;

const exitResult = checkPositionExit(
  {
    ...existingParams,
    trailMultiplierOverride: trailOverride,
  },
  bar,
);
```

**設計判断**: `PositionForExit` インターフェースの既存プロパティ `trailMultiplierOverride` を活用。出口判定のコアロジック（`exit-checker.ts`, `trailing-stop.ts`）の変更は不要。

**注意**: `activationMultiplierOverride` は変更しない。発動条件は通常通りで、発動後のトレール幅のみ狭める。

### 5. バックテスト対応

**変更ファイル**: `src/core/backtest/simulation-engine.ts`

バックテストでも同一ロジックを適用し、本番との整合性を保つ。

- シミュレーション日付ベースで `countNonTradingDaysAhead()` を呼び出す
- エントリー数量: 金曜日はbudget 50%
- トレーリングストップ: 連休前は `trailMultiplierOverride` を設定

### 6. ログ出力

**order-manager.ts**: 金曜サイズ縮小が適用される場合:
```
金曜日（週末リスク）: ポジションサイズ50%に縮小（非営業日: 2日）
```

**position-monitor.ts**: 連休前引き締めが適用される場合:
```
連休前リスク管理: トレーリングストップ引き締め（ATR倍率 ×0.7、非営業日: 3日）
```

### 7. テスト

#### market-calendar テスト

- `countNonTradingDaysAhead()`:
  - 月〜木（翌日が営業日）→ 0
  - 金曜（翌日が土曜）→ 2
  - 祝日前日（月曜が祝日の金曜）→ 3
  - GW前（複数祝日が連続）→ 正しい日数

#### entry-calculator テスト

- 平日: `availableBudget` そのまま → 通常サイズ
- 金曜: `availableBudget × 0.5` → サイズ半減
- 既存テストが壊れないこと

#### position-monitor テスト（連休前引き締め）

- 通常日: `trailMultiplierOverride` なし → 通常のトレール幅
- 連休前: `trailMultiplierOverride = 2.0 × 0.7 = 1.4` → 引き締め
- デイトレポジション: 連休前でも引き締めなし

## 変更ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/market-calendar.ts` | `countNonTradingDaysAhead()` 追加 |
| `src/lib/constants/trading.ts` | `WEEKEND_RISK` 定数追加 |
| `src/core/entry-calculator.ts` | 金曜ポジションサイズ縮小 |
| `src/jobs/position-monitor.ts` | 連休前トレーリングストップ引き締め |
| `src/core/backtest/simulation-engine.ts` | バックテスト対応 |
| テストファイル | 各機能のテスト |
