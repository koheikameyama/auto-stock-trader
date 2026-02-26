# ダッシュボード仕様書

## 概要

ダッシュボードはユーザーがログイン後に最初に表示されるメインページです。ポートフォリオの状況、市場データ、AIおすすめ銘柄、セクタートレンドを一覧で確認できます。

**ページパス**: `/dashboard`

## 画面構成

### 1. Daily Market Navigator（最上部）

ページタイトルの直下に表示される統合カード型コンポーネント。市場の流れとユーザーのポートフォリオを照合し、今日何をすべきかを断定する。

**前提条件**: ポートフォリオ + ウォッチリスト合計3銘柄以上（未満の場合は案内メッセージを表示）

| 項目 | 説明 |
|------|------|
| 市場トーンバッジ | bullish / bearish / neutral / sector_rotation（色分けあり） |
| マーケットヘッドライン | 今日の市況を1文で要約 |
| 市場主要因 | 市場を動かしている主要因（1〜2文） |
| ポートフォリオ状態バッジ | healthy / caution / warning / critical（色分けあり） |
| ポートフォリオ総評 | 保有銘柄の状態（1〜2文） |
| アクションプラン | 投資スタイルに応じた具体的な行動指針 |
| バディメッセージ | 初心者を勇気づける親しみやすいメッセージ |
| 詳細（折りたたみ） | 銘柄ハイライト・セクターハイライト |

**API**: `GET /api/portfolio/overall-analysis`

詳細仕様は [portfolio-analysis.md](portfolio-analysis.md) を参照。

### 3. 日経225指数

| 項目 | 説明 |
|------|------|
| 現在値 | 日経225のリアルタイム価格 |
| 変動額 | 前日比の変動額（円） |
| 変動率 | 前日比の変動率（%） |

**API**: `GET /api/market/nikkei`

#### 日経平均チャート（折りたたみ式）

カードをタップするとチャートが展開される。

| 項目 | 説明 |
|------|------|
| 期間切替 | 1ヶ月 / 3ヶ月 / 1年 |
| 日経平均ライン | オレンジ色の折れ線（期間初日を0%として騰落率表示） |
| ポートフォリオライン | 青色の折れ線（同じく騰落率表示、保有株がある場合のみ） |
| アウトパフォーマンス | チャート下部に市場に対する差分を表示 |

**API**:
- `GET /api/market/nikkei/historical?period={1m|3m|1y}`
- `GET /api/portfolio/history?period={1m|3m|1y}`

### 4. ポートフォリオサマリー（保有銘柄がある場合のみ表示）

| 項目 | 説明 |
|------|------|
| 総資産額 | 保有銘柄の時価総額合計 |
| 含み損益 | 総資産額 - 総投資額 |
| 損益率 | 含み損益 / 総投資額 × 100 |
| 市場比較 | 日経225との比較パフォーマンス |

- 保有銘柄リスト（展開可能）: 銘柄名、数量、現在価格、個別損益

**API**: `GET /api/portfolio/summary`

### 5. 予算サマリー

| 項目 | 説明 |
|------|------|
| 投資予算 | ユーザー設定の投資予算総額 |
| 投資済み | 現在の保有銘柄の取得原価合計 |
| 残り予算 | 投資予算 - 投資済み |

**API**: `GET /api/budget/summary`

### 6. 資産推移チャート（保有銘柄がある場合のみ表示）

- 期間選択: 1ヶ月 / 3ヶ月 / 6ヶ月 / 1年
- 表示モード切替: 資産推移 / 損益推移
- 折れ線グラフ（Recharts）

**API**: `GET /api/portfolio/history?period={1m|3m|6m|1y}`

**レスポンス**:
```json
[
  {
    "date": "2026-02-01",
    "totalValue": 1500000,
    "totalCost": 1200000,
    "unrealizedGain": 300000,
    "unrealizedGainPercent": 25.0,
    "stockCount": 5
  }
]
```

### 7. ポートフォリオ構成チャート（保有銘柄がある場合のみ表示）

- 銘柄別構成（円グラフ）
- セクター別構成（円グラフ）

**API**: `GET /api/portfolio/composition`

### 8. セクタートレンドヒートマップ

- 全セクターのトレンドスコアを色分けグリッド表示
- 時間窓切替: 3日 / 7日
- 表示項目: トレンドスコア、ニュース件数、平均週間変化率

**API**: `GET /api/sector-trends`

### 9. あなたへのおすすめ（パーソナライズ推奨）

- ユーザーごとにAIが選定した5銘柄を横スクロールカードで表示
- 各カード表示項目:
  - 銘柄名、証券コード
  - 現在価格
  - 投資テーマ（短期成長 / 中長期安定成長 / 高配当 / 割安反発 / テクニカル好転 / 安定ディフェンシブ）
  - AIが生成した推奨理由
  - リスク表示（赤字企業、高ボラティリティ、直近下落）
  - 保有状態バッジ（ポートフォリオ / ウォッチリスト / 追跡中）
- 古いデータの場合は警告表示

**API**: `GET /api/featured-stocks`

**レスポンス**:
```json
{
  "recommendations": [
    {
      "id": "xxx",
      "stockId": "xxx",
      "position": 1,
      "reason": "安定した業績と高い配当利回りが魅力...",
      "investmentTheme": "高配当",
      "stock": {
        "tickerCode": "8306.T",
        "name": "三菱UFJ",
        "sector": "銀行業",
        "latestPrice": 1850,
        "isProfitable": true,
        "volatility": 25.3,
        "weekChangeRate": 2.5
      }
    }
  ],
  "date": "2026-02-22",
  "isToday": true
}
```

### 10. 市場ランキング（上昇/下落）

- 上昇TOP5、下落TOP5を表示
- 各銘柄の変化率とAI原因分析

**API**: `GET /api/market-analysis/gainers-losers`

## データフロー

```
ユーザーがダッシュボードにアクセス
    ↓
page.tsx（Server Component）
├─ 認証確認
├─ 利用規約同意確認
├─ ユーザー設定・保有銘柄取得
└─ コンポーネント描画
    ↓
各Client Component（並列レンダリング）
├─ DailyMarketNavigator → GET /api/portfolio/overall-analysis
├─ NikkeiSummary     → GET /api/market/nikkei + /api/market/nikkei/historical + /api/portfolio/history
├─ PortfolioSummary  → GET /api/portfolio/summary + 株価取得
├─ BudgetSummary     → GET /api/budget/summary
├─ PortfolioHistoryChart → GET /api/portfolio/history
├─ PortfolioCompositionChart → GET /api/portfolio/composition
├─ SectorTrendHeatmap → GET /api/sector-trends
├─ FeaturedStocksByCategory → GET /api/featured-stocks
└─ MarketMovers      → GET /api/market-analysis/gainers-losers
```

## コンポーネント一覧

| コンポーネント | ファイル | 役割 |
|---------------|----------|------|
| DashboardClient | `DashboardClient.tsx` | クライアントラッパー、PWAインストール促進 |
| DailyMarketNavigator | `DailyMarketNavigator.tsx` | 市場ナビゲーター（最上部統合カード） |
| NikkeiSummary | `NikkeiSummary.tsx` | 日経225指数表示 |
| PortfolioSummary | `PortfolioSummary.tsx` | ポートフォリオKPI表示 |
| BudgetSummary | `BudgetSummary.tsx` | 予算配分表示 |
| PortfolioHistoryChart | `PortfolioHistoryChart.tsx` | 資産推移/損益推移チャート |
| PortfolioCompositionChart | `PortfolioCompositionChart.tsx` | 構成比率円グラフ |
| SectorTrendHeatmap | `SectorTrendHeatmap.tsx` | セクタートレンドヒートマップ |
| FeaturedStocksByCategory | `FeaturedStocksByCategory.tsx` | おすすめ銘柄カード群 |

## 関連ファイル

- `app/dashboard/page.tsx` - ページエントリ（Server Component）
- `app/dashboard/DashboardClient.tsx` - クライアントラッパー
- `app/dashboard/DailyMarketNavigator.tsx` - Daily Market Navigator コンポーネント
- `app/api/portfolio/overall-analysis/route.ts` - Daily Market Navigator API
- `app/api/market/nikkei/route.ts` - 日経225 API
- `app/api/portfolio/summary/route.ts` - ポートフォリオサマリー API
- `app/api/portfolio/history/route.ts` - 資産推移 API
- `app/api/portfolio/composition/route.ts` - 構成比率 API
- `app/api/budget/summary/route.ts` - 予算サマリー API
- `app/api/sector-trends/route.ts` - セクタートレンド API
- `app/api/featured-stocks/route.ts` - おすすめ銘柄 API
- `app/api/market-analysis/gainers-losers/route.ts` - 市場ランキング API
