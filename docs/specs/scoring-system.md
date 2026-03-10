# スコアリングシステム仕様書

## 概要

正の期待値を実現するための**ロジック配分スコアリングシステム（100点満点）**。

単一指標の評価ではなく、4つのカテゴリの**複合条件（コンフルエンス）**が揃わないと高スコアにならない設計。80点以上の銘柄のみAIレビューに進む。トレンドフォロー戦略に基づき、モメンタム方向のエントリーを重視する。

---

## スコアリング構成（100点満点）

### カテゴリ1: テクニカル指標（40点）

トレンドフォロー戦略の核。モメンタム方向を重視し、トレンドに乗るエントリーを評価する。

| サブ項目 | 配点 | データソース | 算出ルール |
|---------|------|-------------|-----------|
| RSI（モメンタム型） | 10点 | `TechnicalSummary.rsi` | RSI 50-65 = 10点（トレンド継続ゾーン）、40-50 = 7点、65-75 = 5点、30-40 = 3点、それ以外 = 0点 |
| 移動平均線 / 乖離率 | 15点 | `TechnicalSummary.maAlignment` | パーフェクトオーダー+方向一致 = 15点、オーダーのみ = 12点、上昇トレンド = 10点、中立 = 7点、下降 = 0-3点 |
| 出来高の変化（方向性込み） | 10点 | `TechnicalSummary.volumeAnalysis.volumeRatio` + OHLCV | 出来高の量（volumeRatio）× 方向性（accumulation/distribution/neutral）で評価。下表参照 |
| MACD | 5点 | `TechnicalSummary.macd` | ゴールデンクロス+正ヒストグラム = 5点、ゴールデンクロスのみ = 4点、正ヒストグラムのみ = 3点、デッドクロス = 0点、null = 2点 |

### カテゴリ2: チャート・ローソク足パターン（20点）

「形」による優位性の確認。

| サブ項目 | 配点 | データソース | 算出ルール |
|---------|------|-------------|-----------|
| チャートパターン | 14点 | `ChartPatternResult[]` | Sランク買い = 14点、Aランク = 11点、Bランク = 8点、Cランク = 5点、Dランク = 3点、なし = 0点。売りパターン検出時は減点。 |
| ローソク足パターン | 6点 | `PatternResult` | 買いシグナル: strength × 0.06（端数丸め）。売りシグナル: (100-strength) × 0.06。なし = 3点（中立） |

### カテゴリ3: 流動性（25点）※板情報の暫定代替

立花API導入までは、取得可能なデータで「物理的に勝てる場所か」を暫定評価する。

| サブ項目 | 配点 | データソース | 算出ルール |
|---------|------|-------------|-----------|
| 売買代金 | 10点 | `latestPrice × latestVolume` | 5億円以上 = 10点、3億円以上 = 7点、1億円以上 = 5点、5000万以上 = 3点、未満 = 0点 |
| 値幅率（スプレッド代替） | 8点 | `(high - low) / close` from OHLCV | 1%以下 = 8点、2%以下 = 6点、3%以下 = 3点、5%以下 = 1点、超 = 0点 |
| 売買代金安定性 | 7点 | 過去5日の売買代金の変動係数 | CV 0.3以下 = 7点、0.5以下 = 5点、0.7以下 = 3点、超 = 1点 |

### カテゴリ4: ファンダメンタルズ（15点）

「割高すぎる銘柄を買いシグナルだけで買う」ケースを排除するための品質フィルタ。データはyahoo-finance2の`quote()`レスポンスから取得（追加APIコール不要）。

| サブ項目 | 配点 | データソース | 算出ルール |
|---------|------|-------------|-----------|
| PER | 5点 | `Stock.per` (trailingPE) | 5-15 = 5点、15-30 = 4点、0-5 = 3点（安すぎ）、30-50 = 2点、>50 or <0 = 0点、null = 0点 |
| PBR | 4点 | `Stock.pbr` (priceToBook) | 0.5-1.5 = 4点、1.5-3.0 = 3点、<0.5 = 2点、3.0-5.0 = 1点、>5.0 = 0点、null = 2点 |
| 収益性 | 4点 | `Stock.eps` (epsTrailingTwelveMonths) | EPS >= 株価×5% = 4点、>= 2% = 3点、> 0 = 2点、≤ 0 = 0点、null = 2点 |
| 時価総額 | 2点 | `Stock.marketCap` | ≥ 200億円 = 2点、≥ 50億円 = 1点、< 50億円 or null = 0点 |

#### 立花API導入後の移行（流動性カテゴリ）

立花API導入後は流動性カテゴリを以下に置き換え:

| サブ項目 | 配点 | 算出ルール |
|---------|------|-----------|
| オーバー・アンダー比率 | 13点 | 買い板総数が売り板より明確に多い = 13点 |
| スプレッド / 厚み | 12点 | 1ティック差で取引可能、即約定状態 = 12点 |

---

## 即死ルール（レッドカード）

以下の条件に**1つでも該当**したら、合計点に関わらず**即0点**（棄却）。AIには見せない。

| # | ルール | 判定条件 | データソース |
|---|--------|---------|-------------|
| 1 | スプレッド（値幅）が広すぎる | 当日の `(high - low) / close > 5%` | OHLCVデータ |
| 2 | ボラティリティ異常 | `Stock.volatility > 8%`（週次ボラティリティ） | Stockモデル |
| 3 | 10万円で買えない | `latestPrice > 1000`（100株 = 10万円超） | Stockモデル |
| 4 | 決算発表前後 | 決算日の前5日〜後2日 | `Stock.nextEarningsDate`（yahoo-finance2 quoteSummary API） |
| 5 | 配当落ち日前後 | 配当落ち日の前2日〜後1日 | `Stock.exDividendDate`（yahoo-finance2 quoteSummary API） |

> 即死ルール該当銘柄は、棄却理由をDBに記録する（振り返り用）。

---

## 週足トレンド整合性チェック

マルチタイムフレーム分析の第一歩。週足のSMA13/SMA26アラインメントをチェックし、日足の買いシグナルと週足トレンドが矛盾する場合にスコアを減点する。

### 判定ルール

| 日足トレンド | 週足トレンド | 結果 |
|---|---|---|
| 上昇（パーフェクトオーダー） | 上昇 or 中立 | ペナルティなし |
| 上昇（パーフェクトオーダー） | 下降（SMA13 < SMA26） | **-7点**（`technical.ma` から減点） |
| 下降 or 中立 | 任意 | ペナルティなし（日足で既に低スコア） |

### 週足キャンドル集計

日足OHLCVデータ（200日分）をISO週（月曜始まり）単位でグループ化し、週足キャンドルを生成:
- open: 週初日の始値
- high: 週中の最高値
- low: 週中の最安値
- close: 週最終日の終値
- volume: 週合計出来高

### データ要件

- 週足SMA13の算出に最低14本の週足が必要
- 週足SMA26の算出に最低26本の週足が必要
- データ不足時はペナルティなし（安全側に倒す）

### 根拠

プロは「大きな時間軸のトレンドに逆らわない」が鉄則。週足が下降トレンドの銘柄を日足の反発で買うと、戻り売りに巻き込まれるリスクが高い。

---

## 出来高方向性分析（買い集め vs 投げ売り）

出来高の「量」だけでなく「方向性」を評価する。出来高が急増しても、それが買い集めなのか投げ売りなのかで意味が全く異なる。

### 分析手法

2つのファクターを組み合わせて方向性を判定:

**Factor 1: 陽線/陰線ベースの買い・売り出来高比率（直近5日）**
- 陽線（close > open）の日の出来高 → 買い出来高
- 陰線（close < open）の日の出来高 → 売り出来高
- 同値の場合は50/50に分配
- `buyingRatio = 買い出来高 / (買い出来高 + 売り出来高)`

**Factor 2: OBVトレンド（直近10日）**
- On-Balance Volume（OBV）を算出
- 前半と後半の平均OBVを比較し、トレンド方向を判定

### 総合判定

| buyingRatio | OBVトレンド | 判定 |
|---|---|---|
| >= 0.6 | 任意 | **accumulation**（買い集め） |
| <= 0.4 | 任意 | **distribution**（投げ売り） |
| 0.4-0.6 | 上昇 & ratio >= 0.5 | **accumulation** |
| 0.4-0.6 | 下降 & ratio <= 0.5 | **distribution** |
| 0.4-0.6 | その他 | **neutral**（中立） |

### スコアリング（出来高の量 × 方向性）

| volumeRatio | accumulation | neutral | distribution |
|---|---|---|---|
| >= 2.0倍 | **10点** | 7点 | 3点 |
| >= 1.5倍 | **8点** | 6点 | 3点 |
| >= 1.0倍 | **6点** | 5点 | 4点 |
| 0.5-1.0倍 | 4点 | 3点 | 3点 |
| <= 0.5倍 | 2点 | 2点 | 2点 |

> **注**: 出来高の配点は9点→10点に変更（テクニカルカテゴリ40点化に伴う再配分）。

### プロ視点の根拠

出来高2倍でも下落中なら「投げ売り」であり買いシグナルではない。出来高の質を見ないと偽のシグナルに騙される。プロは「出来高を伴った上昇」と「出来高を伴った下落」を明確に区別する。

### 定数

```typescript
VOLUME_DIRECTION: {
  LOOKBACK_DAYS: 5,              // 買い/売り出来高の分析期間
  OBV_PERIOD: 10,                // OBVトレンド算出期間
  ACCUMULATION_THRESHOLD: 0.6,   // これ以上 → 買い集め
  DISTRIBUTION_THRESHOLD: 0.4,   // これ以下 → 投げ売り
  MIN_DATA_DAYS: 3,              // 分析に必要な最低日数
}
```

---

## 逆行ウィナーボーナス

市場全体が取引停止（`shouldTrade=false`）の日に上昇した実績のある銘柄に、スコアリング時にボーナスポイントを加算する。地合いに左右されない独自の強さを持つ銘柄を優遇する仕組み。

### ボーナス計算

過去90日間で、市場停止日に+0.5%以上上昇した回数（逆行勝ち回数）に基づく。

| 逆行勝ち回数（90日間） | ボーナス | 効果 |
|---|---|---|
| 4回以上 | +7点 | B中位 → A昇格可能 |
| 3回 | +5点 | B上位 → A下位に昇格可能 |
| 2回 | +3点 | ランク境界付近で影響 |
| 0-1回 | 0点 | ボーナスなし |

- ボーナスはテクニカルスコアリング後、ランク判定前に適用
- 合計点は100点を上限とする
- 即死ルール棄却銘柄にはボーナスを適用しない
- AIレビュー時の `riskContext` にも逆行実績を記載

### データソース

- `ScoringRecord.rejectionReason = "market_halted"` + `ghostProfitPct >= 0.5` のレコードを過去90日でバッチ集計
- 結果は `ScoringRecord.contrarianBonus` / `contrarianWins` に保存

### 逆行ウィナーレポート

Ghost Review（16:10 JST）実行後、市場停止日に限り「逆行ウィナーレポート」をSlack通知する。上昇した銘柄のスコア・利益率・過去の逆行実績を表示。

---

## スコア閾値とアクション

| スコア | 判定 | アクション |
|--------|------|-----------|
| 80〜100 | S（最有力） | AIレビューへ（優先） |
| 65〜79 | A（有力） | AIレビューへ |
| 50〜64 | B（候補） | 候補が5銘柄未満の場合のみAIレビューへ |
| 0〜49 | C（見送り） | 棄却 |

### 80点突破のシミュレーション

この配分では、複数カテゴリが高得点でないと80点を超えない:

- テクニカル満点(40) + パターン完璧(20) + 流動性普通(8) + ファンダ良好(12) = **80点** → AI候補
- テクニカル優秀(37) + パターン良好(18) + 流動性良好(18) + ファンダ最悪(0) = **73点** → A止まり（ファンダが足を引っ張る）
- テクニカル優秀(37) + パターン良好(18) + 流動性良好(18) + ファンダ良好(12) = **85点** → S候補

---

## データ保存戦略（ハイブリッド）

### 保存対象

| データ | 保存先 | 保存条件 |
|--------|--------|---------|
| 全銘柄のスコア計算結果 | メモリのみ | - |
| 80点以上の候補のスコア内訳 | DB（`ScoringRecord`） | スコア >= 80 |
| 即死ルール棄却記録 | メモリのみ | 物理的に取引不可のためDB保存不要 |
| 個別指標の生値（RSI等） | メモリのみ | - |
| AIレビュー結果 | DB（`MarketAssessment.selectedStocks`） | 既存のまま |

### 新規データモデル

```prisma
model ScoringRecord {
  id           String   @id @default(cuid())
  date         DateTime @db.Date
  tickerCode   String

  // 総合
  totalScore   Int      // 0-100（即死時は0）
  rank         String   // S / A / B / C

  // カテゴリ別スコア
  technicalScore    Int   // 0-40
  patternScore      Int   // 0-20
  liquidityScore    Int   // 0-25
  fundamentalScore  Int   @default(0) // 0-15

  // カテゴリ内訳（JSON）
  technicalBreakdown   Json   // { rsi, ma, volume, macd }
  patternBreakdown     Json   // { chart, candlestick }
  liquidityBreakdown   Json   // { tradingValue, spreadProxy, stability }
  fundamentalBreakdown Json?  // { per, pbr, profitability, marketCap }

  // 即死ルール
  isDisqualified    Boolean @default(false)
  disqualifyReason  String? // "price_too_high" | "volatility_extreme" | "spread_too_wide" | "earnings_upcoming" | "ex_dividend_upcoming"

  // AIレビュー結果（AIに渡された場合のみ）
  aiDecision   String?  // "go" | "no_go"
  aiReasoning  String?  @db.Text

  // トレード結果（後から紐づけ）
  tradingOrderId String? @unique
  tradeResult    String? // "win" | "loss" | "no_trade"
  profitPct      Decimal? @db.Decimal(8, 4)

  createdAt    DateTime @default(now())

  @@unique([date, tickerCode])
  @@index([date(sort: Desc)])
  @@index([rank])
  @@index([tradeResult])
}
```

### 容量見積もり（Railway 500MB制限考慮）

- 1日あたり: 80点以上候補 ≈ 5-15銘柄 + 即死棄却 ≈ 10-20銘柄 = 最大35レコード
- 1レコード ≈ 500B（JSON含む）
- 月間: 35 × 22営業日 × 500B ≈ 385KB/月
- 年間: ≈ 4.6MB → **容量影響は軽微**

### 勝率分析クエリ例

```sql
-- カテゴリ別の勝率への寄与度分析
SELECT
  rank,
  COUNT(*) as total,
  COUNT(CASE WHEN trade_result = 'win' THEN 1 END) as wins,
  ROUND(AVG(technical_score), 1) as avg_technical,
  ROUND(AVG(pattern_score), 1) as avg_pattern,
  ROUND(AVG(liquidity_score), 1) as avg_liquidity
FROM "ScoringRecord"
WHERE trade_result IS NOT NULL
GROUP BY rank;

-- パターンスコアが高い銘柄の勝率
SELECT
  CASE WHEN pattern_score >= 25 THEN 'high' ELSE 'low' END as pattern_level,
  COUNT(*) as total,
  ROUND(100.0 * COUNT(CASE WHEN trade_result = 'win' THEN 1 END) / COUNT(*), 1) as win_rate
FROM "ScoringRecord"
WHERE trade_result IS NOT NULL
GROUP BY pattern_level;
```

---

## 実装設計

### 変更対象ファイル

| ファイル | 変更内容 |
|----------|---------|
| `src/core/technical-scorer.ts` | 3カテゴリ方式に全面改修 + 即死ルール追加 |
| `src/lib/constants/scoring.ts` | 新配点定数の定義 |
| `src/jobs/market-scanner.ts` | `ScoringRecord` の保存処理追加 |
| `prisma/schema.prisma` | `ScoringRecord` モデル追加 |

### インターフェース

```typescript
interface FundamentalInput {
  per: number | null;
  pbr: number | null;
  eps: number | null;
  marketCap: number | null;
  latestPrice: number;
}

interface LogicScoreInput {
  summary: TechnicalSummary;
  chartPatterns: ChartPatternResult[];
  candlestickPattern: PatternResult | null;
  historicalData: OHLCVData[];
  latestPrice: number;
  latestVolume: number;
  weeklyVolatility: number | null;
  weeklyTrend?: WeeklyTrendResult | null;
  fundamentals?: FundamentalInput;
}

interface LogicScore {
  totalScore: number;          // 0-100
  rank: "S" | "A" | "B" | "C";

  technical: {
    total: number;             // 0-40
    rsi: number;               // 0-10
    ma: number;                // 0-15
    volume: number;            // 0-10
    macd: number;              // 0-5
    volumeDirection: "accumulation" | "distribution" | "neutral";
  };
  pattern: {
    total: number;             // 0-20
    chart: number;             // 0-14
    candlestick: number;       // 0-6
  };
  liquidity: {
    total: number;             // 0-25
    tradingValue: number;      // 0-10
    spreadProxy: number;       // 0-8
    stability: number;         // 0-7
  };
  fundamental: {
    total: number;             // 0-15
    per: number;               // 0-5
    pbr: number;               // 0-4
    profitability: number;     // 0-4
    marketCap: number;         // 0-2
  };

  isDisqualified: boolean;
  disqualifyReason: string | null;
  topPattern: { name: string; rank: string; winRate: number; signal: string; } | null;
  technicalSignal: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
  weeklyTrendPenalty: number;
}
```

### 新しい定数定義

```typescript
export const SCORING = {
  // カテゴリ配点
  CATEGORY_MAX: {
    TECHNICAL: 40,
    PATTERN: 20,
    LIQUIDITY: 25,
    FUNDAMENTAL: 15,
  },

  // サブ項目配点
  SUB_MAX: {
    // テクニカル (40点)
    RSI: 10,
    MA: 15,
    VOLUME_CHANGE: 10,
    MACD: 5,
    // パターン (20点)
    CHART_PATTERN: 14,
    CANDLESTICK: 6,
    // 流動性 (25点)
    TRADING_VALUE: 10,
    SPREAD_PROXY: 8,
    STABILITY: 7,
    // ファンダメンタルズ (15点)
    PER: 5,
    PBR: 4,
    PROFITABILITY: 4,
    MARKET_CAP: 2,
  },

  // 閾値
  THRESHOLDS: {
    S_RANK: 80,
    A_RANK: 65,
    B_RANK: 50,
  },

  // 即死ルール
  DISQUALIFY: {
    MAX_PRICE: 1000,              // 株価上限（10万円で100株買えない）
    MAX_DAILY_SPREAD_PCT: 0.05,   // 当日値幅率上限 5%
    MAX_WEEKLY_VOLATILITY: 8,     // 週次ボラティリティ上限 8%
    EARNINGS_DAYS_BEFORE: 5,      // 決算前N日は即死
    EARNINGS_DAYS_AFTER: 2,       // 決算後N日は即死
    EX_DIVIDEND_DAYS_BEFORE: 2,   // 配当落ち日前N日は即死
    EX_DIVIDEND_DAYS_AFTER: 1,    // 配当落ち日後N日は即死
  },

  // 流動性閾値
  LIQUIDITY: {
    TRADING_VALUE_TIERS: [500_000_000, 300_000_000, 100_000_000, 50_000_000],
    SPREAD_PROXY_TIERS: [0.01, 0.02, 0.03, 0.05],
    STABILITY_CV_TIERS: [0.3, 0.5, 0.7],
  },

  // 出来高方向性分析
  VOLUME_DIRECTION: {
    LOOKBACK_DAYS: 5,
    OBV_PERIOD: 10,
    ACCUMULATION_THRESHOLD: 0.6,
    DISTRIBUTION_THRESHOLD: 0.4,
    MIN_DATA_DAYS: 3,
    SCORES: {
      HIGH_VOLUME: { accumulation: 10, neutral: 7, distribution: 3 },
      MEDIUM_VOLUME: { accumulation: 8, neutral: 6, distribution: 3 },
      NORMAL_VOLUME: { accumulation: 6, neutral: 5, distribution: 4 },
    },
  },

  // ファンダメンタルズ閾値
  FUNDAMENTAL: {
    PER_TIERS: [
      { min: 5, max: 15, score: 5 },   // 割安〜適正
      { min: 15, max: 30, score: 4 },  // 小型株として妥当
      { min: 0, max: 5, score: 3 },    // 安すぎ（構造的問題の可能性）
      { min: 30, max: 50, score: 2 },  // やや割高
    ],
    PER_DEFAULT: 0,                     // >50 or <0 or null
    PBR_TIERS: [
      { min: 0.5, max: 1.5, score: 4 },
      { min: 1.5, max: 3.0, score: 3 },
      { min: 0, max: 0.5, score: 2 },
      { min: 3.0, max: 5.0, score: 1 },
    ],
    PBR_DEFAULT: 2,                     // null時は中立
    PBR_OVER_5: 0,
    EPS_STRONG_RATIO: 0.05,            // EPS >= 株価×5%
    EPS_GOOD_RATIO: 0.02,              // EPS >= 株価×2%
    EPS_POSITIVE: 2,                    // EPS > 0
    EPS_NEGATIVE: 0,
    EPS_NULL: 2,                        // データなし → 中立
    MARKET_CAP_TIERS: [
      { min: 200_000_000_000, score: 2 },  // ≥ 200億円
      { min: 50_000_000_000, score: 1 },   // ≥ 50億円
    ],
    MARKET_CAP_DEFAULT: 0,              // < 50億円 or null
  },

  MAX_CANDIDATES_FOR_AI: 20,
  MIN_CANDIDATES_FOR_AI: 5,
} as const;
```

### 処理フロー（market-scanner 内）

```
全銘柄（~90銘柄）
  ↓
即死ルールチェック
  → 該当: score=0, isDisqualified=true, DBに棄却理由記録
  → 非該当: スコアリングへ
  ↓
4カテゴリスコアリング
  → テクニカル(40) + パターン(20) + 流動性(25) + ファンダメンタルズ(15) = 総合スコア
  ↓
ランク判定（S/A/B/C）
  → S+A（不足時B追加）を候補として抽出
  → 80点以上の候補: ScoringRecord にDB保存
  ↓
AIレビュー（Go/No-Go）
  → 結果を ScoringRecord.aiDecision に更新
  ↓
MarketAssessment に保存（既存フロー）
```

### トレード結果の紐づけ

注文成立後、`ScoringRecord.tradeResult` と `profitPct` を更新する。これにより「スコアXX点の銘柄は勝率YY%」の分析が可能になる。

紐づけタイミング: `position-monitor.ts` でポジションクローズ時。

---

## AIレビューとの連携

### AIレビュープロンプト方針（ニュースファースト）

AIレビューの判断基準は以下の優先順位で構成される（`src/prompts/stock-selection.ts`）:

| 優先度 | 判断基準 | 内容 |
|--------|---------|------|
| ① 最優先 | ニュース・カタリスト | 悪材料 → スコア無関係にNo-Go。好材料の織り込み済み度を判断。ニュース情報なし → riskFlagsに「ニュース未確認」追加 |
| ② | 地政学・マクロリスク | センチメントとの整合性、地政学イベントの影響 |
| ③ | セクター全体の流れ | 同セクターの資金フローと逆行していないか |
| ④ | チャートの綺麗さ | ダマシの可能性、出来高の裏付け |

**設計根拠**: テクニカルスコアリング（100点満点）は純テクニカルで完結させ、ニュース等の定性判断はAIレビューに集約する。これにより、スコアのバックテスト可能性を維持しつつ、ニュースリスクをAI層で確実にフィルタリングする。

### AIへの提示フォーマット変更

```
【総合スコア】85/100（Sランク）

【カテゴリ別】
  テクニカル: 37/40
    RSI: 10/10（RSI=55、トレンド継続ゾーン）
    移動平均: 15/15（パーフェクトオーダー成立）
    出来高変化: 8/10（1.8倍 / 買い集め）
    MACD: 4/5（ゴールデンクロス）
  パターン: 18/20
    チャートパターン: 13/14（逆三尊 / Sランク / 勝率89%）
    ローソク足: 5/6（大陽線）
  流動性: 17/25
    売買代金: 8/10（3.2億円）
    値幅率: 5/8（1.8%）
    安定性: 4/7（CV=0.35）
  ファンダメンタルズ: 12/15
    PER: 4/5
    PBR: 3/4
    収益性: 3/4
    時価総額: 2/2

【ロジック判定】strong_buy
```

---

## Ghost Trading Analysis（偽陰性分析）

### 概要

見送った銘柄のうち、実際には利益が出ていたケース（偽陰性）を追跡し、スコアリング閾値やAI判断基準の改善に活用する。

### 追跡対象

| 対象 | `rejectionReason` | 条件 |
|------|-------------------|------|
| AI否決銘柄 | `ai_no_go` | AIがGo/No-Go判定でNo-Goとした銘柄 |
| 閾値未達銘柄 | `below_threshold` | スコア60+だがAI審査に送られなかった銘柄（B/Cランク） |

### ScoringRecord追加フィールド

```prisma
rejectionReason   String?                     // below_threshold / ai_no_go / disqualified
entryPrice        Decimal? @db.Decimal(10, 2) // スコアリング時の株価
closingPrice      Decimal? @db.Decimal(10, 2) // 大引け後の終値
ghostProfitPct    Decimal? @db.Decimal(8, 4)  // 仮想損益 %
ghostAnalysis     String?  @db.Text           // AI後悔分析（JSON）
```

### 処理フロー（ghost-review ジョブ / 16:10 JST）

1. 今日の `ScoringRecord` から `rejectionReason IS NOT NULL` を取得
2. `fetchStockQuotes()` で終値をバッチ取得
3. 仮想損益を算出: `(closingPrice - entryPrice) / entryPrice * 100`
4. DB更新（closingPrice + ghostProfitPct）
5. 利益率1%以上の上位5銘柄にAI後悔分析を実行
6. Slack通知

### AI後悔分析の出力

| フィールド | 内容 |
|-----------|------|
| `misjudgmentType` | `threshold_too_strict` / `ai_overcautious` / `pattern_not_recognized` / `market_context_changed` / `acceptable_miss` |
| `analysis` | 判断が外れた原因（100文字以内） |
| `recommendation` | `lower_threshold` / `adjust_ai_criteria` / `add_pattern_rule` / `no_change_needed` |
| `reasoning` | 改善提案の理由（150文字以内） |

### 定数

```typescript
export const GHOST_TRADING = {
  MIN_SCORE_FOR_TRACKING: 60,       // 追跡対象の最低スコア
  MAX_AI_REGRET_ANALYSIS: 5,        // AI分析の最大件数/日
  MIN_PROFIT_PCT_FOR_ANALYSIS: 1.0, // AI分析トリガーの最低利益率(%)
  AI_CONCURRENCY: 3,                // AI並列数
};
```

### 容量見積もり

- 追加レコード: 約10-30件/日（スコア60+のB/Cランク銘柄）
- 1レコード ≈ 600B
- 月間追加: ≈ 396KB → 容量影響は軽微

---

## セクターモメンタムフィルタ

スコアリングシステムとは別軸で、market-scanner内で弱セクター銘柄を除外するフィルタ。

### 仕組み

StockテーブルのweekChangeRateをセクターグループ別（SECTOR_MASTERの11グループ）に平均し、日経225の週間変化率との差（相対パフォーマンス）を算出する。

```
relativeStrength = セクター平均weekChangeRate - 日経weekChangeRate
```

- `relativeStrength < -2.0%` → 弱セクター → 該当銘柄をAIレビュー候補から除外
- `relativeStrength > +2.0%` → 強セクター（情報としてAIに提供）

### スコアリングとの関係

セクターモメンタムは100点満点のスコアには影響しない。個別銘柄のテクニカル品質とは独立した「環境フィルタ」として機能する。

```
スコアリング（個別銘柄の品質評価）
  ↓ S/A/Bランク抽出
レジームフィルタ（VIX水準によるランク制限）
  ↓
日経平均キルスイッチ（前日比 ≤ -3% で全取引停止・全決済）
  ↓
セクターモメンタムフィルタ（弱セクター除外） ← ここ
  ↓
AIレビュー（Go/No-Go）
```

### 日経平均キルスイッチ

VIXは米国市場の指標であり、日本株の急落をリアルタイムに反映しきれない。日経平均の前日比が -3% 以下の場合、VIXレジームに関わらず **Crisisモード（全取引停止＋全ポジション即時決済）** に移行する。

- **閾値**: `MARKET_INDEX.NIKKEI_CRISIS_THRESHOLD`（-3%）
- **判定タイミング**: VIXレジーム判定の直後、ドローダウンチェックの前（market-scanner ステップ 1.8.5）
- **動作**: `sentiment: "crisis"`, `shouldTrade: false` を MarketAssessment に保存 → position-monitor がディフェンシブモード（全決済）を実行
- **実装**: `src/jobs/market-scanner.ts`

### 実装ファイル

- `src/core/sector-analyzer.ts` の `calculateSectorMomentum()`
- 閾値: `SECTOR_RISK.WEAK_SECTOR_THRESHOLD` (-2.0%)

---

## 将来の拡張

### 板情報スコアリング（立花API導入後）

流動性カテゴリの暫定指標を、リアルタイム板データに置き換え:

- **オーバー・アンダー比率（15点）**: 買い板の総数が売り板より明確に多いか
- **スプレッド / 厚み（15点）**: 1ティック差で取引可能、即約定状態か

即死ルールにも板データ版を追加:
- スプレッドが広すぎる（買値と売値が離れすぎ → 手数料負け確定）

### ウェイト最適化（バックテスト）

`ScoringRecord` の蓄積データを使い、各カテゴリ・サブ項目の配点を期待値（PF・RR比）と相関分析して最適化する。

```sql
-- 各サブ項目と期待値の相関
SELECT
  CORR(technical_score, profit_pct) as technical_corr,
  CORR(pattern_score, profit_pct) as pattern_corr,
  CORR(liquidity_score, profit_pct) as liquidity_corr
FROM "ScoringRecord"
WHERE trade_result IS NOT NULL;
```
