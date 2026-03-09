# スコアリングシステム仕様書

## 概要

勝率70%を実現するための**ロジック配分スコアリングシステム（100点満点）**。

単一指標の評価ではなく、3つのカテゴリの**複合条件（コンフルエンス）**が揃わないと高スコアにならない設計。80点以上の銘柄のみAIレビューに進む。

### 現行システムからの変更点

現行の `technical-scorer.ts` は8カテゴリ加重方式（トレンド20%、RSI15%、MACD10%、BB10%、パターン20%、ローソク足10%、出来高10%、サポート5%）で、すべてテクニカル系指標のみ。

新システムでは**3大カテゴリ**に再構成し、流動性評価と即死ルールを追加する。

---

## スコアリング構成（100点満点）

### カテゴリ1: テクニカル指標（40点）

「計算」で出せる確率の土台。

| サブ項目 | 配点 | データソース | 算出ルール |
|---------|------|-------------|-----------|
| RSI / ストキャスティクス | 15点 | `TechnicalSummary.rsi` | RSI 30-40 = 15点（反発ゾーン）、40-50 = 10点、50-60 = 7点、<30 = 5点、>70 = 0点 |
| 移動平均線 / 乖離率 | 15点 | `TechnicalSummary.maAlignment`, `deviationRate25` | パーフェクトオーダー+方向一致 = 15点、オーダーのみ = 12点、上昇トレンド = 10点、中立 = 7点、下降 = 0-4点 |
| 出来高の変化 | 10点 | `TechnicalSummary.volumeAnalysis.volumeRatio` | 2倍以上 = 10点、1.5倍 = 8点、1.0倍 = 5点、0.5倍以下 = 2点 |

### カテゴリ2: チャート・ローソク足パターン（30点）

「形」による優位性の確認。

| サブ項目 | 配点 | データソース | 算出ルール |
|---------|------|-------------|-----------|
| チャートパターン | 22点 | `ChartPatternResult[]` | Sランク買い = 22点、Aランク = 17点、Bランク = 13点、Cランク = 9点、Dランク = 6点、なし = 0点。売りパターン検出時は減点。 |
| ローソク足パターン | 8点 | `PatternResult` | 買いシグナル: strength × 0.08（端数丸め）。売りシグナル: (100-strength) × 0.08。なし = 4点（中立） |

パターンの完成度（完璧 vs 惜しい）は、チャートパターン検出の `rank` で反映される。

### カテゴリ3: 流動性（30点）※板情報の暫定代替

立花API導入までは、取得可能なデータで「物理的に勝てる場所か」を暫定評価する。

| サブ項目 | 配点 | データソース | 算出ルール |
|---------|------|-------------|-----------|
| 売買代金 | 12点 | `latestPrice × latestVolume` | 5億円以上 = 12点、3億円以上 = 9点、1億円以上 = 6点、5000万以上 = 3点、未満 = 0点 |
| 値幅率（スプレッド代替） | 10点 | `(high - low) / close` from OHLCV | 1%以下 = 10点、2%以下 = 7点、3%以下 = 4点、5%以下 = 2点、超 = 0点 |
| 売買代金安定性 | 8点 | 過去5日の売買代金の変動係数 | CV 0.3以下 = 8点、0.5以下 = 6点、0.7以下 = 3点、超 = 1点 |

#### 立花API導入後の移行

立花API導入後は以下に置き換え:

| サブ項目 | 配点 | 算出ルール |
|---------|------|-----------|
| オーバー・アンダー比率 | 15点 | 買い板総数が売り板より明確に多い = 15点 |
| スプレッド / 厚み | 15点 | 1ティック差で取引可能、即約定状態 = 15点 |

---

## 即死ルール（レッドカード）

以下の条件に**1つでも該当**したら、合計点に関わらず**即0点**（棄却）。AIには見せない。

| # | ルール | 判定条件 | データソース |
|---|--------|---------|-------------|
| 1 | スプレッド（値幅）が広すぎる | 当日の `(high - low) / close > 5%` | OHLCVデータ |
| 2 | ボラティリティ異常 | `Stock.volatility > 8%`（週次ボラティリティ） | Stockモデル |
| 3 | 10万円で買えない | `latestPrice > 1000`（100株 = 10万円超） | Stockモデル |

> 即死ルール該当銘柄は、棄却理由をDBに記録する（振り返り用）。

---

## 週足トレンド整合性チェック

マルチタイムフレーム分析の第一歩。週足のSMA13/SMA26アラインメントをチェックし、日足の買いシグナルと週足トレンドが矛盾する場合にスコアを減点する。

### 判定ルール

| 日足トレンド | 週足トレンド | 結果 |
|---|---|---|
| 上昇（パーフェクトオーダー） | 上昇 or 中立 | ペナルティなし |
| 上昇（パーフェクトオーダー） | 下降（SMA13 < SMA26） | **-8点**（`technical.ma` から減点） |
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

この配分では、2カテゴリ以上が高得点でないと80点を超えない:

- テクニカル満点(40) + パターン完璧(30) + 流動性普通(10) = **80点** → AI候補
- テクニカル普通(20) + パターン完璧(30) + 流動性最強(30) = **80点** → AI候補
- テクニカル満点(40) + パターンなし(0) + 流動性最強(30) = **70点** → 見送り

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
  technicalScore  Int   // 0-40
  patternScore    Int   // 0-30
  liquidityScore  Int   // 0-30

  // カテゴリ内訳（JSON）
  technicalBreakdown Json  // { rsi: 12, ma: 15, volume: 8 }
  patternBreakdown   Json  // { chart: 22, candlestick: 6 }
  liquidityBreakdown Json  // { tradingValue: 12, spread: 7, stability: 6 }

  // 即死ルール
  isDisqualified    Boolean @default(false)
  disqualifyReason  String? // "price_too_high" | "volatility_extreme" | "spread_too_wide"

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

### 新しいインターフェース

```typescript
/** 新スコアリング入力 */
interface LogicScoreInput {
  summary: TechnicalSummary;
  chartPatterns: ChartPatternResult[];
  candlestickPattern: PatternResult | null;
  // 流動性評価用の追加データ
  historicalData: OHLCVData[];   // 過去5日分（売買代金安定性計算用）
  latestPrice: number;
  latestVolume: number;
  // 即死ルール判定用
  weeklyVolatility: number | null;
}

/** 新スコアリング出力 */
interface LogicScore {
  totalScore: number;          // 0-100
  rank: "S" | "A" | "B" | "C";

  // カテゴリ別スコア
  technical: {
    total: number;             // 0-40
    rsi: number;               // 0-15
    ma: number;                // 0-15
    volume: number;            // 0-10
  };
  pattern: {
    total: number;             // 0-30
    chart: number;             // 0-22
    candlestick: number;       // 0-8
  };
  liquidity: {
    total: number;             // 0-30
    tradingValue: number;      // 0-12
    spreadProxy: number;       // 0-10
    stability: number;         // 0-8
  };

  // 即死ルール
  isDisqualified: boolean;
  disqualifyReason: string | null;

  // 最良パターン（既存互換）
  topPattern: {
    name: string;
    rank: string;
    winRate: number;
    signal: string;
  } | null;

  // シグナル（既存互換）
  technicalSignal: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
}
```

### 新しい定数定義

```typescript
export const SCORING = {
  // カテゴリ配点
  CATEGORY_MAX: {
    TECHNICAL: 40,
    PATTERN: 30,
    LIQUIDITY: 30,
  },

  // サブ項目配点
  SUB_MAX: {
    // テクニカル (40点)
    RSI: 15,
    MA: 15,
    VOLUME_CHANGE: 10,
    // パターン (30点)
    CHART_PATTERN: 22,
    CANDLESTICK: 8,
    // 流動性 (30点)
    TRADING_VALUE: 12,
    SPREAD_PROXY: 10,
    STABILITY: 8,
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
  },

  // 流動性閾値
  LIQUIDITY: {
    TRADING_VALUE_TIERS: [500_000_000, 300_000_000, 100_000_000, 50_000_000], // 5億, 3億, 1億, 5000万
    SPREAD_PROXY_TIERS: [0.01, 0.02, 0.03, 0.05], // 1%, 2%, 3%, 5%
    STABILITY_CV_TIERS: [0.3, 0.5, 0.7],           // 変動係数
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
3カテゴリスコアリング
  → テクニカル(40) + パターン(30) + 流動性(30) = 総合スコア
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

### AIへの提示フォーマット変更

```
【総合スコア】85/100（Sランク）

【カテゴリ別】
  テクニカル: 35/40
    RSI: 15/15（RSI=35、反発ゾーン）
    移動平均: 12/15（パーフェクトオーダー成立）
    出来高変化: 8/10（1.8倍）
  パターン: 28/30
    チャートパターン: 22/22（逆三尊 / Sランク / 勝率89%）
    ローソク足: 6/8（大陽線）
  流動性: 22/30
    売買代金: 9/12（3.2億円）
    値幅率: 7/10（1.8%）
    安定性: 6/8（CV=0.35）

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
セクターモメンタムフィルタ（弱セクター除外） ← ここ
  ↓
AIレビュー（Go/No-Go）
```

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

`ScoringRecord` の蓄積データを使い、各カテゴリ・サブ項目の配点を勝率と相関分析して最適化する。

```sql
-- 各サブ項目と勝率の相関
SELECT
  CORR(technical_score, CASE WHEN trade_result = 'win' THEN 1 ELSE 0 END) as technical_corr,
  CORR(pattern_score, CASE WHEN trade_result = 'win' THEN 1 ELSE 0 END) as pattern_corr,
  CORR(liquidity_score, CASE WHEN trade_result = 'win' THEN 1 ELSE 0 END) as liquidity_corr
FROM "ScoringRecord"
WHERE trade_result IS NOT NULL;
```
