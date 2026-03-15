# モンテカルロシミュレーション（破産確率推定）実装計画

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** バックテストのトレード損益データからモンテカルロシミュレーションを実行し、破産確率をバックテストページ上で可視化する

**Architecture:** トレード単位ブートストラップ法で10,000パスのシミュレーションを実行。コアエンジンは純粋関数として `src/core/monte-carlo.ts` に実装。Hono SSRのバックテストページにセクション追加し、クライアントサイドJSでAPIコール・SVGファンチャート描画を行う。

**Tech Stack:** TypeScript, Vitest, Hono (SSR), Prisma, SVG (client-side JS)

**Spec:** `docs/superpowers/specs/2026-03-15-monte-carlo-ruin-probability-design.md`

---

## Chunk 1: データソース準備 + コアエンジン

### Task 1: DailyBacktestConditionResult に tradeReturns を追加

**Files:**
- Modify: `src/backtest/daily-runner.ts:28-34` (interface定義)
- Modify: `src/backtest/daily-runner.ts:526-531` (conditionResults.push)

- [ ] **Step 1: `DailyBacktestConditionResult` に `tradeReturns` フィールドを追加**

`src/backtest/daily-runner.ts:28-34` のインターフェースを変更:

```typescript
export interface DailyBacktestConditionResult {
  condition: ParameterCondition;
  config: BacktestConfig;
  metrics: PerformanceMetrics;
  tradeReturns: number[];
  tickerCount: number;
  executionTimeMs: number;
}
```

- [ ] **Step 2: `conditionResults.push()` で tradeReturns を設定**

`src/backtest/daily-runner.ts:526-532` を変更:

```typescript
conditionResults.push({
  condition,
  config,
  metrics: result.metrics,
  tradeReturns: result.trades
    .filter((t) => t.pnlPct !== null)
    .map((t) => t.pnlPct as number),
  tickerCount: allData.size,
  executionTimeMs: Date.now() - condStart,
});
```

- [ ] **Step 3: PaperTradeResult のインライン構築にも tradeReturns を追加**

`src/backtest/daily-runner.ts` の `paperTradeResult` 構築箇所（約612-625行目）で、`newBaseline` と `oldBaseline` の両方に `tradeReturns` を追加。検索: `paperTradeResult = {` で該当箇所を特定し、各 `DailyBacktestConditionResult` に以下を追加:

```typescript
tradeReturns: newResult.trades  // または oldResult.trades
  .filter((t) => t.pnlPct !== null)
  .map((t) => t.pnlPct as number),
```

- [ ] **Step 4: TypeScriptのコンパイルが通ることを確認**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: エラーなし（または既存の無関係なエラーのみ）

- [ ] **Step 5: コミット**

```bash
git add src/backtest/daily-runner.ts
git commit -m "feat(backtest): DailyBacktestConditionResultにtradeReturnsを追加"
```

---

### Task 2: daily-backtest.ts の fullResult に tradeReturns を含める

**Files:**
- Modify: `src/jobs/daily-backtest.ts:58` (create時のfullResult)
- Modify: `src/jobs/daily-backtest.ts:80` (update時のfullResult)
- Modify: `src/jobs/daily-backtest.ts:124` (ペーパートレードcreate時のfullResult)
- Modify: `src/jobs/daily-backtest.ts:146` (ペーパートレードupdate時のfullResult)

- [ ] **Step 1: メイン結果の fullResult を変更（create + update の両方）**

`src/jobs/daily-backtest.ts` で以下の4箇所を変更:

Line 58 (create):
```typescript
fullResult: {
  ...(cr.metrics as object),
  tradeReturns: cr.tradeReturns,
},
```

Line 80 (update):
```typescript
fullResult: {
  ...(cr.metrics as object),
  tradeReturns: cr.tradeReturns,
},
```

- [ ] **Step 2: ペーパートレード結果の fullResult も同様に変更**

Line 124 (create):
```typescript
fullResult: {
  ...(cr.metrics as object),
  tradeReturns: cr.tradeReturns,
},
```

Line 146 (update):
```typescript
fullResult: {
  ...(cr.metrics as object),
  tradeReturns: cr.tradeReturns,
},
```

- [ ] **Step 3: TypeScriptのコンパイルが通ることを確認**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: エラーなし

- [ ] **Step 4: コミット**

```bash
git add src/jobs/daily-backtest.ts
git commit -m "feat(backtest): fullResultにtradeReturnsを保存"
```

---

### Task 3: モンテカルロコアエンジン — テストを書く

**Files:**
- Create: `src/core/__tests__/monte-carlo.test.ts`

- [ ] **Step 1: テストファイルを作成**

```typescript
import { describe, it, expect } from "vitest";
import {
  runMonteCarloSimulation,
  type MonteCarloConfig,
  type MonteCarloResult,
} from "../monte-carlo";

function makeConfig(overrides: Partial<MonteCarloConfig> = {}): MonteCarloConfig {
  return {
    tradeReturns: [3.0, -2.5, 5.0, -3.0, 2.0, -1.5, 4.0, -2.0, 1.0, -2.8],
    initialBudget: 300000,
    numPaths: 100,
    tradesPerPath: 50,
    ruinThresholdPct: 50,
    riskPerTradePct: 2,
    avgStopLossPct: 2.5,
    ...overrides,
  };
}

describe("runMonteCarloSimulation", () => {
  it("returns valid result structure", () => {
    const result = runMonteCarloSimulation(makeConfig());

    expect(result.totalPaths).toBe(100);
    expect(result.ruinProbability).toBeGreaterThanOrEqual(0);
    expect(result.ruinProbability).toBeLessThanOrEqual(1);
    expect(result.ruinedPaths).toBeGreaterThanOrEqual(0);
    expect(result.ruinedPaths).toBeLessThanOrEqual(100);

    // finalEquityPercentiles are ordered
    expect(result.finalEquityPercentiles.p5).toBeLessThanOrEqual(
      result.finalEquityPercentiles.p25,
    );
    expect(result.finalEquityPercentiles.p25).toBeLessThanOrEqual(
      result.finalEquityPercentiles.p50,
    );
    expect(result.finalEquityPercentiles.p50).toBeLessThanOrEqual(
      result.finalEquityPercentiles.p75,
    );
    expect(result.finalEquityPercentiles.p75).toBeLessThanOrEqual(
      result.finalEquityPercentiles.p95,
    );

    // maxDrawdownPercentiles are non-negative
    expect(result.maxDrawdownPercentiles.p5).toBeGreaterThanOrEqual(0);
    expect(result.maxDrawdownPercentiles.p50).toBeGreaterThanOrEqual(0);
    expect(result.maxDrawdownPercentiles.p95).toBeGreaterThanOrEqual(0);

    // thresholdBreachRates: dd10 >= dd20 >= dd30 >= dd50 (smaller DD thresholds are easier to breach)
    expect(result.thresholdBreachRates.dd10).toBeGreaterThanOrEqual(
      result.thresholdBreachRates.dd20,
    );
    expect(result.thresholdBreachRates.dd20).toBeGreaterThanOrEqual(
      result.thresholdBreachRates.dd30,
    );
    expect(result.thresholdBreachRates.dd30).toBeGreaterThanOrEqual(
      result.thresholdBreachRates.dd50,
    );
  });

  it("equity curves have correct length", () => {
    const config = makeConfig({ tradesPerPath: 50 });
    const result = runMonteCarloSimulation(config);

    // tradesPerPath <= 200 なので間引きなし、長さは tradesPerPath + 1
    const expectedLen = 51;
    expect(result.equityCurves.p5.length).toBe(expectedLen);
    expect(result.equityCurves.p50.length).toBe(expectedLen);
    expect(result.equityCurves.p95.length).toBe(expectedLen);

    // 全パスの初期値は initialBudget
    expect(result.equityCurves.p5[0]).toBe(300000);
    expect(result.equityCurves.p50[0]).toBe(300000);
    expect(result.equityCurves.p95[0]).toBe(300000);
  });

  it("downsamples equity curves when tradesPerPath > 200", () => {
    const config = makeConfig({ tradesPerPath: 500 });
    const result = runMonteCarloSimulation(config);

    // 200点 + 1（初期値）に間引かれる
    expect(result.equityCurves.p50.length).toBeLessThanOrEqual(201);
  });

  it("100% loss trades cause high ruin probability", () => {
    const config = makeConfig({
      tradeReturns: [-5.0, -4.0, -6.0, -3.0, -5.5],
      numPaths: 500,
      tradesPerPath: 200,
    });
    const result = runMonteCarloSimulation(config);

    // 全て損失なので破産確率は高い
    expect(result.ruinProbability).toBeGreaterThan(0.5);
  });

  it("100% win trades cause zero ruin probability", () => {
    const config = makeConfig({
      tradeReturns: [3.0, 2.0, 4.0, 5.0, 2.5],
      numPaths: 500,
      tradesPerPath: 200,
    });
    const result = runMonteCarloSimulation(config);

    expect(result.ruinProbability).toBe(0);
    expect(result.ruinedPaths).toBe(0);
  });

  it("ruined paths have equity set to 0 after ruin", () => {
    // 全て大きな損失 → 必ず破産する設定
    const config = makeConfig({
      tradeReturns: [-10.0],
      numPaths: 10,
      tradesPerPath: 100,
      ruinThresholdPct: 50,
      riskPerTradePct: 5,
      avgStopLossPct: 10.0,
    });
    const result = runMonteCarloSimulation(config);

    // p5（最悪パス）の終了時 equity は 0
    const lastIdx = result.equityCurves.p5.length - 1;
    expect(result.equityCurves.p5[lastIdx]).toBe(0);
  });

  it("inputStats reflects the input data correctly", () => {
    const returns = [3.0, -2.5, 5.0, -3.0, 2.0];
    const config = makeConfig({ tradeReturns: returns });
    const result = runMonteCarloSimulation(config);

    expect(result.inputStats.totalTrades).toBe(5);
    expect(result.inputStats.winRate).toBeCloseTo(60, 0); // 3/5 = 60%
    expect(result.inputStats.avgWinPct).toBeCloseTo(
      (3.0 + 5.0 + 2.0) / 3,
      2,
    );
    expect(result.inputStats.avgLossPct).toBeCloseTo(
      (-2.5 + -3.0) / 2,
      2,
    );
    // expectancy = mean of all returns
    expect(result.inputStats.expectancy).toBeCloseTo(
      (3.0 + -2.5 + 5.0 + -3.0 + 2.0) / 5,
      2,
    );
  });

  it("throws on empty tradeReturns", () => {
    const config = makeConfig({ tradeReturns: [] });
    expect(() => runMonteCarloSimulation(config)).toThrow();
  });

  it("throws on avgStopLossPct = 0", () => {
    const config = makeConfig({ avgStopLossPct: 0 });
    expect(() => runMonteCarloSimulation(config)).toThrow();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/core/__tests__/monte-carlo.test.ts`
Expected: FAIL（モジュールが存在しないためインポートエラー）

- [ ] **Step 3: コミット**

```bash
git add src/core/__tests__/monte-carlo.test.ts
git commit -m "test: モンテカルロシミュレーションのテストを追加"
```

---

### Task 4: モンテカルロコアエンジン — 実装

**Files:**
- Create: `src/core/monte-carlo.ts`

- [ ] **Step 1: コアエンジンを実装**

```typescript
/**
 * モンテカルロシミュレーション — 破産確率の推定
 *
 * トレード単位ブートストラップ法で N 本のパスを生成し、
 * 破産確率・最終資産分布・最大ドローダウン分布を算出する。
 */

export interface MonteCarloConfig {
  tradeReturns: number[];
  initialBudget: number;
  numPaths: number;
  tradesPerPath: number;
  ruinThresholdPct: number;
  riskPerTradePct: number;
  avgStopLossPct: number;
}

interface Percentiles {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

interface DrawdownPercentiles {
  p5: number;
  p50: number;
  p95: number;
}

interface ThresholdBreachRates {
  dd10: number;
  dd20: number;
  dd30: number;
  dd50: number;
}

interface InputStats {
  totalTrades: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancy: number;
}

export interface MonteCarloResult {
  ruinProbability: number;
  totalPaths: number;
  ruinedPaths: number;
  finalEquityPercentiles: Percentiles;
  maxDrawdownPercentiles: DrawdownPercentiles;
  thresholdBreachRates: ThresholdBreachRates;
  equityCurves: {
    p5: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p95: number[];
  };
  inputStats: InputStats;
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeInputStats(tradeReturns: number[]): InputStats {
  const wins = tradeReturns.filter((r) => r > 0);
  const losses = tradeReturns.filter((r) => r <= 0);
  const winRate =
    tradeReturns.length > 0
      ? (wins.length / tradeReturns.length) * 100
      : 0;
  const avgWinPct =
    wins.length > 0 ? wins.reduce((s, v) => s + v, 0) / wins.length : 0;
  const avgLossPct =
    losses.length > 0
      ? losses.reduce((s, v) => s + v, 0) / losses.length
      : 0;
  const expectancy =
    tradeReturns.length > 0
      ? tradeReturns.reduce((s, v) => s + v, 0) / tradeReturns.length
      : 0;

  return {
    totalTrades: tradeReturns.length,
    winRate: Math.round(winRate * 100) / 100,
    avgWinPct: Math.round(avgWinPct * 100) / 100,
    avgLossPct: Math.round(avgLossPct * 100) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
  };
}

export function runMonteCarloSimulation(
  config: MonteCarloConfig,
): MonteCarloResult {
  const {
    tradeReturns,
    initialBudget,
    numPaths,
    tradesPerPath,
    ruinThresholdPct,
    riskPerTradePct,
    avgStopLossPct,
  } = config;

  if (tradeReturns.length === 0) {
    throw new Error("tradeReturns must not be empty");
  }
  if (avgStopLossPct === 0) {
    throw new Error("avgStopLossPct must not be zero");
  }

  const ruinLevel = initialBudget * (1 - ruinThresholdPct / 100);
  const riskFraction = riskPerTradePct / 100;

  // 各パスのステップごとの equity を記録（パーセンタイル計算用）
  // equityAtStep[step][pathIdx] = equity
  const steps = tradesPerPath + 1;
  const equityAtStep: number[][] = Array.from({ length: steps }, () =>
    new Array(numPaths),
  );

  const finalEquities: number[] = new Array(numPaths);
  const maxDrawdowns: number[] = new Array(numPaths);
  let ruinedPaths = 0;

  // 閾値到達カウント
  let dd10Count = 0;
  let dd20Count = 0;
  let dd30Count = 0;
  let dd50Count = 0;

  const len = tradeReturns.length;

  for (let p = 0; p < numPaths; p++) {
    let equity = initialBudget;
    let peak = initialBudget;
    let maxDd = 0;
    let ruined = false;

    let hit10 = false;
    let hit20 = false;
    let hit30 = false;
    let hit50 = false;

    equityAtStep[0][p] = equity;

    for (let t = 1; t <= tradesPerPath; t++) {
      if (!ruined) {
        const sampledReturn =
          tradeReturns[Math.floor(Math.random() * len)];
        const riskAmount = equity * riskFraction;
        const pnl = riskAmount * (sampledReturn / avgStopLossPct);
        equity += pnl;

        if (equity > peak) peak = equity;
        const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
        if (dd > maxDd) maxDd = dd;

        if (!hit10 && dd >= 10) hit10 = true;
        if (!hit20 && dd >= 20) hit20 = true;
        if (!hit30 && dd >= 30) hit30 = true;
        if (!hit50 && dd >= 50) hit50 = true;

        if (equity <= ruinLevel) {
          ruined = true;
          equity = 0;
        }
      }

      equityAtStep[t][p] = equity;
    }

    finalEquities[p] = equity;
    maxDrawdowns[p] = maxDd;

    if (ruined) ruinedPaths++;
    if (hit10) dd10Count++;
    if (hit20) dd20Count++;
    if (hit30) dd30Count++;
    if (hit50) dd50Count++;
  }

  // ソートしてパーセンタイル計算
  const sortedFinal = [...finalEquities].sort((a, b) => a - b);
  const sortedDd = [...maxDrawdowns].sort((a, b) => a - b);

  // エクイティカーブのパーセンタイル（ステップごと）
  // 間引き: tradesPerPath > 200 なら 200 点にダウンサンプリング
  const maxPoints = 200;
  let sampleIndices: number[];
  if (steps <= maxPoints + 1) {
    sampleIndices = Array.from({ length: steps }, (_, i) => i);
  } else {
    sampleIndices = [0];
    for (let i = 1; i < maxPoints; i++) {
      sampleIndices.push(Math.round((i / maxPoints) * (steps - 1)));
    }
    sampleIndices.push(steps - 1);
    // 重複除去
    sampleIndices = [...new Set(sampleIndices)];
  }

  const curves = {
    p5: new Array(sampleIndices.length),
    p25: new Array(sampleIndices.length),
    p50: new Array(sampleIndices.length),
    p75: new Array(sampleIndices.length),
    p95: new Array(sampleIndices.length),
  };

  for (let si = 0; si < sampleIndices.length; si++) {
    const stepIdx = sampleIndices[si];
    const sorted = [...equityAtStep[stepIdx]].sort((a, b) => a - b);
    curves.p5[si] = Math.round(percentile(sorted, 5));
    curves.p25[si] = Math.round(percentile(sorted, 25));
    curves.p50[si] = Math.round(percentile(sorted, 50));
    curves.p75[si] = Math.round(percentile(sorted, 75));
    curves.p95[si] = Math.round(percentile(sorted, 95));
  }

  return {
    ruinProbability: ruinedPaths / numPaths,
    totalPaths: numPaths,
    ruinedPaths,
    finalEquityPercentiles: {
      p5: Math.round(percentile(sortedFinal, 5)),
      p25: Math.round(percentile(sortedFinal, 25)),
      p50: Math.round(percentile(sortedFinal, 50)),
      p75: Math.round(percentile(sortedFinal, 75)),
      p95: Math.round(percentile(sortedFinal, 95)),
    },
    maxDrawdownPercentiles: {
      p5: Math.round(percentile(sortedDd, 5) * 100) / 100,
      p50: Math.round(percentile(sortedDd, 50) * 100) / 100,
      p95: Math.round(percentile(sortedDd, 95) * 100) / 100,
    },
    thresholdBreachRates: {
      dd10: dd10Count / numPaths,
      dd20: dd20Count / numPaths,
      dd30: dd30Count / numPaths,
      dd50: dd50Count / numPaths,
    },
    equityCurves: curves,
    inputStats: computeInputStats(tradeReturns),
  };
}
```

**Note on maxDrawdownPercentiles**: 標準パーセンタイル（p5 = 5th percentile = 小さいDD、p95 = 95th percentile = 大きいDD）。UIではp95（最悪ケース）を「最大DD」として表示する。

- [ ] **Step 2: テストを実行して全て通ることを確認**

Run: `npx vitest run src/core/__tests__/monte-carlo.test.ts`
Expected: 全テスト PASS

- [ ] **Step 3: コミット**

```bash
git add src/core/monte-carlo.ts
git commit -m "feat: モンテカルロシミュレーションのコアエンジンを実装"
```

---

## Chunk 2: APIルート + UI

### Task 5: API ルートを追加

**Files:**
- Modify: `src/web/routes/backtest.ts` (APIルート追加)

- [ ] **Step 1: POST /api/monte-carlo ルートを backtest.ts に追加**

`src/web/routes/backtest.ts` の `export default app;` の直前に追加:

```typescript
import {
  runMonteCarloSimulation,
  type MonteCarloConfig,
} from "../../core/monte-carlo";

app.post("/api/monte-carlo", async (c) => {
  const body = await c.req.json<{
    conditionKey?: string;
    initialBudget?: number;
    numPaths?: number;
    tradesPerPath?: number;
    ruinThreshold?: number;
    riskPerTrade?: number;
  }>();

  const conditionKey = body.conditionKey ?? "baseline";
  const initialBudget = body.initialBudget ?? 300000;
  const numPaths = Math.min(Math.max(body.numPaths ?? 10000, 1000), 100000);
  const tradesPerPath = Math.min(
    Math.max(body.tradesPerPath ?? 1000, 100),
    5000,
  );
  const ruinThreshold = Math.min(
    Math.max(body.ruinThreshold ?? 50, 10),
    90,
  );
  const riskPerTrade = Math.min(
    Math.max(body.riskPerTrade ?? 2, 0.5),
    5,
  );

  // パラメータ上限チェック
  if (numPaths * tradesPerPath > 500_000_000) {
    return c.json(
      { error: "パラメータが大きすぎます。パス数またはトレード数を減らしてください" },
      400,
    );
  }

  // 最新のバックテスト結果を取得
  const latest = await prisma.backtestDailyResult.findFirst({
    where: { conditionKey },
    orderBy: { date: "desc" },
    select: { fullResult: true },
  });

  if (!latest) {
    return c.json(
      { error: "指定された条件キーが見つかりません" },
      400,
    );
  }

  const fullResult = latest.fullResult as Record<string, unknown> | null;
  const tradeReturns = fullResult?.tradeReturns as number[] | undefined;

  if (!tradeReturns || !Array.isArray(tradeReturns)) {
    return c.json(
      { error: "トレードデータがありません。バックテストを再実行してください" },
      400,
    );
  }

  if (tradeReturns.length < 30) {
    return c.json(
      { error: "統計的に有意なシミュレーションには最低30トレードが必要です" },
      400,
    );
  }

  // avgStopLossPct = abs(avgLossPct)
  const avgLossPct = (fullResult?.avgLossPct as number) ?? 0;
  const avgStopLossPct = Math.abs(avgLossPct) || 3; // フォールバック 3%

  const config: MonteCarloConfig = {
    tradeReturns,
    initialBudget,
    numPaths,
    tradesPerPath,
    ruinThresholdPct: ruinThreshold,
    riskPerTradePct: riskPerTrade,
    avgStopLossPct,
  };

  const result = runMonteCarloSimulation(config);
  return c.json(result);
});
```

- [ ] **Step 2: TypeScriptのコンパイルが通ることを確認**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add src/web/routes/backtest.ts
git commit -m "feat: モンテカルロシミュレーションのAPIルートを追加"
```

---

### Task 6: バックテストページにモンテカルロUIセクションを追加

**Files:**
- Modify: `src/web/routes/backtest.ts` (HTMLセクション追加)

- [ ] **Step 1: conditionKey一覧を取得するクエリを追加**

`src/web/routes/backtest.ts` の `app.get("/", ...)` ハンドラ内、既存の `Promise.all` に条件キー一覧の取得を追加:

```typescript
const [latestResults, trendData, conditionKeys] = await Promise.all([
  // 最新日の結果（全条件）
  prisma.backtestDailyResult.findMany({
    orderBy: { date: "desc" },
    take: conditionCount,
    distinct: ["conditionKey"],
  }),
  // 履歴データ（過去30日、ベースラインのみ）
  prisma.backtestDailyResult.findMany({
    where: { date: { gte: sinceDate }, conditionKey: "baseline" },
    orderBy: { date: "asc" },
    select: {
      date: true,
      conditionKey: true,
      winRate: true,
      totalReturnPct: true,
      profitFactor: true,
      totalTrades: true,
    },
  }),
  // 条件キー一覧（モンテカルロ用）
  prisma.backtestDailyResult.findMany({
    orderBy: { date: "desc" },
    take: conditionCount,
    distinct: ["conditionKey"],
    select: { conditionKey: true, conditionLabel: true },
  }),
]);
```

- [ ] **Step 2: モンテカルロセクションのHTMLをページ末尾に追加**

`src/web/routes/backtest.ts` の `content = html\`...\`` 内、`<!-- 詳細モーダル -->` の直前に追加:

```typescript
    <!-- モンテカルロシミュレーション -->
    <p class="section-title">モンテカルロシミュレーション（破産確率）</p>
    <div class="card" style="padding:16px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:12px">
        <label style="font-size:12px;color:${COLORS.textDim}">
          条件
          <select id="mc-condition" style="width:100%;margin-top:4px;padding:6px;background:${COLORS.bg};color:${COLORS.text};border:1px solid ${COLORS.border};border-radius:6px">
            ${conditionKeys.map(
              (k) =>
                html`<option value="${k.conditionKey}" ${k.conditionKey === "baseline" ? "selected" : ""}>
                  ${k.conditionLabel}
                </option>`,
            )}
          </select>
        </label>
        <label style="font-size:12px;color:${COLORS.textDim}">
          初期資金
          <input id="mc-budget" type="number" value="300000" min="100000" max="10000000" step="100000"
            style="width:100%;margin-top:4px;padding:6px;background:${COLORS.bg};color:${COLORS.text};border:1px solid ${COLORS.border};border-radius:6px" />
        </label>
        <label style="font-size:12px;color:${COLORS.textDim}">
          パス数
          <input id="mc-paths" type="number" value="10000" min="1000" max="100000" step="1000"
            style="width:100%;margin-top:4px;padding:6px;background:${COLORS.bg};color:${COLORS.text};border:1px solid ${COLORS.border};border-radius:6px" />
        </label>
        <label style="font-size:12px;color:${COLORS.textDim}">
          トレード数
          <input id="mc-trades" type="number" value="1000" min="100" max="5000" step="100"
            style="width:100%;margin-top:4px;padding:6px;background:${COLORS.bg};color:${COLORS.text};border:1px solid ${COLORS.border};border-radius:6px" />
        </label>
        <label style="font-size:12px;color:${COLORS.textDim}">
          破産閾値(%)
          <input id="mc-ruin" type="number" value="50" min="10" max="90" step="5"
            style="width:100%;margin-top:4px;padding:6px;background:${COLORS.bg};color:${COLORS.text};border:1px solid ${COLORS.border};border-radius:6px" />
        </label>
        <label style="font-size:12px;color:${COLORS.textDim}">
          リスク率(%)
          <input id="mc-risk" type="number" value="2" min="0.5" max="5" step="0.5"
            style="width:100%;margin-top:4px;padding:6px;background:${COLORS.bg};color:${COLORS.text};border:1px solid ${COLORS.border};border-radius:6px" />
        </label>
      </div>
      <button id="mc-run" onclick="runMonteCarlo()"
        style="padding:8px 20px;background:${COLORS.accent};color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px">
        シミュレーション実行
      </button>

      <!-- 結果エリア（初期は非表示） -->
      <div id="mc-results" style="display:none;margin-top:16px">
        <!-- サマリカード -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
          <div style="text-align:center;padding:12px;background:${COLORS.bg};border-radius:8px;border:1px solid ${COLORS.border}">
            <div style="font-size:11px;color:${COLORS.textDim}">破産確率</div>
            <div id="mc-ruin-prob" style="font-size:24px;font-weight:700;margin-top:4px">-</div>
          </div>
          <div style="text-align:center;padding:12px;background:${COLORS.bg};border-radius:8px;border:1px solid ${COLORS.border}">
            <div style="font-size:11px;color:${COLORS.textDim}">最大DD(95%)</div>
            <div id="mc-max-dd" style="font-size:24px;font-weight:700;margin-top:4px;color:${COLORS.loss}">-</div>
          </div>
          <div style="text-align:center;padding:12px;background:${COLORS.bg};border-radius:8px;border:1px solid ${COLORS.border}">
            <div style="font-size:11px;color:${COLORS.textDim}">最終資産中央値</div>
            <div id="mc-final-eq" style="font-size:24px;font-weight:700;margin-top:4px">-</div>
          </div>
        </div>

        <!-- DD到達率テーブル -->
        <div class="table-wrap" style="margin-bottom:16px">
          <table>
            <thead><tr><th>ドローダウン</th><th>到達確率</th></tr></thead>
            <tbody id="mc-dd-table"></tbody>
          </table>
        </div>

        <!-- ファンチャート -->
        <div id="mc-chart" style="margin-bottom:16px"></div>

        <!-- 入力データ -->
        <div id="mc-input-stats" style="font-size:12px;color:${COLORS.textDim}"></div>
      </div>

      <!-- ローディング -->
      <div id="mc-loading" style="display:none;text-align:center;padding:24px;color:${COLORS.textDim}">
        シミュレーション実行中...
      </div>

      <!-- エラー -->
      <div id="mc-error" style="display:none;padding:12px;color:${COLORS.loss};background:rgba(239,68,68,0.1);border-radius:8px;margin-top:12px"></div>
    </div>
```

- [ ] **Step 3: コミット**

```bash
git add src/web/routes/backtest.ts
git commit -m "feat: バックテストページにモンテカルロUIセクションを追加"
```

---

### Task 7: クライアントサイドJavaScriptを追加

**Files:**
- Modify: `src/web/routes/backtest.ts` (script セクション)

- [ ] **Step 1: モンテカルロ実行・描画のJavaScriptを追加**

`src/web/routes/backtest.ts` の既存 `<script>` タグ内（`closeBacktestDetail` 関数の後、`document.addEventListener('keydown'` の前）に追加:

```javascript
      // --- モンテカルロシミュレーション ---
      async function runMonteCarlo() {
        var results = document.getElementById('mc-results');
        var loading = document.getElementById('mc-loading');
        var errorEl = document.getElementById('mc-error');
        var btn = document.getElementById('mc-run');

        results.style.display = 'none';
        errorEl.style.display = 'none';
        loading.style.display = 'block';
        btn.disabled = true;

        try {
          var resp = await fetch('/backtest/api/monte-carlo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conditionKey: document.getElementById('mc-condition').value,
              initialBudget: Number(document.getElementById('mc-budget').value),
              numPaths: Number(document.getElementById('mc-paths').value),
              tradesPerPath: Number(document.getElementById('mc-trades').value),
              ruinThreshold: Number(document.getElementById('mc-ruin').value),
              riskPerTrade: Number(document.getElementById('mc-risk').value),
            }),
          });

          var data = await resp.json();

          if (!resp.ok) {
            errorEl.textContent = data.error || 'エラーが発生しました';
            errorEl.style.display = 'block';
            return;
          }

          // サマリ更新
          var ruinPct = (data.ruinProbability * 100).toFixed(1);
          var ruinEl = document.getElementById('mc-ruin-prob');
          ruinEl.textContent = ruinPct + '%';
          if (data.ruinProbability < 0.01) {
            ruinEl.style.color = '#22c55e';
          } else if (data.ruinProbability < 0.05) {
            ruinEl.style.color = '#3b82f6';
          } else if (data.ruinProbability < 0.10) {
            ruinEl.style.color = '#f59e0b';
          } else {
            ruinEl.style.color = '#ef4444';
          }

          document.getElementById('mc-max-dd').textContent = '-' + data.maxDrawdownPercentiles.p95 + '%';

          var finalEq = data.finalEquityPercentiles.p50;
          var budget = Number(document.getElementById('mc-budget').value);
          var retPct = ((finalEq - budget) / budget * 100).toFixed(1);
          var fEl = document.getElementById('mc-final-eq');
          fEl.textContent = '¥' + finalEq.toLocaleString('ja-JP');
          fEl.style.color = finalEq >= budget ? '#22c55e' : '#ef4444';

          // DD到達率テーブル
          var tbody = document.getElementById('mc-dd-table');
          tbody.innerHTML = [
            ['10%', data.thresholdBreachRates.dd10],
            ['20%', data.thresholdBreachRates.dd20],
            ['30%', data.thresholdBreachRates.dd30],
            ['50% (=破産)', data.thresholdBreachRates.dd50],
          ].map(function(row) {
            return '<tr><td>' + row[0] + '</td><td>' + (row[1] * 100).toFixed(1) + '%</td></tr>';
          }).join('');

          // ファンチャート描画
          drawFanChart(data, budget);

          // 入力データ
          var s = data.inputStats;
          document.getElementById('mc-input-stats').textContent =
            '入力: 勝率' + s.winRate + '% / 平均利益+' + s.avgWinPct.toFixed(2) + '% / 平均損失' + s.avgLossPct.toFixed(2) + '% / サンプル' + s.totalTrades + 'トレード / 期待値' + s.expectancy.toFixed(2) + '%';

          results.style.display = 'block';
        } catch (e) {
          errorEl.textContent = 'ネットワークエラーが発生しました';
          errorEl.style.display = 'block';
        } finally {
          loading.style.display = 'none';
          btn.disabled = false;
        }
      }

      function drawFanChart(data, budget) {
        var container = document.getElementById('mc-chart');
        var W = 640, H = 280;
        var pad = { top: 20, right: 20, bottom: 30, left: 60 };
        var cw = W - pad.left - pad.right;
        var ch = H - pad.top - pad.bottom;

        var curves = data.equityCurves;
        var len = curves.p50.length;

        // Y軸範囲
        var allVals = curves.p5.concat(curves.p95);
        var minY = Math.min.apply(null, allVals.concat([0]));
        var maxY = Math.max.apply(null, allVals);
        var rangeY = maxY - minY || 1;

        function x(i) { return pad.left + (i / (len - 1)) * cw; }
        function y(v) { return pad.top + ch - ((v - minY) / rangeY) * ch; }

        // SVGパスを生成
        function pathD(arr) {
          return arr.map(function(v, i) {
            return (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ',' + y(v).toFixed(1);
          }).join(' ');
        }

        // 帯（area）を生成
        function areaD(upper, lower) {
          var fwd = upper.map(function(v, i) { return x(i).toFixed(1) + ',' + y(v).toFixed(1); });
          var rev = lower.slice().reverse().map(function(v, i) {
            var idx = lower.length - 1 - i;
            return x(idx).toFixed(1) + ',' + y(v).toFixed(1);
          });
          return 'M' + fwd.join(' L') + ' L' + rev.join(' L') + ' Z';
        }

        var ruinLevel = budget * (1 - Number(document.getElementById('mc-ruin').value) / 100);

        var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + W + 'px">'
          // p5-p95 帯
          + '<path d="' + areaD(curves.p95, curves.p5) + '" fill="#3b82f6" fill-opacity="0.12" />'
          // p25-p75 帯
          + '<path d="' + areaD(curves.p75, curves.p25) + '" fill="#3b82f6" fill-opacity="0.25" />'
          // p50 中央線
          + '<path d="' + pathD(curves.p50) + '" fill="none" stroke="#3b82f6" stroke-width="2" />'
          // 破産ライン
          + '<line x1="' + pad.left + '" y1="' + y(ruinLevel).toFixed(1) + '" x2="' + (W - pad.right) + '" y2="' + y(ruinLevel).toFixed(1) + '" stroke="#ef4444" stroke-dasharray="6,4" stroke-width="1" />'
          + '<text x="' + (W - pad.right - 4) + '" y="' + (y(ruinLevel) - 4).toFixed(1) + '" text-anchor="end" fill="#ef4444" font-size="9">破産ライン</text>'
          // 初期資金ライン
          + '<line x1="' + pad.left + '" y1="' + y(budget).toFixed(1) + '" x2="' + (W - pad.right) + '" y2="' + y(budget).toFixed(1) + '" stroke="#334155" stroke-dasharray="4" stroke-width="1" />'
          // Y軸ラベル
          + '<text x="' + (pad.left - 4) + '" y="' + (pad.top + 4) + '" text-anchor="end" fill="#64748b" font-size="9">¥' + maxY.toLocaleString('ja-JP') + '</text>'
          + '<text x="' + (pad.left - 4) + '" y="' + (pad.top + ch + 4) + '" text-anchor="end" fill="#64748b" font-size="9">¥' + Math.max(0, minY).toLocaleString('ja-JP') + '</text>'
          // X軸ラベル
          + '<text x="' + pad.left + '" y="' + (H - 4) + '" text-anchor="start" fill="#64748b" font-size="9">0</text>'
          + '<text x="' + (W - pad.right) + '" y="' + (H - 4) + '" text-anchor="end" fill="#64748b" font-size="9">' + (len - 1) + ' trades</text>'
          + '</svg>';

        container.innerHTML = svg;
      }
```

- [ ] **Step 2: COLORS importを追加**

`src/web/routes/backtest.ts` のimportセクションに追加（既存のimportの後）:

```typescript
import { COLORS } from "../views/styles";
```

現在のファイルには `COLORS` のインポートがないので必ず追加すること。

- [ ] **Step 3: TypeScriptのコンパイルが通ることを確認**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: エラーなし

- [ ] **Step 4: コミット**

```bash
git add src/web/routes/backtest.ts
git commit -m "feat: モンテカルロシミュレーションのクライアントサイドJS描画を追加"
```

---

### Task 8: 動作確認

**Files:** なし（手動テスト）

- [ ] **Step 1: ローカルサーバーを起動して動作確認**

Run: `npm run dev`

ブラウザで `/backtest` を開き:
1. ページ下部に「モンテカルロシミュレーション（破産確率）」セクションが表示される
2. 条件ドロップダウンに各条件が表示される
3. 「シミュレーション実行」ボタンをクリック
4. ローディング表示後、結果が表示される（破産確率、DD、最終資産）
5. ファンチャートが表示される（帯+中央線+破産ライン）
6. エラーケース: tradeReturns がない古いデータの場合、エラーメッセージが表示される

- [ ] **Step 2: 全テストが通ることを確認**

Run: `npx vitest run`
Expected: 全テスト PASS

- [ ] **Step 3: 最終コミット**

```bash
git add -A
git commit -m "feat: KOH-368 モンテカルロシミュレーション（破産確率推定）を実装"
```
