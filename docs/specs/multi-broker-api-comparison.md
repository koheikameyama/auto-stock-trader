# 証券会社API比較・移行戦略

**作成日**: 2026-04-16
**対象**: 立花証券 / Webull証券 / Interactive Brokers
**目的**: 米国株対応・複数戦略並列実行を見据えた証券会社API選定

---

## 目次

- [1. サマリー](#1-サマリー)
- [2. 3社API詳細比較](#2-3社api詳細比較)
- [3. 移行シナリオ](#3-移行シナリオ)
- [4. API統一インターフェース設計](#4-api統一インターフェース設計)
- [5. 審査通過後のアクションプラン](#5-審査通過後のアクションプラン)
- [6. 参考リンク](#6-参考リンク)

---

## 1. サマリー

### 現状
- **利用中**: 立花証券API（日本株のみ）
- **戦略**: Gapup + PSC（日本株現物、breakout・weekly-breakは無効化済み）
- **課題**:
  - 米国株市場にアクセスできない
  - `p_no`順序制約により並列リクエスト不可（複数戦略の同時稼働に制約）

### 口座開設状況
- ✅ **Webull証券**: 口座開設申請済み（審査中）
- ✅ **Interactive Brokers**: 口座開設申請済み（審査中）

### 選定結論（2026-04-16決定）

**用途別に使い分け。Webullは見送り。**

| 用途 | 証券会社 | 理由 |
|------|---------|------|
| **日本株（gapup+PSC）** | **立花証券を継続** | 既に安定稼働・信用手数料無料・移行リスクなし |
| **米国株（将来）** | **IBKR一択** | 手数料最安・オプション対応・Paper Trading完備 |
| **Webull** | **見送り** | 日本株でも米国株でも2番手。IBKR上位互換 |

#### Webull見送りの理由
- API Key 45日更新が運用リスク（忘れると止まる）
- 日本株手数料は立花証券より高い
- 米国株手数料はIBKRより高い（0.22% vs IBKR最安クラス）
- オプション非対応 → 将来の拡張性がない
- SDK・ドキュメントがIBKRほど成熟していない

#### アクションプラン
1. **今は何もしない** — gapup+PSCで資金を増やすフェーズ
2. **IBKR口座が通ったら** → Paper Tradingで米国株の検証環境だけ作る
3. **資金100万超でユニバース拡大した段階** → IBKRで米国株戦略を検討

---

## 2. 3社API詳細比較

### 2.1 認証・セキュリティ

| 項目 | 立花証券 | Webull証券 | Interactive Brokers |
|------|---------|-----------|---------------------|
| **認証方式** | ログインID + パスワード | HMAC-SHA1署名（APP_KEY + SECRET_KEY） | TWS/Gateway経由（ローカル接続） |
| **セキュリティレベル** | 中 | 高（署名ベース） | 高（ローカル接続） |
| **API Key期限** | なし | 45日（更新必要） | なし |
| **セッション有効期限** | 6時間（推定） | 不明 | TWS起動中 |
| **第二パスワード** | 必須（全注文） | 不要 | 不要 |
| **セッション切れ検出** | `sResultCode=2` | HTTPステータスコード | 接続エラー |
| **仮想URL方式** | ✅（セッション固有URL） | ❌ | ❌ |

### 2.2 APIアーキテクチャ

| 項目 | 立花証券 | Webull証券 | Interactive Brokers |
|------|---------|-----------|---------------------|
| **プロトコル** | HTTP GET + WebSocket | HTTP + MQTT + gRPC | Socket通信 |
| **リクエスト形式** | URLクエリ（JSON） | REST API（JSON） | Python API（ib_insync） |
| **レスポンス形式** | JSON（数値キー） | JSON（名前付きキー） | Python Objects |
| **文字コード** | Shift_JIS | UTF-8 | UTF-8 |
| **データ型** | 全て文字列 | 適切な型 | 適切な型 |
| **並列実行** | ❌ (`p_no`順序制約) | ✅ | ✅（clientId分離） |
| **同時セッション** | 1つのみ | 複数可能 | 複数可能（clientId） |

**立花証券の並列実行制約の詳細:**
```
p_no（リクエスト番号）はセッション内で厳密に昇順でなければエラー。
→ 並列リクエストを行うと順序が崩れる
→ リクエストは直列化が必須（p-limit(1)）
→ 複数戦略の同時稼働が困難
```

### 2.3 対応市場・商品

| 項目 | 立花証券 | Webull証券 | Interactive Brokers |
|------|---------|-----------|---------------------|
| **日本株** | ✅ 現物・信用 | ✅ 現物のみ | ✅ |
| **米国株** | ❌ | ✅ 現物のみ | ✅ |
| **米国株オプション** | ❌ | ❌（プラットフォーム上は可） | ✅ |
| **先物** | ❌ | ❌ | ✅ |
| **暗号資産** | ❌ | ❌ | ✅（米国版のみ） |
| **24時間取引** | ❌ | ✅（米国株） | ✅ |
| **端株取引** | ❌ | ✅（米国株） | ✅ |

### 2.4 マーケットデータ

| 項目 | 立花証券 | Webull証券 | Interactive Brokers |
|------|---------|-----------|---------------------|
| **リアルタイム株価** | ✅ CLMMfdsGetMarketPrice | ✅ Market Data API | ✅ reqMktData |
| **板情報** | ✅（気配値・数量） | ✅ Order Book | ✅ MarketDepth |
| **ヒストリカルデータ** | ✅ CLMMfdsGetMarketPriceHistory | ✅ | ✅ reqHistoricalData |
| **複数銘柄同時取得** | ❌（1銘柄/リクエスト） | ✅ | ✅ |
| **バッチ取得の制約** | p_no順序で直列化必須 | 並列可能 | 並列可能 |
| **ファンダメンタルズ** | ❌ | ✅ | ✅ |
| **VWAP** | ✅ | ✅ | ✅ |
| **リアルタイム配信** | WebSocket（SOH区切り） | MQTT/WebSocket | asyncio streaming |

### 2.5 注文機能

| 項目 | 立花証券 | Webull証券 | Interactive Brokers |
|------|---------|-----------|---------------------|
| **成行注文** | ✅ | ✅ | ✅ |
| **指値注文** | ✅ | ✅ | ✅ |
| **逆指値（Stop Loss）** | ✅ sGyakusasiOrderType | ✅ | ✅ |
| **OCO注文** | ✅（通常+逆指値） | ✅ | ✅ |
| **トレーリングストップ** | ❌ | ✅ | ✅ |
| **時間指定（GTC/DAY）** | ✅（最大10営業日） | ✅ | ✅ |
| **執行条件** | 寄付/引け/不成 | 通常/時間外 | 豊富 |
| **注文訂正** | ✅（減株のみ） | ✅ | ✅ |
| **増株訂正** | ❌ | ✅ | ✅ |
| **注文取消** | ✅ | ✅ | ✅ |
| **一括取消** | ✅ | ✅ | ✅ |

### 2.6 約定通知

| 項目 | 立花証券 | Webull証券 | Interactive Brokers |
|------|---------|-----------|---------------------|
| **リアルタイム通知** | ✅ WebSocket（EC） | ✅ gRPC/MQTT | ✅ execDetails |
| **部分約定** | ✅（加重平均算出） | ✅ | ✅ |
| **約定詳細取得** | CLMOrderListDetail | Query Order Detail | reqExecutions |
| **通知方式** | push（WebSocket） | push（gRPC/MQTT） | push（async） |
| **Keep-alive** | 15秒間隔 | 不明 | heartbeat |

### 2.7 SDK・開発サポート

| 項目 | 立花証券 | Webull証券 | Interactive Brokers |
|------|---------|-----------|---------------------|
| **公式SDK** | ❌ | ✅ Python, Java | ✅ Python, Java, C++, C# |
| **推奨ライブラリ** | - | 公式SDK | ib_insync |
| **ドキュメント** | 日本語（詳細） | 英語（一部エラーあり） | 英語（充実） |
| **日本語情報** | 多い | 少ない | 中程度 |
| **サンプルコード** | 少ない | 中程度 | 豊富 |

### 2.8 手数料

| 項目 | 立花証券 | Webull証券 | Interactive Brokers |
|------|---------|-----------|---------------------|
| **API利用料** | 無料 | 無料 | 無料 |
| **日本株手数料** | 信用無料（金利1.6%） | 55円〜（100万円: 535円） | 要確認（高め） |
| **米国株手数料** | - | 0.22%（上限20ドル） | 業界最安クラス |
| **為替手数料** | - | 15銭/ドル | 要確認 |
| **口座維持費** | 無料 | 無料 | 無料 |

### 2.9 実装上の制約・注意点

| 項目 | 立花証券 | Webull証券 | Interactive Brokers |
|------|---------|-----------|---------------------|
| **並列リクエスト** | ❌ `p_no`順序制約 | ✅ | ✅ |
| **数値キーマッピング** | 必須（手動実装） | 不要 | 不要 |
| **文字コード変換** | 必須（Shift_JIS） | 不要 | 不要 |
| **型変換** | 必須（全て文字列） | 最小限 | 不要（Pythonic） |
| **同時セッション** | 1つのみ | 複数可能 | 複数可能 |
| **複数戦略並列稼働** | ❌ | ✅ | ✅ |

---

## 3. 移行シナリオ

### 3.1 シナリオA: 立花証券継続（現状維持）

#### 対象
- 日本株のみで十分に利益が出ている
- 米国株に興味がない
- 移行コストをかけたくない

#### メリット
- ✅ 既存コードをそのまま使える
- ✅ 実績ある立花証券で安定運用
- ✅ 移行リスクゼロ

#### デメリット
- ⚠️ 米国株市場にアクセスできない
- ⚠️ 並列実行の制約（複数戦略の同時稼働が困難）

#### 推奨タイミング
- **今すぐ〜3ヶ月**: 日本株メイン、戦略が安定している場合

---

### 3.2 シナリオB: Webull証券へ段階的移行 ⛔ 見送り

> **2026-04-16判定: 見送り。** IBKRの上位互換であり、日本株でも米国株でも2番手。積極的に使う理由がない。

#### 見送り理由
- ⚠️ API Key 45日更新が運用リスク（忘れると全停止）
- ⚠️ 日本株手数料は立花証券より高い → 日本株移行のメリットなし
- ⚠️ 米国株手数料はIBKRより高い（0.22% vs IBKR最安クラス）
- ⚠️ オプション非対応 → 将来Wheel戦略等を検証する場合に使えない
- ⚠️ SDK・ドキュメントがIBKRほど成熟していない
- ⚠️ Webull APIはまだ新しい（安定性未知）

#### 口座が通った場合
- 口座自体は維持（無料）しておくが、API実装は行わない
- IBKRで何か問題があった場合のバックアップとして位置づける

---

### 3.3 シナリオC: Interactive Brokers活用 ✅ 米国株はこれ

> **2026-04-16判定: 米国株はIBKR一択。** Paper Trading→小額リアル→本格運用の段階移行。

#### 選定理由
- ✅ 米国株手数料が業界最安クラス
- ✅ `ib_insync`（Python）が非常に良くできている → 実装が楽
- ✅ Paper Tradingが完備 → リスクゼロで検証可能
- ✅ オプション・先物にも対応 → 将来Wheel戦略を実オプションデータで検証する場合にも使える
- ✅ プロ・機関投資家も使う信頼性

#### 移行フェーズ

##### フェーズ1: Paper Trading（口座開設後すぐ）
1. TWS/IB Gatewayダウンロード
2. Paper Trading設定
3. `ib_insync`で接続テスト
4. 米国株マーケットデータ取得テスト

##### フェーズ2: リアル運用開始（資金100万超、ユニバース拡大後）
1. 米国株のみIB証券で運用開始
2. 日本株は立花証券継続（信用手数料無料で有利）

##### フェーズ3: 高度化（戦略が見つかったら）
1. オプション戦略の追加（実IVデータでWheel再検証等）
2. グローバル分散投資

#### 注意点
- ⚠️ TWS/IB Gatewayはローカル起動が必要（VPSやRaspberry Piで常時稼働を検討）
- ⚠️ 日本株手数料は高め → 日本株は立花証券を継続
- ⚠️ 英語ドキュメントのみ

---

### 3.4 シナリオD: 立花証券 + IBKR の2社運用（採用）

> **2026-04-16判定: これを採用。** 日本株=立花、米国株=IBKRのシンプルな2社体制。

#### 構成
- **日本株**: 立花証券（信用手数料無料、既存コード活用）
- **米国株+オプション**: Interactive Brokers（手数料最安、将来拡張性）

#### メリット
- ✅ 各市場で最もコストが安い証券会社を使える
- ✅ 2社だけなのでコードの複雑化が最小限
- ✅ IBKRでオプション・先物にも将来拡張可能

#### 注意点
- ⚠️ 2社のAPI実装・管理が必要（ただしWebullを含む3社よりはシンプル）
- ⚠️ IBKRのTWS/Gateway常時起動の運用設計が必要

---

## 4. API統一インターフェース設計

### 4.1 設計思想

複数の証券会社APIを統一インターフェースで抽象化することで：
- ✅ 証券会社の切り替えが容易
- ✅ 複数証券会社の並行運用が可能
- ✅ テストコードの共通化

### 4.2 インターフェース定義

```typescript
/**
 * 証券会社API統一インターフェース
 */
interface BrokerAPI {
  // 認証
  login(): Promise<void>;
  logout(): Promise<void>;

  // マーケットデータ
  fetchQuote(symbol: string): Promise<Quote>;
  fetchQuotesBatch(symbols: string[]): Promise<(Quote | null)[]>;

  // 注文
  placeOrder(params: OrderParams): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  modifyOrder(orderId: string, params: ModifyParams): Promise<void>;

  // ポジション・口座
  getPositions(): Promise<Position[]>;
  getBuyingPower(): Promise<number>;
  getOrders(filter?: OrderFilter): Promise<Order[]>;

  // リアルタイム通知
  subscribeExecutions(callback: (exec: Execution) => void): void;
  unsubscribeExecutions(): void;
}

/**
 * 共通データ型
 */
interface Quote {
  symbol: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  askPrice?: number;
  bidPrice?: number;
  askSize?: number;
  bidSize?: number;
}

interface OrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  price?: number;
  stopPrice?: number;
  timeInForce?: 'DAY' | 'GTC' | 'IOC';
}

interface OrderResult {
  orderId: string;
  status: 'ACCEPTED' | 'REJECTED';
  message?: string;
}

interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  realizedPnL: number;
}

interface Order {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  filledQuantity: number;
  averageFillPrice: number;
  status: 'PENDING' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED';
}

interface Execution {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  timestamp: Date;
}
```

### 4.3 実装例

```typescript
/**
 * 立花証券API実装
 */
class TachibanaAPI implements BrokerAPI {
  async login(): Promise<void> {
    const client = getTachibanaClient();
    // 既存の実装を利用
  }

  async fetchQuote(symbol: string): Promise<Quote> {
    return tachibanaFetchQuote(symbol);
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const client = getTachibanaClient();
    const res = await client.requestBusiness({
      sCLMID: 'CLMKabuNewOrder',
      sIssueCode: tickerToBrokerCode(params.symbol),
      sBaibaiKubun: params.side === 'BUY' ? '3' : '1',
      sOrderPrice: params.orderType === 'MARKET' ? '0' : String(params.price),
      sOrderSuryou: String(params.quantity),
      // ... 他のパラメータ
    });

    return {
      orderId: res.sOrderNumber,
      status: res.sResultCode === '0' ? 'ACCEPTED' : 'REJECTED',
      message: res.sResultText,
    };
  }

  // ... 他のメソッド実装
}

/**
 * Webull証券API実装
 */
class WebullAPI implements BrokerAPI {
  async login(): Promise<void> {
    // Webull認証フロー
  }

  async fetchQuote(symbol: string): Promise<Quote> {
    // Webull Market Data API呼び出し
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const response = await fetch(`${WEBULL_API_BASE}/trade/order/place-order`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({
        account_id: this.accountId,
        instrument_id: this.getInstrumentId(params.symbol),
        side: params.side,
        qty: params.quantity,
        order_type: params.orderType,
        limit_price: params.price,
      }),
    });

    // ... レスポンス処理
  }

  // ... 他のメソッド実装
}

/**
 * Interactive Brokers API実装
 */
class InteractiveBrokersAPI implements BrokerAPI {
  private ib: IB;

  async login(): Promise<void> {
    this.ib = new IB();
    await this.ib.connect('127.0.0.1', 7497, 1);
  }

  async fetchQuote(symbol: string): Promise<Quote> {
    const contract = new Stock(symbol, 'SMART', 'USD');
    const ticker = await this.ib.reqMktData(contract);

    return {
      symbol,
      price: ticker.last,
      previousClose: ticker.close,
      // ... 他のフィールド
    };
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const contract = new Stock(params.symbol, 'SMART', 'USD');
    const order = params.orderType === 'MARKET'
      ? new MarketOrder(params.side, params.quantity)
      : new LimitOrder(params.side, params.quantity, params.price);

    const trade = await this.ib.placeOrder(contract, order);

    return {
      orderId: String(trade.order.orderId),
      status: 'ACCEPTED',
    };
  }

  // ... 他のメソッド実装
}
```

### 4.4 使用例（プロバイダーパターン）

```typescript
/**
 * 環境変数で証券会社を切り替え
 */
function createBrokerAPI(): BrokerAPI {
  const broker = process.env.BROKER || 'tachibana';

  switch (broker) {
    case 'webull':
      return new WebullAPI();
    case 'ib':
      return new InteractiveBrokersAPI();
    case 'tachibana':
    default:
      return new TachibanaAPI();
  }
}

/**
 * ビジネスロジックは証券会社に依存しない
 */
async function executeGapupStrategy() {
  const broker = createBrokerAPI();
  await broker.login();

  // マーケットデータ取得
  const quotes = await broker.fetchQuotesBatch(['7203.T', '6758.T']);

  // エントリー判定
  for (const quote of quotes) {
    if (shouldEntry(quote)) {
      await broker.placeOrder({
        symbol: quote.symbol,
        side: 'BUY',
        quantity: 100,
        orderType: 'MARKET',
      });
    }
  }

  // ポジション確認
  const positions = await broker.getPositions();
  console.log('Current positions:', positions);
}
```

### 4.5 実装優先順位

#### フェーズ1: 最小限の実装
- [ ] `login()` / `logout()`
- [ ] `fetchQuote()` / `fetchQuotesBatch()`
- [ ] `placeOrder()`（MARKET, LIMIT）
- [ ] `getPositions()`

#### フェーズ2: 拡張
- [ ] `cancelOrder()` / `modifyOrder()`
- [ ] `getOrders()`
- [ ] `subscribeExecutions()`
- [ ] Stop Loss / OCO注文

#### フェーズ3: 高度化
- [ ] トレーリングストップ
- [ ] リアルタイムストリーミング
- [ ] パフォーマンス最適化

---

## 5. 審査通過後のアクションプラン

### 5.1 Webull証券 ⛔ API実装なし

口座が通っても API 実装は行わない。口座自体は維持費無料なので放置。
IBKRで問題が発生した場合のバックアップとして位置づける。

---

### 5.2 Interactive Brokers（審査通過後 7営業日）

#### ステップ1: ソフトウェアセットアップ
- [ ] TWS（Trader Workstation）ダウンロード
- [ ] IB Gatewayダウンロード（推奨: 軽量）
- [ ] Paper Trading口座のパスワード設定

#### ステップ2: Python環境構築
```bash
# ib_insyncインストール
pip install ib_insync

# 接続テスト
python -c "from ib_insync import IB; ib = IB(); ib.connect('127.0.0.1', 7497, 1); print('Connected:', ib.isConnected())"
```

#### ステップ3: Paper Tradingテスト
- [ ] IB Gatewayを起動（Paper Trading）
- [ ] API設定有効化（Edit → Global Configuration → API → Settings）
- [ ] `ib_insync`で接続テスト
- [ ] 米国株マーケットデータ取得
- [ ] 注文発注テスト（Paper Trading）

#### ステップ4: リアル口座設定
- [ ] 初回入金
- [ ] リアル口座でIB Gateway起動
- [ ] 小額で注文テスト

---

## 6. 参考リンク

### 公式ドキュメント

#### 立花証券
- 公式サイト: https://www.e-shiten.jp/api/
- API仕様書: 社内ドキュメント `docs/specs/tachibana-api-reference.md`

#### Webull証券
- 公式サイト: https://www.webull.co.jp/open-api
- API Documentation: https://developer.webull.co.jp/api-doc/
- OpenAPI利用申請: https://www.webull.co.jp/help/faq/1727

#### Interactive Brokers
- 公式サイト: https://www.interactivebrokers.co.jp/jp/trading/ib-api.php
- TWS API Documentation: https://interactivebrokers.github.io/tws-api/
- ib_insync Documentation: https://ib-insync.readthedocs.io/
- GitHub: https://github.com/erdewit/ib_insync

### 参考記事

#### Webull
- Webull OpenAPIで米国株の自動売買を行う: https://note.com/bakuson_dameyo/n/ndf6a749f55e4

#### Interactive Brokers
- IB証券API Python開発環境構築: https://munokuno.com/learn-prgramming/run-sample-code/
- ib_insync Guide: https://algotrading101.com/learn/ib_insync-interactive-brokers-api-guide/

---

## 変更履歴

| 日付 | 変更内容 |
|------|---------|
| 2026-04-16 | 初版作成（Webull証券・IB証券口座開設申請済み、審査待ち期間中の調査結果をまとめ） |
| 2026-04-16 | 選定結論を追加: 日本株=立花継続、米国株=IBKR一択、Webull見送り |
