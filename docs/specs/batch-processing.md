# バッチ処理仕様

## Worker（src/worker.ts）

Railway上で常駐する node-cron ベースのジョブスケジューラ。

### スケジュール一覧

| ジョブ | cron式 | 実行タイミング | 備考 |
|--------|--------|--------------|------|
| market-scanner | `30 8 * * 1-5` | 平日 8:30 JST | 市場スキャン |
| order-manager | `0 9 * * 1-5` | 平日 9:00 JST | 注文生成 |
| position-monitor | `* 9-14 * * 1-5` | 平日 9:00-14:59 毎分 | ポジション監視 |
| end-of-day | `30 15 * * 1-5` | 平日 15:30 JST | 日次締め |
| weekly-review | `0 10 * * 6` | 土曜 10:00 JST | 週次レビュー |

### 重複実行防止

`running` Set で同一ジョブの同時実行を防止。ジョブ完了時に Set から削除。

### エラーハンドリング

ジョブエラーは catch してログ出力。Worker プロセス自体は落とさない。

---

## 1. Market Scanner（src/jobs/market-scanner.ts）

**実行**: 平日 8:30 JST
**役割**: 市場全体を評価し、取引候補銘柄を選定する

### 処理フロー

1. **市場指標取得**: 日経225, S&P500, VIX, USD/JPY, CME先物
2. **AI市場評価**: `assessMarket()` で取引判断（shouldTrade boolean）
3. shouldTrade = false → 評価保存して終了
4. shouldTrade = true:
   - 全銘柄をスクリーニング条件でフィルタ
   - 候補銘柄のヒストリカルデータ取得（60日分）
   - テクニカル分析（並列、p-limit=5）
   - AI銘柄選定 `selectStocks()` → score >= 50 の銘柄を選出
5. **MarketAssessment 保存**: 日次の市場評価と選定銘柄を記録
6. **Slack通知**: 候補銘柄一覧を通知

### スクリーニング条件

| 条件 | 値 | 定数名 |
|------|-----|--------|
| 最低株価 | 100円 | `SCREENING.MIN_PRICE` |
| 最高株価 | 50,000円 | `SCREENING.MAX_PRICE` |
| 最低出来高 | 100,000株/日 | `SCREENING.MIN_DAILY_VOLUME` |
| 最低時価総額 | 1億円 | `SCREENING.MIN_MARKET_CAP` |

### DB操作

- **Read**: `Stock`（活動銘柄）
- **Write**: `MarketAssessment`

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
| 期限 | day_trade: 当日14:30 JST、swing: 3日後 |
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

## 3. Position Monitor（src/jobs/position-monitor.ts）

**実行**: 平日 9:00-14:59 毎分
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
4. **14:30以降**: day_trade ポジションを強制決済
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

### DB操作

- **Read**: `TradingPosition`, `TradingOrder`
- **Write**: `TradingOrder`（cancelled）, `TradingDailySummary`

### 外部API

- Yahoo Finance（決済用の現在価格）
- OpenAI GPT-4o（日次レビュー）

---

## 5. Weekly Review（src/jobs/weekly-review.ts）

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

## 6. Backfill Prices（src/jobs/backfill-prices.ts）

**実行**: 手動（`npm run backfill`）
**役割**: 銘柄マスタ登録と株価データの初期取得

### 処理フロー

1. **銘柄マスタ登録**: NIKKEI_TICKERS（90銘柄）を Stock テーブルに upsert
2. **株価データ更新**（並列、p-limit=5、バッチ=10）:
   - 各銘柄の現在価格を取得
   - ヒストリカルデータ（60日分）からテクニカル指標を算出
   - ATR(14)、週間変化率、ボラティリティを更新
   - 取得失敗カウント（5回連続失敗で上場廃止フラグ）
3. **TradingConfig 初期化**: 存在しない場合に作成

### 銘柄ユニバース（90銘柄）

| セクター | 銘柄数 | 代表銘柄 |
|----------|--------|----------|
| 半導体・電子部品 | 8 | アドバンテスト、東京エレクトロン、レーザーテック |
| 自動車・輸送用機器 | 6 | トヨタ、ホンダ、デンソー |
| 金融 | 7 | 三菱UFJ、三井住友、東京海上 |
| 商社 | 4 | 伊藤忠、三菱商事、三井物産 |
| IT・通信 | 8 | NTT、KDDI、ソフトバンクG、リクルート |
| 医薬品・ヘルスケア | 6 | 武田、中外製薬、第一三共 |
| 小売・サービス | 7 | ファーストリテイリング、任天堂、オリエンタルランド |
| 食品・日用品 | 6 | 味の素、JT、花王 |
| 電機・精密 | 13 | ソニー、日立、キーエンス、HOYA |
| 機械 | 3 | ダイキン、SMC、コマツ |
| 不動産・建設 | 5 | 三井不動産、三菱地所、大成建設 |
| 素材・化学 | 8 | 信越化学、富士フイルム、ブリヂストン |
| 運輸・物流 | 6 | JR東日本、JAL、日本郵船 |
| エネルギー・電力 | 3 | ENEOS、東京電力、東京ガス |

### TradingConfig デフォルト値

| 項目 | 値 | 定数名 |
|------|-----|--------|
| 総予算 | 1,000,000円 | `TRADING_DEFAULTS.TOTAL_BUDGET` |
| 最大ポジション数 | 5 | `TRADING_DEFAULTS.MAX_POSITIONS` |
| 最大ポジション比率 | 30% | `TRADING_DEFAULTS.MAX_POSITION_PCT` |
| 最大日次損失率 | 3% | `TRADING_DEFAULTS.MAX_DAILY_LOSS_PCT` |

### DB操作

- **Read**: `Stock`
- **Write**: `Stock`（upsert）, `TradingConfig`（create if missing）

### 外部API

- Yahoo Finance（株価、ヒストリカルデータ）

---

## GitHub Actions（.github/workflows/trading.yml）

手動実行（workflow_dispatch）用。Workerがスケジュール実行を担当するため、定期実行は不要。

### 利用可能なジョブ

scan / order / monitor / eod / weekly / backfill

### 失敗通知

いずれかのジョブが失敗した場合、Slack に通知。

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
| リスクアラート | 日次損失制限超過等 | red |
| ジョブ失敗 | エラー内容 | red |
