# スコアリングシステム再設計 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 現行4カテゴリ（テクニカル65+パターン15+流動性10+ファンダ10）のスコアリングを、3カテゴリ+ゲート（トレンド品質40+エントリータイミング35+リスク品質25）に再設計し、エントリータイミングの精度を向上させる。

**Architecture:** `technical-scorer.ts` を新しい3カテゴリ構造に書き換え、`scoring.ts` 定数を更新し、`on-the-fly-scorer.ts` の ScoredRecord を新構造に対応させる。既存テストは新しいスコアリング関数に合わせて全面書き換え。ゲート（即死ルール）は既存ロジックを流用しつつ流動性チェックを追加。

**Tech Stack:** TypeScript, Vitest, Prisma (ScoringRecord JSON columns)

**Spec:** `docs/superpowers/specs/2026-03-14-scoring-redesign-design.md`

---

## File Structure

### 新規作成

| File | Responsibility |
|------|---------------|
| `src/core/scoring/gates.ts` | ゲート判定（即死ルール + 流動性ゲート） |
| `src/core/scoring/trend-quality.ts` | トレンド品質スコア（40点）: MA配列, 週足トレンド, トレンド継続性 |
| `src/core/scoring/entry-timing.ts` | エントリータイミングスコア（35点）: プルバック深度, ブレイクアウト, ローソク足 |
| `src/core/scoring/risk-quality.ts` | リスク品質スコア（25点）: ATR安定性, レンジ収縮, 出来高安定性 |
| `src/core/scoring/types.ts` | 新インターフェース（NewLogicScore, ScoringGateResult, ScoringInput） |
| `src/core/scoring/index.ts` | メインエントリー: scoreStock() 関数 |
| `src/core/__tests__/scoring/gates.test.ts` | ゲートのテスト |
| `src/core/__tests__/scoring/trend-quality.test.ts` | トレンド品質のテスト |
| `src/core/__tests__/scoring/entry-timing.test.ts` | エントリータイミングのテスト |
| `src/core/__tests__/scoring/risk-quality.test.ts` | リスク品質のテスト |
| `src/core/__tests__/scoring/index.test.ts` | 統合テスト |
| `src/lib/technical-indicators/bb-width-history.ts` | BB幅ヒストリー計算ヘルパー |

### 変更

| File | Changes |
|------|---------|
| `src/lib/constants/scoring.ts` | 定数を新3カテゴリ構造に全面書き換え |
| `src/backtest/on-the-fly-scorer.ts` | ScoredRecord を新構造に更新、新スコアラーを呼び出し |
| `src/backtest/simulation-engine.ts` | scoreTechnicals → scoreStock、LogicScore → NewLogicScore |
| `src/jobs/market-scanner.ts` | 新スコアラーに切り替え、ScoringRecord保存を新カラムに |
| `src/jobs/order-manager.ts` | LogicScore → NewLogicScore、EntrySnapshot構築を更新 |
| `src/jobs/scoring-accuracy-report.ts` | 4カテゴリ分析 → 3カテゴリ分析に変更 |
| `src/jobs/ghost-review.ts` | 旧breakdown参照を新カラムに更新 |
| `src/core/technical-analysis.ts` | `formatScoreForAI()` を新構造に対応 |
| `src/core/entry-calculator.ts` | LogicScore → NewLogicScore 型の更新 |
| `src/types/snapshots.ts` | EntrySnapshot.score を新3カテゴリ構造に |
| `src/web/routes/api.ts` | ScoringRecord の新カラム名でselect |
| `src/web/routes/scoring.ts` | 表示を新3カテゴリに変更 |
| `src/web/routes/contrarian.ts` | 4カテゴリ平均 → 3カテゴリ平均に変更 |
| `src/web/views/stock-modal.ts` | スコアバーを新3カテゴリに変更 |
| `scripts/backfill-scoring-records.ts` | ScoredRecord マッピングを新構造に |
| `prisma/schema.prisma` | ScoringRecord カラムを新3カテゴリに変更 |

### 旧ファイル（最後に削除）

| File | Action |
|------|--------|
| `src/core/technical-scorer.ts` | 新 scoring/ に置き換え後に削除 |
| `src/core/__tests__/technical-scorer.test.ts` | 新テストに置き換え後に削除 |

---

## Chunk 1: Foundation — 型定義・定数・ゲート

### Task 1: 新しい型定義を作成

**Files:**
- Create: `src/core/scoring/types.ts`

- [ ] **Step 1: 型定義ファイルを作成**

```typescript
// src/core/scoring/types.ts
import type { OHLCVData, TechnicalSummary } from "../technical-analysis";

/** ゲート判定結果 */
export interface ScoringGateResult {
  passed: boolean;
  failedGate:
    | "liquidity"
    | "spread"
    | "volatility"
    | "earnings"
    | "dividend"
    | null;
}

/** スコアリング入力 */
export interface ScoringInput {
  /** 日足OHLCV（newest-first） */
  historicalData: OHLCVData[];
  latestPrice: number;
  latestVolume: number;
  weeklyVolatility: number | null;
  nextEarningsDate?: Date | null;
  exDividendDate?: Date | null;
  /** 25日平均出来高 */
  avgVolume25?: number | null;
  /** テクニカルサマリー（analyzeTechnicals() の出力） */
  summary: TechnicalSummary;
}

/** 新スコアリング結果 */
export interface NewLogicScore {
  totalScore: number;
  rank: "S" | "A" | "B" | "C" | "D";
  gate: ScoringGateResult;
  trendQuality: {
    total: number;
    maAlignment: number;
    weeklyTrend: number;
    trendContinuity: number;
  };
  entryTiming: {
    total: number;
    pullbackDepth: number;
    breakout: number;
    candlestickSignal: number;
  };
  riskQuality: {
    total: number;
    atrStability: number;
    rangeContraction: number;
    volumeStability: number;
  };
  isDisqualified: boolean;
  disqualifyReason: string | null;
}

/** ランク判定 */
export function getRank(score: number): NewLogicScore["rank"] {
  if (score >= 80) return "S";
  if (score >= 65) return "A";
  if (score >= 50) return "B";
  if (score >= 35) return "C";
  return "D";
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/scoring/types.ts
git commit -m "feat(scoring): 新スコアリングシステムの型定義を追加"
```

---

### Task 2: スコアリング定数を新構造に更新

**Files:**
- Modify: `src/lib/constants/scoring.ts`

- [ ] **Step 1: テスト不要（定数のみ）— 定数を更新**

`SCORING` オブジェクトを以下に書き換える。旧定数は既存コードがまだ参照するので `SCORING_V1` として残す。

```typescript
/** 旧スコアリング定数（移行完了後に削除） */
export const SCORING_V1 = { ...既存のSCORING };

export const SCORING = {
  /** カテゴリ最大点数 */
  CATEGORY_MAX: {
    TREND_QUALITY: 40,
    ENTRY_TIMING: 35,
    RISK_QUALITY: 25,
  },

  /** サブスコア最大点数 */
  SUB_MAX: {
    // トレンド品質 (40)
    MA_ALIGNMENT: 18,
    WEEKLY_TREND: 12,
    TREND_CONTINUITY: 10,
    // エントリータイミング (35)
    PULLBACK_DEPTH: 15,
    BREAKOUT: 12,
    CANDLESTICK_SIGNAL: 8,
    // リスク品質 (25)
    ATR_STABILITY: 10,
    RANGE_CONTRACTION: 8,
    VOLUME_STABILITY: 7,
  },

  /** ランク閾値 */
  THRESHOLDS: {
    S_RANK: 80,
    A_RANK: 65,
    B_RANK: 50,
    C_RANK: 35,
  },

  /** ゲート（即死ルール） */
  GATES: {
    MIN_AVG_VOLUME_25: 50_000,
    MAX_PRICE: 3000,
    MIN_ATR_PCT: 1.5,
    EARNINGS_DAYS_BEFORE: 5,
    EX_DIVIDEND_DAYS_BEFORE: 3,
  },

  /** トレンド品質パラメータ */
  TREND: {
    /** トレンド継続性のスイートスポット（日） */
    CONTINUITY_SWEET_MIN: 10,
    CONTINUITY_SWEET_MAX: 30,
    CONTINUITY_MATURE_MAX: 50,
    /** 週足SMA13方向の変化率閾値（%） */
    WEEKLY_SMA13_FLAT_THRESHOLD: 0.5,
  },

  /** エントリータイミングパラメータ */
  ENTRY: {
    /** プルバック深度の乖離率閾値（%） */
    PULLBACK_NEAR_MIN: -1,
    PULLBACK_NEAR_MAX: 2,
    PULLBACK_DEEP_THRESHOLD: -3,
    /** ブレイクアウト出来高倍率 */
    BREAKOUT_VOLUME_RATIO: 1.5,
    /** ブレイクアウト高値ルックバック */
    BREAKOUT_LOOKBACK_20: 20,
    BREAKOUT_LOOKBACK_10: 10,
  },

  /** リスク品質パラメータ */
  RISK: {
    /** ATR安定性 CV閾値 */
    ATR_CV_EXCELLENT: 0.15,
    ATR_CV_GOOD: 0.25,
    ATR_CV_FAIR: 0.35,
    /** BB幅パーセンタイル閾値 */
    BB_SQUEEZE_STRONG: 20,
    BB_SQUEEZE_MODERATE: 40,
    /** BB幅ルックバック（日） */
    BB_WIDTH_LOOKBACK: 60,
    /** 出来高CV閾値 */
    VOLUME_CV_STABLE: 0.5,
    VOLUME_CV_MODERATE: 0.8,
    /** 出来高CV計算期間 */
    VOLUME_CV_PERIOD: 25,
  },

  MAX_CANDIDATES_FOR_AI: 20,
  MIN_CANDIDATES_FOR_AI: 5,
} as const;
```

- [ ] **Step 2: 旧スコアラーの参照を SCORING_V1 に切り替え**

`src/core/technical-scorer.ts` のインポートを `SCORING` → `SCORING_V1 as SCORING` に変更して、旧コードが壊れないようにする。

- [ ] **Step 3: ビルド確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 4: Commit**

```bash
git add src/lib/constants/scoring.ts src/core/technical-scorer.ts
git commit -m "feat(scoring): 新3カテゴリ定数を追加、旧定数をSCORING_V1に退避"
```

---

### Task 3: ゲート判定を実装

**Files:**
- Create: `src/core/scoring/gates.ts`
- Test: `src/core/__tests__/scoring/gates.test.ts`

- [ ] **Step 1: ゲートのテストを作成**

```typescript
// src/core/__tests__/scoring/gates.test.ts
import { describe, it, expect } from "vitest";
import { checkGates } from "../../scoring/gates";

describe("checkGates", () => {
  const baseInput = {
    latestPrice: 1000,
    avgVolume25: 100_000,
    atrPct: 2.5,
    nextEarningsDate: null,
    exDividendDate: null,
    today: new Date("2026-03-14"),
  };

  it("全条件クリア → passed=true", () => {
    const result = checkGates(baseInput);
    expect(result.passed).toBe(true);
    expect(result.failedGate).toBeNull();
  });

  it("出来高不足 → liquidity", () => {
    const result = checkGates({ ...baseInput, avgVolume25: 30_000 });
    expect(result.passed).toBe(false);
    expect(result.failedGate).toBe("liquidity");
  });

  it("株価超過 → spread", () => {
    const result = checkGates({ ...baseInput, latestPrice: 5000 });
    expect(result.passed).toBe(false);
    expect(result.failedGate).toBe("spread");
  });

  it("低ボラ → volatility", () => {
    const result = checkGates({ ...baseInput, atrPct: 1.0 });
    expect(result.passed).toBe(false);
    expect(result.failedGate).toBe("volatility");
  });

  it("決算5日以内 → earnings", () => {
    const result = checkGates({
      ...baseInput,
      nextEarningsDate: new Date("2026-03-17"),
    });
    expect(result.passed).toBe(false);
    expect(result.failedGate).toBe("earnings");
  });

  it("配当3日以内 → dividend", () => {
    const result = checkGates({
      ...baseInput,
      exDividendDate: new Date("2026-03-16"),
    });
    expect(result.passed).toBe(false);
    expect(result.failedGate).toBe("dividend");
  });

  it("exDividendDate=null → 合格（安全側デフォルト）", () => {
    const result = checkGates({ ...baseInput, exDividendDate: null });
    expect(result.passed).toBe(true);
  });
});
```

- [ ] **Step 2: テスト実行 → FAIL確認**

Run: `npx vitest run src/core/__tests__/scoring/gates.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: ゲート実装**

```typescript
// src/core/scoring/gates.ts
import { SCORING } from "../../lib/constants/scoring";
import type { ScoringGateResult } from "./types";

interface GateInput {
  latestPrice: number;
  avgVolume25: number | null;
  atrPct: number | null;
  nextEarningsDate: Date | null;
  exDividendDate: Date | null;
  today: Date;
}

export function checkGates(input: GateInput): ScoringGateResult {
  const { GATES } = SCORING;

  // 流動性
  if (input.avgVolume25 != null && input.avgVolume25 < GATES.MIN_AVG_VOLUME_25) {
    return { passed: false, failedGate: "liquidity" };
  }

  // 株価
  if (input.latestPrice > GATES.MAX_PRICE) {
    return { passed: false, failedGate: "spread" };
  }

  // 最低ボラ
  if (input.atrPct != null && input.atrPct < GATES.MIN_ATR_PCT) {
    return { passed: false, failedGate: "volatility" };
  }

  // 決算接近
  if (input.nextEarningsDate) {
    const diffDays = Math.floor(
      (input.nextEarningsDate.getTime() - input.today.getTime()) / 86_400_000,
    );
    if (diffDays >= 0 && diffDays <= GATES.EARNINGS_DAYS_BEFORE) {
      return { passed: false, failedGate: "earnings" };
    }
  }

  // 配当
  if (input.exDividendDate) {
    const diffDays = Math.floor(
      (input.exDividendDate.getTime() - input.today.getTime()) / 86_400_000,
    );
    if (diffDays >= 0 && diffDays <= GATES.EX_DIVIDEND_DAYS_BEFORE) {
      return { passed: false, failedGate: "dividend" };
    }
  }

  return { passed: true, failedGate: null };
}
```

- [ ] **Step 4: テスト実行 → PASS確認**

Run: `npx vitest run src/core/__tests__/scoring/gates.test.ts`
Expected: PASS (全テスト)

- [ ] **Step 5: Commit**

```bash
git add src/core/scoring/gates.ts src/core/__tests__/scoring/gates.test.ts
git commit -m "feat(scoring): ゲート判定（即死ルール+流動性ゲート）を実装"
```

---

## Chunk 2: トレンド品質（40点）

### Task 4: BB幅ヒストリーヘルパーを作成

**Files:**
- Create: `src/lib/technical-indicators/bb-width-history.ts`

BB幅の60日パーセンタイル計算に必要。Task 7（リスク品質）で使うが、独立ユーティリティなので先に作る。

- [ ] **Step 1: テストを作成**

```typescript
// src/lib/__tests__/bb-width-history.test.ts
import { describe, it, expect } from "vitest";
import { calculateBBWidthPercentile } from "../technical-indicators/bb-width-history";

describe("calculateBBWidthPercentile", () => {
  it("安定した価格 → 低パーセンタイル", () => {
    // 60日間ほぼ同じ価格
    const prices = Array.from({ length: 100 }, () => 100);
    const result = calculateBBWidthPercentile(prices, 20, 60);
    // 全日同じBB幅なので50パーセンタイル付近
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
  });

  it("データ不足 → null", () => {
    const prices = Array.from({ length: 30 }, () => 100);
    const result = calculateBBWidthPercentile(prices, 20, 60);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: テスト実行 → FAIL確認**

- [ ] **Step 3: 実装**

```typescript
// src/lib/technical-indicators/bb-width-history.ts
/**
 * BB(20,2σ)幅の直近lookback日パーセンタイルを計算
 * @param prices 終値配列（newest-first）
 * @param period BB期間（デフォルト20）
 * @param lookback パーセンタイル計算期間（デフォルト60）
 * @returns 0-100のパーセンタイル、データ不足時null
 */
export function calculateBBWidthPercentile(
  prices: number[],
  period: number = 20,
  lookback: number = 60,
): number | null {
  // newest-first → oldest-first に反転
  const reversed = [...prices].reverse();
  const minRequired = period + lookback;
  if (reversed.length < minRequired) return null;

  const widths: number[] = [];

  for (let i = reversed.length - lookback; i < reversed.length; i++) {
    const window = reversed.slice(i - period + 1, i + 1);
    if (window.length < period) continue;

    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    widths.push(std * 4); // upper - lower = 2σ×2 = 4σ
  }

  if (widths.length < 2) return null;

  const currentWidth = widths[widths.length - 1];
  const belowCount = widths.filter((w) => w < currentWidth).length;
  return Math.round((belowCount / (widths.length - 1)) * 100);
}
```

- [ ] **Step 4: テスト実行 → PASS確認**

- [ ] **Step 5: Commit**

```bash
git add src/lib/technical-indicators/bb-width-history.ts src/lib/__tests__/bb-width-history.test.ts
git commit -m "feat(scoring): BB幅パーセンタイル計算ヘルパーを追加"
```

---

### Task 5: トレンド品質スコアを実装

**Files:**
- Create: `src/core/scoring/trend-quality.ts`
- Test: `src/core/__tests__/scoring/trend-quality.test.ts`

- [ ] **Step 1: テストを作成**

テスト対象: `scoreMaAlignment()`, `scoreWeeklyTrend()`, `scoreTrendContinuity()`, `scoreTrendQuality()`

```typescript
// src/core/__tests__/scoring/trend-quality.test.ts
import { describe, it, expect } from "vitest";
import {
  scoreMaAlignment,
  scoreWeeklyTrend,
  scoreTrendContinuity,
  scoreTrendQuality,
} from "../../scoring/trend-quality";

describe("scoreMaAlignment", () => {
  it("完全パーフェクトオーダー(close>SMA5>SMA25>SMA75) → 18", () => {
    expect(scoreMaAlignment(100, 98, 95, 90)).toBe(18);
  });

  it("SMA75下(close>SMA5>SMA25, SMA25<SMA75) → 14", () => {
    expect(scoreMaAlignment(100, 98, 95, 97)).toBe(14);
  });

  it("SMA5割れ(close>SMA25, close<SMA5) → 8", () => {
    expect(scoreMaAlignment(96, 98, 95, 90)).toBe(8);
  });

  it("SMA25上だが配列崩れ → 4", () => {
    expect(scoreMaAlignment(96, 90, 95, 98)).toBe(4);
  });

  it("SMA25下 → 0", () => {
    expect(scoreMaAlignment(90, 95, 96, 100)).toBe(0);
  });

  it("SMA75=null(データ不足) → SMA25のみで評価、最大14", () => {
    expect(scoreMaAlignment(100, 98, 95, null)).toBe(14);
  });
});

describe("scoreWeeklyTrend", () => {
  it("SMA13上 & 上向き → 12", () => {
    expect(scoreWeeklyTrend(100, 95, 93)).toBe(12);
  });

  it("SMA13上 & 横ばい → 8", () => {
    expect(scoreWeeklyTrend(100, 95, 95)).toBe(8);
  });

  it("SMA13下 & 上向き → 4", () => {
    expect(scoreWeeklyTrend(90, 95, 93)).toBe(4);
  });

  it("SMA13下 & 下向き → 0", () => {
    expect(scoreWeeklyTrend(90, 95, 97)).toBe(0);
  });

  it("データ不足(null) → 0", () => {
    expect(scoreWeeklyTrend(100, null, null)).toBe(0);
  });
});

describe("scoreTrendContinuity", () => {
  it("10-30日連続 → 10", () => {
    expect(scoreTrendContinuity(20)).toBe(10);
  });

  it("5-9日 → 7", () => {
    expect(scoreTrendContinuity(7)).toBe(7);
  });

  it("31-50日 → 5", () => {
    expect(scoreTrendContinuity(40)).toBe(5);
  });

  it("50日超 → 2", () => {
    expect(scoreTrendContinuity(60)).toBe(2);
  });

  it("0日(SMA25下) → 0", () => {
    expect(scoreTrendContinuity(0)).toBe(0);
  });
});
```

- [ ] **Step 2: テスト実行 → FAIL確認**

Run: `npx vitest run src/core/__tests__/scoring/trend-quality.test.ts`

- [ ] **Step 3: 実装**

```typescript
// src/core/scoring/trend-quality.ts
import { SCORING } from "../../lib/constants/scoring";
import type { OHLCVData } from "../technical-analysis";
import { calculateSMA } from "../../lib/technical-indicators";

const { SUB_MAX, TREND } = SCORING;

/**
 * MA配列スコア（0-18）
 * close, SMA5, SMA25, SMA75 の位置関係を評価
 */
export function scoreMaAlignment(
  close: number,
  sma5: number | null,
  sma25: number | null,
  sma75: number | null,
): number {
  if (sma25 == null || sma5 == null) return 0;

  // SMA25下 → 0
  if (close < sma25) return 0;

  // SMA75なし → SMA25のみで判定（最大14点）
  if (sma75 == null) {
    if (close > sma5 && sma5 > sma25) return 14;
    if (close > sma25 && close < sma5) return 8;
    return 4;
  }

  // 完全パーフェクトオーダー
  if (close > sma5 && sma5 > sma25 && sma25 > sma75) return SUB_MAX.MA_ALIGNMENT;
  // 短中期揃い、SMA75下
  if (close > sma5 && sma5 > sma25) return 14;
  // SMA5割れ（押し目）
  if (close > sma25 && close < sma5) return 8;
  // SMA25上だが配列崩れ
  return 4;
}

/**
 * 週足トレンド確認（0-12）
 * @param weeklyClose 最新週足終値
 * @param weeklySma13 今週のSMA13
 * @param prevWeeklySma13 前週のSMA13
 */
export function scoreWeeklyTrend(
  weeklyClose: number,
  weeklySma13: number | null,
  prevWeeklySma13: number | null,
): number {
  if (weeklySma13 == null || prevWeeklySma13 == null) return 0;

  const aboveSma = weeklyClose > weeklySma13;
  const changeRate = ((weeklySma13 - prevWeeklySma13) / prevWeeklySma13) * 100;
  const isRising = changeRate > TREND.WEEKLY_SMA13_FLAT_THRESHOLD;
  const isFlat = Math.abs(changeRate) <= TREND.WEEKLY_SMA13_FLAT_THRESHOLD;

  if (aboveSma && isRising) return SUB_MAX.WEEKLY_TREND; // 12
  if (aboveSma && isFlat) return 8;
  if (!aboveSma && isRising) return 4;
  return 0; // 下 & 下向き or 横ばい
}

/**
 * SMA25上の連続日数をカウント
 * @param data OHLCVデータ（newest-first）
 */
export function countDaysAboveSma25(data: OHLCVData[]): number {
  if (data.length < 25) return 0;

  // newest-first の終値配列
  const closes = data.map((d) => d.close);
  let count = 0;

  for (let i = 0; i < closes.length - 24; i++) {
    // i番目の日のSMA25を計算
    const window = closes.slice(i, i + 25);
    const sma25 = window.reduce((a, b) => a + b, 0) / 25;
    if (closes[i] > sma25) {
      count++;
    } else {
      break; // 連続が途切れたら終了
    }
  }

  return count;
}

/**
 * トレンド継続性スコア（0-10）
 */
export function scoreTrendContinuity(daysAboveSma25: number): number {
  if (daysAboveSma25 <= 0) return 0;
  if (daysAboveSma25 >= TREND.CONTINUITY_SWEET_MIN && daysAboveSma25 <= TREND.CONTINUITY_SWEET_MAX) return SUB_MAX.TREND_CONTINUITY; // 10
  if (daysAboveSma25 < TREND.CONTINUITY_SWEET_MIN) return 7;
  if (daysAboveSma25 <= TREND.CONTINUITY_MATURE_MAX) return 5;
  return 2; // 50日超
}

/** トレンド品質の入力 */
export interface TrendQualityInput {
  close: number;
  sma5: number | null;
  sma25: number | null;
  sma75: number | null;
  /** 最新週足終値 */
  weeklyClose: number | null;
  /** 今週のSMA13 */
  weeklySma13: number | null;
  /** 前週のSMA13 */
  prevWeeklySma13: number | null;
  /** SMA25上の連続日数 */
  daysAboveSma25: number;
}

/**
 * トレンド品質トータル（0-40）
 */
export function scoreTrendQuality(input: TrendQualityInput) {
  const maAlignment = scoreMaAlignment(input.close, input.sma5, input.sma25, input.sma75);
  const weeklyTrend = scoreWeeklyTrend(
    input.weeklyClose ?? input.close,
    input.weeklySma13,
    input.prevWeeklySma13,
  );
  const trendContinuity = scoreTrendContinuity(input.daysAboveSma25);

  return {
    total: maAlignment + weeklyTrend + trendContinuity,
    maAlignment,
    weeklyTrend,
    trendContinuity,
  };
}
```

- [ ] **Step 4: テスト実行 → PASS確認**

Run: `npx vitest run src/core/__tests__/scoring/trend-quality.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/scoring/trend-quality.ts src/core/__tests__/scoring/trend-quality.test.ts
git commit -m "feat(scoring): トレンド品質スコア（40点）を実装"
```

---

## Chunk 3: エントリータイミング（35点）

### Task 6: エントリータイミングスコアを実装

**Files:**
- Create: `src/core/scoring/entry-timing.ts`
- Test: `src/core/__tests__/scoring/entry-timing.test.ts`

- [ ] **Step 1: テストを作成**

```typescript
// src/core/__tests__/scoring/entry-timing.test.ts
import { describe, it, expect } from "vitest";
import {
  scorePullbackDepth,
  scoreBreakout,
  scoreCandlestickSignal,
  scoreEntryTiming,
} from "../../scoring/entry-timing";
import type { OHLCVData } from "../../technical-analysis";

function makeBar(overrides: Partial<OHLCVData> = {}): OHLCVData {
  return { date: "2026-01-01", open: 100, high: 105, low: 95, close: 100, volume: 10000, ...overrides };
}

describe("scorePullbackDepth", () => {
  it("SMA25付近(-1%~+2%) + 反発サイン → 15", () => {
    const bars = [
      makeBar({ open: 96, high: 100, low: 93, close: 99 }), // 当日: 下ヒゲ=min(96,99)-93=3, 実体=3, 反発OK
      makeBar({ close: 95 }), // 前日
    ];
    const result = scorePullbackDepth(99, 98, 100, 1.0, bars);
    expect(result).toBe(15);
  });

  it("SMA5-SMA25間（浅い押し目） → 10", () => {
    // close=97, sma5=100, sma25=95 → SMA5下, SMA25上
    const bars = [makeBar({ close: 97 }), makeBar()];
    const result = scorePullbackDepth(97, 100, 95, 2.1, bars);
    expect(result).toBe(10);
  });

  it("SMA5上（押してない）→ 3", () => {
    const bars = [makeBar(), makeBar()];
    const result = scorePullbackDepth(100, 98, 90, 11.1, bars);
    expect(result).toBe(3);
  });

  it("SMA25大幅下（乖離-3%超） → 0", () => {
    const bars = [makeBar(), makeBar()];
    const result = scorePullbackDepth(90, 95, 100, -10.0, bars);
    expect(result).toBe(0);
  });
});

describe("scoreBreakout", () => {
  it("20日高値更新 + 出来高1.5倍超 → 12", () => {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < 25; i++) {
      bars.push(makeBar({ close: 100 + (i === 0 ? 10 : 0), volume: i === 0 ? 20000 : 10000 }));
    }
    // bars[0] = newest: close=110, volume=20000
    // avgVolume25 = ~10400
    // maxClose in bars[1..20] = 100
    const result = scoreBreakout(bars, 10000);
    expect(result).toBe(12);
  });

  it("高値更新なし → 0", () => {
    const bars = Array.from({ length: 25 }, () => makeBar());
    const result = scoreBreakout(bars, 10000);
    expect(result).toBe(0);
  });
});

describe("scoreCandlestickSignal", () => {
  it("包み足（陽線）+ 出来高増加 → 8", () => {
    const bars = [
      makeBar({ open: 95, close: 105, high: 106, low: 94, volume: 20000 }),
      makeBar({ open: 102, close: 97, high: 103, low: 96, volume: 10000 }),
    ];
    const result = scoreCandlestickSignal(bars, 10000);
    expect(result).toBe(8);
  });

  it("連続陽線（3本）+ 出来高漸増 → 5", () => {
    const bars = [
      makeBar({ open: 100, close: 103, volume: 15000 }),
      makeBar({ open: 98, close: 101, volume: 12000 }),
      makeBar({ open: 96, close: 99, volume: 10000 }),
    ];
    const result = scoreCandlestickSignal(bars, 20000);
    expect(result).toBe(5);
  });

  it("シグナルなし → 0", () => {
    const bars = [
      makeBar({ open: 100, close: 101, volume: 10000 }),
      makeBar({ open: 100, close: 101, volume: 10000 }),
    ];
    const result = scoreCandlestickSignal(bars, 10000);
    expect(result).toBe(0);
  });
});
```

- [ ] **Step 2: テスト実行 → FAIL確認**

- [ ] **Step 3: 実装**

```typescript
// src/core/scoring/entry-timing.ts
import { SCORING } from "../../lib/constants/scoring";
import type { OHLCVData } from "../technical-analysis";

const { SUB_MAX, ENTRY } = SCORING;

/**
 * 反発サインを検出
 * 直近2本のうち下ヒゲが実体以上、または前日陰線→当日陽線
 */
function hasReversalSign(bars: OHLCVData[]): boolean {
  if (bars.length < 2) return false;
  const [today, yesterday] = bars;

  // 下ヒゲチェック（当日・前日）
  for (const bar of [today, yesterday]) {
    const lowerShadow = Math.min(bar.open, bar.close) - bar.low;
    const realBody = Math.abs(bar.close - bar.open);
    if (lowerShadow >= realBody && realBody > 0) return true;
  }

  // 前日陰線 → 当日陽線
  if (yesterday.close < yesterday.open && today.close > today.open) return true;

  return false;
}

/**
 * プルバック深度スコア（0-15）
 * 評価順序: 上から順にマッチした条件のスコアを採用
 */
export function scorePullbackDepth(
  close: number,
  sma5: number | null,
  sma25: number | null,
  deviationRate25: number | null,
  recentBars: OHLCVData[],
): number {
  if (sma25 == null || deviationRate25 == null) return 0;

  // 条件1: SMA25付近 + 反発サイン → 15
  if (
    deviationRate25 >= ENTRY.PULLBACK_NEAR_MIN &&
    deviationRate25 <= ENTRY.PULLBACK_NEAR_MAX &&
    hasReversalSign(recentBars)
  ) {
    return SUB_MAX.PULLBACK_DEPTH;
  }

  // 条件2: SMA5-SMA25間（浅い押し目）→ 10
  if (sma5 != null && close < sma5 && close > sma25 && deviationRate25 > ENTRY.PULLBACK_NEAR_MAX) {
    return 10;
  }

  // 条件3: SMA25一時割れ復帰 → 8
  if (close > sma25 && recentBars.length >= 3) {
    const recentBelow = recentBars.slice(1, 4).some((bar) => {
      // 直近3営業日（当日除く）でSMA25下があるか
      // 注意: ここではsma25が日ごとに変わるが、簡易的に現在のsma25で判定
      return bar.close < sma25;
    });
    if (recentBelow) return 8;
  }

  // 条件4: SMA5上（押してない）→ 3
  if (sma5 != null && close >= sma5) return 3;

  // 条件5: SMA25大幅下 → 0
  if (deviationRate25 < ENTRY.PULLBACK_DEEP_THRESHOLD) return 0;

  return 0;
}

/**
 * ブレイクアウト検出スコア（0-12）
 * 終値ベースで高値更新を判定
 */
export function scoreBreakout(
  bars: OHLCVData[],
  avgVolume25: number | null,
): number {
  if (bars.length < 2) return 0;

  const currentClose = bars[0].close;
  const currentVolume = bars[0].volume;

  // 直近20日の最高終値（当日除く）
  const lookback20 = bars.slice(1, ENTRY.BREAKOUT_LOOKBACK_20 + 1);
  const max20 = lookback20.length > 0 ? Math.max(...lookback20.map((b) => b.close)) : Infinity;

  // 直近10日の最高終値（当日除く）
  const lookback10 = bars.slice(1, ENTRY.BREAKOUT_LOOKBACK_10 + 1);
  const max10 = lookback10.length > 0 ? Math.max(...lookback10.map((b) => b.close)) : Infinity;

  // 20日高値更新
  if (currentClose > max20 && lookback20.length >= ENTRY.BREAKOUT_LOOKBACK_20) {
    const volumeRatio = avgVolume25 && avgVolume25 > 0
      ? currentVolume / avgVolume25
      : 1;
    if (volumeRatio > ENTRY.BREAKOUT_VOLUME_RATIO) return SUB_MAX.BREAKOUT; // 12
    return 7; // 通常出来高
  }

  // 10日高値更新
  if (currentClose > max10 && lookback10.length >= ENTRY.BREAKOUT_LOOKBACK_10) {
    return 4;
  }

  return 0;
}

/**
 * ローソク足シグナルスコア（0-8）
 * 複数パターン該当時は最高スコアを採用
 * @param bars newest-first OHLCV（最低3本必要）
 * @param avgVolume25 25日平均出来高
 */
export function scoreCandlestickSignal(
  bars: OHLCVData[],
  avgVolume25: number | null,
): number {
  if (bars.length < 2) return 0;
  let maxScore = 0;
  const today = bars[0];
  const yesterday = bars[1];
  const volumeRatio = avgVolume25 && avgVolume25 > 0
    ? today.volume / avgVolume25
    : 1;

  // 包み足（陽線）+ 出来高増加 → 8
  const todayBullish = today.close > today.open;
  const yesterdayBearish = yesterday.close < yesterday.open;
  const engulfing = todayBullish && yesterdayBearish &&
    today.close > yesterday.open && today.open < yesterday.close;
  if (engulfing && volumeRatio > 1.0) {
    maxScore = Math.max(maxScore, SUB_MAX.CANDLESTICK_SIGNAL); // 8
  }

  // 長い下ヒゲ（実体の2倍超）→ 6
  const lowerShadow = Math.min(today.open, today.close) - today.low;
  const realBody = Math.abs(today.close - today.open);
  if (realBody > 0 && lowerShadow > realBody * 2) {
    maxScore = Math.max(maxScore, 6);
  }

  // 連続陽線（3本）+ 出来高漸増 → 5
  if (bars.length >= 3) {
    const [b0, b1, b2] = bars;
    const allBullish = b0.close > b0.open && b1.close > b1.open && b2.close > b2.open;
    const volumeIncreasing = b0.volume > b1.volume && b1.volume > b2.volume;
    if (allBullish && volumeIncreasing) {
      maxScore = Math.max(maxScore, 5);
    }
  }

  // 十字線（実体がほぼゼロ）→ 3
  const totalRange = today.high - today.low;
  if (totalRange > 0 && realBody / totalRange < 0.1) {
    maxScore = Math.max(maxScore, 3);
  }

  return maxScore;
}

/** エントリータイミングの入力 */
export interface EntryTimingInput {
  close: number;
  sma5: number | null;
  sma25: number | null;
  deviationRate25: number | null;
  /** newest-first OHLCV */
  bars: OHLCVData[];
  avgVolume25: number | null;
}

/**
 * エントリータイミングトータル（0-35）
 */
export function scoreEntryTiming(input: EntryTimingInput) {
  const pullbackDepth = scorePullbackDepth(
    input.close, input.sma5, input.sma25, input.deviationRate25, input.bars,
  );
  const breakout = scoreBreakout(input.bars, input.avgVolume25);

  const candlestickSignal = scoreCandlestickSignal(input.bars, input.avgVolume25);

  return {
    total: pullbackDepth + breakout + candlestickSignal,
    pullbackDepth,
    breakout,
    candlestickSignal,
  };
}
```

- [ ] **Step 4: テスト実行 → PASS確認**

Run: `npx vitest run src/core/__tests__/scoring/entry-timing.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/scoring/entry-timing.ts src/core/__tests__/scoring/entry-timing.test.ts
git commit -m "feat(scoring): エントリータイミングスコア（35点）を実装"
```

---

## Chunk 4: リスク品質（25点）+ メインスコアラー

### Task 7: リスク品質スコアを実装

**Files:**
- Create: `src/core/scoring/risk-quality.ts`
- Test: `src/core/__tests__/scoring/risk-quality.test.ts`

- [ ] **Step 1: テストを作成**

```typescript
// src/core/__tests__/scoring/risk-quality.test.ts
import { describe, it, expect } from "vitest";
import {
  scoreAtrStability,
  scoreRangeContraction,
  scoreVolumeStability,
} from "../../scoring/risk-quality";

describe("scoreAtrStability", () => {
  it("CV < 0.15 → 10", () => {
    expect(scoreAtrStability(0.10)).toBe(10);
  });

  it("CV 0.15-0.25 → 7", () => {
    expect(scoreAtrStability(0.20)).toBe(7);
  });

  it("CV 0.25-0.35 → 4", () => {
    expect(scoreAtrStability(0.30)).toBe(4);
  });

  it("CV > 0.35 → 0", () => {
    expect(scoreAtrStability(0.40)).toBe(0);
  });

  it("null → 0", () => {
    expect(scoreAtrStability(null)).toBe(0);
  });
});

describe("scoreRangeContraction", () => {
  it("下位20% → 8", () => {
    expect(scoreRangeContraction(10)).toBe(8);
  });

  it("下位20-40% → 5", () => {
    expect(scoreRangeContraction(30)).toBe(5);
  });

  it("中央 → 3", () => {
    expect(scoreRangeContraction(50)).toBe(3);
  });

  it("上位40%(60以上) → 0", () => {
    expect(scoreRangeContraction(70)).toBe(0);
  });

  it("null → 0", () => {
    expect(scoreRangeContraction(null)).toBe(0);
  });
});

describe("scoreVolumeStability", () => {
  it("5日MA > 25日MA & CV < 0.5 → 7", () => {
    expect(scoreVolumeStability(15000, 10000, 0.3)).toBe(7);
  });

  it("5日MA > 25日MA & CV 0.5-0.8 → 5", () => {
    expect(scoreVolumeStability(15000, 10000, 0.6)).toBe(5);
  });

  it("5日MA <= 25日MA → 3", () => {
    expect(scoreVolumeStability(8000, 10000, 0.3)).toBe(3);
  });

  it("CV > 0.8 → 0", () => {
    expect(scoreVolumeStability(15000, 10000, 0.9)).toBe(0);
  });
});
```

- [ ] **Step 2: テスト実行 → FAIL確認**

- [ ] **Step 3: 実装**

```typescript
// src/core/scoring/risk-quality.ts
import { SCORING } from "../../lib/constants/scoring";

const { SUB_MAX, RISK } = SCORING;

/**
 * ATR安定性スコア（0-10）
 * ATR14の直近20日間の変動係数（CV）を評価
 */
export function scoreAtrStability(atrCv: number | null): number {
  if (atrCv == null) return 0;
  if (atrCv < RISK.ATR_CV_EXCELLENT) return SUB_MAX.ATR_STABILITY; // 10
  if (atrCv < RISK.ATR_CV_GOOD) return 7;
  if (atrCv < RISK.ATR_CV_FAIR) return 4;
  return 0;
}

/**
 * レンジ収縮度スコア（0-8）
 * BB幅の直近60日パーセンタイルを評価
 */
export function scoreRangeContraction(bbWidthPercentile: number | null): number {
  if (bbWidthPercentile == null) return 0;
  if (bbWidthPercentile < RISK.BB_SQUEEZE_STRONG) return SUB_MAX.RANGE_CONTRACTION; // 8
  if (bbWidthPercentile < RISK.BB_SQUEEZE_MODERATE) return 5;
  if (bbWidthPercentile < 60) return 3;
  return 0; // 上位40%
}

/**
 * 出来高安定性スコア（0-7）
 */
export function scoreVolumeStability(
  volumeMA5: number | null,
  volumeMA25: number | null,
  volumeCv: number | null,
): number {
  if (volumeMA5 == null || volumeMA25 == null || volumeCv == null) return 0;

  // CV > 0.8 → 不安定
  if (volumeCv > RISK.VOLUME_CV_MODERATE) return 0;

  // 増加傾向チェック
  const isIncreasing = volumeMA5 > volumeMA25;

  if (isIncreasing && volumeCv < RISK.VOLUME_CV_STABLE) return SUB_MAX.VOLUME_STABILITY; // 7
  if (isIncreasing && volumeCv <= RISK.VOLUME_CV_MODERATE) return 5;

  // 減少傾向だが安定
  return 3;
}

/**
 * ATR14のCV（変動係数）を計算
 * @param atr14Values 直近20日分のATR14値（newest-first）
 */
export function calculateAtrCv(atr14Values: number[]): number | null {
  if (atr14Values.length < 20) return null;
  const window = atr14Values.slice(0, 20);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  if (mean === 0) return null;
  const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window.length;
  return Math.sqrt(variance) / mean;
}

/**
 * 出来高のCVを計算
 * @param volumes 直近25日分の出来高（newest-first）
 */
export function calculateVolumeCv(volumes: number[]): number | null {
  const period = RISK.VOLUME_CV_PERIOD;
  if (volumes.length < period) return null;
  const window = volumes.slice(0, period);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  if (mean === 0) return null;
  const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window.length;
  return Math.sqrt(variance) / mean;
}

/** リスク品質の入力 */
export interface RiskQualityInput {
  atrCv: number | null;
  bbWidthPercentile: number | null;
  volumeMA5: number | null;
  volumeMA25: number | null;
  volumeCv: number | null;
}

/**
 * リスク品質トータル（0-25）
 */
export function scoreRiskQuality(input: RiskQualityInput) {
  const atrStability = scoreAtrStability(input.atrCv);
  const rangeContraction = scoreRangeContraction(input.bbWidthPercentile);
  const volumeStability = scoreVolumeStability(
    input.volumeMA5, input.volumeMA25, input.volumeCv,
  );

  return {
    total: atrStability + rangeContraction + volumeStability,
    atrStability,
    rangeContraction,
    volumeStability,
  };
}
```

- [ ] **Step 4: テスト実行 → PASS確認**

Run: `npx vitest run src/core/__tests__/scoring/risk-quality.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/scoring/risk-quality.ts src/core/__tests__/scoring/risk-quality.test.ts
git commit -m "feat(scoring): リスク品質スコア（25点）を実装"
```

---

### Task 8: メインスコアラー（scoreStock）を実装

**Files:**
- Create: `src/core/scoring/index.ts`
- Test: `src/core/__tests__/scoring/index.test.ts`

- [ ] **Step 1: 統合テストを作成**

```typescript
// src/core/__tests__/scoring/index.test.ts
import { describe, it, expect } from "vitest";
import { scoreStock } from "../../scoring";
import type { OHLCVData, TechnicalSummary } from "../../technical-analysis";

function makeOHLCV(count: number, close = 100): OHLCVData[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-01-${String(count - i).padStart(2, "0")}`,
    open: close,
    high: close + 5,
    low: close - 5,
    close,
    volume: 100000,
  }));
}

function makeSummary(overrides: Partial<TechnicalSummary> = {}): TechnicalSummary {
  return {
    rsi: 55, sma5: 102, sma25: 98, sma75: 95,
    ema12: 100, ema26: 98,
    macd: { macd: 0.5, signal: 0.3, histogram: 0.2 },
    bollingerBands: { upper: 110, middle: 100, lower: 90 },
    atr14: 2,
    maAlignment: { trend: "uptrend", orderAligned: true, slopesAligned: true },
    deviationRate25: 1.5,
    signal: { signal: 1, strength: "buy", reasons: [] },
    supports: [], resistances: [],
    gap: { type: null, price: null, isFilled: false },
    trendlines: { support: null, resistance: null, overallTrend: "uptrend" },
    volumeAnalysis: { avgVolume20: 100000, currentVolume: 120000, volumeRatio: 1.2 },
    currentPrice: 100, previousClose: 99,
    ...overrides,
  };
}

describe("scoreStock", () => {
  it("totalScore は 0-100 の範囲", () => {
    const result = scoreStock({
      historicalData: makeOHLCV(100),
      latestPrice: 100,
      latestVolume: 100000,
      weeklyVolatility: 3,
      summary: makeSummary(),
      avgVolume25: 100000,
    });
    expect(result.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.totalScore).toBeLessThanOrEqual(100);
  });

  it("ゲート不合格 → totalScore=0, isDisqualified=true", () => {
    const result = scoreStock({
      historicalData: makeOHLCV(100),
      latestPrice: 5000, // 価格超過
      latestVolume: 100000,
      weeklyVolatility: 3,
      summary: makeSummary({ currentPrice: 5000 }),
      avgVolume25: 100000,
    });
    expect(result.totalScore).toBe(0);
    expect(result.isDisqualified).toBe(true);
    expect(result.gate.passed).toBe(false);
  });

  it("3カテゴリの合計が totalScore と一致", () => {
    const result = scoreStock({
      historicalData: makeOHLCV(100),
      latestPrice: 100,
      latestVolume: 100000,
      weeklyVolatility: 3,
      summary: makeSummary(),
      avgVolume25: 100000,
    });
    const expected = result.trendQuality.total + result.entryTiming.total + result.riskQuality.total;
    expect(result.totalScore).toBe(expected);
  });

  it("ランクが正しく割り当てられる", () => {
    const result = scoreStock({
      historicalData: makeOHLCV(100),
      latestPrice: 100,
      latestVolume: 100000,
      weeklyVolatility: 3,
      summary: makeSummary(),
      avgVolume25: 100000,
    });
    const rank = result.rank;
    if (result.totalScore >= 80) expect(rank).toBe("S");
    else if (result.totalScore >= 65) expect(rank).toBe("A");
    else if (result.totalScore >= 50) expect(rank).toBe("B");
    else if (result.totalScore >= 35) expect(rank).toBe("C");
    else expect(rank).toBe("D");
  });
});
```

- [ ] **Step 2: テスト実行 → FAIL確認**

- [ ] **Step 3: メインスコアラー実装**

`src/core/scoring/index.ts` — 各カテゴリモジュールを呼び出し、結果を集約する。
主な処理:
1. 入力からゲートチェック（checkGates）
2. 日足OHLCVから週足を合成してSMA13を計算
3. SMA25上の連続日数を計算（countDaysAboveSma25）
4. ATR14のCV, 出来高CV, BB幅パーセンタイルを計算
5. 各カテゴリのスコアリング関数を呼び出し
6. totalScore = trendQuality + entryTiming + riskQuality
7. getRank() でランク決定

- [ ] **Step 4: テスト実行 → PASS確認**

Run: `npx vitest run src/core/__tests__/scoring/index.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/scoring/index.ts src/core/__tests__/scoring/index.test.ts
git commit -m "feat(scoring): メインスコアラー scoreStock() を実装"
```

---

## Chunk 5: DB マイグレーション + 統合

### Task 9: Prisma スキーマを新3カテゴリに移行

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: ScoringRecord モデルのカラムを変更**

旧カラム（technicalScore, patternScore, liquidityScore, fundamentalScore）を新カラム（trendQualityScore, entryTimingScore, riskQualityScore）に変更。JSON breakdown カラムも同様に変更。

```prisma
model ScoringRecord {
  // ... existing fields ...

  // 新3カテゴリスコア
  trendQualityScore     Int           // 0-40
  entryTimingScore      Int           // 0-35
  riskQualityScore      Int           // 0-25

  // JSON Breakdowns（新構造）
  trendQualityBreakdown   Json        // {maAlignment, weeklyTrend, trendContinuity}
  entryTimingBreakdown    Json        // {pullbackDepth, breakout, candlestickSignal}
  riskQualityBreakdown    Json        // {atrStability, rangeContraction, volumeStability}

  // 旧カラムは削除
  // technicalScore, patternScore, liquidityScore, fundamentalScore
  // technicalBreakdown, patternBreakdown, liquidityBreakdown, fundamentalBreakdown
}
```

- [ ] **Step 2: マイグレーション作成**

Run: `npx prisma migrate dev --name scoring_redesign_3categories`

- [ ] **Step 3: Prisma Client 再生成**

Run: `npx prisma generate`

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(scoring): ScoringRecord を新3カテゴリ構造に移行"
```

---

### Task 10: バックテスト系を新スコアラーに切り替え

**Files:**
- Modify: `src/backtest/on-the-fly-scorer.ts`
- Modify: `src/backtest/simulation-engine.ts`

- [ ] **Step 1: on-the-fly-scorer.ts の ScoredRecord 型を新構造に更新**

ScoredRecord の4カテゴリフィールド（technicalScore, patternScore, liquidityScore, fundamentalScore）を新3カテゴリ（trendQualityScore, entryTimingScore, riskQualityScore）+ 対応する breakdown に変更。

- [ ] **Step 2: scoreDayForAllStocks() 内の scoreTechnicals() → scoreStock() に切り替え**

新スコアラーを import し置き換え。RS計算は廃止（新スコアリングには不要）。avgVolume25 を fund から取得して渡す。

- [ ] **Step 3: simulation-engine.ts の import を更新**

scoreTechnicals, calculateRsScores → scoreStock に変更。LogicScore → NewLogicScore。

- [ ] **Step 4: ビルド確認**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/backtest/on-the-fly-scorer.ts src/backtest/simulation-engine.ts
git commit -m "refactor(scoring): バックテスト系を新スコアラーに切り替え"
```

---

### Task 11: ジョブ系を新スコアラーに切り替え

**Files:**
- Modify: `src/jobs/market-scanner.ts`
- Modify: `src/jobs/order-manager.ts`
- Modify: `src/jobs/scoring-accuracy-report.ts`
- Modify: `src/jobs/ghost-review.ts`

- [ ] **Step 1: market-scanner.ts — scoreTechnicals() → scoreStock() に変更**

RS計算のプリパス（calculateRsScores）を削除。avgVolume25 を input に追加。ScoringRecord への DB保存を新カラム（trendQualityScore, entryTimingScore, riskQualityScore + breakdown JSON）に変更。

- [ ] **Step 2: order-manager.ts — LogicScore → NewLogicScore、EntrySnapshot構築を更新**

scoreTechnicals() → scoreStock()。EntrySnapshot.score の構造を新3カテゴリに変更。

- [ ] **Step 3: scoring-accuracy-report.ts — 4カテゴリ分析 → 3カテゴリ分析に変更**

SCORING.CATEGORY_MAX.TECHNICAL → SCORING.CATEGORY_MAX.TREND_QUALITY 等。カテゴリ弱点分析のフィールドを更新。

- [ ] **Step 3b: ghost-review.ts — 旧breakdown参照を新カラムに更新**

technicalBreakdown, patternBreakdown, liquidityBreakdown → trendQualityBreakdown, entryTimingBreakdown, riskQualityBreakdown。AIプロンプトに渡すスコア情報も新構造に。

- [ ] **Step 4: ビルド確認**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/jobs/market-scanner.ts src/jobs/order-manager.ts src/jobs/scoring-accuracy-report.ts src/jobs/ghost-review.ts
git commit -m "refactor(scoring): ジョブ系を新スコアラーに切り替え"
```

---

### Task 12: 型定義・Web層・その他を更新

**Files:**
- Modify: `src/core/technical-analysis.ts` — `formatScoreForAI()` を新構造に対応
- Modify: `src/core/entry-calculator.ts` — LogicScore → NewLogicScore
- Modify: `src/types/snapshots.ts` — EntrySnapshot.score を新3カテゴリに
- Modify: `src/web/routes/api.ts` — ScoringRecord の新カラムでselect
- Modify: `src/web/routes/scoring.ts` — 表示を新3カテゴリに
- Modify: `src/web/routes/contrarian.ts` — カテゴリ平均を3カテゴリに
- Modify: `src/web/views/stock-modal.ts` — スコアバーを3カテゴリに
- Modify: `scripts/backfill-scoring-records.ts` — 新ScoredRecordマッピング

- [ ] **Step 1: formatScoreForAI() を新3カテゴリ構造で出力するよう更新**

トレンド品質/エントリータイミング/リスク品質のスコアをAIプロンプトに含める。

- [ ] **Step 2: entry-calculator.ts の型参照を NewLogicScore に更新**

- [ ] **Step 3: snapshots.ts の EntrySnapshot.score を新構造に変更**

```typescript
score: {
  totalScore: number;
  rank: string;
  trendQuality: { total, maAlignment, weeklyTrend, trendContinuity };
  entryTiming: { total, pullbackDepth, breakout, candlestickSignal };
  riskQuality: { total, atrStability, rangeContraction, volumeStability };
}
```

- [ ] **Step 4: Web層（api.ts, scoring.ts, contrarian.ts, stock-modal.ts）を新カラム名に更新**

Prisma select を新カラム名に、表示ラベルを「トレンド」「タイミング」「リスク」に変更。

- [ ] **Step 5: backfill-scoring-records.ts を新ScoredRecordフィールドに更新**

- [ ] **Step 6: ビルド確認**

Run: `npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add src/core/technical-analysis.ts src/core/entry-calculator.ts src/types/snapshots.ts src/web/ scripts/backfill-scoring-records.ts
git commit -m "refactor(scoring): 型定義・Web層・スクリプトを新スコアリングに更新"
```

---

### Task 13: 旧ファイルの削除とクリーンアップ

**Files:**
- Delete: `src/core/technical-scorer.ts`
- Delete: `src/core/__tests__/technical-scorer.test.ts`
- Modify: `src/lib/constants/scoring.ts` — SCORING_V1 を削除

- [ ] **Step 1: 旧 technical-scorer.ts から SCORING_V1 への参照がないことを確認**

Run: `grep -r "SCORING_V1\|technical-scorer" src/ --include="*.ts" | grep -v node_modules`

- [ ] **Step 2: 旧ファイルを削除**

- [ ] **Step 3: SCORING_V1 を scoring.ts から削除**

- [ ] **Step 4: 全テスト実行**

Run: `npx vitest run`
Expected: 全テストPASS

- [ ] **Step 5: ビルド確認**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(scoring): 旧スコアラー(technical-scorer)を削除"
```

---

## Chunk 6: 仕様書・ドキュメント更新 + 検証

### Task 14: 仕様書を更新

**Files:**
- Modify: `docs/specs/scoring-system.md`

- [ ] **Step 1: scoring-system.md を新3カテゴリ+ゲート構造に全面更新**

設計書（`docs/superpowers/specs/2026-03-14-scoring-redesign-design.md`）の内容を反映する。

- [ ] **Step 2: 設計書を削除**

`docs/superpowers/specs/2026-03-14-scoring-redesign-design.md` は実装済みなので削除。

- [ ] **Step 3: Commit**

```bash
git add docs/specs/scoring-system.md
git rm docs/superpowers/specs/2026-03-14-scoring-redesign-design.md
git commit -m "docs: スコアリング仕様書を新3カテゴリ構造に更新"
```

---

### Task 15: バックテストで新旧比較

- [ ] **Step 1: on-the-fly バックテストを実行**

Run: `npx tsx src/jobs/daily-backtest.ts`

500銘柄×12ヶ月で新スコアリングの PF, 勝率, トレード数を確認。

- [ ] **Step 2: 結果を確認**

成功基準:
- PF >= 1.2（現行1.07から改善）
- 勝率 35%以上
- 200トレード以上

結果が基準を満たさない場合は、閾値やパラメータのチューニングを検討。
