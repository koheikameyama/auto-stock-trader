# ペーパートレード前方追跡 設計書

## 目的

ウォークフォワード検証で堅牢と判定された新パラメータ（ATR×1.0, トレール1.0, overrideTpSl=true）を、前方追跡（フォワードテスト）で実環境検証する。旧パラメータとの並行比較により、本番投入の Go/No-Go を判断する。

## スコープ

- 既存の daily-runner に前方追跡ステップを追加（新規スクリプト不要）
- DB スキーマ変更なし（既存 `BacktestDailyResult` テーブルを活用）
- Slack 通知にペーパートレード比較セクションを追加
- 約2ヶ月（40営業日目標。祝日により前後する）の追跡期間

## アーキテクチャ

### 変更ファイル

```
src/lib/constants/backtest.ts    <- PAPER_TRADE 設定を追加
src/backtest/daily-runner.ts     <- 前方追跡ロジックを追加
src/jobs/daily-backtest.ts       <- 前方追跡結果の保存・通知を追加
src/lib/slack.ts                 <- ペーパートレード比較セクションを追加
```

### 依存関係

- `runBacktest()` from `src/backtest/simulation-engine.ts`（変更なし）
- `BacktestDailyResult` テーブル（変更なし）
- daily-runner の既存データ取得結果（allData, vixData, candidateMap）を再利用

## 比較条件

新旧パラメータの全差分:

| パラメータ | 新ベースライン (`paper_new`) | 旧ベースライン (`paper_old`) |
|----------|--------------------------|--------------------------|
| overrideTpSl | true | false |
| atrMultiplier | 1.0（ATRベースSL） | ─（未使用。固定SL `stopLossRatio: 0.98`） |
| trailMultiplier | 1.0 | 2.0 |
| その他 | DEFAULT_PARAMS | DEFAULT_PARAMS（上記3点以外は同一） |

- 新ベースライン: DEFAULT_PARAMS そのまま（変更不要）
- 旧ベースライン: `{ overrideTpSl: false, trailMultiplier: 2.0 }` でオーバーライド

## データフロー

### DailyBacktestRunResult の拡張

```typescript
// 既存
export interface DailyBacktestRunResult {
  tickers: string[];
  periodStart: string;
  periodEnd: string;
  conditionResults: DailyBacktestConditionResult[];
  dataFetchTimeMs: number;
}

// 追加
export interface PaperTradeResult {
  newBaseline: DailyBacktestConditionResult;
  oldBaseline: DailyBacktestConditionResult;
  periodStart: string;  // TRACKING_START_DATE
  periodEnd: string;    // 今日の日付
  elapsedTradingDays: number;
  judgment: "go" | "tracking" | "no_go";
  judgmentReasons: string[];  // 各基準の達成/未達成
}

export interface DailyBacktestRunResult {
  // ... 既存フィールド
  paperTradeResult?: PaperTradeResult;  // 前方追跡が有効な場合のみ
}
```

### フロー

```
既存 daily-runner フロー:
  1. データ取得（stocks, OHLCV, VIX, candidateMap）
  2. 22条件のバックテスト（LOOKBACK_MONTHS 期間）

追加ステップ（TRACKING_START_DATE が設定されている場合のみ）:
  3. 前方追跡バックテスト
     a. TRACKING_START_DATE → 今日の期間で新ベースライン実行
     b. 同期間で旧ベースライン実行
     c. allData, vixData, candidateMap は既存のものを再利用
     d. 経過営業日数を allData から算出（TRACKING_START_DATE 以降の取引日数をカウント）
     e. Go/No-Go 判定
  4. paperTradeResult を DailyBacktestRunResult に含めて返却
```

### パフォーマンス

- 追加データ取得: なし（daily-runner が取得済みの12ヶ月データに前方追跡期間が含まれる）
- 追加バックテスト: 2回（新 + 旧）。実行時間は数秒程度
- candidateMap: 既存のものを再利用。前方追跡期間の日付は candidateMap のカバー範囲内
  - scoring-record モードの場合、ScoringRecord が存在しない日はエントリー候補なしとなる（バッチ障害時。正常運用では毎日生成される）
  - on-the-fly モードの場合、全日付がカバーされる

## 定数設計

```typescript
PAPER_TRADE: {
  /** 前方追跡の開始日。null で無効化 */
  TRACKING_START_DATE: "2026-03-17" as string | null,
  /** Go判定に必要な営業日数（目安。祝日により前後する） */
  DURATION_TRADING_DAYS: 40,
  /** Go/No-Go 判定基準 */
  GO_CRITERIA: {
    /** 最低 Profit Factor */
    minPf: 1.2,
    /** 最大ドローダウン（%） */
    maxDd: 10,
    /** 最低トレード数 */
    minTrades: 30,
    /** No-Go 判定を開始する最低営業日数（早期誤判定を防ぐ） */
    minDaysForNoGo: 10,
    /** No-Go 相対比較の最低トレード数（両条件とも） */
    minTradesForComparison: 10,
  },
  /** 旧ベースラインのパラメータ（変更前の DEFAULT_PARAMS との差分） */
  OLD_BASELINE: {
    overrideTpSl: false,
    trailMultiplier: 2.0,
  },
}
```

## Go/No-Go 判定ロジック

### 判定基準

| 判定 | 条件 | 意味 |
|------|------|------|
| Go | 経過 ≥ 40日 かつ 新PF ≥ 1.2 かつ maxDD < 10% かつ トレード数 ≥ 30 | 本番投入OK |
| No-Go | 経過 ≥ 10日 かつ（新PF < 1.0 または maxDD ≥ 15%） | パラメータ再検討 |
| No-Go | 両条件トレード数 ≥ 10 かつ 新PF < 旧PF × 0.8 | 旧より明確に劣る |
| 追跡中 | 上記いずれにも該当しない | データ蓄積待ち |

**補足:**
- 経過10日未満はサンプル不足のため、No-Go 判定を行わない（早期誤判定の防止）
- PF 1.0〜1.2 かつ maxDD 10〜15% は「追跡中」として判定保留。40営業日到達時にこのゾーンにいる場合は追跡を延長する
- 新旧相対比較（新PF < 旧PF × 0.8）は両条件のトレード数が10件以上の場合のみ適用

### 経過日数の計算

allData（OHLCVデータ）内の TRACKING_START_DATE 以降の取引日数をカウントする。`BacktestDailyResult` のレコード数ではなく、市場データの取引日に基づくため、バッチ障害による欠損の影響を受けない。

### 初期挙動

TRACKING_START_DATE 直後はトレード数が0〜数件で、PF等のメトリクスが不安定になる。これは正常な動作であり、minDaysForNoGo（10日）ガードにより No-Go 誤判定を防ぐ。

## 出力

### Slack 通知データ構造

`notifyBacktestResult()` の引数に `paperTradeResult?: PaperTradeResult` を追加。既存の通知メッセージの末尾にペーパートレードセクションを追記する。

ログ出力は `[paper-trade]` プレフィックスで統一する。

### 追跡中

```
📊 ペーパートレード追跡（21/40営業日）
新(ATR1.0+トレール1.0): PF 1.45 | 勝率42% | +5.2% | DD -3.1% | 15件
旧(固定SL+トレール2.0): PF 1.12 | 勝率35% | +2.1% | DD -4.8% | 18件
Go判定: 追跡中（PF✅ DD✅ 件数❌ 残り19日）
```

### Go判定完了時

```
🎯 ペーパートレード Go判定: ✅ Go
新(ATR1.0+トレール1.0): PF 1.38 | 勝率40% | +8.5% | DD -5.2% | 35件
旧(固定SL+トレール2.0): PF 1.15 | 勝率34% | +3.8% | DD -6.1% | 38件
→ 本番投入を推奨
```

### No-Go 時

```
⚠️ ペーパートレード Go判定: ❌ No-Go
新(ATR1.0+トレール1.0): PF 0.92 | 勝率30% | -2.1% | DD -12.3% | 32件
旧(固定SL+トレール2.0): PF 1.08 | 勝率33% | +1.5% | DD -7.8% | 35件
→ パラメータ再検討を推奨（PF < 1.0）
```

## 実行方法

自動実行。既存の daily-backtest クロンジョブ（16:30 JST）で自動的に前方追跡が実行される。追加のクロン設定は不要。TRACKING_START_DATE が null の場合、前方追跡ステップはスキップされる。

## 制約・前提

- TRACKING_START_DATE 以降のデータが daily-runner の LOOKBACK_MONTHS（12ヶ月）期間内に含まれている必要がある
- candidateMap は daily-runner のモード（scoring-record or on-the-fly）に依存する。前方追跡専用の candidateMap は構築しない。scoring-record モードで ScoringRecord が欠損している日は、その日のエントリー候補が空になる
- 前方追跡の期間中にウィンドウ境界での still_open ポジションは BacktestResult の metrics から除外される（バックテストエンジンの標準動作）
- 40営業日到達後も自動的に追跡は継続する（TRACKING_START_DATE を null にするまで）

## ライフサイクル

1. **開始**: `PAPER_TRADE.TRACKING_START_DATE` を設定してデプロイ
2. **追跡中**: 毎日16:30に自動実行、Slackに結果通知
3. **Go判定**: 40営業日到達後に自動判定。Goなら本番投入を推奨
4. **終了**: 本番投入決定後、`TRACKING_START_DATE` を `null` にして前方追跡を停止
