# セクターモメンタムスコアリング統合 実装計画

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** セクター相対強度（対日経225）を5点のスコアカテゴリとして既存100点スコアリングに統合し、弱セクター除外フィルタを廃止する。

**Architecture:** リスク品質カテゴリを25→20点に圧縮（ボリューム安定性7→2）し、新たにセクターモメンタム5点を追加。`scoreSectorMomentum()` 純粋関数で変換テーブルによりスコア化。market-scannerのStage 5フィルタを削除し、バックテストにも日経225データを渡して対応。

**Tech Stack:** TypeScript, Prisma, Vitest

**Spec:** `docs/superpowers/specs/2026-03-16-sector-momentum-scoring-design.md`

---

## Chunk 1: コアスコアリングロジック変更

### Task 1: 定数更新（scoring.ts）

**Files:**
- Modify: `src/lib/constants/scoring.ts`

- [ ] **Step 1: リスク品質カテゴリ最大を25→20に変更**

```typescript
// src/lib/constants/scoring.ts:13-17
CATEGORY_MAX: {
  TREND_QUALITY: 40,
  ENTRY_TIMING: 35,
  RISK_QUALITY: 20, // 25 → 20
},
```

- [ ] **Step 2: ボリューム安定性のサブ最大を7→2に変更**

```typescript
// src/lib/constants/scoring.ts:29-32
// リスク品質 (20)
ATR_STABILITY: 10,
RANGE_CONTRACTION: 8,
VOLUME_STABILITY: 2, // 7 → 2
```

- [ ] **Step 3: ファイル先頭のコメントを更新**

```typescript
// src/lib/constants/scoring.ts:1-8
/**
 * スコアリング・損切り検証の定数
 *
 * 4カテゴリ100点満点:
 * - トレンド品質: 40点
 * - エントリータイミング: 35点
 * - リスク品質: 20点
 * - セクターモメンタム: 5点
 */
```

- [ ] **Step 4: セクターモメンタムスコアリング定数を追加**

`SCORING` の直後（`as const` の前、もしくは別の定数として）に追加:

```typescript
// src/lib/constants/scoring.ts — SCORING の閉じカッコの後に追加

export const SECTOR_MOMENTUM_SCORING = {
  CATEGORY_MAX: 5,
  TIERS: [
    { min: 3.0, score: 5 },
    { min: 1.5, score: 4 },
    { min: 0.5, score: 3 },
    { min: -0.5, score: 2 },
    { min: -2.0, score: 1 },
  ],
  DEFAULT_SCORE: 2,
  MIN_SECTOR_STOCK_COUNT: 3,
} as const;
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/constants/scoring.ts
git commit -m "refactor: スコアリング定数をセクターモメンタム対応に変更"
```

---

### Task 2: 型定義更新（types.ts）

**Files:**
- Modify: `src/core/scoring/types.ts`

- [ ] **Step 1: ScoringInput に sectorRelativeStrength を追加**

```typescript
// src/core/scoring/types.ts — ScoringInput の末尾に追加
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
  /** セクター相対強度（対日経225、%） */
  sectorRelativeStrength?: number | null;
}
```

- [ ] **Step 2: NewLogicScore に sectorMomentumScore を追加**

```typescript
// src/core/scoring/types.ts — NewLogicScore に追加
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
  sectorMomentumScore: number;
  isDisqualified: boolean;
  disqualifyReason: string | null;
}
```

- [ ] **Step 3: コミット**

```bash
git add src/core/scoring/types.ts
git commit -m "refactor: スコアリング型にセクターモメンタムフィールドを追加"
```

---

### Task 3: セクターモメンタムスコア関数（新規）+ テスト

**Files:**
- Create: `src/core/scoring/sector-momentum.ts`
- Create: `src/core/__tests__/scoring/sector-momentum.test.ts`

- [ ] **Step 1: テストファイルを作成**

```typescript
// src/core/__tests__/scoring/sector-momentum.test.ts
import { describe, it, expect } from "vitest";
import { scoreSectorMomentum } from "../../scoring/sector-momentum";

describe("scoreSectorMomentum", () => {
  it(">= +3.0% → 5", () => {
    expect(scoreSectorMomentum(3.5)).toBe(5);
    expect(scoreSectorMomentum(3.0)).toBe(5);
  });

  it(">= +1.5% → 4", () => {
    expect(scoreSectorMomentum(2.0)).toBe(4);
    expect(scoreSectorMomentum(1.5)).toBe(4);
  });

  it(">= +0.5% → 3", () => {
    expect(scoreSectorMomentum(1.0)).toBe(3);
    expect(scoreSectorMomentum(0.5)).toBe(3);
  });

  it(">= -0.5% → 2", () => {
    expect(scoreSectorMomentum(0.0)).toBe(2);
    expect(scoreSectorMomentum(-0.5)).toBe(2);
  });

  it(">= -2.0% → 1", () => {
    expect(scoreSectorMomentum(-1.0)).toBe(1);
    expect(scoreSectorMomentum(-2.0)).toBe(1);
  });

  it("< -2.0% → 0", () => {
    expect(scoreSectorMomentum(-2.5)).toBe(0);
    expect(scoreSectorMomentum(-5.0)).toBe(0);
  });

  it("null → DEFAULT_SCORE (2)", () => {
    expect(scoreSectorMomentum(null)).toBe(2);
  });

  it("undefined → DEFAULT_SCORE (2)", () => {
    expect(scoreSectorMomentum(undefined)).toBe(2);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/core/__tests__/scoring/sector-momentum.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装を作成**

```typescript
// src/core/scoring/sector-momentum.ts
import { SECTOR_MOMENTUM_SCORING } from "../../lib/constants/scoring";

/**
 * セクターモメンタムスコア（0-5）
 *
 * セクターの対日経225相対強度をスコアに変換する。
 * null/undefined の場合はデフォルトスコア（市場並み: 2）を返す。
 */
export function scoreSectorMomentum(
  relativeStrength: number | null | undefined,
): number {
  if (relativeStrength == null) {
    return SECTOR_MOMENTUM_SCORING.DEFAULT_SCORE;
  }

  for (const tier of SECTOR_MOMENTUM_SCORING.TIERS) {
    if (relativeStrength >= tier.min) {
      return tier.score;
    }
  }

  return 0;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run src/core/__tests__/scoring/sector-momentum.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/core/scoring/sector-momentum.ts src/core/__tests__/scoring/sector-momentum.test.ts
git commit -m "feat: セクターモメンタムスコア関数を追加"
```

---

### Task 4: ボリューム安定性スコアの圧縮 + テスト更新

**Files:**
- Modify: `src/core/scoring/risk-quality.ts`
- Modify: `src/core/__tests__/scoring/risk-quality.test.ts`

- [ ] **Step 1: テストを新しい期待値に更新**

```typescript
// src/core/__tests__/scoring/risk-quality.test.ts — scoreVolumeStability のテストを差し替え
describe("scoreVolumeStability", () => {
  it("5日MA > 25日MA & CV < 0.5 → 2", () => {
    expect(scoreVolumeStability(15000, 10000, 0.3)).toBe(2);
  });

  it("5日MA > 25日MA & CV 0.5-0.8 → 0", () => {
    expect(scoreVolumeStability(15000, 10000, 0.6)).toBe(0);
  });

  it("5日MA <= 25日MA → 0", () => {
    expect(scoreVolumeStability(8000, 10000, 0.3)).toBe(0);
  });

  it("CV > 0.8 → 0", () => {
    expect(scoreVolumeStability(15000, 10000, 0.9)).toBe(0);
  });

  it("null入力 → 0", () => {
    expect(scoreVolumeStability(null, null, null)).toBe(0);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/core/__tests__/scoring/risk-quality.test.ts`
Expected: FAIL（scoreVolumeStability がまだ旧ロジック）

- [ ] **Step 3: scoreVolumeStability を新ロジックに変更**

```typescript
// src/core/scoring/risk-quality.ts:27-45 を差し替え
/**
 * 出来高安定性スコア（0-2）
 */
export function scoreVolumeStability(
  volumeMA5: number | null,
  volumeMA25: number | null,
  volumeCv: number | null,
): number {
  if (volumeMA5 == null || volumeMA25 == null || volumeCv == null) return 0;

  const isIncreasing = volumeMA5 > volumeMA25;
  if (isIncreasing && volumeCv < RISK.VOLUME_CV_STABLE) {
    return SUB_MAX.VOLUME_STABILITY; // 2
  }

  return 0;
}
```

- [ ] **Step 4: scoreRiskQuality のコメントを更新**

```typescript
// src/core/scoring/risk-quality.ts:83-84
/**
 * リスク品質トータル（0-20）
 */
```

- [ ] **Step 5: テストを実行して成功を確認**

Run: `npx vitest run src/core/__tests__/scoring/risk-quality.test.ts`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/core/scoring/risk-quality.ts src/core/__tests__/scoring/risk-quality.test.ts
git commit -m "refactor: ボリューム安定性スコアを7点→2点に圧縮"
```

---

### Task 5: メインスコアリング関数にセクターモメンタムを統合

**Files:**
- Modify: `src/core/scoring/index.ts`

- [ ] **Step 1: scoreSectorMomentum をインポート**

```typescript
// src/core/scoring/index.ts:16 の後に追加
import { scoreSectorMomentum } from "./sector-momentum";
```

- [ ] **Step 2: scoreStock() のコメントを更新**

```typescript
// src/core/scoring/index.ts:22-25
/**
 * メインスコアリング関数
 * 4カテゴリ（トレンド品質40 + エントリータイミング35 + リスク品質20 + セクターモメンタム5）= 100点満点
 */
```

- [ ] **Step 3: zeroResult に sectorMomentumScore を追加**

```typescript
// src/core/scoring/index.ts:44-53
const zeroResult: NewLogicScore = {
  totalScore: 0,
  rank: "D",
  gate,
  trendQuality: { total: 0, maAlignment: 0, weeklyTrend: 0, trendContinuity: 0 },
  entryTiming: { total: 0, pullbackDepth: 0, breakout: 0, candlestickSignal: 0 },
  riskQuality: { total: 0, atrStability: 0, rangeContraction: 0, volumeStability: 0 },
  sectorMomentumScore: 0,
  isDisqualified: true,
  disqualifyReason: gate.failedGate,
};
```

- [ ] **Step 4: セクターモメンタムスコアを計算し合計に加算**

```typescript
// src/core/scoring/index.ts — riskQuality 計算の後（127行目付近の後）に追加
const sectorMomentumScore = scoreSectorMomentum(input.sectorRelativeStrength);

// --- 9. 合計 & ランク ---
const totalScore = trendQuality.total + entryTiming.total + riskQuality.total + sectorMomentumScore;

return {
  totalScore,
  rank: getRank(totalScore),
  gate,
  trendQuality,
  entryTiming,
  riskQuality,
  sectorMomentumScore,
  isDisqualified: false,
  disqualifyReason: null,
};
```

- [ ] **Step 5: formatScoreForAI() にセクターモメンタムの表示を追加**

リスク品質の出力の後に追加:

```typescript
// src/core/scoring/index.ts — formatScoreForAI 内、リスク品質行の後に追加
// セクターモメンタム（5点）
lines.push(`  セクターモメンタム: ${score.sectorMomentumScore}/${SECTOR_MOMENTUM_SCORING.CATEGORY_MAX}`);
```

`SECTOR_MOMENTUM_SCORING` のインポートも追加:

```typescript
import { SCORING, SECTOR_MOMENTUM_SCORING } from "../../lib/constants/scoring";
```

- [ ] **Step 6: コミット**

```bash
git add src/core/scoring/index.ts
git commit -m "feat: scoreStock にセクターモメンタムスコアを統合"
```

---

## Chunk 2: データベース + market-scanner 変更

### Task 6: Prisma スキーマ更新 + マイグレーション

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: ScoringRecord に sectorMomentumScore を追加**

`riskQualityScore` の行の後に追加:

```prisma
  riskQualityScore   Int   // 0-20
  sectorMomentumScore Int  @default(0) // 0-5
```

また `riskQualityScore` のコメントを `// 0-25` から `// 0-20` に変更。

- [ ] **Step 2: .env のDATABASE_URLがローカルか確認**

Run: `grep DATABASE_URL .env`
Expected: `localhost` を含む

- [ ] **Step 3: マイグレーション実行**

Run: `npx prisma migrate dev --name add-sector-momentum-score`

- [ ] **Step 4: Prisma Client 再生成を確認**

Run: `npx prisma generate`

- [ ] **Step 5: コミット**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "db: ScoringRecord に sectorMomentumScore カラムを追加"
```

---

### Task 7: market-scanner — スコアリングにセクターモメンタムを渡す + フィルタ削除

**Files:**
- Modify: `src/jobs/market-scanner.ts`

- [ ] **Step 1: セクターモメンタム計算をスコアリング前に移動**

現在は行572付近（フィルタリング後）で `calculateSectorMomentum()` を呼んでいるが、スコアリング（行467付近）の**前**に移動する必要がある。

スコアリングループ（行430付近、`for (let i = 0; ...)` のバッチ処理）の**前**に移動:

```typescript
// セクターモメンタムを事前計算（スコアリングで使用）
const nikkeiWeekChange = marketData.nikkei.changePercent;
const sectorMomentum = await calculateSectorMomentum(nikkeiWeekChange);
const sectorMomentumMap = new Map(
  sectorMomentum.map((s) => [s.sectorGroup, s]),
);
```

- [ ] **Step 2: scoreStock() 呼び出しに sectorRelativeStrength を追加**

```typescript
// src/jobs/market-scanner.ts:467-477 付近
// 銘柄のセクターグループから相対強度を取得
const sectorGroup = getSectorGroup(stock.jpxSectorName);
const sectorInfo = sectorGroup ? sectorMomentumMap.get(sectorGroup) : null;
const sectorRelativeStrength =
  sectorInfo && sectorInfo.stockCount >= SECTOR_MOMENTUM_SCORING.MIN_SECTOR_STOCK_COUNT
    ? sectorInfo.relativeStrength
    : null;

const score = scoreStock({
  historicalData: historical,
  latestPrice: Number(stock.latestPrice),
  latestVolume: Number(stock.latestVolume),
  weeklyVolatility: stock.volatility ? Number(stock.volatility) : null,
  nextEarningsDate: stock.nextEarningsDate,
  exDividendDate: stock.exDividendDate,
  avgVolume25: summary.volumeAnalysis.avgVolume20,
  summary,
  sectorRelativeStrength,
});
```

`SECTOR_MOMENTUM_SCORING` のインポートを追加:

```typescript
import { SECTOR_MOMENTUM_SCORING } from "../lib/constants/scoring";
```

- [ ] **Step 3: Stage 5 弱セクター除外フィルタを削除**

行572-610の以下のブロックを削除:

```typescript
// 以下を全て削除:
// - `const nikkeiWeekChange = ...`（Step 1で移動済み）
// - `const sectorMomentum = ...`（Step 1で移動済み）
// - `const newsNegativeSectors = ...`
// - `const weakSectors = ...`
// - `if (weakSectors.size > 0) { ... }` ブロック全体
```

**注意**: 以下の変数はAI審判のコンテキスト生成（行719-741付近）で引き続き使われる:

- `sectorMomentum` — Step 1で移動済み。AI審判コードの `sectorMomentum.find()` は配列メソッドなので、Step 1で作成した `sectorMomentumMap` とは**別に元の配列も保持**すること。Step 1を以下に修正:

```typescript
// セクターモメンタムを事前計算（スコアリングで使用）
const nikkeiWeekChange = marketData.nikkei.changePercent;
const sectorMomentum = await calculateSectorMomentum(nikkeiWeekChange);
const sectorMomentumMap = new Map(
  sectorMomentum.map((s) => [s.sectorGroup, s]),
);
// sectorMomentum 配列はAI審判コンテキスト（行720付近の .find()）で引き続き使用
```

- `newsSentiment` — フィルタから分離して残す。AI審判コンテキスト生成の直前に移動:

```typescript
// AI審判コンテキスト用（フィルタとしては使わない）
const newsSentiment = await getNewsSectorSentiment();
```

- [ ] **Step 4: buildScoringFields に sectorMomentumScore を追加**

```typescript
// buildScoringFields 関数（行655付近）に追加
const buildScoringFields = (c: ScoredCandidate) => ({
  date: today,
  tickerCode: c.tickerCode,
  totalScore: c.score.totalScore,
  rank: c.score.rank,
  trendQualityScore: c.score.trendQuality.total,
  entryTimingScore: c.score.entryTiming.total,
  riskQualityScore: c.score.riskQuality.total,
  sectorMomentumScore: c.score.sectorMomentumScore,
  // ...残りのフィールドはそのまま
});
```

- [ ] **Step 5: TypeScript コンパイルチェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/jobs/market-scanner.ts
git commit -m "feat: market-scanner にセクターモメンタムスコアを統合し弱セクターフィルタを廃止"
```

---

### Task 8: スコアリングUI表示の更新

**Files:**
- Modify: `src/web/routes/scoring.ts`

- [ ] **Step 1: 日付別一覧のカテゴリスコア表示にセクターモメンタムを追加**

行192-196のカテゴリスコア表示を変更:

```typescript
// src/web/routes/scoring.ts:192-197 — カテゴリスコア表示
<div>
  趨<span style="color:#e2e8f0;font-weight:600">${r.trendQualityScore}</span>
  入<span style="color:#e2e8f0;font-weight:600;margin-left:0.35rem">${r.entryTimingScore}</span>
  危<span style="color:#e2e8f0;font-weight:600;margin-left:0.35rem">${r.riskQualityScore}</span>
  業<span style="color:#e2e8f0;font-weight:600;margin-left:0.35rem">${r.sectorMomentumScore ?? 0}</span>
</div>
```

- [ ] **Step 2: 銘柄別履歴ページにも同様に追加**

行273-276にも同じ変更:

```typescript
// src/web/routes/scoring.ts:273-276
<div>
  趨<span style="color:#e2e8f0;font-weight:600">${r.trendQualityScore}</span>
  入<span style="color:#e2e8f0;font-weight:600;margin-left:0.35rem">${r.entryTimingScore}</span>
  危<span style="color:#e2e8f0;font-weight:600;margin-left:0.35rem">${r.riskQualityScore}</span>
  業<span style="color:#e2e8f0;font-weight:600;margin-left:0.35rem">${r.sectorMomentumScore ?? 0}</span>
</div>
```

- [ ] **Step 3: コミット**

```bash
git add src/web/routes/scoring.ts
git commit -m "feat: スコアリングUIにセクターモメンタムスコアを表示"
```

---

## Chunk 3: バックテスト対応

### Task 9: on-the-fly-scorer にセクターモメンタムを統合

**Files:**
- Modify: `src/backtest/on-the-fly-scorer.ts`

- [ ] **Step 1: ScoredRecord 型に sectorMomentumScore を追加**

```typescript
// src/backtest/on-the-fly-scorer.ts — ScoredRecord に追加
export interface ScoredRecord {
  tickerCode: string;
  totalScore: number;
  rank: string;
  trendQualityScore: number;
  trendQualityBreakdown: { ... };
  entryTimingScore: number;
  entryTimingBreakdown: { ... };
  riskQualityScore: number;
  riskQualityBreakdown: { ... };
  sectorMomentumScore: number; // 追加
  isDisqualified: boolean;
  disqualifyReason: string | null;
  rejectionReason: string | null;
  entryPrice: number | null;
}
```

- [ ] **Step 2: scoreDayForAllStocks の引数に nikkei225Ohlcv を追加（optional）**

```typescript
// src/backtest/on-the-fly-scorer.ts
import { getSectorGroup } from "../lib/constants";
import { SECTOR_MOMENTUM_SCORING } from "../lib/constants/scoring";
import { scoreSectorMomentum } from "../core/scoring/sector-momentum";

export function scoreDayForAllStocks(
  targetDate: string,
  allOhlcv: Map<string, OHLCVData[]>,
  fundamentalsMap: Map<string, StockFundamentals>,
  _stocks: { tickerCode: string; jpxSectorName: string | null }[],
  nikkei225Ohlcv?: OHLCVData[], // 追加（oldest-first）
): ScoredRecord[] {
```

- [ ] **Step 3: セクターモメンタム計算ロジックを追加**

`scoreDayForAllStocks` 内、`stockSlices` のMapを構築した後、スコアリングループの前に追加:

```typescript
// セクターモメンタム計算（日経225データがある場合）
const sectorRelativeStrengthMap = new Map<string, number | null>();

if (nikkei225Ohlcv && nikkei225Ohlcv.length > 0) {
  // 日経225の週間変化率
  const nikkeiSliceEnd = nikkei225Ohlcv.findIndex((d) => d.date > targetDate);
  const nikkeiSlice = nikkeiSliceEnd === -1 ? nikkei225Ohlcv : nikkei225Ohlcv.slice(0, nikkeiSliceEnd);
  let nikkeiWeekChange: number | null = null;
  if (nikkeiSlice.length >= 6) {
    const latestClose = nikkeiSlice[nikkeiSlice.length - 1].close;
    const fiveDaysAgoClose = nikkeiSlice[nikkeiSlice.length - 6].close;
    nikkeiWeekChange = ((latestClose - fiveDaysAgoClose) / fiveDaysAgoClose) * 100;
  }

  if (nikkeiWeekChange != null) {
    // 各銘柄の週間変化率をセクターグループ別に集計
    const sectorChanges = new Map<string, number[]>();
    for (const [ticker, slice] of stockSlices) {
      const fund = fundamentalsMap.get(ticker);
      if (!fund?.jpxSectorName) continue;
      const group = getSectorGroup(fund.jpxSectorName);
      if (!group) continue;

      if (slice.length >= 6) {
        const latestClose = slice[slice.length - 1].close;
        const fiveDaysAgoClose = slice[slice.length - 6].close;
        const weekChange = ((latestClose - fiveDaysAgoClose) / fiveDaysAgoClose) * 100;
        const changes = sectorChanges.get(group) ?? [];
        changes.push(weekChange);
        sectorChanges.set(group, changes);
      }
    }

    // セクター平均 → 相対強度
    for (const [group, changes] of sectorChanges) {
      if (changes.length < SECTOR_MOMENTUM_SCORING.MIN_SECTOR_STOCK_COUNT) continue;
      const avg = changes.reduce((a, b) => a + b, 0) / changes.length;
      sectorRelativeStrengthMap.set(group, avg - nikkeiWeekChange);
    }
  }
}
```

- [ ] **Step 4: scoreStock() 呼び出しに sectorRelativeStrength を渡す**

```typescript
// scoreStock 呼び出し（行99付近）を修正
const sectorGroup = fund.jpxSectorName ? getSectorGroup(fund.jpxSectorName) : null;
const sectorRelativeStrength = sectorGroup
  ? (sectorRelativeStrengthMap.get(sectorGroup) ?? null)
  : null;

const score = scoreStock({
  historicalData: newestFirst,
  latestPrice: latest.close,
  latestVolume: latest.volume,
  weeklyVolatility: fund.volatility,
  summary,
  avgVolume25: summary.volumeAnalysis.avgVolume20,
  nextEarningsDate: fund.nextEarningsDate,
  exDividendDate: fund.exDividendDate,
  sectorRelativeStrength,
});
```

- [ ] **Step 5: results.push に sectorMomentumScore を追加**

```typescript
results.push({
  // ... 既存フィールド ...
  sectorMomentumScore: score.sectorMomentumScore,
  // ... 残りのフィールド ...
});
```

- [ ] **Step 6: buildCandidateMapOnTheFly にも nikkei225Ohlcv 引数を追加**

```typescript
export function buildCandidateMapOnTheFly(
  allOhlcv: Map<string, OHLCVData[]>,
  fundamentalsMap: Map<string, StockFundamentals>,
  stocks: { tickerCode: string; jpxSectorName: string | null }[],
  startDate: string,
  endDate: string,
  targetRanks: readonly string[],
  fallbackRanks: readonly string[],
  minTickers: number,
  nikkei225Ohlcv?: OHLCVData[], // 追加
): { candidateMap: Map<string, string[]>; allTickers: string[] } {
```

`scoreDayForAllStocks` 呼び出しに `nikkei225Ohlcv` を渡す:

```typescript
const dayRecords = scoreDayForAllStocks(
  targetDate,
  allOhlcv,
  fundamentalsMap,
  stocks,
  nikkei225Ohlcv,
);
```

- [ ] **Step 7: コミット**

```bash
git add src/backtest/on-the-fly-scorer.ts
git commit -m "feat: バックテストスコアリングにセクターモメンタムを統合"
```

---

### Task 10: バックテスト呼び出し元の更新

**Files:**
- Modify: `src/backtest/daily-runner.ts`
- Modify: `scripts/backfill-scoring-records.ts`
- Modify: `scripts/walk-forward.ts`
- Modify: `scripts/diagnose-backtest.ts`

- [ ] **Step 1: daily-runner.ts — 日経225データを取得して渡す**

`fetchMultipleBacktestData` の呼び出し時にティッカーリストに `^N225` を追加し、結果から分離して `scoreDayForAllStocks` / `buildCandidateMapOnTheFly` に渡す。

各 `fetchMultipleBacktestData` 呼び出し箇所で:

```typescript
// 日経225データも取得
const allTickersWithNikkei = [...stockTickers, "^N225"];
const [allDataWithNikkei, vixData] = await Promise.all([
  fetchMultipleBacktestData(allTickersWithNikkei, startDate, endDate),
  fetchVixData(startDate, endDate).catch(...),
]);

// 日経225を分離
const nikkei225Ohlcv = allDataWithNikkei.get("^N225");
allDataWithNikkei.delete("^N225");
const allData = allDataWithNikkei;
```

`buildCandidateMapOnTheFly` / `scoreDayForAllStocks` の呼び出しに `nikkei225Ohlcv` を追加:

```typescript
buildCandidateMapOnTheFly(
  allData, fundamentalsMap, stocks,
  startDate, endDate,
  targetRanks, fallbackRanks, minTickers,
  nikkei225Ohlcv ? [...nikkei225Ohlcv] : undefined,
)
```

- [ ] **Step 2: backfill-scoring-records.ts — 引数を追加**

`scoreDayForAllStocks` 呼び出しに `undefined` を追加（日経225データなし → デフォルトスコア適用）:

```typescript
const dayRecords = scoreDayForAllStocks(
  targetDate, allOhlcv, fundamentalsMap, stocks, undefined,
);
```

または日経225データも取得する場合は daily-runner.ts と同様のパターンを適用。

- [ ] **Step 3: walk-forward.ts — 引数を追加**

`buildCandidateMapOnTheFly` / `scoreDayForAllStocks` の呼び出しに `nikkei225Ohlcv` を追加。daily-runner.ts と同じパターン。

- [ ] **Step 4: diagnose-backtest.ts — 引数を追加 + カテゴリ平均ログ更新**

`buildCandidateMapOnTheFly` / `scoreDayForAllStocks` の呼び出しに対応。

加えて、`categoryTotals` 変数とログ出力を更新:

```typescript
// 行88: categoryTotals にセクターモメンタムを追加
const categoryTotals = { trend: 0, entry: 0, risk: 0, sector: 0, count: 0 };

// 行100-103: 集計にセクターモメンタムを追加
categoryTotals.sector += r.sectorMomentumScore;

// 行119: ログ出力を更新（/25 → /20、セクター追加）
console.log(`  カテゴリ平均: トレンド=${(categoryTotals.trend / categoryTotals.count).toFixed(1)}/40 エントリー=${(categoryTotals.entry / categoryTotals.count).toFixed(1)}/35 リスク=${(categoryTotals.risk / categoryTotals.count).toFixed(1)}/20 セクター=${(categoryTotals.sector / categoryTotals.count).toFixed(1)}/5`);
```

- [ ] **Step 5: TypeScript コンパイルチェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/backtest/daily-runner.ts scripts/backfill-scoring-records.ts scripts/walk-forward.ts scripts/diagnose-backtest.ts
git commit -m "feat: バックテスト呼び出し元を日経225データ対応に更新"
```

---

## Chunk 4: 精度追跡 + 仕様書更新

### Task 11: 精度追跡の更新

**Files:**
- Modify: `src/jobs/scoring-accuracy.ts`
- Modify: `src/jobs/scoring-accuracy-report.ts`

- [ ] **Step 1: buildFnAnalysisPrompt にセクターモメンタムを追加**

`scoring-accuracy.ts` の `buildFnAnalysisPrompt` 関数（行77付近）のスコア内訳セクションに追加:

```typescript
【スコア内訳】
  トレンド品質: ${JSON.stringify(record.trendQualityBreakdown)}
  エントリータイミング: ${JSON.stringify(record.entryTimingBreakdown)}
  リスク品質: ${JSON.stringify(record.riskQualityBreakdown)}
  セクターモメンタム: ${record.sectorMomentumScore}/5
```

関数の引数型にも `sectorMomentumScore: number` を追加。

- [ ] **Step 2: buildFpAnalysisPrompt にも同様に追加**

`buildFpAnalysisPrompt` 関数（行94付近）にも同じ変更を適用:

```typescript
  リスク品質: ${JSON.stringify(record.riskQualityBreakdown)}
  セクターモメンタム: ${record.sectorMomentumScore}/5
```

- [ ] **Step 3: scoring-accuracy-report.ts のカテゴリ分析にセクターモメンタムを追加**

`analyzeCategoryWeakness` 関数（行46付近）の categories 配列にセクターモメンタムを追加:

```typescript
{
  key: "セクターモメンタム",
  maxScore: SCORING_V2.CATEGORY_MAX.RISK_QUALITY, // ← 後述で修正方法を確認
  getScore: (r: ScoringRecordRow) => r.sectorMomentumScore ?? 0,
},
```

**注意**: `SCORING_V2.CATEGORY_MAX` にはセクターモメンタムが無いため、`SECTOR_MOMENTUM_SCORING.CATEGORY_MAX` を使うか、直接 `5` を指定する。

- [ ] **Step 4: コミット**

```bash
git add src/jobs/scoring-accuracy.ts src/jobs/scoring-accuracy-report.ts
git commit -m "fix: 精度追跡・レポートにセクターモメンタムスコアを含める"
```

---

### Task 12: 仕様書の更新

**Files:**
- Modify: `docs/specs/scoring-system.md`
- Modify: `docs/specs/batch-processing.md`

- [ ] **Step 1: scoring-system.md の配点表とカテゴリ説明を更新**

4カテゴリ構成（トレンド40 + エントリー35 + リスク20 + セクター5 = 100）に更新。セクターモメンタムの変換テーブルを追記。ボリューム安定性の変更を反映。

- [ ] **Step 2: batch-processing.md の market-scanner フローを更新**

Stage 5（弱セクター除外フィルタ）の削除を反映。セクターモメンタムがスコアリング段階で統合されたことを記載。

- [ ] **Step 3: コミット**

```bash
git add docs/specs/scoring-system.md docs/specs/batch-processing.md
git commit -m "docs: 仕様書をセクターモメンタムスコアリング統合に合わせて更新"
```

---

### Task 13: 最終確認

- [ ] **Step 1: 全テスト実行**

Run: `npx vitest run`
Expected: 全テストPASS

- [ ] **Step 2: TypeScript コンパイルチェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 3: 設計ファイルの削除**

Run: `rm docs/superpowers/specs/2026-03-16-sector-momentum-scoring-design.md`
Run: `rm docs/superpowers/plans/2026-03-16-sector-momentum-scoring.md`

- [ ] **Step 4: 最終コミット**

```bash
git add -A
git commit -m "chore: セクターモメンタムスコアリング統合の設計ファイルを削除"
```
