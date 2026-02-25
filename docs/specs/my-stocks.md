# マイ株 仕様書

## 概要

マイ株はユーザーの銘柄管理画面です。4つのタブ（ポートフォリオ・ウォッチリスト・追跡銘柄・売却済み）で投資銘柄のライフサイクルを管理します。

**ページパス**: `/my-stocks`

## タブ構成

### 1. ポートフォリオ（保有銘柄）

保有中の銘柄一覧。AI分析結果と取引機能を提供します。

**表示条件**: Transactionから計算した保有数量 > 0

**ソート順**:
1. 売り推奨銘柄を優先（損益率が悪い順）
2. その他は保有額が大きい順
3. 古いデータ/上場廃止銘柄は薄く表示

**カード表示項目**:
- 銘柄名、証券コード、セクター
- 保有数量、平均取得単価
- 現在価格、含み損益（額・率）
- AI分析結果: ステータスバッジ（即時売却 / 戻り売り / ホールド / 押し目買い / 全力買い）
- 短期分析テキスト
- 決算日バッジ（30日以内の場合表示）
- 取引履歴（展開可能）

**アクション**:
- 追加購入
- 売却（取引作成）
  - 全株売却時: ウォッチリスト追加 / 追跡追加 / 何もしない（過去の保有へ移動）の選択ダイアログを表示
- 個別設定（売却目標/撤退ライン）
- 削除

### 2. ウォッチリスト（気になる銘柄）

購入検討中の銘柄一覧。AIによる購入判断を提供します。

**ソート順**:
1. 買い推奨銘柄を優先（confidence順）
2. その他は追加日時が新しい順

**カード表示項目**:
- 銘柄名、証券コード、セクター
- 現在価格
- AI購入判断: buy / stay / avoid
- 信頼度スコア
- 投資テーマ、推奨理由
- 買い時ヒント（成り行きOK / 押し目待ち）
- 買い時通知の目標価格
- **投資スタイル別分析タブ**: 慎重派 / バランス型 / 積極派の3つのスタイルで分析結果を切り替え表示。ユーザーの設定スタイルがデフォルト選択される。各スタイルのタブには推奨ラベル（買い/様子見/見送り）を表示

**アクション**:
- 購入（ポートフォリオに移動 + 取引作成）
- 購入シミュレーション（購入後分析をモーダルで表示。将来的に有料コンテンツとして展開予定）
- 追跡に移動
- 買い時通知設定
- 削除

### 3. 追跡銘柄

AI分析なしで株価だけ追いたい銘柄。上限10銘柄。

**カード表示項目**:
- 銘柄名、証券コード
- 現在価格、前日比
- テクニカルシグナル（買い/売りシグナル）
- 決算日バッジ

**アクション**:
- ウォッチリストに移動
- 購入
- 削除

### 4. 売却済み

全量売却した銘柄の履歴。

**表示条件**: Transactionから計算した保有数量 = 0

**カード表示項目**:
- 銘柄名、証券コード
- 総購入額 / 総売却額
- 実現損益（額・率）
- 仮に保有し続けていた場合の比較
- 取引履歴

**アクション**:
- ウォッチリストに追加
- 再購入
- 詳細表示

## 銘柄詳細ページ

**パス**: `/my-stocks/[id]`

マイ株からの銘柄詳細ビュー。取引情報やAI分析を含む詳細表示。

**表示内容**:
- 保有状況（数量、平均取得単価、損益）
- AI購入判断（ウォッチリストの場合）
- 個別売却目標/撤退ライン
- タブ: チャート / テクニカル分析 / ニュース / 財務詳細
- 取引履歴（編集・削除可能）
- シミュレーション機能（仮購入の損益予測）

## API仕様

### ユーザー銘柄管理

#### `GET /api/user-stocks`

銘柄一覧を取得。

**クエリパラメータ**:
- `mode`: `all` | `portfolio` | `watchlist`

**レスポンス**: `UserStockResponse[]`

#### `POST /api/user-stocks`

銘柄を追加。

**リクエストボディ**:
```json
{
  "tickerCode": "7203.T",
  "type": "portfolio",
  "quantity": 100,
  "price": 2500,
  "date": "2026-02-22",
  "investmentTheme": "中長期安定成長"
}
```

**バリデーション**:
- ポートフォリオ上限: 100銘柄
- ウォッチリスト上限: 100銘柄
- 重複チェック（同一銘柄の二重登録不可）
- 銘柄マスタ未登録の場合: yfinanceで自動検索・登録

#### `PATCH /api/user-stocks/[id]`

銘柄設定を更新（買い時通知価格、売却目標率/撤退ライン率）。

**リクエストボディ**:
```json
{
  "targetBuyPrice": 2300,
  "takeProfitRate": 15,
  "stopLossRate": -10
}
```

#### `DELETE /api/user-stocks/[id]`

銘柄を削除。関連するトランザクションも削除。

### 追跡銘柄

#### `GET /api/tracked-stocks`

追跡銘柄一覧を取得。

#### `POST /api/tracked-stocks`

追跡銘柄を追加。

**リクエストボディ**: `{ "tickerCode": "7203.T" }` or `{ "stockId": "xxx" }`

**上限**: 10銘柄

#### `DELETE /api/tracked-stocks/[id]`

追跡銘柄を削除。

### 取引管理

#### `PATCH /api/transactions/[id]`

取引情報を編集。

**リクエストボディ**:
```json
{
  "quantity": 200,
  "price": 2600,
  "transactionDate": "2026-02-20"
}
```

**副作用**: なし（保有数量はTransactionから都度計算）。

#### `DELETE /api/transactions/[id]`

取引を削除。最後の取引が削除された場合、PortfolioStock も削除。

### 売却済み銘柄

#### `GET /api/sold-stocks`

売却済み銘柄の一覧を取得。

**レスポンス**:
```json
[
  {
    "id": "xxx",
    "stock": { "tickerCode": "7203.T", "name": "トヨタ自動車" },
    "buyTransactions": [...],
    "sellTransactions": [...],
    "totalBuyAmount": 500000,
    "totalSellAmount": 550000,
    "realizedGain": 50000,
    "realizedGainPercent": 10.0,
    "hypothetical": {
      "currentPrice": 2800,
      "currentValue": 560000,
      "hypotheticalGain": 60000,
      "hypotheticalGainPercent": 12.0
    }
  }
]
```

### CSVインポート（楽天証券）

#### `POST /api/import/rakuten-csv`

楽天証券のCSVデータをインポート。

**リクエストボディ**:
```json
{
  "transactions": [
    {
      "date": "2026-02-15",
      "tickerCode": "7203",
      "type": "buy",
      "quantity": 100,
      "price": 2500
    }
  ]
}
```

**処理フロー**:
1. 証券コード正規化（`.T` サフィックス付与）
2. CSV全体のグローバル日付範囲を計算
3. 対象銘柄の該当日付範囲内の既存取引を削除
4. 新しい取引を挿入
5. PortfolioStock の数量を同期
6. デフォルトの売却目標率/撤退ライン率を適用

### 銘柄追加リクエスト

#### `POST /api/stock-requests`

銘柄マスタへの追加をリクエスト。

**リクエストボディ**:
```json
{
  "tickerCode": "6600.T",
  "name": "キオクシアHD",
  "market": "東証プライム",
  "reason": "IPOしたばかりで気になっている"
}
```

**バリデーション**: yfinanceで銘柄の存在を確認してからリクエストを受理。

#### `GET /api/stock-requests`

自分のリクエスト一覧を取得。

**クエリパラメータ**: `status`, `limit`

## データモデル

### PortfolioStock

| カラム | 型 | 説明 |
|--------|-----|------|
| userId | String | ユーザーID |
| stockId | String | 銘柄ID |
| lastAnalysis | DateTime? | 最終分析日時 |
| shortTerm | Text? | 短期分析テキスト |
| mediumTerm | Text? | 中期分析テキスト |
| longTerm | Text? | 長期分析テキスト |
| statusType | String? | AI推奨ステータス |
| marketSignal | String? | bullish / neutral / bearish |
| suggestedSellPrice | Decimal? | 提案売却価格 |
| suggestedSellPercent | Int? | 推奨売却割合（25/50/75/100） |
| sellCondition | Text? | 売却条件テキスト |
| sellReason | Text? | 売却理由テキスト |
| sellTiming | String? | market / rebound |
| sellTargetPrice | Decimal? | 戻り売り目安価格 |
| takeProfitRate | Decimal? | 個別売却目標率（%、取得単価基準） |
| stopLossRate | Decimal? | 個別撤退ライン率（%、取得単価基準） |

### WatchlistStock

| カラム | 型 | 説明 |
|--------|-----|------|
| userId | String | ユーザーID |
| stockId | String | 銘柄ID |
| targetBuyPrice | Decimal? | 買い時通知の目標価格 |
| investmentTheme | String? | 投資テーマ |
| recommendationReason | Text? | AI推奨理由 |

### Transaction

| カラム | 型 | 説明 |
|--------|-----|------|
| userId | String | ユーザーID |
| stockId | String | 銘柄ID |
| portfolioStockId | String? | ポートフォリオ銘柄ID |
| type | String | buy / sell |
| quantity | Int | 数量 |
| price | Decimal | 単価 |
| totalAmount | Decimal | 合計額 |
| transactionDate | DateTime | 取引日 |

### TrackedStock

| カラム | 型 | 説明 |
|--------|-----|------|
| userId | String | ユーザーID |
| stockId | String | 銘柄ID |

**ユニーク制約**: `(userId, stockId)`

## 関連ファイル

- `app/my-stocks/page.tsx` - ページエントリ
- `app/my-stocks/MyStocksClient.tsx` - メインクライアントコンポーネント
- `app/my-stocks/[id]/page.tsx` - 銘柄詳細ページ
- `app/my-stocks/[id]/MyStockDetailClient.tsx` - 詳細クライアント
- `app/api/user-stocks/route.ts` - ユーザー銘柄管理 API
- `app/api/tracked-stocks/route.ts` - 追跡銘柄 API
- `app/api/transactions/[id]/route.ts` - 取引管理 API
- `app/api/sold-stocks/route.ts` - 売却済み銘柄 API
- `app/api/import/rakuten-csv/route.ts` - CSVインポート API
- `app/api/stock-requests/route.ts` - 銘柄追加リクエスト API
