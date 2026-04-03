# バッチ処理仕様

## エントリー戦略

**breakout戦略（出来高ブレイクアウト）のみで運用中。**

スコアリング+AIレビュー方式は廃止済み。エントリー戦略にAI依存なし。市場予想（market-forecast）のみOpenAI gpt-4o-miniを使用。

## ジョブ実行基盤

### Railway Worker（src/worker.ts）

Railway上で常駐する node-cron ベースのジョブスケジューラ。毎分実行が必要なジョブを担当。

| ジョブ | cron式 | 実行タイミング | 備考 |
|--------|--------|--------------|------|
| position-monitor | `* 9-10, 0-29 11, 30-59 12, * 13-14, 0-19 15 * * 1-5` | 平日 9:00-11:29, 12:30-15:19 毎分 | ポジション監視（昼休み除外） |
| breakout-monitor | `* 9-15 * * 1-5` | 平日 9:00-15:25 毎分 | 出来高ブレイクアウト監視 |

#### ウォッチリスト画面（GET /watchlist）

ウォッチリストページでは、各銘柄のブレイクアウトパイプライン状態をリアルタイムで表示する。

**表示列:**

| 列 | 内容 |
|----|------|
| 銘柄 | ティッカーコード + 銘柄名 |
| 状態 | パイプラインステータスバッジ（下表参照） |
| 条件 | 銘柄別トリガー条件の充足状態（出来高✓/✗、価格✓/✗） |
| サージ | 出来高サージ比率（直近スキャン時の値） |
| 現在価格 | リアルタイム価格（クライアントサイド取得） |
| 20日高値 | ブレイクアウト基準価格 |
| 乖離 | 現在価格と20日高値の差（%） |

**ステータスバッジ:**

| ステータス | 条件 | バッジ色 |
|---|---|---|
| 監視中 | デフォルト状態 | グレー |
| 急騰中 | 出来高サージ比率 ≥ 1.5x | オレンジ |
| 注文済 | トリガー発火 → TradingOrder が作成された | 青 |
| 却下 | トリガー発火 → リスクチェック等で注文不成立 | 赤 |
| 保有中 | 既にポジションあり | 緑 |

**ソート順**: 注文済 → 却下 → 急騰中 → 保有中 → 監視中。同一ステータス内ではサージ比率降順。

**サマリーバー（グローバル条件）:**

スキャナー稼働中はステータス集計に加え、全銘柄共通のエントリー条件を表示:

| 項目 | 内容 |
|------|------|
| エントリー枠 | MAX_POSITIONS・資金制約で自然制限 |
| 時間帯 | 現在時刻が 9:05〜15:00 内か（○/×） |
| 市場評価 | MarketAssessment.shouldTrade の状態（取引可/見送り） |

**条件列（銘柄別）:**

各銘柄のトリガー条件充足状態をコンパクトに表示:
- **出来高✓/✗**: サージ比率 ≥ 2.0x（サーバーサイド判定）
- **価格✓/✗**: 現在価格 > 20日高値（クライアントサイドで価格取得後に更新）

**データ取得**: breakout-monitor のインメモリ BreakoutScanner 状態を `getScannerState()` で直接参照（同一プロセス）。「注文済」「却下」の判定は当日の TradingOrder（strategy=breakout, side=buy）を DB で確認。グローバル条件（エントリー枠・市場評価）も DB から取得。市場時間外はスキャナー未起動のため全銘柄「監視中」表示。

**ウォッチリスト構築フィルター（watchlist-builder, 8:00AM実行）:**

| フィルター | 条件 | 備考 |
|-----------|------|------|
| データ充足 | OHLCVデータが最低バー数以上 | |
| 流動性ゲート | 25日平均出来高 ≥ 50,000株 | |
| 価格ゲート | 株価 ≤ ¥5,000 | スプレッド回避 |
| ボラティリティゲート | ATR% ≥ 1.5% | |
| 決算・配当 | 決算5日前/配当3日前を除外 | |
| 余力フィルター | entry-executorと同じポジションサイズ計算で実効資金内に収まるか | 2025-03-25追加 |
| 週足トレンド | 週足終値 ≥ 13週SMA | 落ちるナイフ回避 |

### cron-job.org

時間の正確性が重要なジョブを担当。GitHub Actions cronは数分〜数十分のズレが発生するため、取引時間に連動する処理はcron-job.orgで実行する。cron-job.orgからGitHub Actionsの `workflow_dispatch` をトリガーする。

| ジョブ | ワークフロー | 実行タイミング | 備考 |
|--------|------------|--------------|------|
| market-assessment + watchlist-builder | cronjob_morning-analysis.yml | 平日 8:00 JST | 市場評価→ブレイクアウトウォッチリスト構築 |
| morning-sl-sync | cronjob_morning-sl-sync.yml | 平日 8:50 JST | デモリセット後のSL注文再発注（市場オープン前） |
| end-of-day → market-forecast | cronjob_end-of-day.yml | 平日 15:50 JST | 日次締め → AI市場予想（EOD完了後に実行） |

### GitHub Actions cron

時間の正確性が不要なジョブを担当。閉場後の分析・週末処理など、数分〜数十分のズレが許容される処理。

| ジョブ | ワークフロー | cron式 (UTC) | 実行タイミング | 備考 |
|--------|------------|-------------|--------------|------|
| defensive-exit-followup | scheduled_defensive-exit-followup.yml | `20 7 * * 1-5` | 平日 16:20 JST | ディフェンシブ出口判断の事後検証 |
| unfilled-order-followup | scheduled_unfilled-order-followup.yml | `30 7 * * 1-5` | 平日 16:30 JST | 未約定注文の事後検証 |
| jpx-delisting-sync | scheduled_jpx-delisting-sync.yml | `0 0 * * 6` | 土曜 9:00 JST | JPX廃止予定同期 |
| weekly-review | scheduled_weekly-review.yml | `0 1 * * 6` | 土曜 10:00 JST | 週次レビュー |
| data-cleanup | scheduled_data-cleanup.yml | `0 18 * * 0` | 月曜 3:00 JST | 全テーブルのリテンション期間超過データ削除 |
| run-backtest | scheduled_daily-backtest.yml | `30 7 * * 1-5` | 平日 16:30 JST | ブレイクアウト戦略バックテスト（直近12ヶ月） |
| run-backtest-gapup | scheduled_daily-backtest-gapup.yml | `0 8 * * 1-5` | 平日 17:00 JST | ギャップアップ戦略バックテスト（直近12ヶ月） |

各ワークフローには `workflow_dispatch` トリガーがあり、手動実行も可能。平日ジョブは `check-market-day` ステップで休場日・システム停止チェックを行う。

### システム停止（isActive=false）の挙動

`TradingConfig.isActive` を `false` にすると、以下の全経路でジョブがスキップされる:

| 実行経路 | チェック箇所 | `skip_checks=true` でバイパス |
|----------|-------------|------|
| Railway Worker (node-cron) | `worker.ts` の `runJob()` | N/A |
| cron-job.org → `/api/cron/*` | `cron.ts` のエンドポイント | **不可**（isActiveチェックはskip_checks対象外） |
| position-monitor 実行中 | `position-monitor.ts` の `main()` フェーズ間チェック | N/A |

`skip_checks=true` は休場日チェックのみスキップし、`isActive` チェックは常に実行される。

### 重複実行防止

Worker: `running` Set で同一ジョブの同時実行を防止。ジョブ完了時に Set から削除。
GitHub Actions: `concurrency` グループで同一ワークフローの重複実行を防止。

### エラーハンドリング

ジョブエラーは catch してログ出力 + Slack通知。Worker プロセス自体は落とさない。

---

## 3. Position Monitor（src/jobs/position-monitor.ts）

**実行**: 平日 9:00-11:29, 12:30-15:19 毎分（昼休み除外）
**役割**: 注文の約定チェックとポジション監視

### システム停止チェック

`main()` 冒頭およびフェーズ間で `TradingConfig.isActive` を確認し、`false` の場合は即座に処理を中断する。これにより、実行中のジョブもフェーズ切替時に停止できる。

### 処理フロー

1. **期限切れ注文処理**: `expiresAt` を過ぎた注文を expired に更新
2. **約定チェック**（pending注文）:
   - 買い指値注文: `安値 <= limitPrice` → 約定
   - 売り指値注文（利確）: `高値 >= limitPrice` → 約定
   - 逆指値注文（損切）: `安値 <= stopPrice` → 約定
   - 約定時: TradingPosition を作成（デフォルト利確3%/損切2%）
3. **ポジション監視**（openポジション）:
   - `高値 >= takeProfitPrice` → 利確決済
   - `安値 <= stopLossPrice` → 損切決済
4. **Slack通知**: 約定・決済・損益を通知

### 約定シミュレーションロジック

```
checkOrderFill(order, currentHigh, currentLow):
  buy  + limit → low <= limitPrice  → fill at limitPrice
  sell + limit → high >= limitPrice → fill at limitPrice
  sell + stop  → low <= stopPrice   → fill at stopPrice
```

### DB操作

- **Read**: `TradingOrder`（pending）, `TradingPosition`（open）, `Stock`
- **Write**: `TradingOrder`（filled/expired）, `TradingPosition`（open/closed）

### 外部API

- Yahoo Finance（リアルタイム株価）

---

## 4. End of Day（src/jobs/end-of-day.ts）

**実行**: 平日 15:30 JST
**役割**: 日次締め処理とレポート生成

### 処理フロー

1. VIX ≥ 30 の場合、既存ポジションも強制決済（オーバーナイトリスク回避）
2. 未約定・期限切れ注文をキャンセル
3. 日次集計:
   - 当日の取引数、勝敗、合計損益
   - ポートフォリオ時価総額、キャッシュ残高
4. 機械的サマリー生成（取引統計・損益）
5. TradingDailySummary を upsert
6. **Slack通知**: 日次レポート

### 日次サマリー項目

| 項目 | 内容 |
|------|------|
| totalTrades | 当日の取引数 |
| wins | 勝ち数 |
| losses | 負け数 |
| totalPnl | 合計損益（円） |
| portfolioValue | ポートフォリオ時価総額 |
| cashBalance | キャッシュ残高 |
| aiReview | 機械的サマリー（取引統計） |

### ★ ピークエクイティ更新

日次サマリー保存後、`updatePeakEquity(portfolioValue + cashBalance)` を実行。現在の資産がハイウォーターマーク（TradingConfig.peakEquity）を超えていれば更新する。

### DB操作

- **Read**: `TradingPosition`, `TradingOrder`
- **Write**: `TradingOrder`（cancelled）, `TradingDailySummary`

### 外部API

- Yahoo Finance（決済用の現在価格）

---

## 5. Morning SL Sync（src/jobs/morning-sl-sync.ts）

**実行**: 毎営業日 8:50 JST（cron-job.org）
**役割**: デモサーバーの毎日リセットによりSL注文が消えるため、市場オープン前に再発注する

### 背景

デモ環境では毎日サーバーリセットが行われ、前日に発注したSL注文（逆指値）がブローカー側で消去される。このジョブは市場オープン（9:00）前にDBのオープンポジションに対してSL注文を再発注し、ポジション保護を維持する。

### 処理フロー

1. **DBのオープンポジション全件を取得**
2. **旧SL注文IDをクリア**（デモリセット後は無効なIDのため）
3. **SL注文を再発注**: `trailingStopPrice` または `stopLossPrice` を使用して逆指値注文を発行

### 動作モード

| 環境 | 挙動 |
|------|------|
| `TACHIBANA_ENV=demo` | デモリセット後のSL注文再発注（主要用途） |
| `TACHIBANA_ENV=production` | 既存SL注文の上書き再発注（本番でも動作可） |

### 備考

- `reconcileHoldings`（broker-reconciliation の Phase 3〜5）はデモモードでスキップされるため、このジョブがデモ環境のポジション保護の主要手段となる
- 市場オープン前（8:50）に実行することで、9:00の立会開始までにSL注文が有効になる

### DB操作

- **Read**: `TradingPosition`（open）
- **Write**: `TradingPosition`（slOrderId更新）, `TradingOrder`（SL注文作成）

---

## 6. Weekly Review（src/jobs/weekly-review.ts）

**実行**: 土曜 10:00 JST
**役割**: 週間パフォーマンス分析と戦略レビュー、DB保存

### 処理フロー

1. **週の範囲算出**: 実行日から直近の月曜〜金曜を算出（`jstDateAsUTC`）
2. 過去7日の TradingDailySummary を集計
3. 週間メトリクス算出:
   - 合計取引数、勝敗数、勝率
   - 合計損益
   - 最新ポートフォリオ価値・キャッシュ残高
4. 過去7日のクローズポジションを取得
5. **機械的レビュー生成**（取引統計ベース）:
   - `performance`: パフォーマンス評価（PF・勝率・RR比）
   - `strengths`: 良かった点（統計ベース）
   - `improvements`: 改善すべき点（統計ベース）
   - `nextWeekStrategy`: 来週の戦略（ルールベース）
6. **TradingWeeklySummary upsert**: weekEnd をキーに週次サマリーをDB保存
7. **Slack通知**: 週次統計レポート

### DB操作

- **Read**: `TradingDailySummary`（7日分）, `TradingPosition`（7日分クローズ）, `TradingOrder`（7日分約定）
- **Write**: `TradingWeeklySummary`（upsert）

### UI表示

- **`/weekly` ページ**: 最新週サマリー、統計レビュー（4セクション）、累積損益チャート、過去の週次一覧テーブル

---

## 7. JPX CSV同期（src/jobs/jpx-csv-sync.ts）

**実行**: 手動（`npm run jpx-sync`）
**役割**: JPX公式CSVから銘柄マスタを同期

### 処理フロー

1. **CSVパース**: `data/data_j.csv`（JPX上場銘柄一覧）を読み込み
2. **市場フィルタ**: プライム・スタンダード・グロース（内国株式）のみ
3. **バッチupsert**（100件ずつ）:
   - 既存銘柄: name, market, sector, jpxSectorCode, jpxSectorName更新、`isActive=true`
   - 新規銘柄: 作成 + StockStatusLog記録
4. **非アクティブ化**: CSVに存在しない銘柄を `isActive=false` に更新
5. **ステータスログ**: StockStatusLog に変更履歴を記録

### DB操作

- **Read**: `Stock`（既存銘柄チェック）
- **Write**: `Stock`（upsert）, `StockStatusLog`

---

## 8. JPX廃止予定同期（src/jobs/jpx-delisting-sync.ts）

**実行**: 土曜 9:00 JST（`npm run delisting-sync` で手動実行も可）
**役割**: JPX公式サイトから上場廃止予定を取得し、取引制限を適用

### 処理フロー

1. **JPXページ取得**: `https://www.jpx.co.jp/listing/stocks/delisted/index.html`
2. **HTMLパース**: cheerioで廃止予定テーブルを解析
3. **DB更新**:
   - `delistingDate` を設定
   - 廃止30日前: `isRestricted=true`（取引候補から除外）
   - 廃止日超過: `isDelisted=true`, `isActive=false`
4. **StockStatusLog記録**
5. **Slack通知**: 新規廃止予定検出時のみ

### DB操作

- **Read**: `Stock`（廃止対象チェック）
- **Write**: `Stock`（delistingDate, isRestricted, isDelisted更新）, `StockStatusLog`

---

## 9. Backfill Prices（src/jobs/backfill-prices.ts）

**実行**: 手動（`npm run backfill`）
**役割**: 株価データの一括取得・更新

### 処理フロー

1. **株価データ更新**（並列、p-limit=5、バッチ=10）:
   - アクティブ銘柄（`isDelisted=false, isActive=true`）の現在価格を取得
   - ヒストリカルデータ（60日分）からテクニカル指標を算出
   - ATR(14)、週間変化率、ボラティリティを更新
   - 取得失敗カウント（5回連続失敗で上場廃止フラグ）
2. **TradingConfig 同期**: TRADING_DEFAULTS の値でDB設定を作成/更新

注: 銘柄マスタ登録は `jpx-csv-sync.ts` が担当。銘柄が0件の場合は警告を表示。

### TradingConfig デフォルト値

| 項目 | 値 | 定数名 |
|------|-----|--------|
| 総予算 | 100,000円 | `TRADING_DEFAULTS.TOTAL_BUDGET` |
| 最大ポジション数 | 3 | `TRADING_DEFAULTS.MAX_POSITIONS` |
| 最大ポジション比率 | 100% | `TRADING_DEFAULTS.MAX_POSITION_PCT` |
| 最大日次損失率 | 3% | `TRADING_DEFAULTS.MAX_DAILY_LOSS_PCT` |

### DB操作

- **Read**: `Stock`
- **Write**: `Stock`（upsert）, `TradingConfig`（create/update）

### 外部API

- Yahoo Finance（株価、ヒストリカルデータ）

---

## GitHub Actions ワークフロー一覧

### trading.yml（手動実行用）

`workflow_dispatch` で任意のジョブを手動実行。

利用可能: scan / monitor / eod / weekly / backfill

失敗時は Slack に通知。

### morning-analysis.yml（cron実行）

market-assessment → watchlist-builder の順で実行。`check-market-day` で休場日・システム停止チェック。

### weekly-review.yml（cron実行）

weekly-review を実行。休場日チェックなし（土曜固定）。

---

## Slack通知一覧

| タイミング | 通知内容 | 色 |
|-----------|---------|-----|
| 市場スキャン完了 | 市場評価・候補銘柄一覧 | blue |
| 注文生成 | 銘柄名・指値・数量 | blue |
| 約定 | 約定価格・数量 | green |
| 利確/損切 | 決済価格・損益 | green/red |
| 日次レポート | 勝敗・PnL・ポートフォリオ | green/red |
| 週次レポート | 週間集計・戦略レビュー | blue |
| 市場予想 | 翌営業日outlook・確信度・サマリー・リスク | blue |
| リスクアラート | 日次損失制限超過等 | red |
| ジョブ失敗 | エラー内容 | red |
