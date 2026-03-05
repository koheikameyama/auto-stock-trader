# ポートフォリオ分析 仕様書

## 概要

ポートフォリオ分析はユーザーの保有銘柄全体を評価する機能です。個別銘柄のAI分析と、ポートフォリオ全体の総評を提供します。

**ページパス**: `/portfolio-analysis`

## 分析の種類

### 1. 個別銘柄分析（PortfolioStock単位）

保有銘柄ごとにAIが売買判断を生成します。

**分析に使用するデータ**:
- 株価データ（3ヶ月分のOHLCV）
- テクニカル指標（RSI, MACD, 移動平均乖離率）
- チャートパターン（逆三尊、ダブルボトム等）
- ローソク足パターン分析
- 出来高分析
- 窓埋め判定
- 支持線・抵抗線
- トレンドライン
- 財務指標（PER, PBR, ROE, 配当利回りなど20以上）
- 関連ニュース（7日分）
- セクタートレンド
- 日経225の動向
- 地政学リスク指標（VIX・WTI）
- 決算・配当落ちスケジュール
- 相対強度（市場/セクター比較）
- ユーザー設定（投資スタイル、売却目標/撤退ライン）
- 直近の購入判断（購入から7日以内の場合のみ）
- 買いシグナル判定コンテキスト（チャート・ファンダメンタルのルールベース判定結果）

**AI出力スキーマ**:

```json
{
  "marketSignal": "bullish | neutral | bearish",
  "shortTerm": "短期分析テキスト（全体共通）",
  "mediumTerm": "中期分析テキスト",
  "longTerm": "長期分析テキスト",
  "shortTermTrend": "up | neutral | down",
  "shortTermPriceLow": 2300,
  "shortTermPriceHigh": 2600,
  "midTermTrend": "up | neutral | down",
  "midTermPriceLow": 2200,
  "midTermPriceHigh": 2800,
  "longTermTrend": "up | neutral | down",
  "longTermPriceLow": 2100,
  "longTermPriceHigh": 3000,
  "isCriticalChange": false,
  "reconciliationMessage": null,
  "styleAnalyses": {
    "CONSERVATIVE": {
      "recommendation": "buy | hold | sell",
      "confidence": 0.85,
      "advice": "アドバイステキスト",
      "shortTerm": "短期分析テキスト（スタイル別）",
      "holdCondition": "hold時の待機目標",
      "sellReason": "売却理由",
      "sellCondition": "売却条件",
      "suggestedSellPercent": 75,
      "suggestedExitRate": 0.05,
      "suggestedSellTargetRate": 0.15
    },
    "BALANCED": { "..." : "同上" },
    "AGGRESSIVE": { "..." : "同上" }
  }
}
```

**安全補正ルール（AIの判断をルールベースで上書き）**:

AI生成後、全3スタイルの結果に対して以下の安全補正を順に適用する。

| # | ルール | 条件 | 動作 |
|---|--------|------|------|
| 1 | パニック売り防止 | MA乖離率 ≤ -20% | sell → hold に変更 |
| 2 | データ取得不可強制 | isDelisted = true | 強制 sell |
| 3 | 危険銘柄ブロック | 赤字 + ボラティリティ > 50% | buy → hold に変更 |
| 4 | 短期下降トレンドブロック | AI短期予測トレンドが「down」 | buy → hold に変更 |
| 5 | 中長期上昇時のsell抑制 | スタイル別: 安定配当型は長期upのみ保護（※含み益+5%以上 + 短期下落予兆時は保護無効化）、バランスは中期or長期up、アクティブ型は保護なし（損失 > -15%の場合のみ） | sell → hold に変更 |
| 6 | 相対強度保護 | 市場比+5%以上のアウトパフォーム | 地合い要因として sell → hold に変更 |
| 7 | 配当権利落ち後の保護 | 権利落ち日から3日以内 + 含み損が軽微（-5%超） | sell → hold に変更 |
| 8 | 利益確定促進 | 含み益あり + 短期下落予兆（shortTermTrend=down）。安定配当型: +5%以上、成長投資型: +8%以上、アクティブ型: +15%以上 | hold → sell（利確）に変更。売却数量は100株（単元株）単位で算出 |
| 9 | 全面下降トレンド損切り促進 | 短期・中期・長期すべてdown + 含み損 | hold → sell（損切り）に変更 |

※ 直近購入保護（購入から7日以内）はAIプロンプトで誠実な対応を指示する形で実現。ポストプロセスのハードルールではなく、AIに「isCriticalChange時のみ売りを許可」する旨をプロンプトに含める。

**利益確定促進の詳細**:
- 推奨売却割合: 安定配当型75%、成長投資型50%、アクティブ型25%
- 保有数が1単元（100株）未満の場合はスキップ
- 理想の割合で1単元以上売れない場合は、1単元売れる最小の割合に引き上げ

**投資スタイル別分析（styleAnalyses）**:

AIが1回のAPIコールで3つの投資スタイル（安定配当型/成長投資型/アクティブ型）ごとに異なる判断（recommendation/confidence/advice/shortTerm/sellReason/sellCondition/holdCondition/suggestedSellPercent/suggestedExitRate/suggestedSellTargetRate）を直接生成します。各スタイルの判断傾向:

| スタイル | 判断傾向 | アドバイスのトーン |
|----------|----------|-------------------|
| 安定配当型（CONSERVATIVE） | 早めの売却目標・狭い撤退ライン、suggestedSellPercent は高め（75-100%）。ただしリスク・リワード比1:3以上ならhold継続・反発シナリオを提示。adviceで最大損失率を明示 | 「リスクは限定的です。撤退ラインを厳守しつつ慎重に判断しましょう。」 |
| 成長投資型（BALANCED） | 中期トレンドで判断、部分売却でバランスを取る。トレンド転換（ゴールデンクロス、RSI回復）を重視 | 「中期的な回復の兆しがあります。標準的なポジションで利益を狙えます。」 |
| アクティブ型（AGGRESSIVE） | 利益最大化、suggestedSellPercent は低め（25-50%）、買い増しも積極的。モメンタム（出来高急増+高値突破）を重視 | 「勢いに乗りましょう。上値追いのチャンスです。」 |

**安定配当型のリスク限定型判断**:
- adviceで「最悪のケースの最大損失率・概算損失額」を明示した上で保有継続・売却の判断理由を説明
- リスク・リワード比1:3以上かつ支持線が維持されている → 含み損でもhold継続を許容し反発シナリオを提示
- 赤字銘柄でもセクター全体に買いが入っていれば「地合いを味方につけた短期戦」としてhold継続を提案可能（cautionで業績リスクに必ず言及）

AI生成後、非スタイル依存の安全補正（上記テーブルの大半）を全スタイルに適用し、さらにスタイル依存のセーフティルールを適用:

| スタイル依存補正 | 条件（スタイルにより閾値が異なる） | 動作 |
|------------------|--------------------------------------|------|
| 急騰銘柄の買い増し抑制 | `isSurgeStock(weekChangeRate, style)` 安定配当+20%/成長+25%/アクティブ+50% | buy → hold に変更 |
| 市場パニック | 市場パニック時のbuy推奨 | confidence低下 |

**マーケットシールド: 撤退ライン引き上げ**:

マーケットシールドがアクティブな場合、保有銘柄の撤退ライン（ストップロス）を引き締める。ATR乗数を通常の2.0〜3.0から1.0に短縮し、より早い損切りで資産を防御する。

- 対象: 全スタイルの `suggestedStopLossPrice`
- 動作: ATR14 × 1.0（`MARKET_SHIELD.SHIELD_ATR_MULTIPLIER`）で撤退ラインを再算出し、既存値より引き上がる場合に上書き

**トレンド収束予測（Trend Convergence）**:

AIが短期/中期/長期トレンドの乖離状態を分析し、収束予測を `trendConvergence` として出力する。結果は `StockAnalysis.trendConvergence` に JSON として保存。

```json
{
  "trendConvergence": {
    "divergenceType": "short_down_long_up | short_up_long_down | aligned",
    "estimatedConvergenceDays": 14,
    "confidence": "high | medium | low",
    "waitSuggestion": "短期の押し目が一巡するまで待つのが安全です",
    "keyLevelToWatch": 2350,
    "triggerCondition": "RSIが40を回復し25日線を上抜けたら転換サイン"
  }
}
```

**トレンド乖離（ねじれ）検出**:

短期トレンドと長期トレンドの方向が異なる場合（例: 短期上昇＋長期下落）、乖離の種類を検出してスタイル別の解説を付与。各スタイルの結果に `divergenceType`、`divergenceLabel`、`divergenceExplanation` が追加される。

**holdCondition（待機目標）**:
- recommendation="hold" の場合、AIが `holdCondition` に具体的な待機目標を記載（例: 「○○円付近まで下がったら買い増し検討」「RSIが30以下になったら買い増し検討」）
- 安全補正ルールで hold に変更された場合も、補正理由に基づいた holdCondition が自動設定される
- buy/sell の場合は null

**売却目標・撤退ラインの算出**:
- 短期予測価格（shortTermPriceHigh/Low）から売却目標率・撤退ライン率を逆算し、AIの率よりも優先して使用
- ATRベースの最低保証（スタイル別: 安定配当型1.5x/成長投資型2.5x/アクティブ型4.0x）を適用し、予測値が近すぎる場合でも最低幅を保証
- トレーリングストップ: 含み益がある場合、撤退ラインの下限は平均取得単価
- 予測価格が現在価格と矛盾する場合（High ≤ 現在価格等）はAIの率にフォールバック

スタイル別の結果は `StockAnalysis.styleAnalyses` に JSON として保存され、フロントエンドでタブ切り替えにより比較表示できます。ユーザーの設定した投資スタイルがデフォルトタブとして表示されます。

シミュレーション分析（`executeSimulatedPortfolioAnalysis`）でも同様に投資スタイル別分析を生成し、`styleAnalyses` としてレスポンスに含めます（DBには保存しません）。

### 2. Daily Market Navigator（ポートフォリオ総評）

ポートフォリオ全体を市場の流れと照合するカード型UIです。朝と夜の2セッションで異なる視点の分析を提供します。

**前提条件**: なし（0銘柄でも表示。ポートフォリオがない場合は市場分析とセクター観点のアクションプランを提供）

**表示場所**:
- `/dashboard` の最上部
- `/portfolio-analysis`（専用ページ）

**セッション**:

| セッション | 生成タイミング | AIの役割 | 内容 |
|-----------|---------------|---------|------|
| 朝（morning） | 9:00 JST | ナビゲーター | 今日の戦略。市場展望・持ち株への影響・今日のアクションプラン |
| 夜（evening） | 15:30 JST | アナリスト兼コーチ | 結果診断。市場振り返り・持ち株の健康診断・明日の予習 |

UIはJST 15時を境にデフォルトセッションを自動切替。タブで手動切替も可能。

**ポートフォリオ有無による分岐**:

| パターン | Section 2 の表示 | STEP 2 の内容 |
|---------|-----------------|--------------|
| ポートフォリオあり | 「あなたのポートフォリオ」+ ステータスバッジ | 持ち株の健康診断 |
| ポートフォリオなし | 「投資戦略ガイド」（バッジなし） | セクターから投資チャンスを探す |

**分析に使用するデータ**:
- セクター構成・集中率
- 含み損益・総資産額・投資額
- ポートフォリオ全体のボラティリティ（加重平均）
- 業績状況（黒字銘柄数、増益/減益傾向）
- 銘柄別の日次値動き（前日比・週間変化率・MA乖離・出来高比）
- 本日の売却取引
- 市場概況（日経225の現在価格・週間変動・トレンド、S&P 500の現在価格・週間変動・トレンド、NASDAQの終値・前日比）
- ベンチマーク比較（日経225・S&P 500との超過リターン・ベータ値、直近1ヶ月）
- ポートフォリオ内セクターのセクタートレンド
- 今後7日間の決算予定銘柄
- ユーザーの投資スタイル

**3ステップ思考ロジック**:

| ステップ | 内容 |
|---------|------|
| STEP 1: 市場の流れを定義 | セクタートレンド・値動きデータ・NY市場（S&P 500・NASDAQ）の動向から今日の地合いを `bullish / bearish / neutral / sector_rotation` の1つに定義 |
| STEP 2: ポートフォリオとの照合 / セクター機会発見 | **ポートフォリオあり**: 保有銘柄と市場の流れを突き合わせ、逆行銘柄・リスク水準・要注意銘柄を特定。**ポートフォリオなし**: セクタートレンドから注目セクターと投資チャンスを探索 |
| STEP 3: 結論（アクション） | 投資スタイルに合わせて「攻める日」か「守る日」かを断定。曖昧な表現を避け具体的なアクションを提示 |

**AI出力スキーマ**:

```json
{
  "marketHeadline": "市況を1文で要約したテキスト",
  "marketTone": "bullish | bearish | neutral | sector_rotation",
  "marketKeyFactor": "市場の主要因（1〜2文）",
  "portfolioStatus": "healthy | caution | warning | critical",
  "portfolioSummary": "ポートフォリオの状態（1〜2文）",
  "actionPlan": "投資スタイルに基づく具体的なアクション。セクタートレンドに基づく戦略も含む（1〜2文）",
  "buddyMessage": "親しみやすい口調で初心者を勇気づける1文",
  "stockHighlights": [
    {
      "stockName": "銘柄名",
      "tickerCode": "7203.T",
      "sector": "輸送用機器",
      "dailyChangeRate": -2.3,
      "weekChangeRate": 1.5,
      "analysis": "値動きの分析テキスト"
    }
  ],
  "sectorHighlights": [
    {
      "sector": "半導体",
      "avgDailyChange": -3.1,
      "trendDirection": "up | down | neutral",
      "compositeScore": -25,
      "commentary": "セクター動向のコメント",
      "watchlistStocks": [
        { "stockName": "東京エレクトロン", "tickerCode": "8035.T" }
      ]
    }
  ]
}
```

**バッジの色分け**:

| 種類 | 値 | 色 |
|------|----|----|
| tone（市場トーン） | `bullish` | 緑（green） |
| tone（市場トーン） | `bearish` | 赤（red） |
| tone（市場トーン） | `neutral` | グレー（gray） |
| tone（市場トーン） | `sector_rotation` | 琥珀（amber） |
| status（ポートフォリオ状態） | `healthy` | 緑（green） |
| status（ポートフォリオ状態） | `caution` | 琥珀（amber） |
| status（ポートフォリオ状態） | `warning` | オレンジ（orange） |
| status（ポートフォリオ状態） | `critical` | 赤（red） |

**UIの構成（統合カード型）**:

| セクション | 内容 |
|-----------|------|
| Section 1: 市場 | `marketHeadline` + `marketTone` バッジ + `marketKeyFactor` |
| Section 2: ポートフォリオ / 投資戦略ガイド | ポートフォリオあり: `portfolioStatus` バッジ + `portfolioSummary` + `actionPlan`。ポートフォリオなし: `portfolioSummary`（市場動向ベース）+ `actionPlan` |
| Section 3: バディメッセージ | `buddyMessage`（紫背景の吹き出し） |
| Section 4: 詳細（折りたたみ） | `stockHighlights`（銘柄ハイライト、銘柄名クリックで詳細ページへ遷移）+ `sectorHighlights`（セクターハイライト、気になるリスト銘柄バッジ付き） |
| フッター | 分析日時 |

### 3. スマートスイッチ（乗り換え提案）

ポートフォリオ総評（Daily Market Navigator）の生成後に、含み損銘柄の乗り換え提案を自動生成する。含み損銘柄の「回復スコア」とウォッチリストのbuy判定銘柄の「チャンススコア」を比較し、乗り換えが有利な場合に提案を表示する。

**生成タイミング**: ポートフォリオ総評の生成直後（`generatePortfolioOverallAnalysis` の末尾）

**対象条件**:
- 含み損が -5% 以下（`SMART_SWITCH.MIN_LOSS_RATE`）の保有銘柄
- ウォッチリストに当日buy判定の銘柄が存在すること

**スコア算出**:

| スコア | 要素 | 重み |
|--------|------|------|
| 回復スコア（0-100） | 含み損の深さ | 30% |
| | AI推奨（buy/hold/sell） | 30% |
| | トレンド方向（短期/中期/長期） | 20% |
| | セクタートレンド | 20% |
| チャンススコア（0-100） | 購入判断結果 + 確信度 | 30% |
| | 銘柄スコア（compositeScore） | 25% |
| | トレンド方向 | 25% |
| | セクタートレンド | 20% |

**提案条件**:
- 回復スコアが70未満（回復見込みが低い）
- チャンススコア - 回復スコア >= 30（`SMART_SWITCH.MIN_SWITCH_BENEFIT`）
- 1日1ユーザーあたり最大3件（`SMART_SWITCH.MAX_PROPOSALS_PER_DAY`）

**理由テキスト**: テンプレートベースで生成（含み損の深さ、購入候補の魅力、セクター分散効果を考慮）

**ユーザーアクション**:
- 「詳細を見る」: 購入候補の銘柄詳細ページへ遷移
- 「今は見送る」: 提案を非表示（`userAction = "rejected"`）

**データモデル（SwitchProposal）**:

| カラム | 型 | 説明 |
|--------|-----|------|
| userId | String | ユーザーID |
| date | Date | 提案日 |
| session | String | セッション |
| sellStockId | String | 売却候補の銘柄ID |
| sellRecoveryScore | Int | 回復スコア |
| buyStockId | String | 購入候補の銘柄ID |
| buyOpportunityScore | Int | チャンススコア |
| switchBenefit | Int | 乗り換えメリット（チャンス - 回復） |
| reason | Text | 乗り換え理由 |
| userAction | String? | ユーザーの対応（accepted/rejected） |

**ユニーク制約**: `userId` + `date` + `sellStockId`

## API仕様

### 個別銘柄分析

#### `GET /api/stocks/[stockId]/portfolio-analysis`

最新の分析結果を取得。

#### `POST /api/stocks/[stockId]/portfolio-analysis`

新しい分析を生成。

**認証**: セッション認証 or CRON_SECRET

### Daily Market Navigator

#### `GET /api/portfolio/overall-analysis`

キャッシュされた Daily Market Navigator の分析を取得。

**クエリパラメータ**:
- `session` (optional): `morning` | `evening`。未指定時はJST時刻で自動判定（15時以降は `evening`）

**レスポンス**:

```json
{
  "hasAnalysis": true,
  "analyzedAt": "2026-02-26T10:00:00.000Z",
  "isToday": true,
  "session": "morning",
  "hasPortfolio": true,
  "portfolioCount": 3,
  "watchlistCount": 2,
  "market": {
    "headline": "半導体セクターが相場を牽引、全体的にリスクオンの展開",
    "tone": "bullish",
    "keyFactor": "外国人投資家の買い越しが続き、輸出関連銘柄に追い風"
  },
  "portfolio": {
    "status": "healthy",
    "summary": "保有銘柄の多くが市場と同じ方向に動いており、ポートフォリオは好調です",
    "actionPlan": "現在のポジションを維持しつつ、次の押し目買いのタイミングを狙ってください",
    "metrics": {
      "totalValue": 1500000,
      "totalCost": 1200000,
      "unrealizedGain": 300000,
      "unrealizedGainPercent": 25.0,
      "portfolioVolatility": 28.5,
      "sectorConcentration": 40.0,
      "sectorCount": 3
    }
  },
  "buddyMessage": "今日の市場は追い風です。焦らず、計画通りに進めましょう！",
  "details": {
    "stockHighlights": [
      {
        "stockName": "トヨタ自動車",
        "tickerCode": "7203.T",
        "sector": "輸送用機器",
        "dailyChangeRate": -2.3,
        "weekChangeRate": 1.5,
        "analysis": "円安一服を受けて利益確定売りが先行"
      }
    ],
    "sectorHighlights": [
      {
        "sector": "半導体",
        "avgDailyChange": 3.1,
        "trendDirection": "up",
        "compositeScore": 25,
        "commentary": "AI関連需要の拡大期待で買いが続く",
        "watchlistStocks": [
          { "stockName": "東京エレクトロン", "tickerCode": "8035.T" }
        ]
      }
    ]
  },
}
```

#### `POST /api/portfolio/overall-analysis`

Daily Market Navigator の分析を再生成。

**認証**: セッション認証 or CRON_SECRET

**リクエストボディ**:
- `userId` (CRON時必須): ユーザーID
- `session` (optional): `morning` | `evening`（デフォルト `morning`）

### ベンチマーク比較

#### `GET /api/portfolio/benchmark-metrics?period={1m|3m|6m|1y}`

ポートフォリオと日経225のベンチマーク比較指標を計算。

**レスポンス（データ十分時）**:
```json
{
  "hasMetrics": true,
  "period": "3m",
  "dataPoints": 60,
  "portfolioReturn": 5.5,
  "nikkeiReturn": 2.3,
  "excessReturn": 3.2,
  "beta": 0.85,
  "sharpeRatio": 1.24
}
```

**レスポンス（データ不足時）**:
```json
{
  "hasMetrics": false,
  "reason": "insufficient_data",
  "dataPoints": 15,
  "required": 30
}
```

### マーケットシールド

#### `GET /api/market-shield`

マーケットシールドの現在の状態を取得。

**レスポンス**:
```json
{
  "active": true,
  "triggerType": "vix_spike",
  "triggerValue": 32.5,
  "activatedAt": "2026-03-05T01:00:00.000Z"
}
```

### 乗り換え提案

#### `POST /api/switch-proposals/[id]/action`

乗り換え提案に対するユーザーアクションを記録。

**リクエストボディ**:
```json
{ "action": "accepted" | "rejected" }
```

### ポートフォリオサマリー

#### `GET /api/portfolio/summary`

ポートフォリオの数値指標を取得。

**レスポンス**:
```json
{
  "totalValue": 1500000,
  "totalCost": 1200000,
  "unrealizedGain": 300000,
  "unrealizedGainPercent": 25.0,
  "realizedGain": 50000,
  "totalGain": 350000,
  "totalGainPercent": 29.2,
  "winCount": 3,
  "loseCount": 1,
  "winRate": 75.0,
  "averageReturn": 12.5
}
```

### ポートフォリオ構成

#### `GET /api/portfolio/composition`

**レスポンス**:
```json
{
  "byStock": [
    {
      "stockId": "xxx",
      "tickerCode": "7203.T",
      "name": "トヨタ自動車",
      "sector": "輸送用機器",
      "value": 500000,
      "cost": 400000,
      "percent": 33.3,
      "color": "#3B82F6"
    }
  ],
  "bySector": [
    {
      "sector": "輸送用機器",
      "value": 500000,
      "percent": 33.3,
      "stockCount": 1,
      "color": "#F97316"
    }
  ]
}
```

### 資産推移

#### `GET /api/portfolio/history?period={1m|3m|6m|1y}`

PortfolioSnapshot テーブルからの時系列データ。

## AI設定

### 個別銘柄分析

| 項目 | 値 |
|------|-----|
| モデル | OpenAI GPT-4o-mini |
| Temperature | 0.3（分析的） |
| レスポンス形式 | JSON Schema（strict mode） |
| 最大トークン | 1600 |

### Daily Market Navigator

| 項目 | 値 |
|------|-----|
| モデル | OpenAI GPT-4o-mini（`DAILY_MARKET_NAVIGATOR.OPENAI_MODEL`） |
| Temperature | 0.3（`DAILY_MARKET_NAVIGATOR.OPENAI_TEMPERATURE`） |
| レスポンス形式 | JSON Schema（strict mode） |
| 最小銘柄数 | 0銘柄（制限なし、`DAILY_MARKET_NAVIGATOR.MIN_STOCKS`） |

## データモデル

### PortfolioOverallAnalysis（Daily Market Navigator）

ユーザー × セッションごとに1レコードを upsert で保存（`userId` + `session` の複合ユニーク）。

| カラム | 型 | 説明 |
|--------|-----|------|
| userId | String | ユーザーID |
| session | String | セッション（`morning` / `evening`、デフォルト `morning`） |
| analyzedAt | DateTime | 分析日時 |
| sectorConcentration | Decimal? | 最大セクター比率(%) |
| sectorCount | Int? | セクター数 |
| totalValue | Decimal? | 総資産額 |
| totalCost | Decimal? | 総投資額 |
| unrealizedGain | Decimal? | 含み損益 |
| unrealizedGainPercent | Decimal? | 含み損益率(%) |
| portfolioVolatility | Decimal? | ポートフォリオ全体のボラティリティ(%) |
| marketHeadline | Text | 市場ヘッドライン（AI生成） |
| marketTone | String | bullish / bearish / neutral / sector_rotation |
| marketKeyFactor | Text | 市場の主要因（AI生成） |
| portfolioStatus | String | healthy / caution / warning / critical |
| portfolioSummary | Text | ポートフォリオ総評（AI生成） |
| actionPlan | Text | アクションプラン（AI生成） |
| buddyMessage | Text | バディメッセージ（AI生成） |
| stockHighlights | Json | 銘柄ハイライト（`StockHighlight[]`） |
| sectorHighlights | Json | セクターハイライト（`SectorHighlight[]`） |

**StockHighlight JSON構造**:

```json
{
  "stockId": "cuid（銘柄詳細ページへのリンク用、optional）",
  "stockName": "銘柄名",
  "tickerCode": "7203.T",
  "sector": "輸送用機器",
  "dailyChangeRate": -2.3,
  "weekChangeRate": 1.5,
  "analysis": "値動きの分析テキスト"
}
```

**SectorHighlight JSON構造**:

```json
{
  "sector": "半導体",
  "avgDailyChange": -3.1,
  "trendDirection": "up | down | neutral",
  "compositeScore": -25,
  "commentary": "セクター動向のコメント",
  "watchlistStocks": [
    { "stockName": "東京エレクトロン", "tickerCode": "8035.T" }
  ]
}
```

### PortfolioSnapshot

| カラム | 型 | 説明 |
|--------|-----|------|
| userId | String | ユーザーID |
| date | Date | スナップショット日付 |
| totalValue | Decimal | 総資産額 |
| totalCost | Decimal | 総投資額 |
| unrealizedGain | Decimal | 含み損益 |
| unrealizedGainPercent | Decimal | 損益率(%) |
| stockCount | Int | 保有銘柄数 |
| sectorBreakdown | Json? | セクター別内訳 |
| stockBreakdown | Json? | 銘柄別内訳 |
| nikkeiClose | Decimal? | 日経225終値（ベンチマーク比較用） |
| sp500Close | Decimal? | S&P 500終値（ベンチマーク比較用） |

## 関連ファイル

- `app/portfolio-analysis/` - ポートフォリオ分析ページ（Daily Market Navigator を表示）
- `app/dashboard/DailyMarketNavigator.tsx` - Daily Market Navigator コンポーネント
- `app/portfolio-analysis/PortfolioAnalysisClient.tsx` - ポートフォリオ分析ページクライアント
- `app/api/portfolio/overall-analysis/route.ts` - Daily Market Navigator API
- `app/api/portfolio/summary/route.ts` - サマリー API
- `app/api/portfolio/composition/route.ts` - 構成比率 API
- `app/api/portfolio/history/route.ts` - 資産推移 API
- `app/api/portfolio/benchmark-metrics/route.ts` - ベンチマーク指標 API
- `app/dashboard/NikkeiSummary.tsx` - 日経225 & ベンチマーク比較コンポーネント
- `lib/portfolio-overall-analysis.ts` - Daily Market Navigator ロジック（型定義・生成・取得）
- `lib/portfolio-analysis-core.ts` - 個別銘柄分析ロジック（安全補正・価格算出・売りタイミング判定）
- `lib/portfolio-calculator.ts` - 計算ロジック
- `lib/style-analysis.ts` - 投資スタイル別セーフティルール
- `lib/stock-safety-rules.ts` - 共通安全ルール（危険銘柄、配当権利落ち判定等）
- `lib/correction-explanation.ts` - 補正理由の解説テキスト生成
- `lib/trend-divergence.ts` - トレンド乖離（ねじれ）検出
- `lib/prompts/portfolio-analysis-prompt.ts` - 個別分析プロンプト
- `lib/prompts/portfolio-overall-analysis-prompt.ts` - Daily Market Navigator プロンプト
- `lib/recommendation-buy-filter.ts` - 買いシグナル判定（チャート・ファンダメンタル）
- `lib/stock-analysis-context.ts` - 分析コンテキスト生成（`buildBuySignalContext`含む）
- `lib/market-shield.ts` - マーケットシールド（発動・解除・状態確認・自動解除）
- `lib/smart-switch.ts` - スマートスイッチ（乗り換え提案生成・スコア算出）
- `app/api/market-shield/route.ts` - マーケットシールド状態 API
- `app/api/switch-proposals/[id]/action/route.ts` - 乗り換え提案アクション API
