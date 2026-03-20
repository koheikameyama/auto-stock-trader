# コアモジュール仕様

## 1. Market Data（src/core/market-data.ts）

**役割**: yahoo-finance2 v3 を使用した株価・市場指標データの取得

### インターフェース

```typescript
interface StockQuote {
  tickerCode: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
  open: number;
}

interface OHLCVBar {
  date: string;   // ISO date (YYYY-MM-DD)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MarketData {
  nikkei: IndexQuote | null;
  sp500: IndexQuote | null;
  vix: IndexQuote | null;
  usdjpy: IndexQuote | null;
  cmeFutures: IndexQuote | null;
}
```

### 関数一覧

| 関数 | 引数 | 戻り値 | 説明 |
|------|------|--------|------|
| `fetchStockQuote` | tickerCode | StockQuote \| null | 個別銘柄のリアルタイムクォート |
| `fetchStockQuotes` | tickerCodes[] | (StockQuote \| null)[] | バッチ取得（p-limit=5、バッチ=10） |
| `fetchHistoricalData` | tickerCode | OHLCVBar[] \| null | 過去60日の日足OHLCV（新しい順） |
| `fetchMarketData` | - | MarketData | 市場指標5種を一括取得 |

### 市場指標シンボル

| 指標 | シンボル |
|------|---------|
| 日経225 | `^N225` |
| S&P500 | `^GSPC` |
| VIX | `^VIX` |
| USD/JPY | `JPY=X` |
| CME日経先物 | `NKD=F` |

### 注意事項

- yahoo-finance2 v3: `new YahooFinance()` でインスタンス化が必要
- `historical()` は非推奨、`chart()` APIを使用
- レート制限: バッチ間に1000msのスリープ

---

## 2. Technical Analysis（src/core/technical-analysis.ts）

**役割**: OHLCVデータからテクニカル指標を算出し、AI向けにフォーマット

### 主要関数

| 関数 | 引数 | 戻り値 | 説明 |
|------|------|--------|------|
| `analyzeTechnicals` | OHLCVData[] | TechnicalSummary | 包括的テクニカル分析 |
| `formatTechnicalForAI` | TechnicalSummary | string | AI向けテキストフォーマット |
| `calculateATR14` | OHLCVData[] | number \| null | ATR(14)のみ計算 |

### TechnicalSummary 出力項目

| カテゴリ | 指標 |
|----------|------|
| 基本指標 | RSI, SMA(5/25/75), EMA(12/26), MACD, ボリンジャーバンド, ATR(14) |
| トレンド | 移動平均線の並び順、乖離率、トレンドシグナル |
| 支持/抵抗線 | パターン検出による価格レベル |
| ギャップ | 上昇/下降ギャップ、窓埋め状態 |
| トレンドライン | サポート/レジスタンスラインとブレイク判定 |
| 出来高 | 20日平均出来高、現在比率 |
| 価格データ | 現在値、前日終値 |

### AI向けフォーマット例

```
【価格】現在値: 3,515円（前日比 +1.2%）
【RSI】52.3（中立圏）
【移動平均線】SMA5: 3,480 / SMA25: 3,420 / SMA75: 3,350（上昇トレンド）
【MACD】+15.2（シグナル上抜け）
【ボリンジャーバンド】上限: 3,600 / 中央: 3,450 / 下限: 3,300
【ATR(14)】85.3
【出来高】平均比 1.3倍
```

### 注意事項

- 最低2データポイント必要
- technicalindicators ライブラリは oldest-first の配列を要求

---

## 3. AI Decision（src/core/ai-decision.ts）

**役割**: OpenAI GPT-4o による市場評価・銘柄選定・売買判断

### 関数一覧

| 関数 | 入力 | 出力 | 用途 |
|------|------|------|------|
| `assessMarket` | MarketDataInput | MarketAssessmentResult | 市場全体の評価 |
| `selectStocks` | assessment + candidates[] | StockSelectionResult[] | 候補銘柄の選定 |
| `decideTrade` | stock + assessment + budget + positions[] | TradeDecisionResult | 個別銘柄の売買判断 |

### assessMarket（市場評価）

**入力**: 市場指標（日経225, S&P500, VIX, USD/JPY, CME先物）

**出力**:
```typescript
{
  shouldTrade: boolean;           // 取引すべきか
  sentiment: "bullish" | "neutral" | "bearish" | "crisis";
  reasoning: string;              // 判断理由
}
```

### selectStocks（銘柄選定）

**入力**: 市場評価結果 + 候補銘柄リスト（テクニカルサマリー付き）

**出力**:
```typescript
{
  tickerCode: string;
  strategy: "day_trade" | "swing";
  score: number;                  // 0-100（50以上のみ採用）
  reasoning: string;
}[]
```

**選定基準**:
- day_trade: 高ボラティリティ、高出来高、日中モメンタム
- swing: 明確なトレンド、MA整列、ブレイクアウトサポート

### decideTrade（売買判断）

**入力**: 銘柄データ + 市場評価 + 利用可能予算 + 現在ポジション

**出力**:
```typescript
{
  action: "buy" | "skip";
  limitPrice: number | null;      // 指値
  takeProfitPrice: number | null; // 利確ライン
  stopLossPrice: number | null;   // 損切ライン
  quantity: number;               // 数量（100株単位）
  strategy: "day_trade" | "swing";
  reasoning: string;
}
```

**売買判断基準**:
- エントリー: サポートライン、ボリンジャーバンド下限
- 利確: 1.5-2x ATR or レジスタンスライン
- 損切: 1-1.5x ATR or サポートブレイク
- リスク/リワード比: 最低 1:1.5

### 共通設定

| 項目 | 値 |
|------|-----|
| モデル | gpt-4o |
| Temperature | 0.3 |
| 出力形式 | JSON Schema（strict mode） |

---

## 4. Order Executor（src/core/order-executor.ts）

**役割**: 注文の約定シミュレーションとステータス管理

### 関数一覧

| 関数 | 引数 | 戻り値 | 説明 |
|------|------|--------|------|
| `checkOrderFill` | order, high, low | number \| null | 約定条件チェック（約定価格 or null） |
| `fillOrder` | orderId, filledPrice | TradingOrder | 注文を約定済みに更新 |
| `expireOrders` | - | number | 期限切れ注文数 |
| `getPendingOrders` | - | TradingOrder[] | 未約定注文一覧 |

### 約定条件

| 注文種別 | 条件 | 約定価格 |
|----------|------|---------|
| 買い指値（buy + limit） | 安値 <= limitPrice | limitPrice |
| 売り指値（sell + limit） | 高値 >= limitPrice | limitPrice |
| 売り逆指値（sell + stop） | 安値 <= stopPrice | stopPrice |

---

## 5. Position Manager（src/core/position-manager.ts）

**役割**: ポジションのライフサイクル管理（建玉・決済・評価）

### 関数一覧

| 関数 | 引数 | 戻り値 | 説明 |
|------|------|--------|------|
| `openPosition` | stockId, strategy, entryPrice, quantity, tp, sl | TradingPosition | 新規ポジション作成 |
| `closePosition` | positionId, exitPrice | TradingPosition | ポジション決済 |
| `getOpenPositions` | - | TradingPosition[] | オープンポジション一覧 |
| `getUnrealizedPnl` | position, currentPrice | number | 含み損益 |
| `getTotalPortfolioValue` | priceMap | number | ポートフォリオ時価総額 |
| `getCashBalance` | - | number | キャッシュ残高 |

### 損益計算

```
実現損益 = (exitPrice - entryPrice) * quantity
含み損益 = (currentPrice - entryPrice) * quantity
キャッシュ残高 = totalBudget - Σ(entryPrice * quantity)  ※openポジション分
```

### トランザクション処理

`openPosition` と `closePosition` は Prisma トランザクションを使用。
ポジション操作と同時に対応する TradingOrder を作成（監査証跡）。

---

## 6. Risk Manager（src/core/risk-manager.ts）

**役割**: ポジションサイジング、損失制限、取引制約のチェック

### 関数一覧

| 関数 | 引数 | 戻り値 | 説明 |
|------|------|--------|------|
| `canOpenPosition` | stockId, quantity, price | { allowed, reason } | 新規ポジション可否 |
| `checkDailyLossLimit` | - | boolean | 日次損失制限チェック（確定損益+含み損益） |
| `getDailyPnl` | date?, options? | number | 日次損益（`includeUnrealized: true` で含み損益を含む） |
| `calculatePositionSize` | price, budget, maxPct | number | 最適ポジションサイズ |

### canOpenPosition チェック項目

1. **取引活性**: TradingConfig.isActive = true
2. **ポジション上限**: 現在ポジション数 < maxPositions（5）
3. **資金**: キャッシュ残高 >= 必要金額
4. **集中度**: 1銘柄のウェイト <= maxPositionPct（30%）
5. **日次損失**: 当日損益（確定損益 + 含み損益）が maxDailyLossPct（3%）以内

### ポジションサイズ計算

```
maxAmount = budget * (maxPositionPct / 100)
maxShares = Math.floor(maxAmount / price)
result = Math.floor(maxShares / UNIT_SHARES) * UNIT_SHARES
```

### リスクパラメータ

| パラメータ | デフォルト値 | 定数名 |
|-----------|-------------|--------|
| 最大ポジション数 | 5 | `TRADING_DEFAULTS.MAX_POSITIONS` |
| 最大ポジション比率 | 30% | `TRADING_DEFAULTS.MAX_POSITION_PCT` |
| 最大日次損失率 | 3% | `TRADING_DEFAULTS.MAX_DAILY_LOSS_PCT` |
| 売買単位 | 100株 | `UNIT_SHARES` |

---

## ユーティリティ

### Ticker Utils（src/lib/ticker-utils.ts）

| 関数 | 説明 | 例 |
|------|------|-----|
| `normalizeTickerCode` | Yahoo Finance用にサフィックス付加 | "7203" → "7203.T" |
| `removeTickerSuffix` | サフィックス除去 | "7203.T" → "7203" |
| `prepareTickerForYahoo` | Yahoo Finance API用に変換 | normalizeTickerCode のエイリアス |
| `prepareTickerForDB` | DB保存用に変換 | removeTickerSuffix のエイリアス |

### Slack（src/lib/slack.ts）

| 関数 | 通知内容 |
|------|---------|
| `notifyMarketAssessment` | 市場評価結果 |
| `notifyStockCandidates` | 候補銘柄一覧 |
| `notifyOrderPlaced` | 注文生成 |
| `notifyOrderFilled` | 約定 |
| `notifyDailyReport` | 日次レポート |
| `notifyRiskAlert` | リスクアラート |

### Constants（src/lib/constants.ts）

| カテゴリ | 主要定数 |
|----------|---------|
| 売買単位 | `UNIT_SHARES = 100` |
| 取引時間 | 9:00-15:00、デイトレ強制決済 14:50 |
| テクニカル閾値 | RSI: 70/30、VIX: 30/25/20 |
| Yahoo Finance | バッチ=10、レート制限=1000ms、ヒストリカル=60日 |
| セクターマスタ | 11セクターグループ（TSE業種→グループへの変換） |

## 7. Broker Event Stream（src/core/broker-event-stream.ts）

立花証券 EVENT I/F（WebSocket）クライアント。約定通知（EC）やキープアライブ（KP）をリアルタイムで受信する。

| 関数/クラス | 説明 |
|------------|------|
| `BrokerEventStream` | WebSocket接続管理、メッセージパース、イベント発火 |
| `parseEventMessage` | `\x01` 区切りメッセージのパース |
| `getBrokerEventStream` | シングルトンインスタンス取得 |
| `resetBrokerEventStream` | シングルトンリセット（テスト/シャットダウン用） |

**イベント:** `execution`（約定）、`keepalive`、`connected`、`disconnected`、`error`、`status`

## 8. Broker Fill Handler（src/core/broker-fill-handler.ts）

WebSocket 約定通知（EC）受信時の約定処理。

| 関数 | 説明 |
|------|------|
| `handleBrokerFill` | EC イベント → `CLMOrderListDetail` で詳細取得 → DB更新・ポジション操作 |

- 買い約定: ポジションオープン + SL逆指値注文をブローカーに発注
- 売り約定: ポジションクローズ + 損益計算
- `brokerStatus` を即座に更新し、position-monitor との二重処理を防止
