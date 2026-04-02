# 立花証券 e支店 API リファレンス (v4r8)

## 基本情報

| 項目 | 内容 |
|------|------|
| 本番URL | `https://kabuka.e-shiten.jp/e_api_v4r8/` |
| デモURL | `https://demo-kabuka.e-shiten.jp/e_api_v4r8/` |
| プロトコル | HTTP GET |
| リクエスト形式 | URLクエリパラメータにJSON文字列 (`?{JSON}`) |
| レスポンス形式 | JSON（デフォルトは数値キー） |
| 文字コード | Shift_JIS（レスポンスの文字列値） |
| 値の型 | **全て文字列**（数値も `"100"` で送受信） |
| 銘柄コード | 4桁数字（`.T` サフィックスなし） |
| 市場コード | `"00"` = 東証 |

### バージョン管理

- URLのPrefix（`e_api_v4rN`）がリビジョン番号
- 後続版リリース後60日前後で旧版が廃止される
- ログイン応答の `sUpdateInformAPISpecFunction` でリリース予定日を通知

### アクセス方法

| 機能 | URL |
|------|-----|
| 認証 | `{API専用URL}/auth/?{JSON}` |
| 業務（注文等） | `{仮想URL(REQUEST)}?{JSON}` |
| マスタ | `{仮想URL(MASTER)}?{JSON}` |
| 時価情報 | `{仮想URL(PRICE)}?{JSON}` |
| EVENT（Long Polling） | `{仮想URL(EVENT)}` |
| EVENT（WebSocket） | `{仮想URL(EVENT-WebSocket)}` |

### 共通パラメータ

全リクエストに必須:

| パラメータ | 説明 | 形式 |
|-----------|------|------|
| `p_no` | リクエスト番号（連番） | 文字列 |
| `p_sd_date` | 送信日時 | `"YYYY.MM.DD-HH:MM:SS.mmm"` |
| `sCLMID` | 機能ID | 文字列 |

---

## 1. 認証機能（認証 I/F）

### 1.1 ログイン（CLMAuthLoginRequest）

**URL**: `{API専用URL}/auth/?{JSON}`

#### リクエスト

```json
{
  "p_no": "1",
  "p_sd_date": "2026.04.02-09:00:00.000",
  "sCLMID": "CLMAuthLoginRequest",
  "sUserId": "xxx",
  "sPassword": "xxx"
}
```

| パラメータ | 説明 | 値 |
|-----------|------|-----|
| `sCLMID` | 機能ID | `CLMAuthLoginRequest` |
| `sUserId` | ログインID | e支店口座のログインID |
| `sPassword` | パスワード | e支店口座のログインパスワード |

#### レスポンス（CLMAuthLoginAck）

**主要フィールド:**

| フィールド | 説明 | 値 |
|-----------|------|-----|
| `sResultCode` | 結果コード | `"0"` = 正常 |
| `sResultText` | 結果テキスト | 正常時: `""` |
| `sUrlRequest` | 仮想URL（REQUEST） | 業務機能用 |
| `sUrlMaster` | 仮想URL（MASTER） | マスタ機能用 |
| `sUrlPrice` | 仮想URL（PRICE） | 時価情報用 |
| `sUrlEvent` | 仮想URL（EVENT） | Long Polling用 |
| `sUrlEventWebSocket` | 仮想URL（EVENT-WebSocket） | WebSocket用 (`wss://`) |

**口座情報フィールド:**

| フィールド | 説明 | 値 |
|-----------|------|-----|
| `sZyoutoekiKazeiC` | 譲渡益課税区分 | `"1"` 特定 / `"3"` 一般 / `"5"` NISA |
| `sSecondPasswordOmit` | 暗証番号省略有無 | `"0"` 固定（省略不可） |
| `sLastLoginDate` | 最終ログイン日時 | `YYYYMMDDHHMMSS` |
| `sSinyouKouzaKubun` | 信用取引口座開設区分 | `"0"` 未開設 / `"1"` 開設 |
| `sHikazeiKouzaKubun` | 非課税口座開設区分（NISA） | `"0"` 未開設 / `"1"` 開設 |
| `sTokuteiKouzaKubunGenbutu` | 特定口座区分（現物） | `"0"` 一般 / `"1"` 源泉徴収なし / `"2"` 源泉徴収あり |
| `sTokuteiKouzaKubunSinyou` | 特定口座区分（信用） | 同上 |
| `sKinsyouhouMidokuFlg` | 金商法交付書面未読フラグ | `"1"` 未読（API利用不可） / `"0"` 既読 |

**通知用フィールド:**

| フィールド | 説明 |
|-----------|------|
| `sUpdateInformWebDocument` | 交付書面更新予定日 |
| `sUpdateInformAPISpecFunction` | e支店・APIリリース予定日 |

> **注意**: `sKinsyouhouMidokuFlg` が `"1"` の場合、仮想URLは発行されずAPIは利用不可。標準Webで書面確認が必要。

### 1.2 ログアウト（CLMAuthLogoutRequest）

#### リクエスト

```json
{
  "p_no": "N",
  "p_sd_date": "...",
  "sCLMID": "CLMAuthLogoutRequest"
}
```

#### レスポンス（CLMAuthLogoutAck）

| フィールド | 説明 |
|-----------|------|
| `sResultCode` | 結果コード（`"0"` = 正常） |
| `sResultText` | 結果テキスト |

---

## 2. 株式注文（業務機能 REQUEST I/F）

### 2.1 新規注文（CLMKabuNewOrder）

**URL**: `{仮想URL(REQUEST)}?{JSON}`

#### リクエスト

| パラメータ | 説明 | 値 |
|-----------|------|-----|
| `sCLMID` | 機能ID | `CLMKabuNewOrder` |
| `sZyoutoekiKazeiC` | 譲渡益課税区分 | `"1"` 特定 / `"3"` 一般 / `"5"` NISA / `"6"` N成長 |
| `sIssueCode` | 銘柄コード | 例: `"8411"` |
| `sSizyouC` | 市場 | `"00"` 東証 |
| `sBaibaiKubun` | 売買区分 | `"1"` 売 / `"3"` 買 / `"5"` 現渡 / `"7"` 現引 |
| `sCondition` | 執行条件 | `"0"` 指定なし / `"2"` 寄付 / `"4"` 引け / `"6"` 不成 |
| `sOrderPrice` | 注文値段 | `"*"` 指定なし / `"0"` 成行 / 数値 = 指値 |
| `sOrderSuryou` | 注文株数 | 例: `"100"` |
| `sGenkinShinyouKubun` | 現金信用区分 | 下表参照 |
| `sOrderExpireDay` | 注文期日 | `"0"` 当日 / `YYYYMMDD`（最大10営業日） |
| `sGyakusasiOrderType` | 逆指値注文種別 | `"0"` 通常 / `"1"` 逆指値 / `"2"` 通常+逆指値 |
| `sGyakusasiZyouken` | 逆指値条件（トリガー価格） | `"0"` 指定なし / 条件値段 |
| `sGyakusasiPrice` | 逆指値値段 | `"*"` 指定なし / `"0"` 成行 / 数値 = 指値 |
| `sTatebiType` | 建日種類 | `"*"` 指定なし / `"1"` 個別指定 / `"2"` 建日順 / `"3"` 単価益順 / `"4"` 単価損順 |
| `sTategyokuZyoutoekiKazeiC` | 建玉譲渡益課税区分 | `"*"` 現引現渡以外 / `"1"` 特定 / `"3"` 一般 |
| `sSecondPassword` | 第二パスワード | 必須 |

**現金信用区分:**

| 値 | 説明 |
|----|------|
| `"0"` | 現物 |
| `"2"` | 新規（制度信用6ヶ月） |
| `"4"` | 返済（制度信用6ヶ月） |
| `"6"` | 新規（一般信用6ヶ月） |
| `"8"` | 返済（一般信用6ヶ月） |

**信用返済時の返済建玉リスト（個別指定時のみ）:**

```json
"aCLMKabuHensaiData": [
  {
    "sTategyokuNumber": "999999",
    "sTatebiZyuni": "1",
    "sOrderSuryou": "100"
  }
]
```

#### レスポンス

| フィールド | 説明 |
|-----------|------|
| `sResultCode` | 結果コード（`"0"` = 正常） |
| `sResultText` | 結果テキスト |
| `sWarningCode` | 警告コード（`"0"` = 正常） |
| `sWarningText` | 警告テキスト |
| `sOrderNumber` | 注文番号（注文番号+営業日でユニーク） |
| `sEigyouDay` | 営業日 `YYYYMMDD` |
| `sOrderUkewatasiKingaku` | 注文受渡金額 |
| `sOrderTesuryou` | 手数料 |
| `sOrderSyouhizei` | 消費税 |
| `sKinri` | 金利（現物の場合 `"-"`） |
| `sOrderDate` | 注文日時 `YYYYMMDDHHMMSS` |

#### 注文パターン例

**現物買・成行（特定口座）:**

```json
{
  "sCLMID": "CLMKabuNewOrder",
  "sZyoutoekiKazeiC": "1",
  "sIssueCode": "6658",
  "sSizyouC": "00",
  "sBaibaiKubun": "3",
  "sCondition": "0",
  "sOrderPrice": "0",
  "sOrderSuryou": "100",
  "sGenkinShinyouKubun": "0",
  "sOrderExpireDay": "0",
  "sGyakusasiOrderType": "0",
  "sGyakusasiZyouken": "0",
  "sGyakusasiPrice": "*",
  "sTatebiType": "*",
  "sTategyokuZyoutoekiKazeiC": "*",
  "sSecondPassword": "pswd"
}
```

**現物売・指値（特定口座）:**

```json
{
  "sCLMID": "CLMKabuNewOrder",
  "sZyoutoekiKazeiC": "1",
  "sIssueCode": "6658",
  "sSizyouC": "00",
  "sBaibaiKubun": "1",
  "sCondition": "0",
  "sOrderPrice": "201",
  "sOrderSuryou": "100",
  "sGenkinShinyouKubun": "0",
  "sOrderExpireDay": "0",
  "sGyakusasiOrderType": "0",
  "sGyakusasiZyouken": "0",
  "sGyakusasiPrice": "*",
  "sTatebiType": "*",
  "sTategyokuZyoutoekiKazeiC": "*",
  "sSecondPassword": "pswd"
}
```

**逆指値注文（460円以上になったら455円で発注）:**

```json
{
  "sCLMID": "CLMKabuNewOrder",
  "sZyoutoekiKazeiC": "1",
  "sIssueCode": "3632",
  "sSizyouC": "00",
  "sBaibaiKubun": "3",
  "sCondition": "0",
  "sOrderPrice": "*",
  "sOrderSuryou": "100",
  "sGenkinShinyouKubun": "0",
  "sOrderExpireDay": "0",
  "sGyakusasiOrderType": "1",
  "sGyakusasiZyouken": "460",
  "sGyakusasiPrice": "455",
  "sTatebiType": "*",
  "sTategyokuZyoutoekiKazeiC": "*",
  "sSecondPassword": "pswd"
}
```

> **注意**: 逆指値条件を満たすまで注文は市場に出ない。

**通常+逆指値注文（指値970円で発注、974円以上になったら972円に変更）:**

```json
{
  "sCLMID": "CLMKabuNewOrder",
  "sZyoutoekiKazeiC": "1",
  "sIssueCode": "3668",
  "sSizyouC": "00",
  "sBaibaiKubun": "3",
  "sCondition": "0",
  "sOrderPrice": "970",
  "sOrderSuryou": "100",
  "sGenkinShinyouKubun": "0",
  "sOrderExpireDay": "0",
  "sGyakusasiOrderType": "2",
  "sGyakusasiZyouken": "974",
  "sGyakusasiPrice": "972",
  "sTatebiType": "*",
  "sTategyokuZyoutoekiKazeiC": "*",
  "sSecondPassword": "pswd"
}
```

**信用新規買（制度信用・成行・特定口座）:**

```json
{
  "sCLMID": "CLMKabuNewOrder",
  "sZyoutoekiKazeiC": "1",
  "sIssueCode": "3556",
  "sSizyouC": "00",
  "sBaibaiKubun": "3",
  "sCondition": "0",
  "sOrderPrice": "0",
  "sOrderSuryou": "100",
  "sGenkinShinyouKubun": "2",
  "sOrderExpireDay": "0",
  "sGyakusasiOrderType": "0",
  "sGyakusasiZyouken": "0",
  "sGyakusasiPrice": "*",
  "sTatebiType": "*",
  "sTategyokuZyoutoekiKazeiC": "*",
  "sSecondPassword": "pswd"
}
```

**買建の売返済（制度信用・個別指定・指値・特定口座）:**

```json
{
  "sCLMID": "CLMKabuNewOrder",
  "sZyoutoekiKazeiC": "1",
  "sIssueCode": "4241",
  "sSizyouC": "00",
  "sBaibaiKubun": "1",
  "sCondition": "0",
  "sOrderPrice": "920",
  "sOrderSuryou": "200",
  "sGenkinShinyouKubun": "4",
  "sOrderExpireDay": "0",
  "sGyakusasiOrderType": "0",
  "sGyakusasiZyouken": "0",
  "sGyakusasiPrice": "*",
  "sTatebiType": "1",
  "sTategyokuZyoutoekiKazeiC": "*",
  "sSecondPassword": "pswd",
  "aCLMKabuHensaiData": [
    { "sTategyokuNumber": "202007220000402", "sTatebiZyuni": "1", "sOrderSuryou": "100" },
    { "sTategyokuNumber": "202007220001591", "sTatebiZyuni": "2", "sOrderSuryou": "100" }
  ]
}
```

### 2.2 訂正注文（CLMKabuCorrectOrder）

#### リクエスト

| パラメータ | 説明 | 値 |
|-----------|------|-----|
| `sCLMID` | 機能ID | `CLMKabuCorrectOrder` |
| `sOrderNumber` | 注文番号 | 新規注文時の値 |
| `sEigyouDay` | 営業日 | 新規注文時の値 |
| `sCondition` | 執行条件 | `"*"` 変更なし / 新しい値 |
| `sOrderPrice` | 注文値段 | `"*"` 変更なし / `"0"` 成行 / 数値 |
| `sOrderSuryou` | 注文数量 | `"*"` 変更なし / 訂正数量（**増株不可**、内出来含む） |
| `sOrderExpireDay` | 注文期日 | `"*"` 変更なし / 新しい値 |
| `sGyakusasiZyouken` | 逆指値条件 | `"*"` 変更なし / 新しい値 |
| `sGyakusasiPrice` | 逆指値値段 | `"*"` 変更なし / 新しい値 |
| `sSecondPassword` | 第二パスワード | 必須 |

> **注意**: 増株訂正は不可。逆指値条件発火後は逆指値の訂正不可（通常の値段訂正を使用）。

#### レスポンス

| フィールド | 説明 |
|-----------|------|
| `sResultCode` | 結果コード |
| `sOrderNumber` | 注文番号 |
| `sEigyouDay` | 営業日 |
| `sOrderUkewatasiKingaku` | 注文受渡金額 |
| `sOrderTesuryou` | 手数料 |
| `sOrderSyouhizei` | 消費税 |
| `sOrderDate` | 注文日時 |

### 2.3 取消注文（CLMKabuCancelOrder）

#### リクエスト

```json
{
  "sCLMID": "CLMKabuCancelOrder",
  "sOrderNumber": "30000007",
  "sEigyouDay": "20200727",
  "sSecondPassword": "pswd"
}
```

#### レスポンス

| フィールド | 説明 |
|-----------|------|
| `sResultCode` | 結果コード |
| `sOrderNumber` | 注文番号 |
| `sEigyouDay` | 営業日 |
| `sOrderUkewatasiKingaku` | 注文受渡金額 |
| `sOrderDate` | 注文日時 |

### 2.4 一括取消（CLMKabuCancelOrderAll）

#### リクエスト

```json
{
  "sCLMID": "CLMKabuCancelOrderAll",
  "sSecondPassword": "pswd"
}
```

#### レスポンス

| フィールド | 説明 |
|-----------|------|
| `sResultCode` | 結果コード |
| `sResultText` | 結果テキスト |

---

## 3. 口座・ポジション情報

### 3.1 現物保有銘柄一覧（CLMGenbutuKabuList）

#### リクエスト

| パラメータ | 説明 | 値 |
|-----------|------|-----|
| `sCLMID` | 機能ID | `CLMGenbutuKabuList` |
| `sIssueCode` | 銘柄コード | `""` 全銘柄 / `"7201"` 指定銘柄 |

> **注意**: 合計値（リスト外項目）は銘柄コード指定に依存しない。

#### レスポンス

**口座別合計（リスト外）:**

| フィールド | 説明 |
|-----------|------|
| `sIppanGaisanHyoukagakuGoukei` | 概算評価額合計（一般口座） |
| `sIppanGaisanHyoukaSonekiGoukei` | 概算評価損益合計（一般口座） |
| `sTokuteiGaisanHyoukagakuGoukei` | 概算評価額合計（特定口座） |
| `sTokuteiGaisanHyoukaSonekiGoukei` | 概算評価損益合計（特定口座） |
| `sNisaGaisanHyoukagakuGoukei` | 概算評価額合計（NISA口座） |
| `sNisaGaisanHyoukaSonekiGoukei` | 概算評価損益合計（NISA口座） |
| `sNseityouGaisanHyoukagakuGoukei` | 概算評価額合計（N成長口座） |
| `sNseityouGaisanHyoukaSonekiGoukei` | 概算評価損益合計（N成長口座） |
| `sTotalGaisanHyoukagakuGoukei` | 概算評価額合計（残高合計） |
| `sTotalGaisanHyoukaSonekiGoukei` | 概算評価損益合計（残高合計） |

**銘柄別リスト（aGenbutuKabuList）:**

| フィールド | 説明 |
|-----------|------|
| `sUriOrderIssueCode` | 銘柄コード |
| `sUriOrderZyoutoekiKazeiC` | 譲渡益課税区分 |
| `sUriOrderZanKabuSuryou` | 残高株数 |
| `sUriOrderUritukeKanouSuryou` | 売付可能株数 |
| `sUriOrderGaisanBokaTanka` | 概算簿価単価 |
| `sUriOrderHyoukaTanka` | 評価単価 |
| `sUriOrderGaisanHyoukagaku` | 評価金額 |
| `sUriOrderGaisanHyoukaSoneki` | 評価損益 |
| `sUriOrderGaisanHyoukaSonekiRitu` | 評価損益率(%) |
| `sSyuzituOwarine` | 前日終値 |
| `sZenzituHi` | 前日比 |
| `sZenzituHiPer` | 前日比(%) |
| `sUpDownFlag` | 騰落率フラグ（下表参照） |
| `sNissyoukinKasikabuZan` | 証金貸株残 |

**騰落率フラグ:**

| コード | 範囲 |
|--------|------|
| `01` | +5.01% 以上 |
| `02` | +3.01% 〜 +5.00% |
| `03` | +2.01% 〜 +3.00% |
| `04` | +1.01% 〜 +2.00% |
| `05` | +0.01% 〜 +1.00% |
| `06` | 0（変化なし） |
| `07` | -0.01% 〜 -1.00% |
| `08` | -1.01% 〜 -2.00% |
| `09` | -2.01% 〜 -3.00% |
| `10` | -3.01% 〜 -5.00% |
| `11` | -5.01% 以下 |

### 3.2 信用建玉一覧（CLMShinyouTategyokuList）

#### リクエスト

| パラメータ | 説明 | 値 |
|-----------|------|-----|
| `sCLMID` | 機能ID | `CLMShinyouTategyokuList` |
| `sIssueCode` | 銘柄コード | `""` 全銘柄 / 指定銘柄 |

#### レスポンス

**合計（リスト外）:**

| フィールド | 説明 |
|-----------|------|
| `sUritateDaikin` | 売建代金合計 |
| `sKaitateDaikin` | 買建代金合計 |
| `sTotalDaikin` | 総代金合計 |
| `sHyoukaSonekiGoukeiUridate` | 評価損益合計（売建） |
| `sHyoukaSonekiGoukeiKaidate` | 評価損益合計（買建） |
| `sTotalHyoukaSonekiGoukei` | 総評価損益合計 |
| `sTokuteiHyoukaSonekiGoukei` | 特定口座残高評価損益合計 |
| `sIppanHyoukaSonekiGoukei` | 一般口座残高評価損益合計 |

**建玉リスト（aShinyouTategyokuList）:**

| フィールド | 説明 |
|-----------|------|
| `sOrderTategyokuNumber` | 建玉番号 |
| `sOrderIssueCode` | 銘柄コード |
| `sOrderSizyouC` | 市場 |
| `sOrderBaibaiKubun` | 売買区分 |
| `sOrderBensaiKubun` | 弁済区分（`"26"` 制度6ヶ月 / `"29"` 制度無期限 / `"36"` 一般6ヶ月 / `"39"` 一般無期限） |
| `sOrderZyoutoekiKazeiC` | 譲渡益課税区分 |
| `sOrderTategyokuSuryou` | 建株数 |
| `sOrderTategyokuTanka` | 建単価 |
| `sOrderHyoukaTanka` | 評価単価 |
| `sOrderGaisanHyoukaSoneki` | 評価損益 |
| `sOrderGaisanHyoukaSonekiRitu` | 評価損益率(%) |
| `sTategyokuDaikin` | 建玉代金 |
| `sOrderTateTesuryou` | 建手数料 |
| `sOrderZyunHibu` | 順日歩 |
| `sOrderGyakuhibu` | 逆日歩 |
| `sOrderKakikaeryou` | 書換料 |
| `sOrderKanrihi` | 管理費 |
| `sOrderKasikaburyou` | 貸株料 |
| `sOrderSonota` | その他 |
| `sOrderTategyokuDay` | 建日 `YYYYMMDD` |
| `sOrderTategyokuKizituDay` | 建玉期日日（`"00000000"` = 無期限） |
| `sTategyokuSuryou` | 建玉数量 |
| `sOrderYakuzyouHensaiKabusu` | 約定返済株数 |
| `sOrderGenbikiGenwatasiKabusu` | 現引現渡株数 |
| `sOrderOrderSuryou` | 注文中数量 |
| `sOrderHensaiKanouSuryou` | 返済可能数量 |

### 3.3 買余力（CLMZanKaiKanougaku）

#### リクエスト

```json
{
  "sCLMID": "CLMZanKaiKanougaku",
  "sIssueCode": "",
  "sSizyouC": ""
}
```

> **注意**: 銘柄コード・市場は未使用（空文字を指定）。

#### レスポンス

| フィールド | 説明 |
|-----------|------|
| `sSummaryUpdate` | 更新日時 `YYYYMMDDHHMM` |
| `sSummaryGenkabuKaituke` | 株式現物買付可能額 |
| `sSummaryNseityouTousiKanougaku` | NISA成長投資可能額 |
| `sHusokukinHasseiFlg` | 不足金発生フラグ（`"0"` 未発生 / `"1"` 発生） |

### 3.4 建余力＆本日維持率（CLMZanShinkiKanoIjiritu）

#### リクエスト

```json
{
  "sCLMID": "CLMZanShinkiKanoIjiritu",
  "sIssueCode": "",
  "sSizyouC": ""
}
```

#### レスポンス

| フィールド | 説明 |
|-----------|------|
| `sSummaryUpdate` | 更新日時 |
| `sSummarySinyouSinkidate` | 信用新規建可能額 |
| `sItakuhosyoukin` | 委託保証金率(%) |
| `sOisyouKakuteiFlg` | 追証フラグ（`"0"` 未確定 / `"1"` 確定） |

### 3.5 売却可能数量（CLMZanUriKanousuu）

#### リクエスト

```json
{
  "sCLMID": "CLMZanUriKanousuu",
  "sIssueCode": "6501"
}
```

#### レスポンス

| フィールド | 説明 |
|-----------|------|
| `sZanKabuSuryouUriKanouIppan` | 売付可能株数（一般） |
| `sZanKabuSuryouUriKanouTokutei` | 売付可能株数（特定） |
| `sZanKabuSuryouUriKanouNisa` | 売付可能株数（NISA） |
| `sZanKabuSuryouUriKanouNseityou` | 売付可能株数（N成長） |

---

## 4. 注文照会

### 4.1 注文一覧（CLMOrderList）

#### リクエスト

| パラメータ | 説明 | 値 |
|-----------|------|-----|
| `sCLMID` | 機能ID | `CLMOrderList` |
| `sIssueCode` | 銘柄コード（任意） | `""` 全銘柄 / 指定銘柄 |
| `sSikkouDay` | 注文執行予定日（任意） | `""` 全日 / `YYYYMMDD` |
| `sOrderSyoukaiStatus` | 注文照会状態（任意） | 下表参照 |

> 任意項目はAND条件で検索。

**注文照会状態:**

| 値 | 説明 |
|----|------|
| `""` | 指定なし（全件） |
| `"1"` | 未約定 |
| `"2"` | 全部約定 |
| `"3"` | 一部約定 |
| `"4"` | 訂正取消可能な注文 |
| `"5"` | 未約定+一部約定 |

#### レスポンス（aOrderList）

| フィールド | 説明 |
|-----------|------|
| `sOrderOrderNumber` | 注文番号 |
| `sOrderIssueCode` | 銘柄コード |
| `sOrderSizyouC` | 市場 |
| `sOrderZyoutoekiKazeiC` | 譲渡益課税区分 |
| `sGenkinSinyouKubun` | 現金信用区分 |
| `sOrderBensaiKubun` | 弁済区分 |
| `sOrderBaibaiKubun` | 売買区分 |
| `sOrderOrderSuryou` | 注文株数 |
| `sOrderCurrentSuryou` | 有効株数 |
| `sOrderOrderPrice` | 注文単価 |
| `sOrderCondition` | 執行条件 |
| `sOrderOrderPriceKubun` | 注文値段区分（`"1"` 成行 / `"2"` 指値） |
| `sOrderGyakusasiOrderType` | 逆指値注文種別 |
| `sOrderGyakusasiZyouken` | 逆指値条件 |
| `sOrderGyakusasiKubun` | 逆指値値段区分 |
| `sOrderGyakusasiPrice` | 逆指値値段 |
| `sOrderTriggerType` | トリガータイプ（`"0"` 未トリガー / `"1"` 自動 / `"2"` 手動発注 / `"3"` 手動失効） |
| `sOrderYakuzyouSuryo` | 成立株数 |
| `sOrderYakuzyouPrice` | 成立単価 |
| `sOrderSikkouDay` | 執行日 |
| `sOrderStatusCode` | 状態コード（下表参照） |
| `sOrderStatus` | 状態名称 |
| `sOrderYakuzyouStatus` | 約定ステータス（`"0"` 未約定 / `"1"` 一部約定 / `"2"` 全部約定 / `"3"` 約定中） |
| `sOrderOrderDateTime` | 注文日付 `YYYYMMDDHHMMSS` |
| `sOrderOrderExpireDay` | 有効期限 `YYYYMMDD` |
| `sOrderKurikosiOrderFlg` | 繰越注文フラグ（`"0"` 当日 / `"1"` 繰越 / `"2"` 無効） |
| `sOrderCorrectCancelKahiFlg` | 訂正取消可否（`"0"` 可 / `"1"` 否 / `"2"` 取消のみ可） |
| `sGaisanDaikin` | 概算代金 |

**注文状態コード:**

| コード | 状態 | 説明 |
|--------|------|------|
| `0` | 受付未済 | |
| `1` | 未約定 | |
| `2` | 受付エラー | |
| `3` | 訂正中 | |
| `4` | 訂正完了 | |
| `5` | 訂正失敗 | |
| `6` | 取消中 | |
| `7` | 取消完了 | |
| `8` | 取消失敗 | |
| `9` | 一部約定 | |
| `10` | 全部約定 | |
| `11` | 一部失効 | |
| `12` | 全部失効 | |
| `13` | 発注待ち | |
| `14` | 無効 | |
| `15` | 切替注文 | 逆指値: 切替中 |
| `16` | 切替完了 | 逆指値: 未約定 |
| `17` | 切替注文失敗 | |
| `19` | 繰越失効 | |
| `20` | 一部障害処理 | |
| `21` | 障害処理 | |
| `50` | 発注中 | |

### 4.2 注文約定一覧・詳細（CLMOrderListDetail）

#### リクエスト

```json
{
  "sCLMID": "CLMOrderListDetail",
  "sOrderNumber": "18000002",
  "sEigyouDay": "20231018"
}
```

> 全項目必須。

#### レスポンス

注文一覧の全フィールドに加え、以下が追加:

| フィールド | 説明 |
|-----------|------|
| `sChannel` | チャネル（`"F"` = e支店API） |
| `sGenbutuZyoutoekiKazeiC` | 現物口座区分 |
| `sSinyouZyoutoekiKazeiC` | 建玉口座区分 |
| `sTriggerTime` | トリガー日時 `YYYYMMDDHHMMSS` |
| `sUkewatasiDay` | 受渡日 |
| `sYakuzyouPrice` | 約定単価 |
| `sYakuzyouSuryou` | 約定株数 |
| `sBaiBaiDaikin` | 売買代金 |
| `sBaiBaiTesuryo` | 手数料 |
| `sShouhizei` | 消費税 |
| `sSizyouErrorCode` | 取引所エラー理由コード |
| `sOrderAcceptTime` | 取引所受付時刻 |
| `sOrderExpireDayLimit` | 注文失効日付 |

**約定リスト（aYakuzyouSikkouList）:**

| フィールド | 説明 |
|-----------|------|
| `sYakuzyouSuryou` | 約定数量 |
| `sYakuzyouPrice` | 約定価格 |
| `sYakuzyouDate` | 約定日時 `YYYYMMDDHHMMSS` |

**決済注文建株リスト（aKessaiOrderTategyokuList）:**

| フィールド | 説明 |
|-----------|------|
| `sKessaiTatebiZyuni` | 順位 |
| `sKessaiTategyokuDay` | 建日 |
| `sKessaiTategyokuPrice` | 建単価 |
| `sKessaiOrderSuryo` | 返済注文株数 |
| `sKessaiYakuzyouSuryo` | 約定株数 |
| `sKessaiYakuzyouPrice` | 約定単価 |
| `sKessaiSoneki` | 決済損益/受渡代金 |

---

## 5. 可能額・余力情報

### 5.1 可能額サマリー（CLMZanKaiSummary）

#### リクエスト

```json
{ "sCLMID": "CLMZanKaiSummary" }
```

#### レスポンス（主要フィールド）

| フィールド | 説明 |
|-----------|------|
| `sUpdateDate` | 更新日時 |
| `sOisyouHasseiFlg` | 追証発生フラグ |
| `sTatekaekinHasseiFlg` | 立替金発生フラグ |
| `sGenbutuKabuKaituke` | 株式現物買付可能額 |
| `sSinyouSinkidate` | 信用新規建可能額 |
| `sSinyouGenbiki` | 信用現引可能額 |
| `sHosyouKinritu` | 委託保証金率(%) |
| `sNseityouTousiKanougaku` | NISA成長投資可能額 |
| `sTousinKaituke` | 投信買付可能額 |
| `sSyukkin` | 出金可能額 |
| `sFusokugaku` | 不足額（入金請求額） |

**売買実績:**

| フィールド | 説明 |
|-----------|------|
| `sGenbutuBaibaiDaikin` | 現物売買代金 |
| `sGenbutuOrderCount` | 現物注文件数 |
| `sGenbutuYakuzyouCount` | 現物約定件数 |
| `sSinyouBaibaiDaikin` | 信用売買代金 |
| `sSinyouOrderCount` | 信用注文件数 |
| `sSinyouYakuzyouCount` | 信用約定件数 |

**追証発生状況リスト（aOisyouHasseiZyoukyouList）:**

| フィールド | 説明 |
|-----------|------|
| `sOhzHasseiDay` | 発生日 |
| `sOhzHosyoukinRitu` | 保証金率(%) |
| `sOhzNyukinKigenDay` | 入金期限 |
| `sOhzOisyouKingaku` | 追証金額 |
| `sOhzMikaisyouKingaku` | 未解消金額 |

**非課税口座リスト（aHikazeiKouzaList）:**

| フィールド | 説明 |
|-----------|------|
| `sHikazeiTekiyouYear` | 適用年 |
| `sSeityouTousiKanougaku` | 成長投資可能額 |

### 5.2 可能額推移（CLMZanKaiKanougakuSuii）

#### リクエスト

```json
{ "sCLMID": "CLMZanKaiKanougakuSuii" }
```

#### レスポンス（aKanougakuSuiiList）

6営業日分の推移データを配列で返却（`[0]` = 当日営業日 〜 `[5]` = 6営業日目）。

| フィールド | 説明 |
|-----------|------|
| `sHituke` | 日付 |
| `sAzukariKin` | 預り金 |
| `sGenkinHosyoukin` | 現金保証金 |
| `sDaiyouHyoukagaku` | 代用証券評価額 |
| `sUkeireHosyoukin` | 受入保証金 |
| `sMikessaiTateDaikin` | 未決済建株代金 |
| `sHosyoukinYoryoku` | 保証金余力 |
| `sItakuHosyoukinRitu` | 委託保証金率(%) |
| `sGenbutuKaitukeKanougaku` | 現物株式買付可能額 |
| `sSinyouSinkidateKanougaku` | 信用新規建可能額 |
| `sSyukkinKanougaku` | 出金可能額 |

### 5.3 現物株式買付可能額詳細（CLMZanKaiGenbutuKaitukeSyousai）

#### リクエスト

| パラメータ | 説明 | 値 |
|-----------|------|-----|
| `sHitukeIndex` | 日付インデックス | `"3"` 第4営業日 / `"4"` 第5営業日 / `"5"` 第6営業日 |

### 5.4 信用新規建て可能額詳細（CLMZanKaiSinyouSinkidateSyousai）

#### リクエスト

| パラメータ | 説明 | 値 |
|-----------|------|-----|
| `sHitukeIndex` | 日付インデックス | `"0"`〜`"5"`（第1〜第6営業日） |

---

## 6. 時価情報（PRICE I/F）

### 6.1 時価情報問合取得（CLMMfdsGetMarketPrice）

**URL**: `{仮想URL(PRICE)}?{JSON}`

#### リクエスト

```json
{
  "sCLMID": "CLMMfdsGetMarketPrice",
  "sTargetIssueCode": "7203",
  "sTargetSizyouC": "00",
  "sTargetColumn": "pDPP,pDOP,pDHP,pDLP,pPRP,pDV,pDYWP,pDYRP"
}
```

| パラメータ | 説明 | 値 |
|-----------|------|-----|
| `sTargetIssueCode` | 銘柄コード | 例: `"7203"` |
| `sTargetSizyouC` | 市場 | `"00"` 東証 |
| `sTargetColumn` | 取得カラム | カンマ区切り |

#### カラムコード一覧

| コード | 数値キー | 説明 |
|--------|---------|------|
| `pDPP` | 115 | 現在値 |
| `pDOP` | 112 | 始値 |
| `pDHP` | 106 | 高値 |
| `pDLP` | 110 | 安値 |
| `pPRP` | 181 | 前日終値 |
| `pDV` | 117 | 出来高 |
| `pDJ` | 108 | 売買代金 |
| `pDYWP` | 120 | 前日比（円） |
| `pDYRP` | 119 | 前日比率(%) |
| `pQAP` | 182 | 売気配値 |
| `pQBP` | 184 | 買気配値 |
| `pQAS` | 183 | 売気配数量 |
| `pQBS` | 185 | 買気配数量 |
| `pVWAP` | 213 | VWAP |
| `tDPP:T` | 938 | 約定時刻（HH:MM） |

#### レスポンス

```json
{
  "sResultCode": "0",
  "sCLMID": "CLMMfdsGetMarketPrice",
  "aMarketPriceList": [
    {
      "sTargetIssueCode": "7203",
      "pDPP": "3325",
      "pDOP": "3360",
      "pDHP": "3380",
      "pDLP": "3300",
      "pPRP": "3350",
      "pDV": "12345600",
      "pDYWP": "-25",
      "pDYRP": "-0.75"
    }
  ]
}
```

> **注意**: レスポンスは数値キー形式で返る場合がある（例: `"115": "3325"` = `pDPP`）。ファンダメンタルズ（PER, PBR, EPS, 時価総額）は取得不可。

### 6.2 蓄積情報問合取得（CLMMfdsGetMarketPriceHistory）

過去の時価情報を取得。詳細はマスタデータ利用方法を参照。

---

## 7. マスタデータ（MASTER I/F）

### 7.1 マスタ情報ダウンロード（CLMEventDownload）

**URL**: `{仮想URL(MASTER)}?{JSON}`

- ストリーミング配信（同期応答ではない）
- `CLMEventDownloadComplete` を受信するまでが初期データ
- 取得可能: 銘柄マスタ、日付情報、呼値テーブル、運用ステータス等

### 7.2 運用ステータス（CLMUnyouStatus）

| コード | 状態 |
|--------|------|
| `000` | 注文受付 |
| `100` | 前場受付開始 |
| `120` | 前場立会開始 |
| `140` | 前場立会終了 |
| `200` | 後場受付開始 |
| `260` | 後場立会終了 |
| `300` | 株式閉局 |
| `500` | 翌日注文受付開始 |

---

## 8. EVENT I/F（リアルタイム通知）

### 8.1 接続方式

| 方式 | URL | 特徴 |
|------|-----|------|
| HTTP Long Polling | `sUrlEvent` | シンプル、ファイアウォール制約が少ない |
| WebSocket | `sUrlEventWebSocket` (`wss://`) | 低レイテンシ、双方向通信 |

### 8.2 通知内容

- 注文約定通知（EC: Execution Confirmation）
- マスタ情報のリアルタイム更新
- 時価配信

---

## 9. 実装上の注意事項

### 全般

1. **数値キーのマッピング**: レスポンスキーが数値の場合がある。名前付きキーとの双方向マッピングが必要
2. **URLエンコード**: JSONをURLエンコードして送信
3. **Shift_JIS**: レスポンスの文字列値のデコードが必要
4. **全値が文字列**: 数値も `"100"` のように文字列で送受信

### 認証・セッション

5. **仮想URL**: ログイン成功時にセッション固有の仮想URLが発行される。以降のAPIは全てこの仮想URLを使用
6. **金商法書面未読**: `sKinsyouhouMidokuFlg` が `"1"` の場合、仮想URLは発行されずAPI利用不可

### 注文

7. **第二パスワード**: 全ての注文操作で必須
8. **注文番号+営業日**: 注文の一意特定にはペアが必要
9. **逆指値**: SL注文に利用可能（`sGyakusasiOrderType="1"`）
10. **通常+逆指値**: OCO的な注文（`sGyakusasiOrderType="2"`）
11. **増株訂正不可**: 訂正注文は減株のみ
12. **逆指値条件発火後**: 逆指値条件・値段の訂正は不可。通常の値段訂正を使用

### JSONの項目順

13. **項目順不問**: リクエスト・レスポンスともにJSON項目の順番は保証されない（JSON仕様準拠）
