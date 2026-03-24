# イントラデイ出来高ブレイクアウト戦略 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 現行のスコアリングベース戦略を、立花証券APIを活用したイントラデイ出来高ブレイクアウト戦略に置き換える

**Architecture:** ゲートのみでウォッチリスト(~90銘柄)を作成し、ザラ場中に1分間隔のポーリングで出来高ブレイクアウトを検知。検知時にentry-executorが即座に注文。既存のposition-monitor・エグジットロジックはそのまま維持。

**Tech Stack:** TypeScript, Hono, Prisma, Tachibana Securities API, node-cron, Vitest

**Spec:** `docs/superpowers/specs/2026-03-24-intraday-volume-breakout-design.md`

**Linear:** KOH-397

---

## ファイル構成

### 新規作成

| ファイル | 責務 |
|---|---|
| `src/lib/constants/breakout.ts` | ブレイクアウト検知の全定数 |
| `src/core/breakout/types.ts` | WatchlistEntry, HotListEntry, BreakoutTrigger 等の型定義 |
| `src/core/breakout/elapsed-trading-minutes.ts` | 昼休み考慮の取引経過時間計算 |
| `src/core/breakout/watchlist-builder.ts` | ゲートのみのウォッチリスト構築（DBからテクニカルデータ取得） |
| `src/core/breakout/volume-surge.ts` | volumeSurgeRatio計算（時間正規化） |
| `src/core/breakout/breakout-scanner.ts` | スキャナー状態管理（Cold/Hot/トリガー） |
| `src/core/breakout/entry-executor.ts` | トリガー発火時の注文実行 |
| `src/jobs/watchlist-builder.ts` | 朝8:00のcronジョブラッパー |
| `src/jobs/breakout-monitor.ts` | ザラ場中1分間隔のworkerジョブ |
| `src/core/breakout/__tests__/elapsed-trading-minutes.test.ts` | |
| `src/core/breakout/__tests__/watchlist-builder.test.ts` | |
| `src/core/breakout/__tests__/volume-surge.test.ts` | |
| `src/core/breakout/__tests__/breakout-scanner.test.ts` | |
| `src/core/breakout/__tests__/entry-executor.test.ts` | |

### 変更

| ファイル | 変更内容 |
|---|---|
| `src/web/routes/cron.ts` | watchlist-builderをJOBSレジストリに追加 |
| `src/worker.ts` | breakout-monitorのnode-cronスケジュールを追加 |
| `.github/workflows/cronjob_morning-analysis.yml` | stock-scannerをwatchlist-builderに差し替え |
| `package.json` | `watchlist-build` スクリプト追加 |

---

## Task 1: 定数・型定義

**Files:**
- Create: `src/lib/constants/breakout.ts`
- Create: `src/core/breakout/types.ts`

- [ ] **Step 1: 定数ファイル作成**

```typescript
// src/lib/constants/breakout.ts
export const BREAKOUT = {
  VOLUME_SURGE: {
    HOT_THRESHOLD: 1.5,
    TRIGGER_THRESHOLD: 2.0,
    COOL_DOWN_THRESHOLD: 1.2,
    COOL_DOWN_COUNT: 2,
  },
  PRICE: {
    HIGH_LOOKBACK_DAYS: 20,
  },
  POLLING: {
    COLD_INTERVAL_MS: 5 * 60 * 1000,
    HOT_INTERVAL_MS: 1 * 60 * 1000,
  },
  GUARD: {
    EARLIEST_ENTRY_TIME: "09:05",
    LATEST_ENTRY_TIME: "14:30",
    MAX_DAILY_ENTRIES: 3,
  },
  TRADING_MINUTES_PER_DAY: 300,
} as const;
```

- [ ] **Step 2: 型定義ファイル作成**

```typescript
// src/core/breakout/types.ts
export interface WatchlistEntry {
  ticker: string;
  avgVolume25: number;
  high20: number;
  atr14: number;
  latestClose: number;
}

export interface HotListEntry {
  ticker: string;
  promotedAt: Date;
  coolDownCount: number;
}

export interface ScannerState {
  watchlist: WatchlistEntry[];
  hotSet: Map<string, HotListEntry>;
  triggeredToday: Set<string>;
  lastColdScanTime: Map<string, number>;
}

export interface BreakoutTrigger {
  ticker: string;
  currentPrice: number;
  cumulativeVolume: number;
  volumeSurgeRatio: number;
  high20: number;
  atr14: number;
  triggeredAt: Date;
}
```

- [ ] **Step 3: コミット**

```bash
git add src/lib/constants/breakout.ts src/core/breakout/types.ts
git commit -m "feat(breakout): 定数・型定義を追加"
```

---

## Task 2: 取引経過時間ユーティリティ

**Files:**
- Create: `src/core/breakout/elapsed-trading-minutes.ts`
- Create: `src/core/breakout/__tests__/elapsed-trading-minutes.test.ts`

- [ ] **Step 1: テスト作成**

```typescript
// src/core/breakout/__tests__/elapsed-trading-minutes.test.ts
import { describe, it, expect } from "vitest";
import { getElapsedTradingMinutes, getElapsedFraction } from "../elapsed-trading-minutes";

describe("getElapsedTradingMinutes", () => {
  it("前場開始直後: 9:01 → 1分", () => {
    expect(getElapsedTradingMinutes(9, 1)).toBe(1);
  });

  it("前場中盤: 10:00 → 60分", () => {
    expect(getElapsedTradingMinutes(10, 0)).toBe(60);
  });

  it("前場終了: 11:30 → 150分", () => {
    expect(getElapsedTradingMinutes(11, 30)).toBe(150);
  });

  it("昼休み中: 12:00 → 150分（前場分のみ）", () => {
    expect(getElapsedTradingMinutes(12, 0)).toBe(150);
  });

  it("後場開始直後: 12:31 → 151分", () => {
    expect(getElapsedTradingMinutes(12, 31)).toBe(151);
  });

  it("後場中盤: 14:00 → 240分", () => {
    expect(getElapsedTradingMinutes(14, 0)).toBe(240);
  });

  it("大引け: 15:00 → 300分", () => {
    expect(getElapsedTradingMinutes(15, 0)).toBe(300);
  });

  it("場前: 8:30 → 0分", () => {
    expect(getElapsedTradingMinutes(8, 30)).toBe(0);
  });
});

describe("getElapsedFraction", () => {
  it("9:30 → 0.1", () => {
    expect(getElapsedFraction(9, 30)).toBeCloseTo(0.1);
  });

  it("15:00 → 1.0", () => {
    expect(getElapsedFraction(15, 0)).toBeCloseTo(1.0);
  });
});
```

- [ ] **Step 2: テスト実行 → 失敗確認**

Run: `npx vitest run src/core/breakout/__tests__/elapsed-trading-minutes.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: 実装**

```typescript
// src/core/breakout/elapsed-trading-minutes.ts
import { BREAKOUT } from "../../lib/constants/breakout";

const MORNING_START_H = 9, MORNING_START_M = 0;
const MORNING_END_H = 11, MORNING_END_M = 30;
const AFTERNOON_START_H = 12, AFTERNOON_START_M = 30;
const MORNING_MINUTES = 150;

export function getElapsedTradingMinutes(hour: number, minute: number): number {
  const t = hour * 60 + minute;
  const morningStart = MORNING_START_H * 60 + MORNING_START_M;
  const morningEnd = MORNING_END_H * 60 + MORNING_END_M;
  const afternoonStart = AFTERNOON_START_H * 60 + AFTERNOON_START_M;

  if (t < morningStart) return 0;
  if (t <= morningEnd) return t - morningStart;
  if (t < afternoonStart) return MORNING_MINUTES;
  return MORNING_MINUTES + Math.min(t - afternoonStart, MORNING_MINUTES);
}

export function getElapsedFraction(hour: number, minute: number): number {
  return getElapsedTradingMinutes(hour, minute) / BREAKOUT.TRADING_MINUTES_PER_DAY;
}
```

- [ ] **Step 4: テスト実行 → 全パス確認**

Run: `npx vitest run src/core/breakout/__tests__/elapsed-trading-minutes.test.ts`
Expected: ALL PASS

- [ ] **Step 5: コミット**

```bash
git add src/core/breakout/elapsed-trading-minutes.ts src/core/breakout/__tests__/elapsed-trading-minutes.test.ts
git commit -m "feat(breakout): 取引経過時間ユーティリティを追加"
```

---

## Task 3: 出来高サージ比率計算

**Files:**
- Create: `src/core/breakout/volume-surge.ts`
- Create: `src/core/breakout/__tests__/volume-surge.test.ts`

- [ ] **Step 1: テスト作成**

```typescript
// src/core/breakout/__tests__/volume-surge.test.ts
import { describe, it, expect } from "vitest";
import { calculateVolumeSurgeRatio } from "../volume-surge";

describe("calculateVolumeSurgeRatio", () => {
  it("9:30に平均の10%到達 → ratio 1.0", () => {
    // 9:30 → elapsedFraction = 30/300 = 0.1
    // avgVolume25 = 100,000, cumulativeVolume = 10,000
    // ratio = 10,000 / (100,000 * 0.1) = 1.0
    const ratio = calculateVolumeSurgeRatio(10_000, 100_000, 9, 30);
    expect(ratio).toBeCloseTo(1.0);
  });

  it("9:30に平均の20%到達 → ratio 2.0（ブレイクアウト）", () => {
    const ratio = calculateVolumeSurgeRatio(20_000, 100_000, 9, 30);
    expect(ratio).toBeCloseTo(2.0);
  });

  it("昼休み中は前場終了値で計算", () => {
    // 12:00 → elapsedFraction = 150/300 = 0.5
    const ratio = calculateVolumeSurgeRatio(50_000, 100_000, 12, 0);
    expect(ratio).toBeCloseTo(1.0);
  });

  it("場前（elapsedFraction=0）→ ratio 0", () => {
    const ratio = calculateVolumeSurgeRatio(5_000, 100_000, 8, 30);
    expect(ratio).toBe(0);
  });

  it("avgVolume25が0 → ratio 0（ゼロ除算防止）", () => {
    const ratio = calculateVolumeSurgeRatio(5_000, 0, 10, 0);
    expect(ratio).toBe(0);
  });
});
```

- [ ] **Step 2: テスト実行 → 失敗確認**

Run: `npx vitest run src/core/breakout/__tests__/volume-surge.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装**

```typescript
// src/core/breakout/volume-surge.ts
import { getElapsedFraction } from "./elapsed-trading-minutes";

export function calculateVolumeSurgeRatio(
  cumulativeVolume: number,
  avgVolume25: number,
  hour: number,
  minute: number,
): number {
  if (avgVolume25 <= 0) return 0;
  const fraction = getElapsedFraction(hour, minute);
  if (fraction <= 0) return 0;
  return cumulativeVolume / (avgVolume25 * fraction);
}
```

- [ ] **Step 4: テスト実行 → 全パス確認**

Run: `npx vitest run src/core/breakout/__tests__/volume-surge.test.ts`
Expected: ALL PASS

- [ ] **Step 5: コミット**

```bash
git add src/core/breakout/volume-surge.ts src/core/breakout/__tests__/volume-surge.test.ts
git commit -m "feat(breakout): 出来高サージ比率計算を追加"
```

---

## Task 4: ウォッチリスト・ビルダー

**Files:**
- Create: `src/core/breakout/watchlist-builder.ts`
- Create: `src/core/breakout/__tests__/watchlist-builder.test.ts`

- [ ] **Step 1: テスト作成**

ゲートロジックは`checkGates`を流用する。**ただし`checkGates()`には週足下降トレンドチェックが含まれていない**（`scoreStock()`内で`computeScoringIntermediates()`の結果を使って別途チェックしている）。watchlist-builderでは`checkGates()`呼び出し後に、週足データを計算して`weeklyClose > weeklySMA13`を別途チェックする必要がある。

```typescript
// src/core/breakout/__tests__/watchlist-builder.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildWatchlist } from "../watchlist-builder";
import type { WatchlistEntry } from "../types";

// テスト内容:
// 1. ゲート通過銘柄のみがウォッチリストに入ること
// 2. high20がOHLCVデータの過去20日のhigh最大値であること
// 3. avgVolume25が正しく計算されること
// 4. ゲート不合格銘柄（価格超過・低流動性・低ボラ）が除外されること
// 5. 週足下降トレンド銘柄が除外されること（checkGates外の独立チェック）
// 6. checkGates通過 + 週足SMA13上回り → ウォッチリスト入り
// 7. checkGates通過 + 週足SMA13下回り → 除外
```

テストの具体実装は、既存の`stock-scanner.ts`のDBクエリパターンと`on-the-fly-scorer.ts`のデータ取得パターンを参考にする。`analyzeTechnicals()`で取得できるSMA/ATR/週足データを利用し、`checkGates()`をそのまま呼び出す。

- [ ] **Step 2: テスト実行 → 失敗確認**

Run: `npx vitest run src/core/breakout/__tests__/watchlist-builder.test.ts`

- [ ] **Step 3: 実装**

`buildWatchlist()`の責務:
1. Prismaで全銘柄のOHLCVデータを取得（`stock-scanner.ts`の`readHistoricalFromDB()`パターンを参考）
2. 各銘柄に`analyzeTechnicals()`を実行
3. `checkGates()`でゲート判定（流動性・価格・ボラ・決算・配当）
4. **週足下降トレンドチェック**（`checkGates()`に含まれていないため別途実装）: `computeScoringIntermediates()`で`weeklyClose`と`weeklySma13`を取得し、`weeklyClose < weeklySma13`の銘柄を除外
5. 通過銘柄の`avgVolume25`, `high20`（過去20日のhighカラム最大値）, `atr14`をキャッシュ
6. `WatchlistEntry[]`を返す

```typescript
// src/core/breakout/watchlist-builder.ts
import { checkGates } from "../scoring/gates";
import { computeScoringIntermediates } from "../scoring/intermediates";
import { analyzeTechnicals } from "../technical-analysis";
import { BREAKOUT } from "../../lib/constants/breakout";
import type { WatchlistEntry } from "./types";

export async function buildWatchlist(): Promise<WatchlistEntry[]> {
  // 1. DB全銘柄取得 + OHLCVデータ一括読み込み
  // 2. checkGates()でゲート判定
  // 3. 通過銘柄に対してcomputeScoringIntermediates()を実行
  // 4. weeklyClose < weeklySma13 の銘柄を除外（落ちるナイフ回避）
  // 5. high20（日足highの20日最大値）算出
  // 6. WatchlistEntry配列を返す
}
```

既存の`stock-scanner.ts`のDB取得ロジック（`readHistoricalFromDB`呼び出し、並列テクニカル分析）を参考に実装する。ただしスコアリング・AIレビューは行わない。**重要**: `checkGates()`は週足チェックを含まないため、`scoreStock()`内のロジック（`src/core/scoring/index.ts:70-77`）を参考に、`computeScoringIntermediates()`の結果で独立にチェックすること。

- [ ] **Step 4: テスト実行 → 全パス確認**

Run: `npx vitest run src/core/breakout/__tests__/watchlist-builder.test.ts`

- [ ] **Step 5: コミット**

```bash
git add src/core/breakout/watchlist-builder.ts src/core/breakout/__tests__/watchlist-builder.test.ts
git commit -m "feat(breakout): ウォッチリストビルダーを追加"
```

---

## Task 5: ブレイクアウト・スキャナー

**Files:**
- Create: `src/core/breakout/breakout-scanner.ts`
- Create: `src/core/breakout/__tests__/breakout-scanner.test.ts`

- [ ] **Step 1: テスト作成**

```typescript
// src/core/breakout/__tests__/breakout-scanner.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BreakoutScanner } from "../breakout-scanner";

// テストケース:
// 1. 初期状態ではホットリスト空、トリガー無し
// 2. volumeSurgeRatio >= 1.5 でCold → Hot昇格
// 3. volumeSurgeRatio < 1.2 が2回連続でHot → Cold降格
// 4. volumeSurgeRatio < 1.2 が1回の後 >= 1.2 に復帰 → coolDownCountリセット
// 5. volumeSurgeRatio >= 2.0 AND price > high20 でトリガー発火
// 6. 同一銘柄の2回目トリガーはブロック
// 7. 9:05前はスキャンしない
// 8. 14:30以降はトリガー発火しない
// 9. 日次エントリー上限(3件)到達でトリガー発火しない
// 10. 保有中銘柄はスキップ
// 11. Coldスキャンは5分間隔でのみ実行（lastColdScanTime管理）
```

- [ ] **Step 2: テスト実行 → 失敗確認**

Run: `npx vitest run src/core/breakout/__tests__/breakout-scanner.test.ts`

- [ ] **Step 3: 実装**

```typescript
// src/core/breakout/breakout-scanner.ts
import { BREAKOUT } from "../../lib/constants/breakout";
import { calculateVolumeSurgeRatio } from "./volume-surge";
import type { WatchlistEntry, ScannerState, BreakoutTrigger } from "./types";

interface QuoteData {
  ticker: string;
  price: number;
  volume: number; // 累積出来高（pDV）
}

export class BreakoutScanner {
  private state: ScannerState;

  constructor(watchlist: WatchlistEntry[]) {
    this.state = {
      watchlist,
      hotSet: new Map(),
      triggeredToday: new Set(),
      lastColdScanTime: new Map(),
    };
  }

  /**
   * 1分間隔で呼ばれるメインスキャンループ
   * @returns 発火したトリガーのリスト
   */
  scan(
    quotes: QuoteData[],
    now: Date,
    dailyEntryCount: number,
    holdingTickers: Set<string>,
  ): BreakoutTrigger[] {
    // 1. ガード条件チェック（時刻、日次上限）
    // 2. ホットリスト銘柄をスキャン（毎分）
    // 3. Coldスキャン対象をフィルタ（前回から5分以上経過）
    // 4. Cold銘柄のvolumeRatio計算、Hot昇格判定
    // 5. Hot銘柄のトリガー判定（volume ≥ 2.0 AND price > high20）
    // 6. 降格判定（ratio < 1.2 が2回連続）
    // 返り値: 発火したトリガーの配列
  }

  /** 日次リセット（翌営業日の朝に呼ぶ） */
  resetDaily(newWatchlist: WatchlistEntry[]): void {
    // watchlist更新、全ステート初期化
  }

  /** テスト用: 現在の状態取得 */
  getState(): Readonly<ScannerState> { return this.state; }
}
```

スキャナーはクラスとして実装し、状態（ホットリスト・トリガー済みセット等）をインスタンスに持たせる。純粋なロジックでブローカーAPIやDBへの依存はない。

- [ ] **Step 4: テスト実行 → 全パス確認**

Run: `npx vitest run src/core/breakout/__tests__/breakout-scanner.test.ts`

- [ ] **Step 5: コミット**

```bash
git add src/core/breakout/breakout-scanner.ts src/core/breakout/__tests__/breakout-scanner.test.ts
git commit -m "feat(breakout): ブレイクアウトスキャナーを追加"
```

---

## Task 6: エントリー・エグゼキューター

**Files:**
- Create: `src/core/breakout/entry-executor.ts`
- Create: `src/core/breakout/__tests__/entry-executor.test.ts`

- [ ] **Step 1: テスト作成**

```typescript
// src/core/breakout/__tests__/entry-executor.test.ts
// テストケース:
// 1. shouldTrade=false → 注文しない
// 2. 買付余力不足 → 注文しない
// 3. SLが最大3%を超える → 3%にクランプ
// 4. ポジションサイズが100株単位に丸められる
// 5. 正常系: TradingOrder作成 + submitBrokerOrder呼び出し
// 6. セクター集中度超過 → 注文しない
```

- [ ] **Step 2: テスト実行 → 失敗確認**

- [ ] **Step 3: 実装**

```typescript
// src/core/breakout/entry-executor.ts
import type { BreakoutTrigger } from "./types";

export interface ExecutionResult {
  success: boolean;
  orderId?: string;
  reason?: string;
}

export async function executeEntry(
  trigger: BreakoutTrigger,
  brokerMode: string,
): Promise<ExecutionResult> {
  // 1. shouldTradeチェック（MarketAssessmentから）
  // 2. 買付余力計算（既存のentry-calculator.tsのロジック参考）
  // 3. SL価格 = currentPrice - ATR × 1.0（最大3%）
  // 4. ポジションサイズ = リスク額(2%) / (currentPrice - SL), 100株丸め
  // 5. TradingOrder作成（Prisma）
  // 6. submitBrokerOrder呼び出し（simulation時はスキップ）
  // 7. Slack通知
}
```

既存の`order-manager.ts`のPhase 2ロジック（SL計算・ポジションサイズ・注文送信）を簡略化して流用。スコアリング・AIレビューは不要。`validateStopLoss()`と`submitBrokerOrder()`はそのまま呼び出す。

- [ ] **Step 4: テスト実行 → 全パス確認**

- [ ] **Step 5: コミット**

```bash
git add src/core/breakout/entry-executor.ts src/core/breakout/__tests__/entry-executor.test.ts
git commit -m "feat(breakout): エントリーエグゼキューターを追加"
```

---

## Task 7: ジョブ統合（watchlist-builder + breakout-monitor）

**Files:**
- Create: `src/jobs/watchlist-builder.ts`
- Create: `src/jobs/breakout-monitor.ts`
- Modify: `src/web/routes/cron.ts`
- Modify: `src/worker.ts`

- [ ] **Step 1: watchlist-builder ジョブ作成**

```typescript
// src/jobs/watchlist-builder.ts
// 朝8:00に実行。buildWatchlist()を呼び、結果をグローバル変数に保存。
// cron.tsのJOBSレジストリから呼ばれる。
// ウォッチリストはworkerプロセス内のモジュールスコープ変数に保持。
import { buildWatchlist } from "../core/breakout/watchlist-builder";
import type { WatchlistEntry } from "../core/breakout/types";

let currentWatchlist: WatchlistEntry[] = [];

export function getWatchlist(): WatchlistEntry[] {
  return currentWatchlist;
}

export async function main(): Promise<void> {
  currentWatchlist = await buildWatchlist();
  console.log(`ウォッチリスト構築完了: ${currentWatchlist.length}銘柄`);
  // Slack通知
}
```

- [ ] **Step 2: breakout-monitor ジョブ作成**

```typescript
// src/jobs/breakout-monitor.ts
// worker.tsのnode-cronから1分間隔で呼ばれる。
// BreakoutScannerインスタンスを保持し、scan()→executeEntry()を実行。
import { BreakoutScanner } from "../core/breakout/breakout-scanner";
import { executeEntry } from "../core/breakout/entry-executor";
import { getWatchlist } from "./watchlist-builder";
import { tachibanaFetchQuotesBatch } from "../lib/tachibana-price-client";

let scanner: BreakoutScanner | null = null;
let lastScanDate: string | null = null;

export async function main(): Promise<void> {
  const watchlist = getWatchlist();
  if (watchlist.length === 0) return;

  // 日付が変わっていたらスキャナーをリセット（翌営業日対応）
  const today = dayjs().tz("Asia/Tokyo").format("YYYY-MM-DD");
  if (lastScanDate && lastScanDate !== today) {
    scanner?.resetDaily(watchlist);
    scanner = null;
  }
  lastScanDate = today;

  if (!scanner) {
    scanner = new BreakoutScanner(watchlist);
  }

  // 0. MarketAssessmentをDBから取得し、shouldTrade=falseならスキップ
  // 1. スキャン対象銘柄のティッカーリスト取得
  // 2. tachibanaFetchQuotesBatch()でリアルタイム価格取得
  // 3. scanner.scan()でトリガー検知
  // 4. 各トリガーに対してexecuteEntry()実行
}

export function resetScanner(): void {
  scanner = null;
}
```

- [ ] **Step 3: cron.tsの更新（watchlist-builder追加 + 旧ジョブ削除）**

`src/web/routes/cron.ts`のJOBSレジストリを更新:

```typescript
import { main as runWatchlistBuilder } from "../../jobs/watchlist-builder";

// JOBSオブジェクトに追加:
"watchlist-builder": { fn: runWatchlistBuilder, requiresMarketDay: true },

// JOBSオブジェクトから削除:
// - "stock-scanner" エントリーと対応するimport（watchlist-builderに置き換え）
// - "order-manager" エントリーと対応するimport（entry-executorに置き換え）
```

- [ ] **Step 4: worker.tsにbreakout-monitor登録**

`src/worker.ts`の既存node-cronスケジュール配列に追加。`position-monitor`と同じ時間帯(9:00-15:00)で1分間隔。

```typescript
import { main as runBreakoutMonitor } from "./jobs/breakout-monitor";

// schedulesに追加:
{ name: "breakout-monitor", cron: "...", fn: runBreakoutMonitor }
```

- [ ] **Step 5: コミット**

```bash
git add src/jobs/watchlist-builder.ts src/jobs/breakout-monitor.ts src/web/routes/cron.ts src/worker.ts
git commit -m "feat(breakout): ジョブ統合（watchlist-builder + breakout-monitor）"
```

---

## Task 8: morning-analysis ワークフロー変更

**Files:**
- Modify: `.github/workflows/cronjob_morning-analysis.yml`
- Modify: `package.json`

- [ ] **Step 1: package.jsonにスクリプト追加**

```json
"watchlist-build": "tsx src/jobs/watchlist-builder.ts"
```

- [ ] **Step 2: morning-analysis.ymlを変更**

1. `stock-scanner`ジョブを`watchlist-builder`に置き換え
2. `news-collector`ジョブを削除（AIレビュー廃止のため不要）
3. `notify-failure`のneedsリストを更新
4. `workflow_dispatch`のinputsオプションを更新（`scan`→`watchlist`に変更、`news`を削除）

```yaml
watchlist-builder:
  needs: [check-market-day, market-assessment]
  if: |
    always() &&
    needs.check-market-day.outputs.should_run == 'true' &&
    needs.market-assessment.result != 'failure'
  runs-on: ubuntu-latest
  timeout-minutes: 15
  steps:
    - uses: actions/checkout@v5
    - uses: actions/setup-node@v5
      with:
        node-version-file: ".tool-versions"
        cache: "npm"
    - run: npm ci
    - run: npx prisma generate
    - name: Run watchlist builder
      env:
        DATABASE_URL: ${{ secrets.DATABASE_URL }}
      run: npm run watchlist-build
```

- [ ] **Step 3: コミット**

```bash
git add .github/workflows/cronjob_morning-analysis.yml package.json
git commit -m "feat(breakout): morning-analysisをwatchlist-builderに差し替え"
```

---

## Task 9: cron-job.org設定変更 + 動作確認

**Files:** なし（外部サービスの設定変更）

- [ ] **Step 1: cron-job.orgのorder-managerジョブを無効化**

```bash
# CRONJOB_API_KEYを使用してorder-managerジョブを無効化
# （実装時にジョブIDを確認してから実行）
```

- [ ] **Step 2: cron-job.orgにwatchlist-builderを追加（既存morning-analysisの中で呼ばれるので不要な場合はスキップ）**

morning-analysisがGitHub Actionsで動くため、cron-job.orgへの追加は不要。ただしmorning-analysisの呼び出しURLがwatchlist-builderに更新されていることを確認。

- [ ] **Step 3: BROKER_MODE=simulation でエンドツーエンド確認**

1. `npm run watchlist-build` を手動実行 → ウォッチリスト構築確認
2. workerを起動 → breakout-monitorが1分間隔で実行されることを確認
3. ログで出来高サージ比率の計算が行われていることを確認
4. Slack通知が届くことを確認

- [ ] **Step 4: コミット（必要な微修正があれば）**

```bash
git commit -m "fix(breakout): 動作確認で見つかった修正"
```

---

## 実行順序の依存関係

```
Task 1 (定数・型)
    ↓
Task 2 (経過時間) → Task 3 (サージ比率) → Task 5 (スキャナー)
    ↓                                          ↓
Task 4 (ウォッチリスト)                    Task 6 (エグゼキューター)
    ↓                                          ↓
    └──────────── Task 7 (ジョブ統合) ─────────┘
                      ↓
                 Task 8 (ワークフロー)
                      ↓
                 Task 9 (設定変更・動作確認)
```

Task 2 と Task 4 は Task 1 完了後に並列実行可能。Task 3 は Task 2 に依存する。
