# 立花証券API移行ガイド

## 概要

現在のシステムはYahoo Financeの遅延データ（約15-20分）を使ったシミュレーション取引。立花証券のブローカーAPIに接続し、リアルマネーでの自動売買に移行するための変更事項をまとめる。

---

## 変更カテゴリ

| カテゴリ | 影響度 | 概要 |
|---------|--------|------|
| A. 注文執行 | 最大 | シミュレーション → 実注文 |
| B. マーケットデータ | 大 | Yahoo Finance → リアルタイムデータ |
| C. スケジュール | 中 | +20分オフセット撤廃 |
| D. ポジション管理 | 中 | ローカル計算 → ブローカー残高連携 |
| E. ティッカーコード | 小 | `.T`サフィックス → 4桁コード |
| F. 新規実装 | 大 | ブローカー固有の機能追加 |

---

## A. 注文執行（最大の変更）

### 現状: シミュレーション

```
order-manager: DB に pending レコード作成 → 完了
position-monitor: Yahoo Finance 価格取得 → checkOrderFill() で約定判定 → DB更新
```

ブローカーに注文を送信していない。約定判定は `checkOrderFill()` のロジックで疑似的に行っている。

### 変更後: リアル注文

```
order-manager: ブローカーAPI に注文送信 → ブローカー注文IDをDB保存
position-monitor: ブローカーAPI から注文ステータス取得 → DB同期
```

### 対象ファイル・関数

| ファイル | 関数 | 現状 | 変更後 |
|---------|------|------|--------|
| `src/core/order-executor.ts` | `checkOrderFill()` | 価格比較で約定判定 | **廃止** — ブローカーが約定通知 |
| `src/core/order-executor.ts` | `fillOrder()` | DB を `filled` に更新 | ブローカー約定イベント受信時に呼ぶ |
| `src/core/order-executor.ts` | `expireOrders()` | DB を `expired` に更新 | ブローカー側で失効 → ステータス同期 |
| `src/core/order-executor.ts` | `getPendingOrders()` | ローカルDB検索 | ブローカーAPI `GET /orders` + ローカルDB同期 |
| `src/core/position-manager.ts` | `openPosition()` | 即座に `filled` で記録 | ブローカー約定確認後に記録 |
| `src/core/position-manager.ts` | `closePosition()` | 即座に `closed` で記録 | 売り注文送信 → 約定確認後に記録 |
| `src/jobs/order-manager.ts` | 注文作成部 | `prisma.tradingOrder.create()` のみ | ブローカーAPI送信 + ブローカー注文ID保存 |

### DBスキーマ変更

`TradingOrder` テーブルに追加が必要：

```prisma
model TradingOrder {
  // 既存フィールド...
  brokerOrderId  String?  // ブローカー側の注文ID
  brokerStatus   String?  // ブローカー側のステータス（参照用）
}
```

### 重要: 注文ライフサイクルの変化

```
【現在（シミュレーション）】
create → pending → (checkOrderFill) → filled/expired

【移行後（リアル）】
create → ブローカーに送信 → pending（ブローカーID付き）
  → ブローカーから約定通知 → filled
  → ブローカーから失効通知 → expired
  → キャンセル要求 → ブローカーにキャンセル送信 → cancelled
```

---

## B. マーケットデータ

### 現状: Yahoo Finance（15-20分遅延）

`src/core/market-data.ts` が全てのデータソース。

### 変更対象

| 関数 | 現状 | 変更後 |
|------|------|--------|
| `fetchStockQuote()` | Yahoo Finance `quote()` | ブローカーリアルタイムAPI |
| `fetchStockQuotesBatch()` | Yahoo Finance バッチ | ブローカーバッチAPI or 個別呼び出し |
| `fetchHistoricalData()` | Yahoo Finance `chart()` | ブローカー日足API or 別データプロバイダー |
| `fetchMarketData()` | Yahoo Finance（指数） | 据え置き可能（指数はブローカーAPI外の場合も） |

### 定数変更

`src/lib/constants/trading.ts` の `YAHOO_FINANCE` 定数ブロックをブローカー固有の設定に差し替え：

```typescript
// 現在
export const YAHOO_FINANCE = {
  BATCH_SIZE: 50,
  RATE_LIMIT_DELAY_MS: 2000,
  RETRY_MAX_ATTEMPTS: 3,
  RETRY_BASE_DELAY_MS: 5000,
};

// 移行後
export const BROKER_API = {
  BATCH_SIZE: ???,           // 立花証券APIの仕様に依存
  RATE_LIMIT_DELAY_MS: ???,
  RETRY_MAX_ATTEMPTS: 3,
  RETRY_BASE_DELAY_MS: 1000,
};
```

### 設計判断: データプロバイダーの抽象化

移行時に `MarketDataProvider` インターフェースを導入し、Yahoo FinanceとブローカーAPIを切り替え可能にすることを推奨：

```typescript
interface MarketDataProvider {
  fetchQuote(symbol: string): Promise<StockQuote>;
  fetchQuotesBatch(symbols: string[]): Promise<Map<string, StockQuote>>;
  fetchHistorical(symbol: string, days: number): Promise<OHLCV[]>;
}
```

理由: バックテストや開発時にはYahoo Financeを引き続き使用するため。

---

## C. スケジュール変更

### 現在のオフセット（Yahoo Finance遅延対策）

`src/worker.ts` のコメント: 「Yahoo Finance約20分遅延を考慮し+20分にオフセット」

| ジョブ | 現在 | 変更後 | 理由 |
|--------|------|--------|------|
| order-manager | 9:20 | **9:00-9:05** | リアルタイムデータなら寄付き直後に発注可能 |
| position-monitor | 9:20-15:19 | **9:00-15:00** | リアルタイムで全取引時間をカバー |
| end-of-day | 15:50 | **15:05-15:10** | 大引け後すぐに処理可能 |
| DAY_TRADE_FORCE_EXIT | 14:50 | **14:50-14:55** | 遅延なしでも大引け前の安全マージンは残す |

### 対象定数

```typescript
// src/lib/constants/trading.ts
export const TRADING_SCHEDULE = {
  DAY_TRADE_FORCE_EXIT: { hour: 14, minute: 50 }, // → 実時間に修正
};
```

### 重要: 9:00-9:20の空白時間

**現在**: 9:00-9:20はシステムが動いていない（Yahoo Finance遅延のため意図的にスキップ）。シミュレーションなので実害なし。

**移行後**: この20分間はリアルマネーがノーガードになる。SLが寄付きのギャップダウンで突き抜けるリスクがある。

**対策**:
1. ブローカー側にSL逆指値注文を事前に出しておく（前日or寄付き前）
2. position-monitorを9:00開始に変更
3. 寄付き前の板寄せで約定する場合のハンドリング追加

---

## D. ポジション・資金管理

### 現状: ローカル計算

| 関数 | 現状 | 変更後 |
|------|------|--------|
| `getCashBalance()` | `totalBudget - Σ(entryPrice × quantity)` で計算 | ブローカーAPI `GET /account/balance` |
| `getTotalPortfolioValue()` | ローカルDB + Yahoo Finance価格で計算 | ブローカーAPI `GET /account/portfolio` |
| `closePosition()` の残高更新 | `totalBudget += 売却額` で即時反映 | ブローカー残高と定期同期 |

### 設計判断: 二重管理 vs ブローカー単一ソース

**推奨: 二重管理（ローカルDB + ブローカー）**

- ローカルDBは取引履歴・分析用に維持
- 残高はブローカーAPIを正（Source of Truth）とする
- 定期的にブローカー残高とローカル計算の乖離を検証（リコンシリエーション）

---

## E. ティッカーコード

### 現状

`src/lib/ticker-utils.ts` で日本株コードに `.T` サフィックスを付与（Yahoo Finance形式）。

```
7203 → 7203.T（Yahoo Finance用）
```

### 変更

立花証券APIのシンボル形式に合わせる。おそらく4桁の数値コードそのまま。

```
7203.T → 7203（ブローカーAPI用）
```

対象:
- `normalizeTickerCode()` — Yahoo Finance依存の `.T` ロジック
- `prepareTickerForYahoo()` — 関数名自体がYahoo Finance固有
- DBの `Stock.tickerCode` — 現在 `.T` 付きで保存。移行時にサフィックス削除するか検討

---

## F. 新規実装が必要な機能

### 1. ブローカー認証・セッション管理

```typescript
// 新規: src/core/broker-client.ts
class TachibanaClient {
  login(): Promise<void>;       // ログイン（セッション取得）
  logout(): Promise<void>;      // ログアウト
  isSessionValid(): boolean;    // セッション有効性確認
  refreshSession(): Promise<void>; // セッション更新
}
```

取引時間中はセッションを維持し続ける必要がある。

### 2. 注文API連携

```typescript
// 新規: src/core/broker-orders.ts
submitOrder(order: OrderRequest): Promise<BrokerOrderResponse>;
cancelOrder(brokerOrderId: string): Promise<void>;
getOrderStatus(brokerOrderId: string): Promise<OrderStatus>;
getOpenOrders(): Promise<BrokerOrder[]>;
```

### 3. ブローカー側SL/TP注文

**最も重要な新機能。**

現在はposition-monitorが毎分ポーリングしてSL/TPを判定しているが、リアルトレードではブローカー側に逆指値注文を出しておくべき。

```
【現在】
position-monitor (毎分) → quote取得 → low ≤ SL? → closePosition()

【移行後】
ポジション開設時 → ブローカーにSL逆指値注文を同時送信
→ ブローカーが自動でSL執行
→ position-monitorはTP確認 + トレーリングストップ更新のみ
```

**理由**: position-monitorが落ちても、ブローカー側のSL注文が損失を限定する。

### 4. トレーリングストップのSL更新

現在のATRベーストレーリングストップは `position-monitor` 内でローカル計算のみ。移行後はブローカー側のSL逆指値注文も更新する必要がある。

```
trailingStopPrice 更新時 → ブローカーのSL注文を変更（modify order）
```

### 5. 約定通知ハンドラー（Webhook or ポーリング）

立花証券APIの仕様次第だが、約定通知を受け取る仕組みが必要。

- **Webhook方式**: ブローカーから HTTP コールバック → エンドポイント追加
- **ポーリング方式**: 定期的にブローカーの注文ステータスを確認

### 6. リコンシリエーション（整合性チェック）

ブローカーの実残高・ポジションとローカルDBの乖離を検出する日次ジョブ。

```typescript
// 新規: src/jobs/reconciliation.ts
async function reconcile() {
  const brokerPositions = await broker.getPositions();
  const localPositions = await getOpenPositions();
  // 差分を検出 → Slack通知
}
```

---

## 移行戦略

### フェーズ1: 並行運用（推奨）

1. ブローカーAPIクライアント実装
2. `MarketDataProvider` インターフェース導入
3. 発注ロジックに「ドライラン」モード追加（ログのみ、実注文なし）
4. シミュレーション結果とブローカーAPI結果を並行比較

### フェーズ2: 段階的移行

1. マーケットデータをブローカーAPIに切り替え（注文はまだシミュレーション）
2. 1銘柄・最小ロットで実注文テスト
3. SL逆指値のブローカー側注文を実装
4. 全機能を実注文に切り替え

### フェーズ3: 本番運用

1. スケジュールオフセット撤廃（9:20 → 9:00）
2. リコンシリエーションジョブ追加
3. ドライランモード無効化

---

## リスクと注意事項

### 致命的リスク

| リスク | 対策 |
|--------|------|
| 二重発注（DBとブローカーの不整合） | 冪等性キー（idempotency key）をブローカーに送信 |
| SL未設定のまま放置 | ポジション開設と同時にSL注文を必ず送信。失敗時はポジション自体をキャンセル |
| セッション切れ中の取引見逃し | セッション監視 + 自動再接続 + Slack警報 |
| API障害時の対応 | フォールバック: 手動取引 or 全ポジション決済 |

### ディフェンシブモードへの影響

現在の `closePosition(positionId, quote.price, ...)` は即座にDBを更新するだけだが、移行後は：

1. ブローカーに成行売り注文を送信
2. 約定確認を待つ
3. 約定価格でDB更新

crisis時の全決済も同様に、一括成行注文 → 約定確認のフローになる。大量注文の同時送信時のレート制限に注意。

---

## 変更ファイル一覧（サマリ）

| ファイル | 変更種別 |
|---------|---------|
| `src/core/order-executor.ts` | 大幅改修（`checkOrderFill` 廃止、ブローカー連携に置換） |
| `src/core/market-data.ts` | 大幅改修（Yahoo Finance → ブローカーAPI） |
| `src/core/position-manager.ts` | 改修（非同期約定フローに対応） |
| `src/jobs/order-manager.ts` | 改修（ブローカーに注文送信） |
| `src/jobs/position-monitor.ts` | 改修（ブローカーSL注文 + ステータス同期） |
| `src/jobs/end-of-day.ts` | 改修（成行注文送信） |
| `src/jobs/backfill-prices.ts` | 改修（データソース切り替え） |
| `src/lib/constants/trading.ts` | 改修（スケジュール・API設定） |
| `src/lib/ticker-utils.ts` | 改修（シンボル形式変更） |
| `src/worker.ts` | 改修（スケジュールオフセット撤廃） |
| `src/core/broker-client.ts` | **新規**（ブローカー認証・セッション管理） |
| `src/core/broker-orders.ts` | **新規**（注文API連携） |
| `src/jobs/reconciliation.ts` | **新規**（整合性チェック） |
| `prisma/schema.prisma` | 改修（`brokerOrderId` 等追加） |
