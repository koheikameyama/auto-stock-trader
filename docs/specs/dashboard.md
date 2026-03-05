# ダッシュボード仕様書

## 概要

ダッシュボードはユーザーがログイン後に最初に表示されるメインページです。ポートフォリオの状況、市場データ、AIおすすめ銘柄、セクタートレンドを一覧で確認できます。

**ページパス**: `/dashboard`

## 画面構成

### 1. Daily Market Navigator（最上部）

ページタイトルの直下に表示される統合カード型コンポーネント。朝と夜の2セッションで異なる視点の分析を提供する。

**前提条件**: ポートフォリオ + ウォッチリスト合計3銘柄以上（未満の場合は案内メッセージを表示）

**セッション切り替え**: カード上部にタブ（朝の戦略 / 結果診断）を表示。JST 15時以降は夜セッションがデフォルト。

| 項目 | 説明 |
|------|------|
| セッションタブ | 🧭 朝の戦略 / 🌙 結果診断 の切り替え |
| 市場トーンバッジ | bullish / bearish / neutral / sector_rotation（色分けあり） |
| マーケットヘッドライン | 朝: 今日の市況展望 / 夜: 今日の市場結果総括 |
| 市場主要因 | 市場を動かしている主要因（1〜2文） |
| ポートフォリオ状態バッジ | healthy / caution / warning / critical（色分けあり） |
| ポートフォリオ総評 | 朝: 持ち株への影響予測 / 夜: 持ち株の健康診断 |
| アクションプラン | 朝: 今日の行動指針 / 夜: 明日の予習ポイント |
| バディメッセージ | 朝: 前向きな激励 / 夜: 労いと明日への期待 |
| 詳細（折りたたみ） | 銘柄ハイライト・セクターハイライト |

**API**: `GET /api/portfolio/overall-analysis?session=morning|evening`

詳細仕様は [portfolio-analysis.md](portfolio-analysis.md) を参照。

#### マーケットシールドバナー

マーケットシールドがアクティブな場合、Daily Market Navigator 内に赤色の警告バナーを表示する。

| 項目 | 説明 |
|------|------|
| 表示条件 | マーケットシールドがアクティブ（`deactivatedAt == null`） |
| トリガー種別 | 日経225急落 / VIX急騰 / WTI原油急変動 / 為替急変動 |
| トリガー値 | VIX絶対値またはパーセント変動率を表示 |
| UI | 赤色ボーダーの警告カード（`MarketShieldBanner` コンポーネント） |

**API**: `GET /api/market-shield`

#### 乗り換え提案カード（Switch Proposal）

Daily Market Navigator の詳細セクション内に、スマートスイッチによる乗り換え提案を表示する。

| 項目 | 説明 |
|------|------|
| 表示条件 | 当日の乗り換え提案が存在し、ユーザーが未対応のもの |
| 売却候補 | 含み損銘柄の名前 + 回復スコア（銘柄詳細へリンク） |
| 購入候補 | buy判定銘柄の名前 + チャンススコア（銘柄詳細へリンク） |
| 乗り換えメリット | switchBenefit の値を表示 |
| 理由テキスト | テンプレート生成の乗り換え理由 |
| アクション | 「今は見送る」（rejected）/ 「詳細を見る」（銘柄詳細へ遷移） |
| UI | 琥珀色ボーダーのカード（`SwitchProposalCard` コンポーネント） |

#### イブニングレビュー（eveningセッション追加機能）

夜セッション（結果診断）に追加される振り返り機能。今日の売買判断・機会損失・行動パターンを分析し、投資スキルの向上を支援する。

**表示条件**: eveningセッション選択時に、Daily Market Navigatorの詳細（折りたたみ）内に表示

##### a. 売買判断の振り返り

今日実行した売買判断をAIが評価し、判断の質をフィードバックする。

| 項目 | 説明 |
|------|------|
| 対象銘柄 | 今日売買を実行した銘柄 |
| 判断評価 | excellent（素晴らしい）/ good（良い）/ neutral（普通）/ questionable（要検討） |
| 評価理由 | なぜその評価になったかの解説 |
| 改善ポイント | 次回同様の場面での判断改善アドバイス |

##### b. 機会損失の指摘

ウォッチリストやAIおすすめ銘柄のうち、ユーザーが購入しなかったが大きく上昇した銘柄を指摘する。

| 項目 | 説明 |
|------|------|
| ウォッチリスト急騰銘柄 | ウォッチリスト内で当日+3%以上上昇した銘柄 |
| AI推奨見送り銘柄 | AIが買い推奨したがユーザーが購入しなかった銘柄 |
| 見送り理由の推測 | なぜ購入に至らなかった可能性があるかの分析 |
| 学びのポイント | 機会損失から得られる教訓 |

##### c. 行動パターンの改善提案

過去の売買履歴を分析し、繰り返し発生している行動パターンの傾向と改善策を提示する。

| 項目 | 説明 |
|------|------|
| 検出パターン | 利確が早すぎる / 損切りが遅い / 高値掴み傾向 など |
| 具体例 | 該当する過去の売買事例 |
| 改善提案 | パターンを改善するための具体的なアドバイス |
| 参考指標 | 改善に役立つテクニカル指標や基準値の紹介 |

##### データモデル

`PortfolioOverallAnalysis` モデルに `eveningReview Json?` カラムとして保存。

```json
{
  "tradeReview": [
    {
      "tickerCode": "8306.T",
      "name": "三菱UFJ",
      "action": "buy",
      "rating": "good",
      "reason": "移動平均線のゴールデンクロス直後の購入タイミングは適切...",
      "improvement": "出来高の確認も加えるとさらに精度が上がります"
    }
  ],
  "missedOpportunities": [
    {
      "tickerCode": "6758.T",
      "name": "ソニーグループ",
      "source": "watchlist",
      "changeRate": 4.2,
      "reason": "決算好調を受けて急騰。ウォッチリストに入れていたが購入に至らず",
      "lesson": "決算前にウォッチリスト銘柄の業績予想を確認する習慣をつけましょう"
    }
  ],
  "behavioralPatterns": [
    {
      "pattern": "early_profit_taking",
      "description": "利確が早すぎる傾向があります",
      "examples": ["過去1ヶ月で3回、+5%で利確後にさらに+10%上昇"],
      "suggestion": "トレーリングストップ（逆指値を切り上げる手法）の活用を検討してください",
      "referenceMetric": "ATR（平均真の値幅）を基準にした利確ラインの設定"
    }
  ]
}

### 2. 寄り付きギャップ予測（morningセッションのみ表示）

海外市場の夜間データから、日本市場の寄り付きギャップ（窓開け）を予測するカード。

**表示条件**: JST 07:00〜15:00 のみ表示

| 項目 | 説明 |
|------|------|
| 海外市場の動き | CME日経先物、USD/JPY、S&P 500、NASDAQの終値と変化率 |
| 日本市場の予測 | ギャップアップ/ダウン/横ばいの方向と予測変動率 |
| severity バッジ | 大きな変動 / やや変動 / 小幅 |
| 要注意銘柄 | ポートフォリオ銘柄のうち、severity が medium 以上の銘柄リスト |

**API**: `GET /api/gap-prediction`

**データソース**: `PreMarketData` テーブル（毎朝07:00 JST に `pre-market-data.yml` で取得）

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

### 8. 地政学・マクロリスク（セクタートレンドの直上）

直近3日の地政学・マクロ経済ニュースをコンパクトカードで表示。地政学リスクモード発動時は防御措置の情報も表示。

| 項目 | 説明 |
|------|------|
| リスクレベルバッジ | 安定（緑）/ 注意（黄）/ 警戒（赤） |
| リスクモード情報 | caution/alert時に表示。リスクスコア、アクションアドバイス、要因一覧 |
| ニュース一覧 | 最大3件。タイトル + 影響セクター + 影響方向 |
| 詳細リンク | ニュースページ（市場影響フィルター）へ遷移 |

**リスクレベル判定（サーバーサイド算出）**:

VIX・WTI・地政学ニュースからリスクスコアを算出:
- VIXレベル: VIX>=30→40点, VIX>=25→20点, VIX>=20→10点
- VIX急変動: 前日比>=20%→20点
- WTI急変動: |前日比|>=5%→15点
- 地政学ネガティブニュース: 1件5点（最大3件=15点）

| スコア | レベル | 防御措置 |
|--------|--------|----------|
| <25 | stable（安定）| なし |
| 25-49 | caution（注意）| 損切りライン15%引き締め、confidence -0.05 |
| >=50 | alert（警戒）| 損切りライン35%引き締め、buy→stay強制、キャッシュ増加推奨 |

**API**: `GET /api/news/geopolitical`
- レスポンス: `{ news, riskLevel, riskScore, riskFactors }`

### 9. セクタートレンドヒートマップ

- 全セクターのトレンドスコアを色分けグリッド表示
- 時間窓切替: 3日 / 7日
- 表示項目: トレンドスコア、ニュース件数、平均週間変化率

**API**: `GET /api/sector-trends`

### 10. あなたへのおすすめ（パーソナライズ推奨）

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

### 11. 注目の高評価銘柄（投資スタイル別）

- 分析済み全銘柄（PurchaseRecommendation）の中から、ユーザーの投資スタイルで「買い推奨」の銘柄を横スクロールカードで表示
- confidence（確信度）の高い順に最大10件表示
- 投資スタイル未設定の場合は非表示
- 各カード表示項目:
  - 銘柄名、証券コード、セクター
  - 現在価格（リアルタイム取得）
  - 買い推奨バッジ + 確信度（%）
  - 市場シグナルバッジ（bullish / neutral / bearish）
  - 投資スタイル別の推奨理由
  - リスク表示（赤字企業、高ボラティリティ、直近下落）
  - 保有状態バッジ（ポートフォリオ / ウォッチリスト / 追跡中）
- 古いデータの場合は警告表示

**前提条件**: 投資スタイルが設定済み、かつ PurchaseRecommendation に styleAnalyses データがあること

**API**: `GET /api/top-stocks`

**レスポンス**:
```json
{
  "stocks": [
    {
      "id": "xxx",
      "stockId": "xxx",
      "confidence": 0.85,
      "reason": "安定した収益基盤と成長性...",
      "caution": "決算前の注意...",
      "advice": "現在の水準は...",
      "marketSignal": "bullish",
      "isOwned": false,
      "isRegistered": true,
      "isTracked": false,
      "userStockId": "xxx",
      "stock": {
        "id": "xxx",
        "tickerCode": "8306.T",
        "name": "三菱UFJ",
        "sector": "銀行業",
        "currentPrice": null,
        "isProfitable": true,
        "volatility": 25.3,
        "weekChangeRate": 2.5
      }
    }
  ],
  "investmentStyle": "BALANCED",
  "date": "2026-02-27"
}
```

### 12. 市場ランキング（上昇/下落）

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
├─ GeopoliticalRiskCard → GET /api/news/geopolitical
├─ SectorTrendHeatmap → GET /api/sector-trends
├─ FeaturedStocksByCategory → GET /api/featured-stocks
├─ TopStocksByStyle  → GET /api/top-stocks
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
| GeopoliticalRiskCard | `GeopoliticalRiskCard.tsx` | 地政学・マクロリスクカード |
| SectorTrendHeatmap | `SectorTrendHeatmap.tsx` | セクタートレンドヒートマップ |
| FeaturedStocksByCategory | `FeaturedStocksByCategory.tsx` | おすすめ銘柄カード群 |
| TopStocksByStyle | `TopStocksByStyle.tsx` | 投資スタイル別高評価銘柄 |
| MarketShieldBanner | `MarketShieldBanner.tsx` | マーケットシールド警告バナー |
| SwitchProposalCard | `SwitchProposalCard.tsx` | 乗り換え提案カード |

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
- `app/dashboard/GeopoliticalRiskCard.tsx` - 地政学リスクカード
- `app/api/news/geopolitical/route.ts` - 地政学ニュース API
- `app/api/sector-trends/route.ts` - セクタートレンド API
- `app/api/featured-stocks/route.ts` - おすすめ銘柄 API
- `app/dashboard/TopStocksByStyle.tsx` - 投資スタイル別高評価銘柄コンポーネント
- `app/api/top-stocks/route.ts` - 高評価銘柄 API
- `app/api/market-analysis/gainers-losers/route.ts` - 市場ランキング API
- `app/dashboard/MarketShieldBanner.tsx` - マーケットシールドバナー
- `app/dashboard/SwitchProposalCard.tsx` - 乗り換え提案カード
- `app/api/market-shield/route.ts` - マーケットシールド状態 API
- `app/api/switch-proposals/[id]/action/route.ts` - 乗り換え提案アクション API
