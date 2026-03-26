# Breakout Score Filter Verification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scoring filter to the breakout backtest and compare performance across multiple thresholds/categories to determine if scoring improves expected value.

**Architecture:** A single new file `src/backtest/scoring-filter.ts` implements a 100-point scoring engine (3 categories: trend quality, entry timing, risk quality) computed entirely from OHLCV data. The breakout simulation accepts an optional score filter config. The CLI entry point adds a `--score-compare` mode that runs 14 simulations with different filter thresholds and prints a comparison table.

**Tech Stack:** TypeScript, `technicalindicators` package (ATR), existing helpers (`aggregateDailyToWeekly`, `calculateSMA`, `calculateBBWidthPercentile`)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/backtest/scoring-filter.ts` | Create | 100-point scoring engine (all 9 sub-scores + intermediates computation) |
| `src/backtest/types.ts` | Modify | Add `ScoreFilterConfig` and `ScoreFilterResult` types |
| `src/backtest/breakout-simulation.ts` | Modify | Accept optional score filter, call scoring in `detectBreakoutEntries()` |
| `src/backtest/breakout-run.ts` | Modify | Add `--score-compare` CLI option, run 14 simulations, print comparison table |

---

### Task 1: Add Score Filter Types

**Files:**
- Modify: `src/backtest/types.ts`

- [ ] **Step 1: Add ScoreFilterResult and ScoreFilterConfig to types.ts**

Add these types at the end of `src/backtest/types.ts` (after the `RankMetrics` interface around line 152):

```typescript
/** スコアフィルター結果 */
export interface ScoreFilterResult {
  total: number; // 0-100
  trend: number; // 0-40
  timing: number; // 0-35
  risk: number; // 0-25
}

/** スコアフィルター設定（バックテスト用） */
export interface ScoreFilterConfig {
  /** フィルター対象カテゴリ */
  category: "total" | "trend" | "timing" | "risk";
  /** 最低スコア閾値 */
  minScore: number;
}
```

- [ ] **Step 2: Add scoreFilter to BreakoutBacktestConfig**

In `BreakoutBacktestConfig` interface, add an optional field at the end (before the closing `}`):

```typescript
  /** スコアフィルター設定（省略時はフィルターなし） */
  scoreFilter?: ScoreFilterConfig;
```

- [ ] **Step 3: Commit**

```bash
git add src/backtest/types.ts
git commit -m "feat: スコアフィルター型定義を追加"
```

---

### Task 2: Implement Scoring Filter Module — Risk Quality

**Files:**
- Create: `src/backtest/scoring-filter.ts`

Risk Quality は外部依存が少なく、最もシンプル。ここから始めて基盤を構築する。

- [ ] **Step 1: Write the failing test**

Create `src/backtest/__tests__/scoring-filter.test.ts`:

```typescript
import type { OHLCVData } from "../../core/technical-analysis";
import {
  scoreAtrStability,
  scoreRangeContraction,
  scoreVolumeStability,
  calculateAtrCv,
  calculateVolumeCv,
} from "../scoring-filter";

describe("Risk Quality sub-scores", () => {
  describe("scoreAtrStability", () => {
    it("returns 10 for excellent stability (CV < 0.15)", () => {
      expect(scoreAtrStability(0.10)).toBe(10);
    });
    it("returns 7 for good stability (CV < 0.25)", () => {
      expect(scoreAtrStability(0.20)).toBe(7);
    });
    it("returns 4 for fair stability (CV < 0.35)", () => {
      expect(scoreAtrStability(0.30)).toBe(4);
    });
    it("returns 0 for poor stability (CV >= 0.35)", () => {
      expect(scoreAtrStability(0.50)).toBe(0);
    });
    it("returns 0 for null", () => {
      expect(scoreAtrStability(null)).toBe(0);
    });
  });

  describe("scoreRangeContraction", () => {
    it("returns 8 for strong squeeze (< 20th percentile)", () => {
      expect(scoreRangeContraction(15)).toBe(8);
    });
    it("returns 5 for moderate squeeze (< 40th)", () => {
      expect(scoreRangeContraction(30)).toBe(5);
    });
    it("returns 3 for mild squeeze (< 60th)", () => {
      expect(scoreRangeContraction(50)).toBe(3);
    });
    it("returns 0 for no squeeze (>= 60th)", () => {
      expect(scoreRangeContraction(70)).toBe(0);
    });
    it("returns 0 for null", () => {
      expect(scoreRangeContraction(null)).toBe(0);
    });
  });

  describe("scoreVolumeStability", () => {
    it("returns 7 for increasing + stable (CV < 0.5)", () => {
      expect(scoreVolumeStability(1200, 1000, 0.3)).toBe(7);
    });
    it("returns 5 for increasing + moderate (CV < 0.8)", () => {
      expect(scoreVolumeStability(1200, 1000, 0.6)).toBe(5);
    });
    it("returns 3 for not increasing + stable (CV < 0.5)", () => {
      expect(scoreVolumeStability(900, 1000, 0.3)).toBe(3);
    });
    it("returns 1 for not increasing + moderate (CV < 0.8)", () => {
      expect(scoreVolumeStability(900, 1000, 0.6)).toBe(1);
    });
    it("returns 0 for unstable (CV >= 0.8)", () => {
      expect(scoreVolumeStability(1200, 1000, 0.9)).toBe(0);
    });
    it("returns 0 for null inputs", () => {
      expect(scoreVolumeStability(null, null, null)).toBe(0);
    });
  });

  describe("calculateAtrCv", () => {
    it("returns null if fewer than 20 values", () => {
      expect(calculateAtrCv(Array(19).fill(100))).toBeNull();
    });
    it("returns 0 for constant ATR values", () => {
      expect(calculateAtrCv(Array(20).fill(100))).toBe(0);
    });
    it("returns a positive number for varying ATR values", () => {
      const values = Array.from({ length: 20 }, (_, i) => 100 + i * 5);
      const result = calculateAtrCv(values);
      expect(result).not.toBeNull();
      expect(result!).toBeGreaterThan(0);
    });
  });

  describe("calculateVolumeCv", () => {
    it("returns null if fewer than 25 values", () => {
      expect(calculateVolumeCv(Array(24).fill(1000))).toBeNull();
    });
    it("returns 0 for constant volumes", () => {
      expect(calculateVolumeCv(Array(25).fill(1000))).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/backtest/__tests__/scoring-filter.test.ts --no-coverage`
Expected: FAIL — cannot find module `../scoring-filter`

- [ ] **Step 3: Implement Risk Quality functions**

Create `src/backtest/scoring-filter.ts`:

```typescript
/**
 * Backtest-only scoring filter for breakout strategy verification.
 * Computes a 100-point score from OHLCV data to filter breakout entries.
 *
 * Categories:
 *   Trend Quality (40) + Entry Timing (35) + Risk Quality (25) = 100
 */

import type { OHLCVData } from "../core/technical-analysis";
import type { ScoreFilterResult } from "./types";

// ============================================================
// Constants
// ============================================================

// Risk Quality thresholds
const ATR_CV_EXCELLENT = 0.15;
const ATR_CV_GOOD = 0.25;
const ATR_CV_FAIR = 0.35;
const BB_SQUEEZE_STRONG = 20;
const BB_SQUEEZE_MODERATE = 40;
const VOLUME_CV_STABLE = 0.5;
const VOLUME_CV_MODERATE = 0.8;
const VOLUME_CV_PERIOD = 25;
const ATR_CV_WINDOW = 20;

// ============================================================
// Risk Quality (max 25)
// ============================================================

/** ATR安定性スコア (0-10) */
export function scoreAtrStability(atrCv: number | null): number {
  if (atrCv == null) return 0;
  if (atrCv < ATR_CV_EXCELLENT) return 10;
  if (atrCv < ATR_CV_GOOD) return 7;
  if (atrCv < ATR_CV_FAIR) return 4;
  return 0;
}

/** レンジ収縮スコア (0-8) */
export function scoreRangeContraction(bbWidthPercentile: number | null): number {
  if (bbWidthPercentile == null) return 0;
  if (bbWidthPercentile < BB_SQUEEZE_STRONG) return 8;
  if (bbWidthPercentile < BB_SQUEEZE_MODERATE) return 5;
  if (bbWidthPercentile < 60) return 3;
  return 0;
}

/** 出来高安定性スコア (0-7) */
export function scoreVolumeStability(
  volumeMA5: number | null,
  volumeMA25: number | null,
  volumeCv: number | null,
): number {
  if (volumeMA5 == null || volumeMA25 == null || volumeCv == null) return 0;
  const isIncreasing = volumeMA5 > volumeMA25;
  if (isIncreasing && volumeCv < VOLUME_CV_STABLE) return 7;
  if (isIncreasing && volumeCv < VOLUME_CV_MODERATE) return 5;
  if (volumeCv < VOLUME_CV_STABLE) return 3;
  if (volumeCv < VOLUME_CV_MODERATE) return 1;
  return 0;
}

/** ATR14のCV（変動係数）を計算 */
export function calculateAtrCv(atr14Values: number[]): number | null {
  if (atr14Values.length < ATR_CV_WINDOW) return null;
  const window = atr14Values.slice(0, ATR_CV_WINDOW);
  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  if (mean === 0) return 0;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
  return Math.sqrt(variance) / mean;
}

/** 出来高のCV（変動係数）を計算 */
export function calculateVolumeCv(volumes: number[]): number | null {
  if (volumes.length < VOLUME_CV_PERIOD) return null;
  const window = volumes.slice(0, VOLUME_CV_PERIOD);
  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  if (mean === 0) return 0;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
  return Math.sqrt(variance) / mean;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/backtest/__tests__/scoring-filter.test.ts --no-coverage`
Expected: All 14 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/backtest/scoring-filter.ts src/backtest/__tests__/scoring-filter.test.ts
git commit -m "feat: スコアフィルター Risk Quality サブスコアを実装"
```

---

### Task 3: Implement Scoring Filter — Trend Quality

**Files:**
- Modify: `src/backtest/scoring-filter.ts`
- Modify: `src/backtest/__tests__/scoring-filter.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/backtest/__tests__/scoring-filter.test.ts`:

```typescript
import {
  // ... existing imports ...
  scoreMaAlignment,
  scoreWeeklyTrend,
  scoreTrendContinuity,
  countDaysAboveSma25,
} from "../scoring-filter";

describe("Trend Quality sub-scores", () => {
  describe("scoreMaAlignment", () => {
    it("returns 18 for perfect order (close > SMA5 > SMA25 > SMA75)", () => {
      expect(scoreMaAlignment(400, 380, 350, 300)).toBe(18);
    });
    it("returns 14 for close > SMA5 > SMA25 (no SMA75)", () => {
      expect(scoreMaAlignment(400, 380, 350, null)).toBe(14);
    });
    it("returns 14 for close > SMA5 > SMA25 (SMA75 present but broken)", () => {
      expect(scoreMaAlignment(400, 380, 350, 360)).toBe(14);
    });
    it("returns 8 for close > SMA25 but below SMA5", () => {
      expect(scoreMaAlignment(360, 380, 350, 300)).toBe(8);
    });
    it("returns 4 for pullback in uptrend (close < SMA25, close > SMA75, SMA25 > SMA75)", () => {
      expect(scoreMaAlignment(310, 360, 350, 300)).toBe(4);
    });
    it("returns 2 for close > SMA75 only (alignment broken)", () => {
      expect(scoreMaAlignment(310, 360, 350, 305)).toBe(2);
    });
    it("returns 0 for close below all MAs", () => {
      expect(scoreMaAlignment(200, 380, 350, 300)).toBe(0);
    });
    it("returns 0 if SMA25 is null", () => {
      expect(scoreMaAlignment(400, 380, null, null)).toBe(0);
    });
  });

  describe("scoreWeeklyTrend", () => {
    it("returns 12 for above SMA13 + rising", () => {
      expect(scoreWeeklyTrend(1100, 1000, 990)).toBe(12);
    });
    it("returns 8 for above SMA13 + flat", () => {
      expect(scoreWeeklyTrend(1010, 1000, 999)).toBe(8);
    });
    it("returns 4 for below SMA13 + rising", () => {
      expect(scoreWeeklyTrend(990, 1000, 990)).toBe(4);
    });
    it("returns 0 for below SMA13 + falling", () => {
      expect(scoreWeeklyTrend(990, 1000, 1020)).toBe(0);
    });
    it("returns 0 if SMA13 is null", () => {
      expect(scoreWeeklyTrend(1000, null, null)).toBe(0);
    });
  });

  describe("scoreTrendContinuity", () => {
    it("returns 10 for sweet spot (10-30 days)", () => {
      expect(scoreTrendContinuity(15)).toBe(10);
      expect(scoreTrendContinuity(30)).toBe(10);
    });
    it("returns 7 for early trend (< 10 days)", () => {
      expect(scoreTrendContinuity(5)).toBe(7);
    });
    it("returns 5 for mature trend (31-50 days)", () => {
      expect(scoreTrendContinuity(40)).toBe(5);
    });
    it("returns 2 for over-mature trend (> 50 days)", () => {
      expect(scoreTrendContinuity(60)).toBe(2);
    });
    it("returns 0 for zero days", () => {
      expect(scoreTrendContinuity(0)).toBe(0);
    });
  });

  describe("countDaysAboveSma25", () => {
    it("returns 0 if data is too short", () => {
      const data: OHLCVData[] = Array.from({ length: 24 }, (_, i) => ({
        date: `2025-01-${String(i + 1).padStart(2, "0")}`,
        open: 100, high: 105, low: 95, close: 100, volume: 1000,
      }));
      expect(countDaysAboveSma25(data)).toBe(0);
    });
    it("counts consecutive days above SMA25 from newest", () => {
      // 25 bars at close=100, then 5 bars at close=200 (newest-first)
      const highBars: OHLCVData[] = Array.from({ length: 5 }, (_, i) => ({
        date: `2025-02-${String(5 - i).padStart(2, "0")}`,
        open: 200, high: 210, low: 190, close: 200, volume: 1000,
      }));
      const lowBars: OHLCVData[] = Array.from({ length: 25 }, (_, i) => ({
        date: `2025-01-${String(25 - i).padStart(2, "0")}`,
        open: 100, high: 105, low: 95, close: 100, volume: 1000,
      }));
      const data = [...highBars, ...lowBars]; // newest-first
      const result = countDaysAboveSma25(data);
      expect(result).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/backtest/__tests__/scoring-filter.test.ts --no-coverage`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement Trend Quality functions**

Add to `src/backtest/scoring-filter.ts` (after the constants section, before the Risk Quality section):

```typescript
// Trend Quality thresholds
const CONTINUITY_SWEET_MIN = 10;
const CONTINUITY_SWEET_MAX = 30;
const CONTINUITY_MATURE_MAX = 50;
const WEEKLY_SMA13_FLAT_THRESHOLD = 0.5;

// ============================================================
// Trend Quality (max 40)
// ============================================================

/** MA整列スコア (0-18) */
export function scoreMaAlignment(
  close: number,
  sma5: number | null,
  sma25: number | null,
  sma75: number | null,
): number {
  if (sma25 == null || sma5 == null) return 0;

  if (sma75 == null) {
    if (close > sma5 && sma5 > sma25) return 14;
    if (close > sma25 && close < sma5) return 8;
    if (close > sma25) return 4;
    return 0;
  }

  if (close < sma25) {
    if (close > sma75 && sma25 > sma75) return 4;
    if (close > sma75) return 2;
    return 0;
  }

  if (close > sma5 && sma5 > sma25 && sma25 > sma75) return 18;
  if (close > sma5 && sma5 > sma25) return 14;
  if (close > sma25 && close < sma5) return 8;
  return 4;
}

/** 週足トレンドスコア (0-12) */
export function scoreWeeklyTrend(
  weeklyClose: number | null,
  weeklySma13: number | null,
  prevWeeklySma13: number | null,
): number {
  if (weeklySma13 == null || prevWeeklySma13 == null) return 0;
  const changeRate = ((weeklySma13 - prevWeeklySma13) / prevWeeklySma13) * 100;
  const isRising = changeRate > WEEKLY_SMA13_FLAT_THRESHOLD;
  const aboveSma = weeklyClose != null && weeklyClose > weeklySma13;
  if (aboveSma && isRising) return 12;
  if (aboveSma) return 8;
  if (isRising) return 4;
  return 0;
}

/** トレンド継続性スコア (0-10) */
export function scoreTrendContinuity(daysAboveSma25: number): number {
  if (daysAboveSma25 <= 0) return 0;
  if (daysAboveSma25 >= CONTINUITY_SWEET_MIN && daysAboveSma25 <= CONTINUITY_SWEET_MAX) return 10;
  if (daysAboveSma25 < CONTINUITY_SWEET_MIN) return 7;
  if (daysAboveSma25 <= CONTINUITY_MATURE_MAX) return 5;
  return 2;
}

/** SMA25上の連続日数をカウント（newest-first配列） */
export function countDaysAboveSma25(data: OHLCVData[]): number {
  if (data.length < 25) return 0;
  let count = 0;
  for (let i = 0; i < data.length - 24; i++) {
    const closes = data.slice(i, i + 25).map((d) => d.close);
    const sma25 = closes.reduce((s, v) => s + v, 0) / 25;
    if (data[i].close > sma25) {
      count++;
    } else {
      break;
    }
  }
  return count;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/backtest/__tests__/scoring-filter.test.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/backtest/scoring-filter.ts src/backtest/__tests__/scoring-filter.test.ts
git commit -m "feat: スコアフィルター Trend Quality サブスコアを実装"
```

---

### Task 4: Implement Scoring Filter — Entry Timing

**Files:**
- Modify: `src/backtest/scoring-filter.ts`
- Modify: `src/backtest/__tests__/scoring-filter.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/backtest/__tests__/scoring-filter.test.ts`:

```typescript
import {
  // ... existing imports ...
  scorePullbackDepth,
  scorePriorBreakout,
  scoreCandlestickSignal,
} from "../scoring-filter";

function makeBar(overrides: Partial<OHLCVData> = {}): OHLCVData {
  return { date: "2025-06-01", open: 100, high: 105, low: 95, close: 102, volume: 50000, ...overrides };
}

describe("Entry Timing sub-scores", () => {
  describe("scorePullbackDepth", () => {
    it("returns 0 if SMA25 is null", () => {
      expect(scorePullbackDepth(100, 110, null, null, [])).toBe(0);
    });
    it("returns 0 for deep pullback (deviation < -3%)", () => {
      expect(scorePullbackDepth(95, 110, 100, -5, [makeBar()])).toBe(0);
    });
    it("returns 15 for near SMA25 with reversal sign", () => {
      // reversal: yesterday bearish, today bullish
      const bars = [
        makeBar({ open: 99, close: 101, high: 102, low: 98 }),   // today: bullish
        makeBar({ open: 101, close: 99, high: 102, low: 98 }),   // yesterday: bearish
      ];
      expect(scorePullbackDepth(101, 110, 100, 1.0, bars)).toBe(15);
    });
    it("returns 10 for near SMA25 without reversal", () => {
      const bars = [
        makeBar({ open: 100, close: 101, high: 102, low: 100 }),
        makeBar({ open: 100, close: 101, high: 102, low: 100 }),
      ];
      expect(scorePullbackDepth(101, 110, 100, 1.0, bars)).toBe(10);
    });
    it("returns 6 for moderate deviation (2-5%)", () => {
      expect(scorePullbackDepth(103, 110, 100, 3.0, [makeBar()])).toBe(6);
    });
    it("returns 4 for close >= SMA5", () => {
      expect(scorePullbackDepth(115, 110, 100, 6.0, [makeBar()])).toBe(4);
    });
  });

  describe("scorePriorBreakout", () => {
    it("returns 0 if pullbackScore is 0", () => {
      const bars = Array.from({ length: 25 }, (_, i) =>
        makeBar({ close: 100 + i, volume: 100000 }),
      );
      expect(scorePriorBreakout(bars, 50000, 0)).toBe(0);
    });
    it("returns 12 for 20-day high within 7 days + high volume", () => {
      // bar[3] = 20-day high with 2x volume
      const bars = Array.from({ length: 25 }, (_, i) =>
        makeBar({ close: 100, volume: 50000 }),
      );
      bars[3] = makeBar({ close: 150, volume: 100000 });
      expect(scorePriorBreakout(bars, 50000, 10)).toBe(12);
    });
    it("returns 0 for no recent breakout", () => {
      const bars = Array.from({ length: 25 }, () =>
        makeBar({ close: 100, volume: 50000 }),
      );
      expect(scorePriorBreakout(bars, 50000, 10)).toBe(0);
    });
  });

  describe("scoreCandlestickSignal", () => {
    it("returns 8 for bullish engulfing with volume", () => {
      const bars = [
        makeBar({ open: 98, close: 105, high: 106, low: 97, volume: 60000 }),  // today: bullish engulfing
        makeBar({ open: 104, close: 99, high: 105, low: 98, volume: 50000 }),   // yesterday: bearish
      ];
      expect(scoreCandlestickSignal(bars, 50000)).toBe(8);
    });
    it("returns 6 for hammer pattern", () => {
      // hammer: small body near top, long lower shadow
      const bars = [
        makeBar({ open: 100, close: 101, high: 102, low: 90, volume: 50000 }),
        makeBar({ close: 100, volume: 50000 }),
      ];
      expect(scoreCandlestickSignal(bars, 50000)).toBe(6);
    });
    it("returns 0 for no pattern", () => {
      const bars = [
        makeBar({ open: 100, close: 100.5, high: 101, low: 99.5, volume: 50000 }),
        makeBar({ open: 100, close: 100.5, high: 101, low: 99.5, volume: 50000 }),
      ];
      expect(scoreCandlestickSignal(bars, 50000)).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/backtest/__tests__/scoring-filter.test.ts --no-coverage`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement Entry Timing functions**

Add to `src/backtest/scoring-filter.ts` (after Trend Quality section, before Risk Quality section):

```typescript
// Entry Timing thresholds
const PULLBACK_NEAR_MIN = -1;
const PULLBACK_NEAR_MAX = 2;
const PULLBACK_DEEP_THRESHOLD = -3;
const PRIOR_BREAKOUT_VOLUME_RATIO = 1.5;
const PRIOR_BREAKOUT_LOOKBACK_20 = 20;
const PRIOR_BREAKOUT_RECENCY_20 = 7;
const PRIOR_BREAKOUT_LOOKBACK_10 = 10;
const PRIOR_BREAKOUT_RECENCY_10 = 5;
const PRIOR_BREAKOUT_NEAR_HIGH_PCT = 0.95;

// ============================================================
// Entry Timing (max 35)
// ============================================================

/** リバーサルサインの判定 */
function hasReversalSign(bars: OHLCVData[]): boolean {
  if (bars.length < 2) return false;
  const [today, yesterday] = bars;
  // 下ヒゲが実体以上
  for (const bar of [today, yesterday]) {
    const lowerShadow = Math.min(bar.open, bar.close) - bar.low;
    const realBody = Math.abs(bar.close - bar.open);
    if (lowerShadow >= realBody && realBody > 0) return true;
  }
  // 陰線→陽線の転換
  if (yesterday.close < yesterday.open && today.close > today.open) return true;
  return false;
}

/** プルバック深度スコア (0-15) */
export function scorePullbackDepth(
  close: number,
  sma5: number | null,
  sma25: number | null,
  deviationRate25: number | null,
  recentBars: OHLCVData[],
): number {
  if (sma25 == null || deviationRate25 == null) return 0;
  if (deviationRate25 < PULLBACK_DEEP_THRESHOLD) return 0;

  const nearSma = deviationRate25 >= PULLBACK_NEAR_MIN && deviationRate25 <= PULLBACK_NEAR_MAX;
  if (nearSma && hasReversalSign(recentBars)) return 15;
  if (nearSma) return 10;
  if (sma5 != null && close < sma5 && close > sma25 && deviationRate25 > PULLBACK_NEAR_MAX) return 10;

  // SMA25を一時的に割って回復
  if (close > sma25 && recentBars.length >= 4) {
    for (let i = 1; i <= Math.min(3, recentBars.length - 1); i++) {
      if (recentBars[i].close < sma25) return 8;
    }
  }

  if (deviationRate25 > PULLBACK_NEAR_MAX && deviationRate25 <= 5) return 6;
  if (sma5 != null && close >= sma5) return 4;
  return 0;
}

/** 直近ブレイクアウトスコア (0-12) */
export function scorePriorBreakout(
  bars: OHLCVData[],
  avgVolume25: number | null,
  pullbackScore: number,
): number {
  if (pullbackScore === 0 || bars.length < 2) return 0;
  const currentClose = bars[0].close;

  // 20日チェック
  const lookback20 = bars.slice(0, PRIOR_BREAKOUT_LOOKBACK_20 + 1);
  if (lookback20.length > 1) {
    let maxClose = -Infinity;
    let maxIdx = 0;
    for (let i = 0; i < lookback20.length; i++) {
      if (lookback20[i].close > maxClose) {
        maxClose = lookback20[i].close;
        maxIdx = i;
      }
    }
    if (maxIdx >= 1 && maxIdx <= PRIOR_BREAKOUT_RECENCY_20) {
      const breakoutBar = lookback20[maxIdx];
      const volumeRatio = avgVolume25 && avgVolume25 > 0
        ? breakoutBar.volume / avgVolume25
        : 1;
      if (volumeRatio > PRIOR_BREAKOUT_VOLUME_RATIO) return 12;
      if (volumeRatio > 1.2) return 9;
      return 7;
    }
  }

  // 10日チェック
  const lookback10 = bars.slice(0, PRIOR_BREAKOUT_LOOKBACK_10 + 1);
  if (lookback10.length > 1) {
    let maxClose = -Infinity;
    let maxIdx = 0;
    for (let i = 0; i < lookback10.length; i++) {
      if (lookback10[i].close > maxClose) {
        maxClose = lookback10[i].close;
        maxIdx = i;
      }
    }
    if (maxIdx >= 1 && maxIdx <= PRIOR_BREAKOUT_RECENCY_10) return 5;
    if (currentClose >= maxClose * PRIOR_BREAKOUT_NEAR_HIGH_PCT) return 2;
  }

  return 0;
}

/** ローソク足シグナルスコア (0-8) */
export function scoreCandlestickSignal(
  bars: OHLCVData[],
  avgVolume25: number | null,
): number {
  if (bars.length < 2) return 0;
  const [today, yesterday] = bars;
  let maxScore = 0;

  const volumeRatio = avgVolume25 && avgVolume25 > 0
    ? today.volume / avgVolume25
    : 0;

  // Bullish engulfing + volume
  const todayBullish = today.close > today.open;
  const yesterdayBearish = yesterday.close < yesterday.open;
  if (
    todayBullish && yesterdayBearish &&
    today.close > yesterday.open &&
    today.open < yesterday.close &&
    volumeRatio > 1.0
  ) {
    maxScore = Math.max(maxScore, 8);
  }

  // Hammer
  const realBody = Math.abs(today.close - today.open);
  const totalRange = today.high - today.low;
  const lowerShadow = Math.min(today.open, today.close) - today.low;
  const upperShadow = today.high - Math.max(today.open, today.close);
  if (totalRange > 0 && realBody > 0 && lowerShadow > realBody * 2 && upperShadow <= lowerShadow / 3) {
    maxScore = Math.max(maxScore, 6);
  }

  // 3 consecutive bullish + increasing volume
  if (bars.length >= 3) {
    const [b0, b1, b2] = bars;
    if (
      b0.close > b0.open && b1.close > b1.open && b2.close > b2.open &&
      b0.volume > b1.volume && b1.volume > b2.volume
    ) {
      maxScore = Math.max(maxScore, 5);
    }
  }

  // Strong bullish bar
  if (totalRange > 0) {
    const closeToHigh = (today.high - today.close) / totalRange;
    const bodyRatio = realBody / totalRange;
    if (closeToHigh < 0.15 && bodyRatio > 0.6) {
      maxScore = Math.max(maxScore, 4);
    }
  }

  // Doji
  if (totalRange > 0 && realBody / totalRange < 0.1) {
    maxScore = Math.max(maxScore, 3);
  }

  return maxScore;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/backtest/__tests__/scoring-filter.test.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/backtest/scoring-filter.ts src/backtest/__tests__/scoring-filter.test.ts
git commit -m "feat: スコアフィルター Entry Timing サブスコアを実装"
```

---

### Task 5: Implement Scoring Filter — Intermediates & Main Entry Point

**Files:**
- Modify: `src/backtest/scoring-filter.ts`
- Modify: `src/backtest/__tests__/scoring-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/backtest/__tests__/scoring-filter.test.ts`:

```typescript
import {
  // ... existing imports ...
  computeScoreFilter,
} from "../scoring-filter";

describe("computeScoreFilter", () => {
  // 100バー分のモックデータ（oldest-firstで作成してnewest-firstに反転）
  function makeTestBars(count: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
      const price = 500 + i * 2; // 緩やかな上昇トレンド
      bars.push({
        date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
        open: price - 3,
        high: price + 5,
        low: price - 5,
        close: price,
        volume: 100000 + i * 100,
      });
    }
    return bars.reverse(); // newest-first
  }

  it("returns a valid ScoreFilterResult with total, trend, timing, risk", () => {
    const bars = makeTestBars(120);
    const result = computeScoreFilter(bars);
    expect(result).toHaveProperty("total");
    expect(result).toHaveProperty("trend");
    expect(result).toHaveProperty("timing");
    expect(result).toHaveProperty("risk");
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(100);
    expect(result.total).toBe(result.trend + result.timing + result.risk);
  });

  it("returns zeros for insufficient data", () => {
    const bars = makeTestBars(10);
    const result = computeScoreFilter(bars);
    expect(result.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/backtest/__tests__/scoring-filter.test.ts --no-coverage`
Expected: FAIL — `computeScoreFilter` not exported

- [ ] **Step 3: Implement intermediates computation and main entry point**

Add to `src/backtest/scoring-filter.ts`:

```typescript
import { ATR } from "technicalindicators";
import { calculateSMA, aggregateDailyToWeekly } from "../lib/technical-indicators";
import { calculateBBWidthPercentile } from "../lib/technical-indicators/bb-width-history";

// ============================================================
// Intermediates Computation
// ============================================================

interface ScoringIntermediates {
  weeklyClose: number | null;
  weeklySma13: number | null;
  prevWeeklySma13: number | null;
  daysAboveSma25: number;
  atrCv: number | null;
  volumeCv: number | null;
  volumeMA5: number | null;
  volumeMA25: number | null;
  bbWidthPercentile: number | null;
  atr14: number | null;
  sma5: number | null;
  sma25: number | null;
  sma75: number | null;
  deviationRate25: number | null;
}

/** ATR14系列を計算（newest-first入力） */
function computeAtr14Series(data: OHLCVData[]): number[] {
  if (data.length < 34) return [];
  const oldestFirst = [...data].reverse();
  const result = ATR.calculate({
    high: oldestFirst.map((d) => d.high),
    low: oldestFirst.map((d) => d.low),
    close: oldestFirst.map((d) => d.close),
    period: 14,
  });
  return result.reverse(); // newest-first
}

/** 全中間指標を一括計算 */
function computeIntermediates(data: OHLCVData[]): ScoringIntermediates {
  const result: ScoringIntermediates = {
    weeklyClose: null, weeklySma13: null, prevWeeklySma13: null,
    daysAboveSma25: 0, atrCv: null, volumeCv: null,
    volumeMA5: null, volumeMA25: null, bbWidthPercentile: null,
    atr14: null, sma5: null, sma25: null, sma75: null, deviationRate25: null,
  };

  if (data.length < 25) return result;

  const closes = data.map((d) => d.close);
  const volumes = data.map((d) => d.volume);

  // SMAs
  const closePrices = data.map((d) => ({ close: d.close }));
  result.sma5 = calculateSMA(closePrices, 5);
  result.sma25 = calculateSMA(closePrices, 25);
  result.sma75 = data.length >= 75 ? calculateSMA(closePrices, 75) : null;

  // Deviation rate
  if (result.sma25 != null) {
    result.deviationRate25 = ((closes[0] - result.sma25) / result.sma25) * 100;
  }

  // ATR14
  const atr14Series = computeAtr14Series(data);
  if (atr14Series.length > 0) {
    result.atr14 = atr14Series[0];
    result.atrCv = calculateAtrCv(atr14Series);
  }

  // Volume MAs & CV
  const volumePrices = volumes.map((v) => ({ close: v }));
  result.volumeMA5 = calculateSMA(volumePrices, 5);
  result.volumeMA25 = calculateSMA(volumePrices, 25);
  result.volumeCv = calculateVolumeCv(volumes);

  // BB width percentile
  result.bbWidthPercentile = calculateBBWidthPercentile(closes, 20, 60);

  // Weekly trend
  const oldestFirst = [...data].reverse();
  const weeklyBars = aggregateDailyToWeekly(oldestFirst);
  if (weeklyBars.length >= 14) {
    const weeklyNewest = [...weeklyBars].reverse();
    result.weeklyClose = weeklyNewest[0].close;
    const weeklyCloses = weeklyNewest.map((w) => ({ close: w.close }));
    result.weeklySma13 = calculateSMA(weeklyCloses, 13);
    if (weeklyNewest.length >= 14) {
      const prevCloses = weeklyNewest.slice(1).map((w) => ({ close: w.close }));
      result.prevWeeklySma13 = calculateSMA(prevCloses, 13);
    }
  }

  // Days above SMA25
  result.daysAboveSma25 = countDaysAboveSma25(data);

  return result;
}

// ============================================================
// Main Entry Point
// ============================================================

/**
 * OHLCVデータからスコアを計算（newest-first配列を入力）
 * バックテスト専用。全指標をOHLCVから算出する。
 */
export function computeScoreFilter(data: OHLCVData[]): ScoreFilterResult {
  if (data.length < 25) {
    return { total: 0, trend: 0, timing: 0, risk: 0 };
  }

  const im = computeIntermediates(data);
  const close = data[0].close;
  const avgVolume25 = im.volumeMA25;

  // Trend Quality
  const maAlignment = scoreMaAlignment(close, im.sma5, im.sma25, im.sma75);
  const weeklyTrend = scoreWeeklyTrend(im.weeklyClose, im.weeklySma13, im.prevWeeklySma13);
  const trendContinuity = scoreTrendContinuity(im.daysAboveSma25);
  const trend = maAlignment + weeklyTrend + trendContinuity;

  // Entry Timing
  const pullback = scorePullbackDepth(close, im.sma5, im.sma25, im.deviationRate25, data);
  const priorBreakout = scorePriorBreakout(data, avgVolume25, pullback);
  const candlestick = scoreCandlestickSignal(data, avgVolume25);
  const timing = pullback + priorBreakout + candlestick;

  // Risk Quality
  const atrStab = scoreAtrStability(im.atrCv);
  const rangeContr = scoreRangeContraction(im.bbWidthPercentile);
  const volStab = scoreVolumeStability(im.volumeMA5, im.volumeMA25, im.volumeCv);
  const risk = atrStab + rangeContr + volStab;

  const total = Math.min(100, Math.max(0, trend + timing + risk));

  return { total, trend, timing, risk };
}
```

Update the imports at the top of the file to include the new dependencies:

```typescript
import { ATR } from "technicalindicators";
import type { OHLCVData } from "../core/technical-analysis";
import { calculateSMA, aggregateDailyToWeekly } from "../lib/technical-indicators";
import { calculateBBWidthPercentile } from "../lib/technical-indicators/bb-width-history";
import type { ScoreFilterResult } from "./types";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/backtest/__tests__/scoring-filter.test.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/backtest/scoring-filter.ts src/backtest/__tests__/scoring-filter.test.ts
git commit -m "feat: スコアフィルター中間指標計算とメインエントリポイントを実装"
```

---

### Task 6: Integrate Score Filter into Breakout Simulation

**Files:**
- Modify: `src/backtest/breakout-simulation.ts`

- [ ] **Step 1: Add scoring filter import and integration**

At the top of `breakout-simulation.ts`, add import:

```typescript
import { computeScoreFilter } from "./scoring-filter";
```

In `detectBreakoutEntries()`, after the `maxChaseAtr` filter check (around line 359) and before the entry is pushed, add the score filter check. Find the block where `entries.push(...)` is called and wrap it:

```typescript
    // --- Score filter (optional) ---
    if (config.scoreFilter) {
      const score = computeScoreFilter(newestFirst);
      const { category, minScore } = config.scoreFilter;
      const scoreValue =
        category === "total" ? score.total :
        category === "trend" ? score.trend :
        category === "timing" ? score.timing :
        score.risk;
      if (scoreValue < minScore) continue;
    }
```

Insert this block right before the `entries.push({...})` call inside the ticker loop. The `newestFirst` variable (the reversed window of bars) is already available at that point (used by `analyzeTechnicals`).

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `npx jest src/backtest/ --no-coverage`
Expected: All existing tests PASS (the filter is optional, defaults to undefined)

- [ ] **Step 3: Commit**

```bash
git add src/backtest/breakout-simulation.ts
git commit -m "feat: breakoutシミュレーションにスコアフィルターフックを追加"
```

---

### Task 7: Add `--score-compare` CLI Option and Comparison Report

**Files:**
- Modify: `src/backtest/breakout-run.ts`

- [ ] **Step 1: Add score-compare option parsing**

In `breakout-run.ts`, after the existing argument parsing section (around line 30):

```typescript
const scoreCompare = args.includes("--score-compare");
```

- [ ] **Step 2: Add comparison report logic**

Add a new function to `breakout-run.ts`:

```typescript
import type { ScoreFilterConfig } from "./types";

interface ComparisonRow {
  label: string;
  filter: ScoreFilterConfig | undefined;
}

const COMPARISON_GRID: ComparisonRow[] = [
  { label: "(none)", filter: undefined },
  { label: "total >= 40", filter: { category: "total", minScore: 40 } },
  { label: "total >= 50", filter: { category: "total", minScore: 50 } },
  { label: "total >= 60", filter: { category: "total", minScore: 60 } },
  { label: "total >= 70", filter: { category: "total", minScore: 70 } },
  { label: "trend >= 15", filter: { category: "trend", minScore: 15 } },
  { label: "trend >= 20", filter: { category: "trend", minScore: 20 } },
  { label: "trend >= 25", filter: { category: "trend", minScore: 25 } },
  { label: "timing >= 15", filter: { category: "timing", minScore: 15 } },
  { label: "timing >= 20", filter: { category: "timing", minScore: 20 } },
  { label: "timing >= 25", filter: { category: "timing", minScore: 25 } },
  { label: "risk >= 10", filter: { category: "risk", minScore: 10 } },
  { label: "risk >= 15", filter: { category: "risk", minScore: 15 } },
  { label: "risk >= 20", filter: { category: "risk", minScore: 20 } },
];

function runScoreComparison(
  baseConfig: BreakoutBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData: Map<string, number> | undefined,
): void {
  console.log("\n=== Score Filter Comparison ===");
  console.log(
    `${"Filter".padEnd(16)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"RR".padStart(5)}`,
  );
  console.log("-".repeat(68));

  for (const row of COMPARISON_GRID) {
    const config: BreakoutBacktestConfig = {
      ...baseConfig,
      scoreFilter: row.filter,
      verbose: false,
    };
    const result = runBreakoutBacktest(config, allData, vixData);
    const m = result.metrics;
    console.log(
      `${row.label.padEnd(16)}| ${String(m.totalTrades).padStart(6)} | ${(m.winRate * 100).toFixed(1).padStart(6)}% | ${m.profitFactor.toFixed(2).padStart(5)} | ${(m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%"}${"".padStart(Math.max(0, 8 - ((m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%").length))} | ${(m.maxDrawdown * 100).toFixed(1).padStart(6)}% | ${m.riskRewardRatio.toFixed(1).padStart(5)}`,
    );
  }
  console.log("");
}
```

Also add the import for `OHLCVData`:

```typescript
import type { OHLCVData } from "../core/technical-analysis";
```

- [ ] **Step 3: Wire score-compare into the main function**

In the main function of `breakout-run.ts`, after the data fetch and before the single-run simulation, add:

```typescript
  if (scoreCompare) {
    const vix = vixData.size > 0 ? vixData : undefined;
    runScoreComparison(config, allData, vix);
    await prisma.$disconnect();
    return;
  }
```

This should be placed after `allData` and `vixData` are fetched (around line 70) and before the existing `runBreakoutBacktest` call.

- [ ] **Step 4: Test manually**

Run: `npx tsx src/backtest/breakout-run.ts --score-compare`
Expected: A comparison table with 14 rows showing different filter thresholds and their metrics.

- [ ] **Step 5: Commit**

```bash
git add src/backtest/breakout-run.ts
git commit -m "feat: --score-compare オプションでスコアフィルター効果の比較表を出力"
```

---

### Task 8: Clean Up — Delete Design Doc

**Files:**
- Delete: `docs/superpowers/specs/2026-03-26-breakout-score-filter-design.md`
- Delete: `docs/superpowers/plans/2026-03-26-breakout-score-filter.md`

Per project coding standards ("実装された設計ファイルはコミット前に削除"):

- [ ] **Step 1: Delete design and plan files**

```bash
rm docs/superpowers/specs/2026-03-26-breakout-score-filter-design.md
rm docs/superpowers/plans/2026-03-26-breakout-score-filter.md
```

- [ ] **Step 2: Commit**

```bash
git add -A docs/superpowers/
git commit -m "chore: 実装済みの設計・計画ファイルを削除"
```
