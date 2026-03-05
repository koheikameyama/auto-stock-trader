# 通知 仕様書

## 概要

株価アラートやデータ変化の通知を管理する機能です。アプリ内通知とプッシュ通知の2チャネルを提供します。

> **注意**: 通知は事実の伝達のみ行い、売買の指示は含みません。

**ページパス**: `/notifications`

## 通知タイプ

| タイプ | 説明 | トリガー |
|--------|------|----------|
| `price_alert` | 価格アラート | ウォッチリストの設定価格に到達 |
| `surge` | 急騰アラート | 日次変化率 ≥ +5% |
| `plunge` | 急落アラート | 日次変化率 ≤ -5% |
| `sell_target` | 売却目標到達 | ユーザー設定の売却目標価格に到達 |
| `stop_loss` | 撤退ライン到達 | ユーザー設定の撤退ラインに到達 |
| `profit_milestone` | 含み益マイルストーン | ポートフォリオ銘柄の含み益が+10%, +20%, +30%に到達 |
| `market_alert` | 市場警戒アラート | 市場急変を検知（VIX急騰、日経急落等）。トリガー種別と値を表示 |
| `daily_highlights` | 注目データ更新 | 今日の注目データが更新された際の通知 |
| `trend_divergence` | トレンド乖離 | 短期/長期トレンドの乖離が検出された際の通知。乖離状況と注目価格水準を表示 |
| `delisting_warning` | 上場廃止警告 | ポートフォリオ・ウォッチリスト銘柄の上場廃止関連ニュースを検出した際の通知 |

※ 廃止された通知タイプ: `buy_recommendation`（買い推奨）、`switch_proposal`（乗り換え提案）、`market_shield_activated/deactivated`（マーケットシールド発動/解除）

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

## 通知メッセージの原則

通知メッセージは事実の伝達のみ行い、行動指示は含めない。

### 価格アラート（price_alert）

- 「設定価格（¥X,XXX）に到達しました」
- ※ 「買い時です」「購入を検討してください」等の行動指示は含めない

### 売却目標/撤退ライン通知（sell_target / stop_loss）

- sell_target: 「設定した売却目標（+XX%）に到達しました」
- stop_loss: 「設定した撤退ライン（-XX%）に到達しました」
- ※ 「売却してください」「AIも売却を推奨しています」等の行動指示は含めない

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
