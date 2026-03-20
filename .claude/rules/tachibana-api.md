# 立花証券 e支店 API (v4r8)

## 基本情報

| 項目 | 内容 |
|------|------|
| 本番URL | `https://kabuka.e-shiten.jp/e_api_v4r8/` |
| デモURL | `https://demo-kabuka.e-shiten.jp/e_api_v4r8/` |
| リファレンス | https://www.e-shiten.jp/e_api/mfds_json_api_refference.html |
| プロトコル | HTTP GET |
| リクエスト形式 | URLクエリパラメータにJSON文字列 (`?{JSON}`) |
| レスポンス形式 | JSON（デフォルトは数値キー） |
| 文字コード | Shift_JIS（レスポンスの文字列値） |
| 値の型 | **全て文字列**（数値も `"100"` で送受信） |
| 銘柄コード | 4桁数字（`.T` サフィックスなし） |
| 市場コード | `"00"` = 東証 |

## 環境変数

```
TACHIBANA_USER_ID=xxx
TACHIBANA_PASSWORD=xxx
TACHIBANA_SECOND_PASSWORD=xxx  # 注文時に必須（発注用暗証番号）
```

## 共通パラメータ

全リクエストに必須:
- `p_no`: リクエスト番号（連番、文字列）
- `p_sd_date`: 送信日時 `"YYYY.MM.DD-HH:MM:SS.mmm"`
- `sCLMID`: 機能ID

## 認証

### ログイン (CLMAuthLoginRequest)

```
URL: {API専用URL}/auth/?{JSON}
```

**リクエスト:**
```json
{
  "p_no": "1",
  "p_sd_date": "2026.03.20-14:00:00.000",
  "sCLMID": "CLMAuthLoginRequest",
  "sUserId": "xxx",
  "sPassword": "xxx"
}
```

**レスポンス（主要フィールド）:**

| 数値キー | 名前付きキー | 説明 |
|---------|-------------|------|
| 287 | sResultCode | 結果コード（`"0"` = 正常） |
| 286 | sResultText | エラーテキスト |
| 334 | sCLMID | `"CLMAuthLoginAck"` |
| 872 | sUrlRequest | 業務機能用の仮想URL |
| 870 | sUrlMaster | マスタ機能用の仮想URL |
| 871 | sUrlPrice | 時価情報用の仮想URL |
| 868 | sUrlEvent | EVENT I/F用の仮想URL（Long Polling） |
| 869 | sUrlEventWebSocket | WebSocket用の仮想URL (`wss://`) |
| 744 | sSummaryGenkabuKaituke | 株式現物買付可能額 |
| 549 | sLastLoginDate | 最終ログイン日時 |

**セッション管理:**
- ログイン成功時にセッション固有の仮想URLが発行される
- 以降のAPI呼び出しは全てこの仮想URLを使用
- `sKinsyouhouMidokuFlg`（552）が `"1"` の場合、API利用不可

### ログアウト (CLMAuthLogoutRequest)

```json
{ "p_no": "N", "p_sd_date": "...", "sCLMID": "CLMAuthLogoutRequest" }
```

## 注文API（仮想URL(REQUEST)を使用）

### 株式新規注文 (CLMKabuNewOrder)

| パラメータ | 説明 | 値 |
|-----------|------|-----|
| sZyoutoekiKazeiC | 譲渡益課税区分 | `"1"` 特定, `"3"` 一般, `"5"` NISA |
| sIssueCode | 銘柄コード | 例: `"8411"` |
| sSizyouC | 市場 | `"00"` = 東証 |
| sBaibaiKubun | 売買区分 | `"1"` 売, `"3"` 買 |
| sCondition | 執行条件 | `"0"` 指定なし, `"2"` 寄付, `"4"` 引け, `"6"` 不成 |
| sOrderPrice | 注文値段 | `"0"` 成行, 数値 = 指値 |
| sOrderSuryou | 注文株数 | 例: `"100"` |
| sGenkinShinyouKubun | 現金信用区分 | `"0"` 現物, `"2"` 信用新規(制度), `"4"` 信用返済(制度) |
| sOrderExpireDay | 注文期日 | `"0"` 当日, YYYYMMDD（最大10営業日） |
| sGyakusasiOrderType | 逆指値注文種別 | `"0"` 通常, `"1"` 逆指値, `"2"` 通常+逆指値 |
| sGyakusasiZyouken | 逆指値条件（トリガー価格） | 数値 |
| sGyakusasiPrice | 逆指値値段 | `"0"` 成行, 数値 = 指値 |
| sSecondPassword | 第二パスワード | 必須 |

**レスポンス:**
- sOrderNumber: 注文番号（注文番号+営業日でユニーク）
- sEigyouDay: 営業日 (YYYYMMDD)
- sOrderTesuryou: 手数料
- sOrderSyouhizei: 消費税

**注文パターン例:**
- 現物買成行: `sGenkinShinyouKubun="0"`, `sBaibaiKubun="3"`, `sOrderPrice="0"`
- 現物売指値: `sGenkinShinyouKubun="0"`, `sBaibaiKubun="1"`, `sOrderPrice="201"`
- 逆指値（SL用）: `sGyakusasiOrderType="1"`, `sGyakusasiZyouken="460"`（トリガー）, `sGyakusasiPrice="455"`（指値）or `"0"`（成行）

### 株式訂正注文 (CLMKabuCorrectOrder)

- sOrderNumber, sEigyouDay で対象注文を指定
- `"*"` = 変更なし
- **増株不可**（減株のみ）
- 逆指値トリガー発火後は訂正不可

### 株式取消注文 (CLMKabuCancelOrder)

- sOrderNumber, sEigyouDay, sSecondPassword

### 株式一括取消 (CLMKabuCancelOrderAll)

- sSecondPassword のみ

## 口座・ポジションAPI

### 現物保有銘柄一覧 (CLMGenbutuKabuList)

- `sIssueCode`: 銘柄コード（`""` で全銘柄）
- レスポンス: 口座種別ごとの評価額合計 + `aGenbutuKabuList` 配列

| 数値キー | 名前付きキー | 説明 |
|---------|-------------|------|
| 859 | sUriOrderIssueCode | 銘柄コード |
| 863 | sUriOrderZanKabuSuryou | 残高株数 |
| 860 | sUriOrderUritukeKanouSuryou | 売付可能株数 |
| 854 | sUriOrderGaisanBokaTanka | 概算簿価単価 |
| 858 | sUriOrderHyoukaTanka | 評価単価 |
| 857 | sUriOrderGaisanHyoukagaku | 評価金額 |
| 855 | sUriOrderGaisanHyoukaSoneki | 評価損益 |

### 買余力 (CLMZanKaiKanougaku)

| 数値キー | 名前付きキー | 説明 |
|---------|-------------|------|
| 744 | sSummaryGenkabuKaituke | 株式現物買付可能額 |
| 746 | sSummaryNseityouTousiKanougaku | NISA成長投資可能額 |
| 451 | sHusokukinHasseiFlg | 不足金発生フラグ |

### 注文一覧 (CLMOrderList)

- `sIssueCode`: `""` で全銘柄
- `sOrderSyoukaiStatus`: `"1"` 未約定, `"2"` 全部約定, `"4"` 訂正取消可, `"5"` 未約定+一部約定

**注文状態コード:**

| コード | 状態 |
|--------|------|
| 0 | 受付未済 |
| 1 | 未約定 |
| 9 | 一部約定 |
| 10 | 全部約定 |
| 7 | 取消完了 |
| 12 | 全部失効 |
| 13 | 発注待ち（逆指値） |
| 15 | 切替注文（逆指値:切替中） |
| 16 | 切替完了（逆指値:未約定） |
| 50 | 発注中 |

### 注文約定一覧詳細 (CLMOrderListDetail)

- sOrderNumber + sEigyouDay で指定
- 約定リスト `aYakuzyouSikkouList`: 約定数量, 約定価格, 約定日時

### 売却可能数量 (CLMZanUriKanousuu)

### リアル保証金率 (CLMZanRealHosyoukinRitu)

### 可能額サマリー (CLMZanKaiSummary)

## マスタデータAPI（仮想URL(MASTER)を使用）

### マスタ情報ダウンロード (CLMEventDownload)

- ストリーミング配信（同期応答ではない）
- `CLMEventDownloadComplete` を受信するまでが初期データ
- 取得可能: 銘柄マスタ、日付情報、呼値テーブル、運用ステータス等

### 運用ステータス (CLMUnyouStatus)

| コード | 状態 |
|--------|------|
| 000 | 注文受付 |
| 100 | 前場受付開始 |
| 120 | 前場立会開始 |
| 140 | 前場立会終了 |
| 200 | 後場受付開始 |
| 260 | 後場立会終了 |
| 300 | 株式閉局 |
| 500 | 翌日注文受付開始 |

## 時価情報API（仮想URL(PRICE)を使用）

### 時価情報問合取得 (CLMMfdsGetMarketPrice)

- 詳細はPDF文書参照: `api_request_if_v4r7.pdf`
- 板情報（bid/ask）、出来高、時価等を取得可能

### 蓄積情報問合取得 (CLMMfdsGetMarketPriceHistory)

## EVENT I/F（リアルタイム通知）

### 2つの接続方式

1. **HTTP Long Polling** (`sUrlEvent`)
2. **WebSocket** (`sUrlEventWebSocket`, `wss://`)

### 通知内容

- 注文約定通知
- マスタ情報のリアルタイム更新
- 時価配信

## デモ環境テスト結果（2026-03-20確認済み）

- ログイン: OK
- 買余力: 2,000万円（デモ）
- 現物保有: 6501(日立), 6502(東芝), 9984(ソフトバンクG)
- 注文一覧: 空
- レスポンスは数値キー（名前付きキーのマッピングが必要）

## 実装上の注意

1. **数値キーのマッピング**: レスポンスのキーが数値。名前付きキーとのマッピングテーブルが必要
2. **URLエンコード**: JSONをURLエンコードして送信
3. **Shift_JIS**: レスポンスのデコードが必要
4. **第二パスワード**: 全ての注文操作で必須
5. **注文番号+営業日**: 注文の一意特定にはペアが必要
6. **逆指値**: SL注文に使える（`sGyakusasiOrderType="1"`）
7. **通常+逆指値**: OCO的な注文（`sGyakusasiOrderType="2"`）
