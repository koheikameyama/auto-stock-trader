# 通知 仕様書

## 概要

株価アラートや投資関連の通知を管理する機能です。アプリ内通知とプッシュ通知の2チャネルを提供します。

**ページパス**: `/notifications`

## 通知タイプ

| タイプ | 説明 | トリガー |
|--------|------|----------|
| `ideal_entry_price` | 理想の買い値到達 | ウォッチリストの目標価格以下に下落 |
| `buy_recommendation` | 買い推奨 | ユーザーの投資スタイル別分析でbuyと判断 |
| `surge` | 急騰アラート | 日次変化率 ≥ +5% |
| `plunge` | 急落アラート | 日次変化率 ≤ -5% |
| `sell_target` | 売却目標到達 | ユーザー設定の売却目標価格に到達（スタイル別AI判断をメッセージに付加） |
| `stop_loss` | 撤退ライン到達 | ユーザー設定の撤退ラインに到達（スタイル別AI判断をメッセージに付加） |
| `profit_milestone` | 利確マイルストーン通知 | ポートフォリオ銘柄の含み益が+10%, +20%, +30%に到達した際に通知。投資スタイル別のアドバイス付き |

## 画面構成

### フィルター
- すべて / 未読のみ

### 通知カード
- タイプ別アイコン・色
- 通知タイトル、本文
- 関連銘柄名（ソースバッジ: 保有 / 注目）
- 経過時間
- 未読/既読状態

### アクション
- タップで関連ページに遷移
- 一括既読
- 個別既読

## API仕様

### `GET /api/notifications`

通知一覧を取得（カーソルベースページネーション）。

**クエリパラメータ**:
- `cursor`: ページネーションカーソル
- `limit`: 取得件数（デフォルト20）

**レスポンス**:
```json
{
  "notifications": [
    {
      "id": "xxx",
      "type": "surge",
      "title": "急騰アラート: トヨタ自動車",
      "body": "トヨタ自動車(7203.T)が前日比+5.2%上昇しました",
      "url": "/stocks/xxx",
      "stockId": "xxx",
      "stock": { "tickerCode": "7203.T", "name": "トヨタ自動車" },
      "triggerPrice": 2800,
      "changeRate": 5.2,
      "isRead": false,
      "createdAt": "2026-02-22T10:00:00Z"
    }
  ],
  "nextCursor": "xxx",
  "hasMore": true
}
```

### `PATCH /api/notifications/[id]/read`

通知を既読にする。

### `POST /api/notifications/read-all`

全通知を一括既読にする。

### `POST /api/notifications/send`

通知を送信（CRON経由）。

**認証**: CRON_SECRET

**重複防止**: 1ユーザー/1銘柄/1タイプにつき1日1回まで

## プッシュ通知

### フロー

1. ユーザーが設定画面でプッシュ通知をON
2. Service Worker登録（`/sw.js`）
3. VAPID公開鍵取得 → ブラウザのPush API登録
4. `PushSubscription` テーブルに保存
5. 通知送信時: `web-push` ライブラリで全アクティブ購読に配信

### API

#### `POST /api/push/subscribe`

プッシュ通知を購読。

**リクエストボディ**:
```json
{
  "endpoint": "https://fcm.googleapis.com/...",
  "keys": {
    "p256dh": "...",
    "auth": "..."
  }
}
```

#### `DELETE /api/push/subscribe`

プッシュ通知の購読を解除。

### 送信仕様

- 並列送信: `p-limit(10)`
- 410 Gone レスポンス: 購読を自動削除（アンインストール検出）

## データモデル

### Notification

| カラム | 型 | 説明 |
|--------|-----|------|
| userId | String | ユーザーID |
| type | String | 通知タイプ |
| stockId | String? | 関連銘柄ID |
| title | String | タイトル |
| body | Text | 本文 |
| url | String? | 遷移先URL |
| triggerPrice | Decimal? | トリガー価格 |
| targetPrice | Decimal? | 目標価格 |
| changeRate | Decimal? | 変化率 |
| isRead | Boolean | 既読フラグ |
| isPushSent | Boolean | プッシュ送信済みフラグ |
| readAt | DateTime? | 既読日時 |

### PushSubscription

| カラム | 型 | 説明 |
|--------|-----|------|
| userId | String | ユーザーID |
| endpoint | String | プッシュエンドポイント（ユニーク） |
| p256dh | String | 暗号化キー |
| auth | String | 認証キー |

## 投資スタイル連携

通知生成時にユーザーの投資スタイル（慎重派/バランス型/積極派）の分析結果を参照する。

### 購入推奨通知（buy_recommendation）

- `PurchaseRecommendation.styleAnalyses[ユーザーのスタイル]`を参照
- ユーザーのスタイルで`recommendation == "buy"` かつ `confidence >= 閾値`の場合のみ通知
- スタイル別の確信度・理由を通知本文に使用
- `styleAnalyses`がない場合はベースの推奨にフォールバック

### 売却目標/撤退ライン通知（sell_target / stop_loss）

- 価格アラートは安全機構のため常に通知する（フィルタリングしない）
- `StockAnalysis.styleAnalyses[ユーザーのスタイル]`のAI推奨をメッセージに付加
  - AI推奨が"sell"の場合: 「AIも売却を推奨しています」
  - AI推奨が"buy"の場合: 「AIはまだ保有継続を推奨しています」（sell_target）/ 「AIは回復を予測しています」（stop_loss）

## アラート監視スケジュール

- 取引時間中（9:00-15:30 JST）の15分間隔
- 昼休み（11:30-12:30）と取引時間外は除外

## 関連ファイル

- `app/notifications/page.tsx` - 通知ページ
- `app/api/notifications/route.ts` - 通知一覧 API
- `app/api/notifications/[id]/read/route.ts` - 既読 API
- `app/api/notifications/read-all/route.ts` - 一括既読 API
- `app/api/notifications/send/route.ts` - 通知送信 API
- `app/api/push/subscribe/route.ts` - プッシュ購読 API
