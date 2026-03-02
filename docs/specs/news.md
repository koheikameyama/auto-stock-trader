# ニュース 仕様書

## 概要

日本株・米国株のマーケットニュースを一覧表示します。セクタートレンド分析のデータソースにもなります。

**ページパス**: `/news`

## 画面構成

### フィルター

- ALL: 全ニュース
- JP（🇯🇵）: 日本市場のみ
- US（🇺🇸）: 米国市場のみ

### ニュースカード

- ニュースタイトル
- 本文プレビュー（2行クリップ）
- センチメントバッジ（positive / negative / neutral）
- 関連銘柄バッジ（最大3銘柄）
- 市場フラグ（JP/US）
- 経過時間（「X分前」「N日前」）

## API仕様

### `GET /api/news`

**クエリパラメータ**:

| パラメータ | 型 | デフォルト | 説明 |
|-----------|-----|----------|------|
| limit | number | 20 | 取得件数 |
| market | string | - | JP / US |
| daysAgo | number | 7 | 何日前まで取得 |
| withRelated | boolean | false | 関連銘柄を含めるか |

**レスポンス**:
```json
{
  "news": [
    {
      "id": "xxx",
      "title": "ニュースタイトル",
      "content": "本文...",
      "url": "https://...",
      "source": "tavily",
      "sector": "情報・通信",
      "sentiment": "positive",
      "publishedAt": "2026-02-22T10:00:00Z",
      "market": "JP",
      "region": "日本",
      "relatedStocks": [
        { "tickerCode": "7203.T", "name": "トヨタ自動車" }
      ]
    }
  ]
}
```

### `GET /api/news/dashboard`

ダッシュボード用の最新ニュース5件。

## セクタートレンド

ニュースのセンチメントと株価データを統合してセクターごとのトレンドスコアを算出します。

### SectorTrend データ

| 指標 | 説明 |
|------|------|
| score3d / score7d | 3日/7日のニューススコア |
| newsCount3d / newsCount7d | ニュース件数 |
| positive3d / negative3d / neutral3d | センチメント内訳 |
| avgWeekChangeRate | セクター平均週間変化率(%) |
| avgDailyChangeRate | セクター平均日次変化率(%) |
| avgMaDeviationRate | セクター平均MA乖離率(%) |
| avgVolumeRatio | セクター平均出来高比率 |
| avgVolatility | セクター平均ボラティリティ(%) |
| compositeScore | 総合スコア（-100〜+100） |
| trendDirection | up / down / neutral |

### API: `GET /api/sector-trends`

全セクターのトレンドデータを取得。

## データモデル

### MarketNews

| カラム | 型 | 説明 |
|--------|-----|------|
| title | String | タイトル |
| content | Text | 本文（yfinance取得分は空文字） |
| url | String? | 記事URL |
| source | String | ソース（RSS名 / yfinance / publisher名） |
| sector | String? | 関連セクター |
| sentiment | String? | positive / negative / neutral |
| publishedAt | DateTime | 公開日時 |
| market | String | JP / US |
| region | String? | 表示用地域名 |
| tickerCode | String? | 銘柄コード（yfinanceで取得した場合に設定、例: "7203"） |

**ユニーク制約**: `(url, tickerCode)`（同一URLでも銘柄ごとに別行保存可）

#### ソース別の特徴

| source | tickerCode | 用途 |
|--------|-----------|------|
| RSS各種（nikkei等） | null | 市場全体ニュース・セクタートレンド |
| yfinance / publisher名 | 銘柄コード | 銘柄個別ニュース・AI分析入力 |

### SectorTrend

| カラム | 型 | 説明 |
|--------|-----|------|
| date | Date | 日付 |
| sector | String | セクター名 |
| score3d / score7d | Float | ニューススコア |
| newsCount3d / newsCount7d | Int | ニュース件数 |
| usNewsCount3d / usNewsCount7d | Int | 米国ニュース件数 |
| avg* | Float? | 株価指標の平均値群 |
| compositeScore | Float? | 総合スコア |
| trendDirection | String | トレンド方向 |

**ユニーク制約**: `(date, sector)`

## ニュース取得スケジュール

| 時刻（JST） | 対象 | スクリプト |
|-------------|------|----------|
| 08:00（pre-morning） | JP + USニュース（RSS） | `scripts/news/fetch-news.ts`, `fetch-us-news.ts` |
| 08:00（pre-morning） | 全銘柄個別ニュース（yfinance） | `scripts/github-actions/fetch_stock_news.py` |
| 11:40（pre-afternoon） | JPニュース（RSS） | `scripts/news/fetch-news.ts` |

## データ保持期間

| 種別 | 保持期間 |
|------|---------|
| RSS取得ニュース（tickerCode=null） | 30日 |
| yfinance取得ニュース（tickerCode!=null） | 14日 |

## 銘柄別ニュース（getRelatedNews の動作）

`lib/news-rag.ts` の `getRelatedNews` は以下の優先度でニュースを取得：

1. **tickerCode 直接マッチ**（yfinance取得分）→ 精度最高
2. **コンテンツ内銘柄コード検索**（content LIKE '%7203%'）→ フォールバック
3. **セクターマッチ**（sector IN (...)）→ 最終フォールバック

## 関連ファイル

- `app/news/page.tsx` - ページエントリ
- `app/news/NewsPageClient.tsx` - ニュース一覧コンポーネント
- `app/api/news/route.ts` - ニュース取得 API
- `app/api/news/dashboard/route.ts` - ダッシュボード用 API
- `app/api/sector-trends/route.ts` - セクタートレンド API
- `lib/news.ts` - ニュース処理
- `lib/news-rag.ts` - ニュースRAG（getRelatedNews）
- `scripts/news/fetch-news.ts` - JPニュース取得スクリプト（RSS）
- `scripts/news/fetch-us-news.ts` - USニュース取得スクリプト（RSS）
- `scripts/github-actions/fetch_stock_news.py` - 銘柄別ニュース取得（yfinance）
