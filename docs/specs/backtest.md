# バックテスト仕様

## 概要

スコアリング→エントリー→TP/SL判定のロジック層を、ヒストリカルデータでシミュレーションするCLIツール。
AI部分（Go/No-Go判断）は対象外。API呼び出しが膨大になるため、純粋なロジックのみを検証する。

## 目的

- 戦略パラメータ変更の効果を即座に検証（フォワードテストだと数週間かかる）
- スコア閾値・利確/損切り幅の最適値を感度分析で探索
- ランク別（S/A/B）の勝率を把握し、エントリー基準を調整

## ディレクトリ構成

```
src/backtest/
  run.ts                 # CLIエントリポイント
  types.ts               # 型定義
  data-fetcher.ts        # Yahoo Financeデータ取得
  simulation-engine.ts   # 日次シミュレーションループ
  metrics.ts             # パフォーマンス指標算出
  sensitivity.ts         # パラメータ感度分析
  reporter.ts            # コンソール・JSON出力
```

## 使い方

```bash
# 基本（銘柄指定は必須、¥1,000以下の銘柄のみ対象）
npm run backtest -- --tickers 5401,9501 --start-date 2025-09-01

# 詳細ログ（個別トレードの約定・決済を表示）
npm run backtest -- --tickers 5401,9501 --start-date 2025-09-01 --verbose

# パラメータ感度分析
npm run backtest -- --tickers 5401,9501 --start-date 2025-09-01 --sensitivity

# カスタムパラメータ
npm run backtest -- --tickers 5401 --tp-ratio 1.05 --atr-multiplier 1.5

# JSON出力
npm run backtest -- --tickers 5401,9501 --output results.json

# ヘルプ
npm run backtest -- --help
```

## CLIオプション

| オプション | 説明 | デフォルト |
|---|---|---|
| `--tickers <codes>` | 銘柄コード（カンマ区切り） | **必須** |
| `--start-date <YYYY-MM-DD>` | 開始日 | 6ヶ月前 |
| `--end-date <YYYY-MM-DD>` | 終了日 | 今日 |
| `--budget <yen>` | 初期資金 | 100,000 |
| `--max-positions <n>` | 最大同時保有数 | 3 |
| `--score-threshold <n>` | エントリーするスコア閾値 | 65 |
| `--tp-ratio <n>` | 利確比率（1.03 = 3%利確） | 1.03 |
| `--sl-ratio <n>` | 損切比率（0.98 = 2%損切） | 0.98 |
| `--atr-multiplier <n>` | ATR倍率（損切幅の調整） | 1.0 |
| `--strategy <type>` | `day_trade` or `swing` | swing |
| `--sensitivity` | パラメータ感度分析を実行 | off |
| `--output <path>` | JSON結果を出力 | なし |
| `--verbose` | 詳細ログ | off |

## シミュレーションロジック

### 日次ループ

各営業日Dについて以下を実行:

```
1. ペンディング注文のフィル判定
   - 前日に出した指値注文を、D日の安値と比較
   - 安値 <= 指値 → 約定

2. オープンポジションのTP/SL判定
   - D日の高値 >= 利確価格 → 利確クローズ
   - D日の安値 <= 損切価格 → 損切クローズ
   - 両方ヒット → 保守的にSL優先

3. 新規エントリー評価（ポジション枠に空きがある場合）
   a. D日までの履歴でテクニカル分析
   b. チャートパターン・ローソク足パターン検出
   c. 3カテゴリ100点スコアリング
   d. スコア >= 閾値 かつ 即死ルール非該当 → エントリー条件算出
   e. D+1日でフィル判定（翌日の安値で約定チェック）

4. エクイティスナップショット記録
```

### 重要な設計判断

- **D日分析→D+1フィル**: リアルなタイムラグを再現。D日のクロージングデータで分析し、翌営業日に指値注文が約定するかチェック
- **同一銘柄の重複禁止**: 1銘柄につき1ポジションまで
- **TP/SLの上書き**: `calculateEntryCondition()` の結果に対して、CLIで指定したTP/SL/ATRパラメータを上書き適用（既存コード無変更）
- **weeklyVolatility**: 直近5日の日次リターンの標準偏差から算出（DBアクセス不要）
- **ウォームアップ**: 開始日の120日前からデータ取得（SMA75等の指標計算に必要）

### 再利用するコアモジュール

| モジュール | 関数 |
|---|---|
| `core/technical-analysis.ts` | `analyzeTechnicals()` |
| `core/technical-scorer.ts` | `scoreTechnicals()` |
| `core/entry-calculator.ts` | `calculateEntryCondition()` |
| `lib/chart-patterns.ts` | `detectChartPatterns()` |
| `lib/candlestick-patterns.ts` | `analyzeSingleCandle()` |

## パフォーマンス指標

| 指標 | 説明 |
|---|---|
| 勝率 | wins / (wins + losses) |
| 平均利益% | 勝ちトレードの平均損益率 |
| 平均損失% | 負けトレードの平均損益率 |
| プロフィットファクター (PF) | 総利益 / 総損失 |
| 最大ドローダウン (DD) | エクイティカーブのピークからの最大下落率 |
| シャープレシオ | 日次リターンから年率換算（√252） |
| 平均保有日数 | クローズ済みトレードの平均 |
| ランク別集計 | S/A/B ランクごとの勝率・平均損益 |

## パラメータ感度分析

`--sensitivity` フラグで、以下の16パターンを自動実行:

| パラメータ | テスト値 |
|---|---|
| スコア閾値 | 60, 65, 70, 75, 80 |
| 利確比率 | 1.02, 1.03, 1.04, 1.05 |
| 損切比率 | 0.97, 0.98, 0.99 |
| ATR倍率 | 0.8, 1.0, 1.2, 1.5 |

データ取得は1回のみ。パラメータを変えてシミュレーションを繰り返すため高速。

## 出力例

### コンソール出力

```
==================================================
  バックテスト結果
==================================================
  期間: 2025-09-01 ~ 2026-03-07
  銘柄数: 2, 初期資金: ¥100,000
  戦略: swing, スコア閾値: 65

--------------------------------------------------
  パフォーマンス
--------------------------------------------------
  トレード数: 23 (勝: 11, 負: 12)
  勝率: 47.83%
  平均利益: +3% / 平均損失: -3.55%
  PF: 0.71 / 最大DD: -16.8%
  累計損益: -¥8,500 (-8.5%)

--------------------------------------------------
  ランク別
--------------------------------------------------
  ランク  取引数  勝率     平均損益
  S         4      25%   -1.69%
  A        19   52.63%   -0.15%
```

### JSON出力

`--output results.json` で以下を出力:

```json
{
  "backtest": {
    "config": { ... },
    "trades": [ ... ],
    "equityCurve": [ ... ],
    "metrics": { ... }
  },
  "sensitivity": [ ... ],
  "generatedAt": "2026-03-09T..."
}
```

## 制約・注意事項

- **即死ルール**: 株価>¥1,000の銘柄はスコア0点でスキップされる
- **AIなし**: AI判断（Go/No-Go）はバイパス。スコアが閾値以上なら機械的にエントリー
- **DBアクセスなし**: 全てインメモリで完結。本番DBへの影響なし
- **Yahoo Finance制限**: 銘柄数が多いとレート制限に注意。同時3リクエスト、バッチ間2秒遅延で対処

## 日次自動バックテスト

### 概要

毎日16:30 JST（平日）に自動実行され、4つの資金帯でバックテストを実施。戦略の有効性を日々トラッキングする。

### ファイル構成

```
src/lib/constants/backtest.ts    -- 予算ティア・デフォルトパラメータ定数
src/backtest/daily-runner.ts     -- 銘柄選定→データ取得→4ティア実行
src/jobs/daily-backtest.ts       -- ジョブ: DB保存+Slack通知
src/web/routes/backtest.ts       -- ダッシュボードページ
```

### 資金帯（ティア）

| ティア | 初期資金 | 価格上限 | 最大ポジション |
|--------|----------|----------|----------------|
| 10万 | ¥100,000 | ¥1,000 | 3 |
| 30万 | ¥300,000 | ¥3,000 | 3 |
| 50万 | ¥500,000 | ¥5,000 | 5 |
| 100万 | ¥1,000,000 | ¥10,000 | 5 |

価格上限 = 初期資金 ÷ 100（日本株の最低売買単位=100株で1ロット買える価格上限）。

### 銘柄選定ロジック

1. ScoringRecordから直近30日のS/Aランク銘柄をdistinctで取得
2. 5件未満ならBランクも含める
3. ScoringRecordが空の場合、Stockテーブルから出来高上位50銘柄を取得

### バックテスト期間

ローリング6ヶ月。当日から6ヶ月前まで。

### 実行フロー

1. 銘柄選定（`selectTickers()`）
2. Yahoo Financeからデータを**1回だけ**一括取得
3. 4つの資金帯それぞれで`runBacktest()`を実行
4. 結果をDB保存（`BacktestDailyResult`テーブルにupsert、`@@unique([date, budgetTier])`で冪等）
5. Slack通知

### スケジュール

- **定時実行**: 16:30 JST / 平日（市場営業日のみ）
- **catch-up**: 17:00以降で当日分のBacktestDailyResultが0件なら自動実行

### DBモデル: BacktestDailyResult

1日4レコード（ティアごと）。

| カラム | 型 | 説明 |
|--------|-----|------|
| date | Date | 実行日 |
| budgetTier | String | "10万" / "30万" / "50万" / "100万" |
| initialBudget | Int | 初期資金 |
| maxPrice / maxPositions | Int | ティア設定 |
| tickerCount | Int | 対象銘柄数 |
| totalTrades / wins / losses | Int | 取引結果 |
| winRate | Decimal(5,2) | 勝率 |
| profitFactor | Decimal(8,2) | PF（Infinityは999.99にキャップ） |
| maxDrawdown | Decimal(5,2) | 最大DD |
| sharpeRatio | Decimal(8,2)? | シャープレシオ |
| totalPnl | Int | 累計損益 |
| totalReturnPct | Decimal(8,2) | リターン率 |
| avgHoldingDays | Decimal(5,2) | 平均保有日数 |
| byRank | Json | ランク別集計 |
| periodStart / periodEnd | String | バックテスト期間 |

### ダッシュボード

`/backtest` ページで確認可能:

1. **最新結果テーブル** — 4ティア横並び（勝率/PF/リターン/DD/取引数）
2. **ティア別詳細** — `<details>`展開で初期資金・価格上限・勝敗・シャープレシオ等
3. **勝率トレンド** — ティアごとの30日sparklineチャート
4. **履歴テーブル** — 日付×ティアの一覧

### 手動実行

```bash
npm run daily-backtest
```
