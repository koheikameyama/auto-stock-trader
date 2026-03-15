# モンテカルロシミュレーション（破産確率の推定）設計書

## 概要

バックテスト結果の個別トレード損益データを用いたモンテカルロシミュレーションにより、破産確率を推定する。リスク管理の妥当性を定量的に検証し、ポジションサイジングや初期資金の適切性を評価する。

## 要件

- バックテスト結果から個別トレード損益%を自動取得
- トレード単位ブートストラップ法（復元抽出）でN本のパスを生成
- 破産確率、最終資産分布、最大ドローダウン分布を算出
- エクイティカーブのファンチャートで結果を可視化
- APIオンデマンド実行（DB保存なし）
- バックテストページ（`/backtest`）に統合

## 前提条件: データソースの準備

### 現状の問題

現在の日次バックテストジョブ（`src/jobs/daily-backtest.ts`）は `fullResult` に `PerformanceMetrics`（集約統計のみ）を保存しており、個別トレード損益データ（`SimulatedPosition.pnlPct`）は保存していない。

### 必要な変更（2ファイル）

#### 1. `src/backtest/daily-runner.ts` の修正

`DailyBacktestConditionResult` インターフェースに `tradeReturns` フィールドを追加し、`conditionResults.push()` で値を設定する。現在の `runDailyBacktest()` は `runBacktest()` の結果から `result.metrics` のみを保持し、`result.trades`（`SimulatedPosition[]`）を破棄している。

```typescript
// DailyBacktestConditionResult に追加
interface DailyBacktestConditionResult {
  condition: string;
  config: BacktestConfig;
  metrics: PerformanceMetrics;
  tradeReturns: number[];  // ← 追加
  tickerCount: number;
  executionTimeMs: number;
}

// conditionResults.push() で tradeReturns を設定
conditionResults.push({
  condition: conditionName,
  config,
  metrics: result.metrics,
  tradeReturns: result.trades           // ← 追加
    .filter((t) => t.pnlPct !== null)
    .map((t) => t.pnlPct as number),
  tickerCount: tickers.length,
  executionTimeMs: elapsed,
});
```

#### 2. `src/jobs/daily-backtest.ts` の修正

`fullResult` 保存時に `tradeReturns` を含める。

```typescript
// 変更前:
fullResult: cr.metrics as object,

// 変更後:
fullResult: {
  ...cr.metrics,
  tradeReturns: cr.tradeReturns,
} as object,
```

**補足**: `tradeReturns` は数値の配列のみで、個別トレードの全フィールド（ticker, entryDate等）は含めない。これによりデータサイズの増加を最小限に抑える（1条件あたり数百バイト程度の増加）。

**既存データへの対応**: `tradeReturns` が存在しない古い `fullResult` レコードの場合、APIはエラーを返す（「バックテストを再実行してください」）。

## アルゴリズム

### トレード単位ブートストラップ法

1. `BacktestDailyResult` の最新レコードから `fullResult.tradeReturns` を取得
2. N本のパスを生成（デフォルト10,000パス）
3. 各パスで以下を繰り返す（デフォルト1,000トレード）:
   a. `tradeReturns` からランダムに1つ復元抽出
   b. リスクベースのポジションサイジングで損益額を算出
   c. 資金を更新
   d. 資金が破産閾値（初期資金の50%以下）に到達したら破産フラグ
4. 全パスの統計を集計

### ポジションサイジング

実際のシステムと同じリスクベースのポジションサイジングを適用。資金が減ると自動的にポジションサイズも縮小される（幾何的効果を正しく反映）。

```
riskAmount = currentEquity * riskPerTradePct
pnl = riskAmount * (sampledReturnPct / avgStopLossPct)
currentEquity += pnl
```

**`avgStopLossPct` の定義**: `PerformanceMetrics.avgLossPct` の絶対値を使用する。これは実際の平均損切り執行幅を表す。例: `avgLossPct = -3.1%` → `avgStopLossPct = 3.1%`。

**計算の意味**: `sampledReturnPct / avgStopLossPct` は「リスク量に対する実現リターンの倍率」を表す。例えば損切り幅3.1%のトレードで+6.2%の利益が出た場合、リスクの2倍（2R）のリターンとなる。

### 破産の定義

- メイン閾値: 初期資金から50%ドローダウン（業界標準）
- 中間閾値: 10%, 20%, 30%ドローダウン到達率も併せて表示

### 破産確率の評価基準

| 破産確率 | 評価 | 色 |
|---------|------|-----|
| < 1% | 非常に良好 | 緑 |
| 1% - 5% | 良好 | 青 |
| 5% - 10% | 注意 | 黄 |
| > 10% | 危険 | 赤 |

### エクイティカーブのパーセンタイル計算

各トレードステップTにおいて、全N本のパスの `equity[T]` を収集し、パーセンタイルを算出する。

- 配列の長さ: `tradesPerPath + 1`（初期資金を含む）
- 破産したパス: 破産後の equity は 0 として扱う（破産 = 資金喪失）
- チャート用にデータポイントを間引く: `tradesPerPath > 200` の場合、等間隔で200点にサンプリング

### エラーハンドリング

| ケース | レスポンス |
|-------|-----------|
| `conditionKey` が存在しない | 400: 「指定された条件キーが見つかりません」 |
| `tradeReturns` が `fullResult` に存在しない | 400: 「トレードデータがありません。バックテストを再実行してください」 |
| トレード数が30未満 | 400: 「統計的に有意なシミュレーションには最低30トレードが必要です」 |
| パス数 × トレード数 > 5億 | 400: 「パラメータが大きすぎます。パス数またはトレード数を減らしてください」 |

## API設計

### エンドポイント

```
POST /api/backtest/monte-carlo
```

### リクエスト

```typescript
interface MonteCarloRequest {
  conditionKey: string;    // バックテスト条件キー（"baseline" など）
  initialBudget: number;   // 初期資金（デフォルト: 300000）
  numPaths: number;        // パス数（デフォルト: 10000）
  tradesPerPath: number;   // トレード数/パス（デフォルト: 1000）
  ruinThreshold: number;   // 破産DD%（デフォルト: 50）
  riskPerTrade: number;    // リスク率%（デフォルト: 2）
}
```

### レスポンス

```typescript
interface MonteCarloResponse {
  // 基本統計
  ruinProbability: number;          // 破産確率 (例: 0.023 = 2.3%)
  totalPaths: number;
  ruinedPaths: number;

  // 最終資産の分布（パーセンタイル）
  finalEquityPercentiles: {
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
  };

  // 最大ドローダウン分布（パーセンタイル）
  maxDrawdownPercentiles: {
    p5: number;
    p50: number;
    p95: number;
  };

  // 中間閾値到達率
  thresholdBreachRates: {
    dd10: number;
    dd20: number;
    dd30: number;
    dd50: number;  // = ruinProbability
  };

  // エクイティカーブ（チャート用、パーセンタイルパス、最大200点に間引き）
  equityCurves: {
    p5: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p95: number[];
  };

  // 入力に使ったトレード統計
  inputStats: {
    totalTrades: number;       // サンプル元のトレード数
    winRate: number;           // 勝率
    avgWinPct: number;         // 平均利益%
    avgLossPct: number;        // 平均損失%
    expectancy: number;        // 期待値 = (winRate × avgWinPct) + ((1 - winRate) × avgLossPct)
  };
}
```

### データ取得フロー

```
API呼び出し
  → conditionKeyでBacktestDailyResultの最新レコードを取得
  → fullResult JSON内のtradeReturns配列を抽出
  → tradeReturnsが存在しない場合はエラー返却
  → トレード数が30未満の場合はエラー返却
  → PerformanceMetricsからavgLossPctを取得し、avgStopLossPct = abs(avgLossPct)
  → モンテカルロシミュレーション実行
  → 結果を返却（DB保存なし）
```

### 有効な conditionKey

バックテスト条件キーは `src/backtest/daily-runner.ts` で定義されている。UIのドロップダウンは `BacktestDailyResult` テーブルから最新日付の全レコードの `conditionKey` を動的に取得して表示する。

## ファイル構成

### 新規ファイル

```
src/
  core/
    monte-carlo.ts              # コアシミュレーションエンジン（純粋関数）
  web/
    views/
      monte-carlo.ts            # モンテカルロUI描画関数（Hono HTMLテンプレート）
```

### 既存ファイル（変更）

```
src/
  web/
    routes/
      backtest.ts               # モンテカルロセクションHTML追加 + APIルート追加
  backtest/
    daily-runner.ts             # DailyBacktestConditionResultにtradeReturns追加
  jobs/
    daily-backtest.ts           # fullResultにtradeReturnsを追加保存
```

## モジュール責務

| モジュール | 責務 | 依存 |
|-----------|------|------|
| `monte-carlo.ts` (core) | シミュレーション実行、統計計算 | なし（純粋関数） |
| `monte-carlo.ts` (views) | UIコンポーネントのHTML生成 | なし |
| `backtest.ts` (既存routes) | APIルート追加 + ページにモンテカルロセクション追加 | core/monte-carlo.ts, Prisma |
| `daily-runner.ts` (既存backtest) | DailyBacktestConditionResultにtradeReturns追加 | なし |
| `daily-backtest.ts` (既存jobs) | fullResult保存時にtradeReturns含める | なし |

## コアエンジンインターフェース

```typescript
// src/core/monte-carlo.ts

interface MonteCarloConfig {
  tradeReturns: number[];     // 個別トレード損益%のリスト
  initialBudget: number;
  numPaths: number;
  tradesPerPath: number;
  ruinThresholdPct: number;   // 50 = 50%ドローダウンで破産
  riskPerTradePct: number;    // 2 = 資金の2%
  avgStopLossPct: number;     // abs(avgLossPct) = 平均損切り執行幅
}

function runMonteCarloSimulation(config: MonteCarloConfig): MonteCarloResult;
```

コアエンジンは純粋関数として実装し、外部依存なし。テストが容易で、将来的にWeb Workerに移動も可能。

## UI設計

### アーキテクチャ

バックテストページは **Hono SSR**（サーバーサイドレンダリング）で構築されている。モンテカルロセクションも同じアーキテクチャに従う。

- **サーバー側**: Hono `html` テンプレートリテラルで設定フォーム・結果サマリ・チャートコンテナのHTMLを生成
- **クライアント側**: インラインJavaScriptでAPIコール・チャート描画（SVG）を実行
- **チャート**: 既存のバックテストページのSVGスパークライン描画パターン（`src/web/views/components.ts`）を拡張したファンチャートをクライアントサイドJSで描画

### バックテストページへの統合

既存の `/backtest` ページの下部に「モンテカルロシミュレーション」セクションを追加。

### レイアウト構成

1. **設定パネル**: 条件キー選択（ドロップダウン）、初期資金、パス数、トレード数、破産閾値、リスク率の入力フォームと「シミュレーション実行」ボタン
2. **結果サマリ**: 破産確率（評価色付き）、最大DD中央値、最終資産中央値をカードで表示
3. **ドローダウン到達率テーブル**: 10%/20%/30%/50%DDの到達確率
4. **エクイティカーブファンチャート**: 5パーセンタイルパス（p5, p25, p50, p75, p95）を半透明SVGパスで描画。破産ラインを点線で表示
5. **入力データ表示**: シミュレーションに使用した勝率・平均損益・期待値を表示

### クライアントサイドJSの動作フロー

```
1. ユーザーが「シミュレーション実行」ボタンをクリック
2. フォームの値を収集してPOST /api/backtest/monte-carlo にリクエスト
3. ローディング表示
4. レスポンスを受け取り:
   a. 結果サマリのDOMを更新
   b. ドローダウン到達率テーブルを更新
   c. SVGファンチャートを動的生成してコンテナに挿入
5. エラー時はエラーメッセージを表示
```

### ファンチャートのSVG描画

5本のパーセンタイルパスを以下の要素で構成:

- **帯（Area）**: p5-p95間、p25-p75間を半透明の塗りつぶし（`fill-opacity: 0.15` / `0.3`）
- **中央線**: p50を実線で描画
- **破産ライン**: 初期資金の50%の位置に赤の点線
- **Y軸**: 資産額（¥）
- **X軸**: トレード回数

### 入力パラメータの範囲

| パラメータ | デフォルト | 範囲 |
|-----------|-----------|------|
| 初期資金 | 300,000 | 100,000 - 10,000,000 |
| パス数 | 10,000 | 1,000 - 100,000 |
| トレード数/パス | 1,000 | 100 - 5,000 |
| 破産閾値 | 50% | 10% - 90% |
| リスク率/トレード | 2% | 0.5% - 5% |

## 設計判断の根拠

### トレード単位ブートストラップを選択した理由

- **ファットテールの反映**: 正規分布仮定（パラメトリック法）と異なり、実際のリターン分布がそのまま反映される
- **実装のシンプルさ**: 日次リターンブートストラップと比べ、「トレード1000回」という単位が直感的
- **データ基盤の活用**: バックテストの個別トレード損益をfullResultに追加保存することで取得可能

### DB保存なしの理由

- オンデマンド実行でパラメータを変えて試行錯誤する使い方が主
- 計算結果は数秒で再現可能（決定論的ではないが統計的に同等）
- DB容量（Railway 500MB上限）を消費しない

### Hono SSR + クライアントサイドJSを選択した理由

- 既存のバックテストページがHono SSRで構築されているため、同じアーキテクチャに合わせる
- SVGチャートはクライアントサイドJSで動的生成（APIレスポンスのデータを使うため）
- Rechartsなどの外部ライブラリは不要（SVGパスの直接描画で十分）
