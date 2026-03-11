# バッチ処理仕様

## ジョブ実行基盤

ジョブは2つの基盤で実行される。

### Railway Worker（src/worker.ts）

Railway上で常駐する node-cron ベースのジョブスケジューラ。時間精度が重要なジョブ、または毎分実行が必要なジョブを担当。

| ジョブ | cron式 | 実行タイミング | 備考 |
|--------|--------|--------------|------|
| order-manager | `20 9 * * 1-5` | 平日 9:20 JST | 注文生成（寄付き9:00のデータ反映後） |
| midday-reassessment | `15 12 * * 1-5` | 平日 12:15 JST | 昼休み再評価（前場終了11:30のデータ反映後） |
| position-monitor | `20-59 9, * 10-14, 0-19 15 * * 1-5` | 平日 9:20-15:19 毎分 | ポジション監視 |
| end-of-day | `50 15 * * 1-5` | 平日 15:50 JST | 日次締め（大引け15:30のデータ反映後） |
| daily-backtest | `30 16 * * 1-5` | 平日 16:30 JST | 日次バックテスト |
| jpx-delisting-sync | `0 9 * * 6` | 土曜 9:00 JST | JPX廃止予定同期 |

### GitHub Actions cron

外部API（Yahoo Finance等）への接続が必要なジョブを担当。RailwayのIPレンジがYahoo Financeにブロックされる問題を回避するため、GitHub Actionsランナーから実行する（KOH-296）。

| ジョブ | ワークフロー | cron式 (UTC) | 実行タイミング | 備考 |
|--------|------------|-------------|--------------|------|
| news-collector | morning-analysis.yml | `0 23 * * 0-4` | 平日 8:00 JST | ニュース収集・AI分析 |
| market-scanner | morning-analysis.yml | news完了後 | 平日 ~8:15-8:30 JST | `needs:` で順序制御 |
| ghost-review | ghost-review.yml | `10 7 * * 1-5` | 平日 16:10 JST | ゴースト・トレード分析 |
| defensive-exit-followup | defensive-exit-followup.yml | `20 7 * * 1-5` | 平日 16:20 JST | ディフェンシブ出口判断の事後検証 |
| unfilled-order-followup | unfilled-order-followup.yml | `30 7 * * 1-5` | 平日 16:30 JST | 未約定注文の事後検証 |
| weekly-review | weekly-review.yml | `0 1 * * 6` | 土曜 10:00 JST | 週次レビュー |
| scoring-accuracy-report | scoring-accuracy-report.yml | `0 2 * * 6` | 土曜 11:00 JST | スコアリング精度レポート |

各ワークフローには `workflow_dispatch` トリガーがあり、手動実行も可能。平日ジョブは `check-market-day` ステップで休場日・システム停止チェックを行う。

### 重複実行防止

Worker: `running` Set で同一ジョブの同時実行を防止。ジョブ完了時に Set から削除。
GitHub Actions: `concurrency` グループで同一ワークフローの重複実行を防止。

### エラーハンドリング

ジョブエラーは catch してログ出力 + Slack通知。Worker プロセス自体は落とさない。

---

## 0. News Collector（src/jobs/news-collector.ts）

**実行**: 平日 8:00 JST
**役割**: ニュースを収集し、AIで市場影響を分析する

### 処理フロー

1. **ニュースフェッチ**（3ソース並列）:
   - NewsAPI.org: 地政学 + マーケット関連（API key不在時スキップ）
   - Google News RSS: 地政学 + マーケット + セクター別
   - Yahoo Finance: 主要20銘柄の個別ニュース（p-limit=5）
2. **重複排除**: SHA-256ハッシュ（title + url）で排除
3. **DB保存**: 新規記事のみ `createMany`（skipDuplicates）
4. **AI分析**: 直近24時間の記事タイトルをGPT-4oで構造化分析
5. **NewsAnalysis upsert**: 当日1レコード（地政学リスク、市場インパクト、セクター影響、銘柄カタリスト）
6. **クリーンアップ**: 90日超の古い記事・分析結果を削除
7. **Slack通知**: 地政学リスクレベル、市場インパクト、セクター影響

### AI分析出力

| 項目 | 内容 |
|------|------|
| geopoliticalRiskLevel | 1-5（1=平穏, 5=危機的） |
| geopoliticalSummary | 地政学・マクロ環境の要約 |
| marketImpact | positive / neutral / negative |
| sectorImpacts | セクター別影響（JSON配列） |
| stockCatalysts | 銘柄別カタリスト（JSON配列） |
| keyEvents | 主要イベントの要約 |

### DB操作

- **Read**: `Stock`（Yahoo Finance用ティッカー取得）, `NewsArticle`（重複チェック）
- **Write**: `NewsArticle`（記事保存）, `NewsAnalysis`（分析結果保存）
- **Delete**: 90日超の `NewsArticle`, `NewsAnalysis`

### 外部API

- NewsAPI.org（オプション、API key必要）
- Google News RSS（無料、キー不要）
- Yahoo Finance（yahoo-finance2 search API）
- OpenAI GPT-4o（ニュース分析）

### ニュース分析の利用箇所

- **market-scanner**: `assessMarket()` に地政学・マクロ要約、`selectStocks()` に銘柄別カタリスト
- **order-manager**: `decideTrade()` に銘柄別ニュースコンテキスト
- **midday-reassessment**: `collectAndAnalyzeNews()` でニュースを再取得し、`reassessMarketMidday()` にニュース分析サマリーを提供

---

## 1. Market Scanner（src/jobs/market-scanner.ts）

**実行**: 平日 8:30 JST
**役割**: 市場全体を評価し、取引候補銘柄を選定する

### 処理フロー

1. **市場指標取得**: 日経225, S&P500, VIX, USD/JPY, CME先物
2. **★ VIXレジーム判定**（機械的）: VIX > 30 → 取引停止、保存して終了
3. **★ ドローダウンチェック**（機械的）: 週次5%/月次10%/5連敗 → 取引停止
4. **AI市場評価**: `assessMarket()` で取引判断（shouldTrade boolean）
5. shouldTrade = false → 評価保存して終了
6. shouldTrade = true:
   - 全銘柄をスクリーニング条件でフィルタ
   - 候補銘柄のヒストリカルデータ取得（60日分）
   - テクニカル分析 + スコアリング（並列、p-limit=5）
   - **★ レジームによるランク制限**（VIX 25-30→Sのみ、20-25→S/Aのみ）
   - **★ 弱セクター銘柄除外**（日経比-2%以下のセクター）
   - AI銘柄選定 `reviewStocks()` → Go/No-Go判断（リスクコンテキスト付き）
7. **MarketAssessment 保存**: 日次の市場評価と選定銘柄を記録
8. **Slack通知**: 候補銘柄一覧を通知

### スクリーニング条件

| 条件 | 値 | 定数名 |
|------|-----|--------|
| 最低株価 | 100円 | `SCREENING.MIN_PRICE` |
| 最高株価 | 利用可能資金から動的算出 | `min(残高, 総予算×最大比率%) / 100株` |
| 最低出来高 | 100,000株/日 | `SCREENING.MIN_DAILY_VOLUME` |
| 最低時価総額 | 1億円 | `SCREENING.MIN_MARKET_CAP` |

### DB操作

- **Read**: `Stock`（活動銘柄）, `TradingConfig`, `TradingPosition`（オープン）
- **Write**: `MarketAssessment`, `ScoringRecord`

### 外部API

- Yahoo Finance（市場指標、ヒストリカルデータ）
- OpenAI GPT-4o（市場評価、銘柄選定）

---

## 2. Order Manager（src/jobs/order-manager.ts）

**実行**: 平日 9:00 JST
**役割**: AI判断に基づき取引注文を生成する

### 処理フロー

1. 当日の MarketAssessment を取得（なし or shouldTrade=false → 終了）
2. 現在のポジション・キャッシュ残高を取得
3. 選定銘柄ごとに:
   - 現在価格・ヒストリカルデータ取得
   - テクニカル分析
   - AI売買判断 `decideTrade()` → action: buy/skip
   - リスクチェック `canOpenPosition()`
   - TradingOrder 作成（status: pending）
4. **Slack通知**: 注文内容を通知

### 注文パラメータ

| 項目 | 内容 |
|------|------|
| 数量 | `Math.floor(budget / (price * 100)) * 100`（100株単位） |
| 期限 | day_trade: 当日14:50 JST、swing: 3日後 |
| 指値 | AI が決定（サポートライン、ボリンジャーバンド下限等を考慮） |
| 利確 | AI が決定（1.5-2x ATR or レジスタンスライン） |
| 損切 | AI が決定（1-1.5x ATR or サポートブレイク） |

### DB操作

- **Read**: `MarketAssessment`, `Stock`, `TradingPosition`
- **Write**: `TradingOrder`

### 外部API

- Yahoo Finance（株価、ヒストリカルデータ）
- OpenAI GPT-4o（売買判断）

---

## 2.5. Midday Reassessment（src/jobs/midday-reassessment.ts）

**実行**: 平日 12:15 JST（Railway Worker）
**役割**: 前場終了後のニュース再取得・セクター再分析・センチメント再評価と未約定注文キャンセル

### 処理フロー

1. **MarketAssessment取得**: 今日の朝の評価を取得（なし→スキップ）
2. **重複チェック**: `middayReassessedAt` が既にセットされている場合はスキップ
3. **市場データ再取得**: 日経225, VIX, S&P500, USD/JPY
4. **ニュース再取得 & AI再分析**: `collectAndAnalyzeNews()` で3ソースからニュースを再取得し、AIで分析。前場中に出たニュースをキャッチする。エラー時はスキップして続行
5. **セクターモメンタム再計算**: `calculateSectorMomentum()` で前場の値動きを反映したセクター強弱を取得。エラー時はスキップして続行
6. **AI再評価**: `reassessMarketMidday()` で前場実績 + 最新ニュース + セクター動向に基づく再評価
7. **Sentinel判定**: センチメントが悪化方向の場合のみ `sentiment` フィールドを更新
   - bullish → neutral/bearish/crisis: 更新
   - neutral → bearish/crisis: 更新
   - bearish → crisis: 更新
   - 同レベルまたは改善: 朝のセンチメントを維持
8. **注文キャンセル**:
   - day_trade買い注文: 全てキャンセル（昼休み時点で未約定 = エントリー窓逸失）
   - swing買い注文: bearish/crisis時のみキャンセル
9. **Slack通知**: センチメント変化・新着ニュース件数・セクター動向・キャンセル結果

### Sentinel Logic

センチメントは悪化方向にのみ更新される（改善方向には更新しない）。
朝の評価の保守性を維持し、前場の一時的な好転に惑わされないようにする。

### DB操作

- **Read**: `MarketAssessment`, `TradingOrder`（pending buy）, `Stock`（ニュース用ティッカー）, `NewsArticle`（重複チェック）
- **Write**: `MarketAssessment`（midday fields + potentially sentiment）, `TradingOrder`（cancelled）, `NewsArticle`（新規記事）, `NewsAnalysis`（upsert）

### 外部API

- Yahoo Finance（市場指標、銘柄別ニュース）
- Google News RSS（ニュース）
- NewsAPI.org（ニュース、オプション）
- OpenAI GPT-4o（ニュース分析、センチメント再評価）

---

## 3. Position Monitor（src/jobs/position-monitor.ts）

**実行**: 平日 9:20-15:19 毎分
**役割**: 注文の約定チェックとポジション監視

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
4. **14:50以降**: day_trade ポジションを強制決済
5. **Slack通知**: 約定・決済・損益を通知

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

1. 残っている day_trade ポジションを市場価格で強制決済
2. 未約定・期限切れ注文をキャンセル
3. 日次集計:
   - 当日の取引数、勝敗、合計損益
   - ポートフォリオ時価総額、キャッシュ残高
4. AI日次レビュー生成（100文字、振り返りとインサイト）
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
| aiReview | AI生成の日次レビュー |

### ★ ピークエクイティ更新

日次サマリー保存後、`updatePeakEquity(portfolioValue + cashBalance)` を実行。現在の資産がハイウォーターマーク（TradingConfig.peakEquity）を超えていれば更新する。

### DB操作

- **Read**: `TradingPosition`, `TradingOrder`
- **Write**: `TradingOrder`（cancelled）, `TradingDailySummary`

### 外部API

- Yahoo Finance（決済用の現在価格）
- OpenAI GPT-4o（日次レビュー）

---

## 5. Ghost Review（src/jobs/ghost-review.ts）

**実行**: 平日 16:10 JST
**役割**: 見送った銘柄の事後分析（偽陰性検出）

### 処理フロー

1. 今日の `ScoringRecord` から `rejectionReason IS NOT NULL` の銘柄を取得
2. `fetchStockQuotes()` で終値をバッチ取得
3. 仮想損益を算出: `(closingPrice - entryPrice) / entryPrice * 100`
4. 全レコードの `closingPrice`, `ghostProfitPct` をDB更新
5. 利益率1%以上の上位5銘柄にAI後悔分析を実行
6. `ghostAnalysis` をDB保存
7. Slack通知（機会損失サマリー）

### DB操作

- **Read**: `ScoringRecord`（当日のrejected銘柄）
- **Write**: `ScoringRecord`（closingPrice, ghostProfitPct, ghostAnalysis を更新）

### 外部API

- Yahoo Finance（終値取得）
- OpenAI GPT-4o（後悔分析、最大5銘柄/日）

---

## 6. Weekly Review（src/jobs/weekly-review.ts）

**実行**: 土曜 10:00 JST
**役割**: 週間パフォーマンス分析と戦略レビュー

### 処理フロー

1. 過去7日の TradingDailySummary を集計
2. 週間メトリクス算出:
   - 合計取引数、勝敗数、勝率
   - 合計損益
   - 最新ポートフォリオ価値・キャッシュ残高
3. 過去7日のクローズポジションを取得
4. AI戦略レビュー生成（200文字、パフォーマンス評価・改善提案）
5. **Slack通知**: 詳細な週次レポート

### DB操作

- **Read**: `TradingDailySummary`（7日分）, `TradingPosition`（7日分クローズ）, `TradingOrder`（7日分約定）

### 外部API

- OpenAI GPT-4o（週次レビュー）

---

## 6.5. Scoring Accuracy Report（src/jobs/scoring-accuracy-report.ts）

**実行**: 土曜 11:00 JST（weekly-reviewの1時間後）
**役割**: スコアリングシステムの弱点を定量的に集計・レポート

### 処理フロー

1. 直近7日間の `ScoringRecord`（ghostProfitPct != null）を取得
2. 直近30日間の `ScoringRecord` も取得（トレンド比較用）
3. **カテゴリ別弱点分析**: 見逃し銘柄（却下 + ghostProfitPct >= 1%）のカテゴリ別欠損を平均集計
4. **ランク別実績**: S/A/B/Cランクごとの平均利益率・上昇率・件数
5. **rejectionReason別機会損失**: 各却下理由ごとの件数・上昇件数・平均利益率
6. **週次/月次トレンド比較**: 今週 vs 30日ローリングの上昇率・平均利益率
7. **Slack通知**: 精度レポート

### DB操作

- **Read**: `ScoringRecord`（7日分 + 30日分、ghostProfitPct != null）

### 外部API

- なし（純粋な統計集計のみ）

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

利用可能: news / scan / order / monitor / eod / ghost / weekly / backfill

失敗時は Slack に通知。

### morning-analysis.yml（cron実行）

news-collector → market-scanner の順で実行。`check-market-day` で休場日・システム停止チェック。

### ghost-review.yml（cron実行）

ghost-review を実行。`check-market-day` で休場日・システム停止チェック。

### weekly-review.yml（cron実行）

weekly-review を実行。休場日チェックなし（土曜固定）。

### scoring-accuracy-report.yml（cron実行）

scoring-accuracy-report を実行。休場日チェックなし（土曜固定、weekly-reviewの1時間後）。

---

## Slack通知一覧

| タイミング | 通知内容 | 色 |
|-----------|---------|-----|
| ニュース分析完了 | 地政学リスク・市場インパクト・セクター影響 | good/warning/gray |
| 市場スキャン完了 | 市場評価・候補銘柄一覧 | blue |
| 昼休み再評価（変更なし） | 朝のセンチメント維持・キャンセル結果 | good/warning |
| 昼休み再評価（悪化） | センチメント悪化・キャンセル結果 | red |
| 注文生成 | 銘柄名・指値・数量 | blue |
| 約定 | 約定価格・数量 | green |
| 利確/損切 | 決済価格・損益 | green/red |
| 日次レポート | 勝敗・PnL・ポートフォリオ | green/red |
| 週次レポート | 週間集計・戦略レビュー | blue |
| ゴースト分析 | 機会損失サマリー・AI後悔分析 | warning/green |
| スコアリング精度レポート | カテゴリ別弱点・ランク別実績・却下理由別機会損失・トレンド | warning/good |
| リスクアラート | 日次損失制限超過等 | red |
| ジョブ失敗 | エラー内容 | red |
