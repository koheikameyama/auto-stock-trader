# スコアリングシステム仕様書

## 概要

正の期待値を実現するための**3カテゴリ＋セクターボーナス＋ゲート方式のスコアリングシステム（100点満点）**。

「この銘柄は良い銘柄か？」ではなく「この銘柄に**今入るべきか？**」を測る設計。ゲート（即死ルール）でバイナリに足切りした後、トレンド品質・エントリータイミング・リスク品質の3カテゴリで合計100点満点のベーススコアを算出し、セクターモメンタムボーナス（-3〜+5）を加減する。

**設計方針**: エントリータイミングの精度を最重視し、トレンドフォロー戦略に特化。流動性やファンダメンタルズはスコアではなくゲート（バイナリ判定）で処理する。

---

## アーキテクチャ

```
ゲート（即死ルール） → 不合格なら即除外（isDisqualified=true）
  ↓ 合格
3カテゴリスコアリング（100点満点）
  ├─ トレンド品質       (40点)
  ├─ エントリータイミング (35点)
  └─ リスク品質         (25点)
  + セクターモメンタムボーナス (-3〜+5)
  ↓
ランク判定（S/A/B）
  ↓
AIレビュー（Go/No-Go）
```

---

## ゲート（即死ルール）

スコアではなくバイナリ判定。1つでも不合格なら候補から即除外する。

| ゲート | 条件 | 根拠 |
|--------|------|------|
| 流動性 | 25日平均出来高 >= 50,000株 | 約定リスク回避 |
| スプレッド/価格 | 株価 <= 3,000円（100株=30万円制約） | 予算制約 |
| 最低ボラティリティ | ATR(14)/終値 × 100 >= 1.5% | 低ボラ銘柄はスイングに不向き |
| 決算接近 | 決算発表まで5日超（カレンダー日数） | 決算ギャンブル回避 |
| 配当落ち | 権利落ち日まで3日超（カレンダー日数） | 権利落ち下落回避 |

- ゲート不合格銘柄は `isDisqualified=true`、`disqualifyReason` に理由を記録
- 配当データ欠損時（`exDividendDate` null）は合格（安全側デフォルト）

### 定数

```typescript
GATES: {
  MIN_AVG_VOLUME_25: 50_000,
  MAX_PRICE: 3000,
  MIN_ATR_PCT: 1.5,
  EARNINGS_DAYS_BEFORE: 5,
  EX_DIVIDEND_DAYS_BEFORE: 3,
}
```

---

## スコアリング構成（100点満点）

### カテゴリ配分

| カテゴリ | 配点 | 役割 |
|---------|------|------|
| トレンド品質 | **40点** | 今トレンドが出ているか、信頼できるか |
| エントリータイミング | **35点** | 今がエントリーすべきタイミングか |
| リスク品質 | **25点** | リスクは管理可能か |
| セクターモメンタム | **-3〜+5（ボーナス）** | セクターの追い風/逆風を加減 |

---

## カテゴリ1: トレンド品質（40点）

### 1-1. MA配列スコア（18点）

移動平均線のパーフェクトオーダーを評価する。

| 条件 | 点数 |
|------|------|
| 終値 > SMA5 > SMA25 > SMA75 | 18 |
| 終値 > SMA5 > SMA25、SMA75下 | 14 |
| 終値 > SMA25、SMA5割れ | 8 |
| SMA25上だが配列崩れ | 4 |
| SMA25下 | 0 |

### 1-2. 週足トレンド確認（12点）

日足だけでなく上位時間軸でトレンド方向を確認する。

| 条件 | 点数 |
|------|------|
| 週足SMA13上 & 上向き | 12 |
| 週足SMA13上 & 横ばい | 8 |
| 週足SMA13下 & 上向き（転換初期） | 4 |
| 週足SMA13下 & 下向き | 0 |

**方向判定**: `上向き` = 今週のSMA13 > 前週のSMA13、`横ばい` = 変化率が±0.5%以内、`下向き` = 今週のSMA13 < 前週のSMA13。

### 1-3. トレンド継続性（10点）

トレンドの「鮮度」を測る。

| 条件 | 点数 | 根拠 |
|------|------|------|
| SMA25上に10-30日連続 | 10 | スイングのスイートスポット |
| SMA25上に5-9日 | 7 | トレンド初期 |
| SMA25上に31-50日 | 5 | やや成熟 |
| SMA25上に50日超 | 2 | 終盤リスク |
| SMA25下 | 0 | - |

**カウント方法**: 最新のバーから逆順に、`close > SMA25`の連続日数をカウント。1日でも`close <= SMA25`があればカウント停止。

---

## カテゴリ2: エントリータイミング（35点）

### 2-1. プルバック深度（15点）

トレンド中の押し目の深さを評価する。

| 条件 | 点数 |
|------|------|
| SMA25付近（乖離率 -1%〜+2%）で反発サイン | 15 |
| SMA5-SMA25間（浅い押し目） | 10 |
| SMA25を一時的に割った直後に復帰 | 8 |
| SMA5上（押してない） | 3 |
| SMA25大幅下（乖離-3%超） | 0 |

**乖離率**: `deviationRate = (close - SMA25) / SMA25 * 100`

**反発サイン**: 下ヒゲが実体以上のローソク足、または前日陰線→当日陽線の包み足。

### 2-2. BO後押し目ボーナス（12点）

直近にブレイクアウト（高値更新）があり、かつ現在押し目にいる場合のみ加点。
ブレイクアウト後のサポート転換は高品質な押し目セットアップであるため、押し目深度へのボーナスとして機能する。

**ゲート条件**: `pullbackDepth === 0` → 0点（押し目でないなら加点なし）

| 条件 | 点数 |
|------|------|
| 20日高値が1〜7日前に発生 + 出来高 > 25日平均の1.5倍 | 12 |
| 20日高値が1〜7日前に発生 + 出来高 > 1.2倍 | 9 |
| 20日高値が1〜7日前に発生 | 7 |
| 10日高値が1〜5日前に発生 | 5 |
| 現在値が20日高値の95%以上（高値圏で押している） | 2 |
| 上記いずれにも該当しない | 0 |

**設計意図**: ブレイクアウトは独立エントリーシグナルとしては使わない（指値ロジックが押し目買いのみのため）。代わりに「直近の強い上昇後に押している = 質の高い押し目」というコンテキスト情報として活用する。

### 2-3. ローソク足シグナル（8点）

| 条件 | 点数 |
|------|------|
| 包み足（陽線）+ 出来高増加 | 8 |
| 長い下ヒゲ（実体の2倍超）+ SMA付近 | 6 |
| 連続陽線（3本）+ 出来高漸増 | 5 |
| 十字線 + サポート付近 | 3 |
| 特にシグナルなし | 0 |

複数パターン該当時は最高スコアの1つを採用。

---

## カテゴリ3: リスク品質（25点）

### 3-1. ATR安定性（10点）

| 条件 | 点数 |
|------|------|
| ATR14の変動係数(CV) < 0.15 | 10 |
| CV 0.15-0.25 | 7 |
| CV 0.25-0.35 | 4 |
| CV > 0.35 | 0 |

CV = ATR14の直近20日間の標準偏差 / 平均値。

### 3-2. レンジ収縮度（8点）

| 条件 | 点数 |
|------|------|
| BB幅が直近60日で最小付近（下位20%） | 8 |
| BB幅が下位20-40% | 5 |
| BB幅が中央付近 | 3 |
| BB幅が上位40%（ボラ拡大中） | 0 |

BB幅 = `BB上限(20,2σ) - BB下限(20,2σ)`。直近60営業日分のBB幅から当日のパーセンタイル順位を算出。

### 3-3. 出来高安定性（7点）

| 条件 | 点数 |
|------|------|
| 出来高5日MA > 25日MA & CV < 0.5 | 7（増加+安定） |
| 出来高5日MA > 25日MA & CV < 0.8 | 5（増加+やや安定） |
| CV < 0.5（増加なし） | 3（安定のみ） |
| CV < 0.8（増加なし） | 1（やや安定） |
| CV >= 0.8 | 0（不安定） |

出来高CV = 直近25日間の日次出来高の標準偏差 / 平均値。

---

## セクターモメンタムボーナス（-3〜+5）

セクター相対強度（対日経225の週間パフォーマンス差）をボーナス/ペナルティとして最終スコアに加減する。
3カテゴリの合計（ベーススコア）に対して加算し、0〜100の範囲にクランプする。

### 入力

`calculateSectorMomentum()` が返す `relativeStrength`（セクター平均週間変化率 - 日経225週間変化率）

### ボーナス変換テーブル

上位の条件から順にマッチする（`>=` 比較）：

| 相対強度（%） | ボーナス | 解釈 |
|---|---|---|
| >= +2.0% | +5 | セクター大幅アウトパフォーム |
| >= +1.0% | +3 | 明確にアウトパフォーム |
| >= +0.5% | +1 | やや強い |
| >= -0.5% | 0 | 市場並み（ニュートラル） |
| >= -2.0% | -2 | やや弱い |
| < -2.0% | -3 | 弱セクター |

### セクター不明時・銘柄数不足時

- `getSectorGroup()` が `null` を返す場合 → デフォルト0（ニュートラル）
- セクターグループの銘柄数が3未満 → デフォルト0（統計的に不安定）

### スコア計算

```
最終スコア = min(100, max(0, ベーススコア + セクターボーナス))
```

- テクニカルのみで75点以上 → セクター中立でもSランク到達
- テクニカル73点 + 追い風(+3) → 76点でSランクにブースト
- テクニカル77点 + 逆風(-3) → 74点でAランクに降格

---

## スコア閾値とランク

| ランク | スコア範囲 | アクション |
|--------|-----------|-----------|
| S | 75-100 | エントリー候補 → AIレビューへ |
| A | 60-74 | 候補が5銘柄未満の場合のみAIレビューへ（フォールバック） |
| B | 0-59 | 対象外 |

---

## データ要件

| 指標 | 必要日数 |
|------|---------|
| SMA75（MA配列） | 75日 |
| 週足SMA13 | 65日（≒13週） |
| BB幅の60日パーセンタイル | 80日 |
| ATR14のCV（20日） | 34日 |
| 出来高25日MA | 25日 |
| 20日高値 | 20日 |

最低必要日数: 80日。on-the-flyモードの200日ルックバックで十分カバー。

### データ不足時のフォールバック

| 指標 | データ不足時 |
|------|------------|
| SMA75（MA配列） | SMA25のみで評価（最大14点） |
| 週足SMA13 | 0点（週足トレンド未評価） |
| BB幅60日パーセンタイル | 0点（レンジ収縮未評価） |
| ATR14のCV(20日) | 0点（ATR安定性未評価） |
| SMA25上の連続日数 | 利用可能な日数でカウント |

---

## 出力インターフェース

```typescript
interface ScoringGateResult {
  passed: boolean;
  failedGate: string | null; // "liquidity" | "spread" | "volatility" | "earnings" | "dividend"
}

interface NewLogicScore {
  totalScore: number;
  rank: "S" | "A" | "B";
  gate: ScoringGateResult;
  trendQuality: {
    total: number;        // 0-40
    maAlignment: number;  // 0-18
    weeklyTrend: number;  // 0-12
    trendContinuity: number; // 0-10
  };
  entryTiming: {
    total: number;           // 0-35
    pullbackDepth: number;   // 0-15
    priorBreakout: number;   // 0-12
    candlestickSignal: number; // 0-8
  };
  riskQuality: {
    total: number;            // 0-25
    atrStability: number;     // 0-10
    rangeContraction: number; // 0-8
    volumeStability: number;  // 0-7
  };
  sectorMomentumScore: number; // -3〜+5（ボーナス/ペナルティ）
  isDisqualified: boolean;
  disqualifyReason: string | null;
}
```

---

## データ保存（ScoringRecord）

```prisma
model ScoringRecord {
  id           String   @id @default(cuid())
  date         DateTime @db.Date
  tickerCode   String

  // 総合
  totalScore   Int      // 0-100
  rank         String   // S / A / B

  // カテゴリ別スコア
  trendQualityScore      Int   // 0-40
  entryTimingScore       Int   // 0-35
  riskQualityScore       Int   // 0-25
  sectorMomentumScore    Int   @default(0) // -3〜+5（ボーナス/ペナルティ）

  // カテゴリ内訳（JSON）
  trendQualityBreakdown   Json  // { maAlignment, weeklyTrend, trendContinuity }
  entryTimingBreakdown    Json  // { pullbackDepth, priorBreakout, candlestickSignal }
  riskQualityBreakdown    Json  // { atrStability, rangeContraction, volumeStability }

  // 即死ルール
  isDisqualified    Boolean @default(false)
  disqualifyReason  String?

  // AIレビュー結果
  aiDecision   String?  // "go" | "no_go"
  aiReasoning  String?  @db.Text

  // Ghost Trading（偽陰性追跡）
  rejectionReason   String?
  entryPrice        Decimal? @db.Decimal(10, 2)
  closingPrice      Decimal? @db.Decimal(10, 2)
  ghostProfitPct    Decimal? @db.Decimal(8, 4)

  // 逆行ボーナス
  contrarianBonus   Int      @default(0)
  contrarianWins    Int      @default(0)

  // トレード結果
  tradingOrderId String? @unique
  tradeResult    String?
  profitPct      Decimal? @db.Decimal(8, 4)

  createdAt    DateTime @default(now())

  @@unique([date, tickerCode])
  @@index([date(sort: Desc)])
  @@index([rank])
}
```

---

## 実装ファイル

| ファイル | 役割 |
|----------|------|
| `src/core/scoring/gates.ts` | ゲート判定（即死ルール + 流動性ゲート） |
| `src/core/scoring/trend-quality.ts` | トレンド品質スコア（40点） |
| `src/core/scoring/entry-timing.ts` | エントリータイミングスコア（35点） |
| `src/core/scoring/risk-quality.ts` | リスク品質スコア（25点） |
| `src/core/scoring/sector-momentum.ts` | セクターモメンタムボーナス（-3〜+5） |
| `src/core/scoring/types.ts` | 型定義（NewLogicScore, ScoringGateResult, ScoringInput） |
| `src/core/scoring/index.ts` | メインエントリー: `scoreStock()`, `formatScoreForAI()` |
| `src/lib/constants/scoring.ts` | 定数定義（SCORING） |

---

## 処理フロー（market-scanner 内）

```
全候補銘柄
  ↓
Pass 1: データ取得（並列）— historicalData, technicals 等
  ↓
ゲート判定
  → 不合格: isDisqualified=true, DB記録
  → 合格: スコアリングへ
  ↓
3カテゴリスコアリング + セクターボーナス
  → トレンド品質(40) + エントリータイミング(35) + リスク品質(25) = ベーススコア + セクターボーナス(-3〜+5) = 総合スコア
  ↓
逆行ボーナス加算（contrarianBonus）
  ↓
ランク判定（S/A/B）
  → S（不足時A追加）を候補として抽出
  → ScoringRecord にDB保存
  ↓
AIレビュー（Go/No-Go）
  → 結果を ScoringRecord.aiDecision に更新
```

---

## AIレビューとの連携

テクニカルスコアリング（100点満点）は純テクニカルで完結。ニュース等の定性判断はAIレビューに集約する。

### AIへの提示フォーマット

```
【総合スコア】85/100（Sランク）

【ゲート】全て合格

【カテゴリ別】
  トレンド品質: 32/40
    MA配列: 18/18
    週足トレンド: 8/12
    トレンド継続性: 6/10
  エントリータイミング: 30/35
    プルバック深度: 15/15
    BO後押し目: 7/12
    ローソク足シグナル: 8/8
  リスク品質: 25/25
    ATR安定性: 10/10
    レンジ収縮: 8/8
    出来高安定性: 7/7
  セクターボーナス: +3
```

---

## 逆行ウィナーボーナス

取引見送り日（`shouldTrade=false`）に上昇した実績のある銘柄にボーナスポイントを加算。

| 条件 | ボーナス |
|------|---------|
| 4回以上 & 勝率50%以上 | +4点 |
| 3回以上 & 勝率40%以上 | +2点 |
| それ以外 | 0点 |

- 合計点は100点上限
- 即死ルール棄却銘柄にはボーナスを適用しない

---

## Ghost Trading Analysis（偽陰性分析）

見送った銘柄のうち実際に利益が出ていたケースを追跡し、スコアリング精度の改善に活用する。

### 追跡対象

| 対象 | `rejectionReason` |
|------|--------------------|
| AI否決銘柄 | `ai_no_go` |
| 閾値未達銘柄 | `below_threshold` |
| 取引見送り日銘柄 | `market_halted` |
| 即死棄却銘柄 | `disqualified` |

### 処理（ghost-review ジョブ / 16:10 JST）

1. 今日の `ScoringRecord` から `rejectionReason IS NOT NULL` を取得
2. 終値をバッチ取得
3. 仮想損益を算出: `(closingPrice - entryPrice) / entryPrice * 100`
4. DB更新
5. 利益率1%以上の上位5銘柄にAI後悔分析を実行
6. Slack通知
7. 意思決定整合性評価

---

## 旧システムからの変更点

| 項目 | 旧（旧4カテゴリ） | 新（4カテゴリ+ゲート） |
|------|----------------|----------------------|
| テクニカル指標 | 65点（RSI, MA, 出来高, MACD, RS） | トレンド品質40点 + エントリー35点に分割再設計 |
| パターン認識 | 15点 | エントリータイミング内ローソク足シグナル（8点）に統合 |
| 流動性 | 10点（スコア） | ゲート（バイナリ足切り） |
| ファンダメンタルズ | 10点 | 廃止（スイングトレードに無関係） |
| RSI | 12点（逆モメンタム型） | 廃止（トレンドフォローと矛盾） |
| MACD | 7点 | 廃止（MA配列と情報重複） |
| RS（相対強度） | 15点 | 廃止（MA配列・週足トレンドと重複） |
| ランク | S/A/B/C | S/A/B（3段階に簡素化） |
| 即死ルール | スプレッド, ボラ, 価格, 決算, 配当 | + 流動性ゲート + 最低ボラゲート |

---

## 保有継続スコアリング（Holding Score）

### 概要

オープンポジションの銘柄を日次評価し、トレンド劣化時にトレーリングストップを引き締めて早期撤退を可能にする。エントリータイミング（35点）を除外し、**トレンド品質（40点）+ リスク品質（25点）+ セクターモメンタムボーナス（-3〜+5）**で評価する。

### スコア構成（65点満点 + セクター補正最大+5 = 最大67点）

| カテゴリ | 配点 | 内容 |
|---------|------|------|
| トレンド品質 | 40点 | MA配列・週足トレンド・トレンド継続性（エントリー用と同一ロジック） |
| リスク品質 | 25点 | ATR安定性・レンジ収縮・出来高安定性（エントリー用と同一ロジック） |
| セクターモメンタム | -3〜+5 | セクター相対強度ボーナス（エントリー用と同一ロジック） |

### 保有用ゲート（即死ルール）

| ゲート | 条件 | 理由 |
|--------|------|------|
| 流動性枯渇 | avgVolume25 < 30,000 | エントリー時(50k)より低い閾値。流動性枯渇で撤退困難 |
| 週足崩壊 | weeklyClose < weeklySMA13 | トレンドフォロー戦略の前提崩壊 |

### ランク定義

| ランク | スコア | 意味 | アクション |
|--------|--------|------|-----------|
| strong | 50-67 | トレンド健全 | 通常監視 |
| healthy | 40-49 | 正常 | 通常監視 |
| weakening | 30-39 | 劣化傾向 | TS引き締め（×0.7） |
| deteriorating | 20-29 | 大幅劣化 | TS引き締め（×0.5） |
| critical | 0-19 | トレンド崩壊 | TS引き締め（×0.5）+ Slack警告 |

### アラート

| タイプ | 重要度 | 条件 |
|--------|--------|------|
| trend_collapse | critical | 週足SMA13割れ |
| trend_collapse | warning | トレンド品質 ≤ 10/40 |
| risk_spike | warning | リスク品質 ≤ 5/25 |
| sector_weakness | warning | セクターモメンタム ≤ -2 |
| liquidity_warning | critical | 25日平均出来高 < 30,000 |
| score_drop | critical | 前日比15点以上急落 |

### position-monitor連携

`holdingScoreTrailOverride` に実際のATR倍率値（例: 2.0 × 0.7 = 1.4）を保存。position-monitorが既存のoverride（連休前引き締め、cautious引き締め）と比較し、最も保守的な値を採用する。

### 出力インターフェース

```typescript
interface HoldingScore {
  totalScore: number;        // 0-67
  holdingRank: "strong" | "healthy" | "weakening" | "deteriorating" | "critical";
  trendQuality: { total: number; maAlignment: number; weeklyTrend: number; trendContinuity: number };
  riskQuality: { total: number; atrStability: number; rangeContraction: number; volumeStability: number };
  sectorMomentumScore: number;
  gate: { passed: boolean; failedGate: "liquidity_dried" | "weekly_breakdown" | null };
  alerts: { type: string; severity: "warning" | "critical"; message: string }[];
}
```

### データ保存（HoldingScoreRecord）

```prisma
model HoldingScoreRecord {
  id           String   @id @default(cuid())
  date         DateTime @db.Date
  positionId   String
  tickerCode   String
  totalScore          Int      // 0-67
  holdingRank         String   // strong/healthy/weakening/deteriorating/critical
  trendQualityScore   Int      // 0-40
  riskQualityScore    Int      // 0-25
  sectorMomentumScore Int      // -3〜+5
  trendQualityBreakdown Json
  riskQualityBreakdown  Json
  gateResult            Json
  alerts                Json?
  currentPrice     Decimal @db.Decimal(10, 2)
  unrealizedPnlPct Decimal @db.Decimal(8, 4)
  holdingDays      Int
  actionTaken      String?  // ts_tightened / null
  @@unique([date, positionId])
}
```

### 実装ファイル

| ファイル | 役割 |
|----------|------|
| `src/core/scoring/holding.ts` | `scoreHolding()` メイン関数 |
| `src/core/scoring/intermediates.ts` | 中間計算ヘルパー（`scoreStock()`と共有） |
| `src/jobs/holding-score.ts` | 保有スコアリングジョブ（market-scannerから呼び出し） |
| `src/lib/constants/scoring.ts` | `HOLDING_SCORE` 定数 |
