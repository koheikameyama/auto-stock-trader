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
- **戦略**: Gapup、Weekly-break、PSC（すべて日本株現物）
- **課題**:
  - 米国株市場にアクセスできない
  - `p_no`順序制約により並列リクエスト不可（複数戦略の同時稼働に制約）

### 口座開設状況
- ✅ **Webull証券**: 口座開設申請済み（審査中）
- ✅ **Interactive Brokers**: 口座開設申請済み（審査中）

### 推奨戦略
**段階的移行アプローチ**
- **短期（〜3ヶ月）**: 立花証券継続（現状維持）
- **中期（3〜6ヶ月）**: Webull証券で米国株テスト運用
- **長期（6ヶ月〜）**: 戦略に応じて最適な証券会社を選択

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

### 3.2 シナリオB: Webull証券へ段階的移行

#### 対象
- 米国株市場に参入したい
- 日本株と米国株を統合管理したい
- 複数戦略を並列稼働したい

#### 移行フェーズ

##### フェーズ1: 検証（1〜2週間）
1. OpenAPI申請・承認
2. API仕様の確認
3. 認証テスト
4. マーケットデータ取得テスト

##### フェーズ2: 並行運用（1〜3ヶ月）
1. 米国株のみWebull APIで運用開始（小額）
2. 日本株は立花証券のまま継続
3. パフォーマンス・手数料を比較

##### フェーズ3: 完全移行（3ヶ月〜）
1. 日本株もWebull APIに移行（段階的）
2. 立花証券API削除
3. コードベース統一

#### メリット
- ✅ 並列実行可能（複数戦略を同時稼働）
- ✅ 米国株への拡張が簡単
- ✅ 1つのAPIで日米統合管理
- ✅ 署名ベース認証で安全性が高い

#### デメリット
- ⚠️ API実装の書き換え必要（工数大）
- ⚠️ Webull APIはまだ新しい（安定性未知）
- ⚠️ 日本株手数料は立花証券より高い可能性
- ⚠️ API Key 45日更新の運用管理が必要

#### 推奨タイミング
- 立花証券の「同時セッション1つのみ」が制約になったとき
- 米国株を本格的に始めるとき

---

### 3.3 シナリオC: Interactive Brokers活用（プロ向け）

#### 対象
- オプション・先物も含めた多様な戦略を実装したい
- グローバル市場にアクセスしたい
- 最も高機能なAPIを使いたい

#### 移行フェーズ

##### フェーズ1: Paper Trading（1ヶ月）
1. TWS/IB Gatewayダウンロード
2. Paper Trading設定
3. `ib_insync`で接続テスト
4. 米国株マーケットデータ取得テスト
5. 仮想資金でGapup戦略をテスト

##### フェーズ2: リアル運用開始（1〜3ヶ月）
1. 米国株のみIB証券で運用開始
2. 日本株は立花証券継続（手数料が安い）
3. オプションヘッジの検証

##### フェーズ3: 高度化（3ヶ月〜）
1. オプション戦略の追加
2. 先物取引の検討
3. グローバル分散投資

#### メリット
- ✅ 最も高機能（オプション・先物・グローバル市場）
- ✅ `ib_insync`で非同期処理が簡単
- ✅ Paper Tradingが最初から使える
- ✅ プロ・機関投資家も使う信頼性

#### デメリット
- ⚠️ 実装難易度が高い
- ⚠️ 日本株手数料は高め
- ⚠️ 英語ドキュメントのみ

#### 推奨タイミング
- オプション戦略を追加したいとき
- グローバル分散投資を本格化するとき

---

### 3.4 シナリオD: ハイブリッド運用（推奨）

#### 構成
- **日本株**: 立花証券（低コスト）
- **米国株**: Webull証券（統合管理）
- **オプション・先物**: Interactive Brokers（将来的に）

#### メリット
- ✅ 各証券会社の強みを活かせる
- ✅ コストを最適化できる
- ✅ リスク分散

#### デメリット
- ⚠️ 複数APIの実装・管理が必要
- ⚠️ コードが複雑化

#### 推奨タイミング
- **現在〜6ヶ月**: 最も柔軟性が高く、段階的に最適化できる

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

### 5.1 Webull証券（審査通過後 1〜3日）

#### ステップ1: API設定
- [ ] 審査通過メール確認
- [ ] 公式サイトから「OpenAPI利用申請」
- [ ] 「マイアプリケーション」でAPIサービス申請
- [ ] 審査待ち（1〜2営業日）

#### ステップ2: API Key発行
- [ ] 審査通過後、アプリケーション作成
- [ ] API Key生成（有効期限45日）
- [ ] APP_KEY, SECRET_KEYを環境変数に保存

#### ステップ3: 認証テスト
- [ ] HMAC-SHA1署名生成の実装
- [ ] 認証APIテスト
- [ ] セッション管理の確認

#### ステップ4: マーケットデータ取得テスト
- [ ] 日本株1銘柄の時価取得
- [ ] 米国株1銘柄の時価取得
- [ ] バッチ取得テスト（10銘柄）
- [ ] 板情報取得テスト

#### ステップ5: Paper Trading（あれば）
- [ ] デモ環境の確認
- [ ] 注文発注テスト
- [ ] 約定通知受信テスト

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
