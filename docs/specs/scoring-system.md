# スコアリングシステム仕様書

## 概要

正の期待値を実現するための**ロジック配分スコアリングシステム（100点満点）**。

単一指標の評価ではなく、4つのカテゴリの**複合条件（コンフルエンス）**が揃わないと高スコアにならない設計。80点以上の銘柄のみAIレビューに進む。トレンドフォロー戦略に基づき、モメンタム方向のエントリーを重視する。

**設計方針**: 予測力のある指標（テクニカル）に配点を集中し、非予測項目（流動性・ファンダ）は足切り寄りに縮小。相対強度(RS)で同日の銘柄間比較を実現し、null/シグナルなし=0点に統一して偽のBランク到達を防止する。

---

## スコアリング構成（100点満点）

### カテゴリ配分

| カテゴリ | 配点 | 役割 |
|---------|------|------|
| テクニカル指標 | **65点** | トレンドフォローの核 + セクター内相対強度 |
| チャート・ローソク足パターン | **15点** | 形による優位性の確認 |
| 流動性 | **10点** | 物理的に勝てる場所かの足切り |
| ファンダメンタルズ | **10点** | 割高排除の品質フィルタ |

### カテゴリ1: テクニカル指標（65点）

トレンドフォロー戦略の核。モメンタム方向を重視し、トレンドに乗るエントリーを評価する。相対強度(RS)により、同日に全銘柄が似たスコアになるレジーム連動問題を解消。

| サブ項目 | 配点 | データソース | 算出ルール |
|---------|------|-------------|-----------|
| RSI（モメンタム型） | 12点 | `TechnicalSummary.rsi` | 区分線形関数: RSI 50-65=12点（ピーク）、40-50で4→12、65-75で12→4、30-40で0→4、それ以外=0点。null=0点 |
| 移動平均線（MA） | 18点 | `TechnicalSummary.maAlignment` | 7段階: パーフェクトオーダー+方向一致=18、オーダーのみ=14、上昇トレンド=10、中立=6、下降=3、下降+オーダー=1、下降+完全一致=0 |
| 出来高変化（方向性込み） | 13点 | `TechnicalSummary.volumeAnalysis.volumeRatio` + OHLCV | 連続関数: baseScore=clamp(volumeRatio×5, 0, 10)に方向性倍率（accumulation×1.3, neutral×1.0, distribution×0.5）。null=0点 |
| MACD | 7点 | `TechnicalSummary.macd` + 直近2日のヒストグラム | 加速度判定付き: ゴールデンクロス+加速=7、減速=5、シグナル上=3、デッドクロス改善=1、デッドクロス悪化=0。null=0点 |
| 相対強度（RS） | 15点 | `Stock.weekChangeRate` + セクター平均 | セクター内パーセンタイルスコア。後述の「相対強度（RS）」セクション参照 |

### カテゴリ2: チャート・ローソク足パターン（15点）

「形」による優位性の確認。

| サブ項目 | 配点 | データソース | 算出ルール |
|---------|------|-------------|-----------|
| チャートパターン | 10点 | `ChartPatternResult[]` | S=10、A=8、B=6、C=4、D=2、neutral=4（パターン検出なし）。売りパターン検出時は減点 |
| ローソク足パターン | 5点 | `PatternResult` | 買いシグナル: Math.round(strength / 100 * 5)。売りシグナル: Math.round((100-strength) / 100 * 5)。なし=0点 |

### カテゴリ3: 流動性（10点）

取得可能なデータで「物理的に勝てる場所か」を評価する足切り的な役割。

| サブ項目 | 配点 | データソース | 算出ルール |
|---------|------|-------------|-----------|
| 売買代金 | 5点 | `latestPrice × latestVolume` | 5億円以上=5点、3億円以上=4点、1億円以上=3点、5000万以上=1点、未満=0点 |
| 値幅率（スプレッド代替） | 3点 | `(high - low) / close` from OHLCV | 1%以下=3点、2%以下=2点、3%以下=1点、超=0点。データなし=0点 |
| 売買代金安定性 | 2点 | 過去5日の売買代金の変動係数 | CV 0.3以下=2点、0.5以下=1点、超=0点。データ不足=0点 |

### カテゴリ4: ファンダメンタルズ（10点）

「割高すぎる銘柄を買いシグナルだけで買う」ケースを排除するための品質フィルタ。

| サブ項目 | 配点 | データソース | 算出ルール |
|---------|------|-------------|-----------|
| PER | 4点 | `Stock.per` (trailingPE) | 5-15=4点、15-30=3点、0-5=2点、30-50=1点、>50 or <0=0点、null=0点 |
| PBR | 3点 | `Stock.pbr` (priceToBook) | 0.5-1.5=3点、1.5-3.0=2点、<0.5=1点、3.0-5.0=1点、>5.0=0点、null=0点 |
| 収益性 | 2点 | `Stock.eps` (epsTrailingTwelveMonths) | EPS >= 株価×5%=2点、EPS > 0=1点、≤ 0=0点、null=0点 |
| 時価総額 | 1点 | `Stock.marketCap` | ≥ 200億円=1点、< 200億円 or null=0点 |

#### 立花API導入後の移行（流動性カテゴリ）

立花API導入後は流動性カテゴリを以下に置き換え:

| サブ項目 | 配点 | 算出ルール |
|---------|------|-----------|
| オーバー・アンダー比率 | 5点 | 買い板総数が売り板より明確に多い = 5点 |
| スプレッド / 厚み | 5点 | 1ティック差で取引可能、即約定状態 = 5点 |

---

## nullデフォルト値

**全サブ項目でnull/未取得=0点に統一。**

「シグナルなし = 加点理由なし = 0点」の原則を適用。

| サブ項目 | 条件 | スコア |
|---------|------|--------|
| RSI | null | 0点 |
| MACD | null | 0点 |
| 出来高 | null | 0点 |
| ローソク足 | パターンなし | 0点 |
| 値幅率 | データなし | 0点 |
| 安定性 | データ不足 | 0点 |
| PBR | null | 0点 |
| EPS | null | 0点 |
| RS | データ不足 | 0点 |

> RSI/MACD/VolumeがnullになるのはhistoricalDataが極端に不足する場合のみ。実運用でnullが多発する銘柄は即死ルールで既に除外されている可能性が高く、影響範囲は限定的。

---

## 即死ルール（レッドカード）

以下の条件に**1つでも該当**したら、合計点に関わらず**即0点**（棄却）。AIには見せない。

| # | ルール | 判定条件 | データソース |
|---|--------|---------|-------------|
| 1 | スプレッド（値幅）が広すぎる | 当日の `(high - low) / close > 5%` | OHLCVデータ |
| 2 | ボラティリティ異常 | `Stock.volatility > 8%`（週次ボラティリティ） | Stockモデル |
| 3 | 30万円で買えない | `latestPrice > 3000`（100株 = 30万円超） | Stockモデル |
| 4 | 決算発表前後 | 決算日の前5日〜後2日 | `Stock.nextEarningsDate`（yahoo-finance2 quoteSummary API） |
| 5 | 配当落ち日前後 | 配当落ち日の前2日〜後1日 | `Stock.exDividendDate`（yahoo-finance2 quoteSummary API） |

> 即死ルール該当銘柄は、棄却理由をDBに記録する（振り返り用）。

---

## 相対強度（RS）

### 概要

セクター内での相対的な強さを評価する新サブ項目（15点満点）。同日に全銘柄が似たスコアになるレジーム連動問題を解消する。

### 計算方法

既存データを活用し、追加API不要。

**ステップ1: セクター分類**

`Stock.jpxSectorName` と `getSectorGroup()` を使用してセクターグループに分類。

**ステップ2: セクター平均リターンの算出**

セクターグループ別に `weekChangeRate` の平均を算出。

**ステップ3: 個別銘柄のRS値を算出**

```
RS = 銘柄のweekChangeRate - セクター平均weekChangeRate
```

- RS > 0: セクターをアウトパフォーム
- RS < 0: セクターをアンダーパフォーム

**ステップ4: パーセンタイル変換**

その日のスコアリング対象銘柄のRS値を昇順ソートし、各銘柄のパーセンタイル（0-100）を算出。

**ステップ5: スコア化（線形）**

```
rsScore = Math.round(percentile / 100 * 15)
```

- パーセンタイル100（最強）→ 15点
- パーセンタイル50（中央）→ 8点
- パーセンタイル0（最弱）→ 0点

### market-scannerでの2パス処理

RS計算は`scoreTechnicals`の外で行い、算出済みスコアを渡すことで純粋性を維持。

```
Pass 1（既存の並列データ取得）:
  ① 全候補の historicalData, technicals 等を並列取得

Pass 1.5（RSスコア事前計算 — 軽量）:
  ② Stockテーブルから全候補のweekChangeRateを取得
  ③ jpxSectorName + getSectorGroup() でセクター別平均を算出
  ④ 各銘柄のRS値 = weekChangeRate - sectorAvg
  ⑤ RS値をパーセンタイル変換 → rsScore（0-15）

Pass 2（スコアリング）:
  ⑥ 各銘柄に rsScore を付与して scoreTechnicals(input) → スコア
```

### null/欠損データの扱い

| 条件 | RS値 | rsScore |
|------|------|---------|
| `weekChangeRate` が null | RS = 0 | 0点 |
| セクター平均が null | RS = 0 | 0点 |
| セクター内銘柄数 < MIN_SECTOR_STOCKS (2) | RS = 0 | 0点 |
| `rsScore` が未提供（テスト等） | — | 0点 |

### 設計根拠

- **相対評価なのでレジーム非依存**: 暴落日でも上位銘柄は高スコア
- **線形変換で粒度が最大**: 90銘柄なら約90段階のスコア差
- **追加データ不要**: 既存のweekChangeRateで計算可能

### 定数

```typescript
RELATIVE_STRENGTH: {
  MAX_SCORE: 15,
  MIN_SECTOR_STOCKS: 2,
}
```

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

### 定数

```typescript
WEEKLY_TREND: {
  PENALTY: 8,
  MIN_WEEKLY_BARS: 14,
}
```

### 根拠

プロは「大きな時間軸のトレンドに逆らわない」が鉄則。週足が下降トレンドの銘柄を日足の反発で買うと、戻り売りに巻き込まれるリスクが高い。

---

## 連続スコアリング（ステップ関数→線形補間）

粗い離散ステップでの境界ジャンプ（RSI 49=7点、RSI 50=10点等）を解消するため、主要サブ項目に連続関数を導入。

### RSI（12点満点）

ピーク値を持つ区分線形関数。

```
RSI 50-65: 12点（スイートスポット＝トレンド継続ゾーン）
RSI 40-50: 線形 4→12（RSI 40で4点、RSI 50で12点）
RSI 65-75: 線形 12→4（RSI 65で12点、RSI 75で4点）
RSI 30-40: 線形 0→4
RSI <30 or ≥75: 0点
null: 0点
```

### MA（18点満点）

maAlignmentの離散値に依存するため、7段階で粒度を改善。

```
uptrend + orderAligned + slopesAligned: 18点
uptrend + orderAligned:                 14点
uptrend:                                10点
none (neutral):                          6点
downtrend:                               3点
downtrend + orderAligned:                1点
downtrend + orderAligned + slopesAligned: 0点
```

### 出来高×方向性（13点満点）

volumeRatioを連続関数化し、方向性で倍率を掛ける。

```
baseScore = clamp(volumeRatio * 5, 0, 10)

方向性倍率:
  accumulation: ×1.3
  neutral:      ×1.0
  distribution: ×0.5

volumeScore = Math.min(13, Math.round(baseScore * multiplier))
```

スコア例:

| volumeRatio | accumulation | neutral | distribution |
|-------------|-------------|---------|-------------|
| 0.5 | 3 | 3 | 1 |
| 1.0 | 7 | 5 | 3 |
| 1.5 | 10 | 8 | 4 |
| 2.0 | 13 | 10 | 5 |

### MACD（7点満点）

ヒストグラムの加速度を反映した連続スコア。

```
MACDがシグナル上 + ヒストグラム正:
  前回ヒストグラムとの差分で加速度を判定:
    histogram > prevHistogram（加速中）: 7点
    histogram <= prevHistogram（減速中）: 5点

MACDがシグナル上 + ヒストグラム負（縮小中だがまだ上）:
  score = 3

MACDがシグナル下 + ヒストグラム改善中（前回より増加）:
  score = 1（底打ち気配）

デッドクロス（ヒストグラム悪化中）:
  score = 0

null:
  score = 0
```

`prevHistogram`は`historicalData`の直近2日分のMACDヒストグラムを算出して比較。算出には既存の`calculateMACD()`関数を利用。

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

過去90日間で、市場停止日に+1.5%以上上昇した回数（逆行勝ち回数）と勝率に基づく。

| 条件 | ボーナス |
|---|---|
| 4回以上 & 勝率50%以上 | +4点 |
| 3回以上 & 勝率40%以上 | +2点 |
| それ以外 | 0点 |

- ボーナスはテクニカルスコアリング後、ランク判定前に適用
- 合計点は100点を上限とする
- 即死ルール棄却銘柄にはボーナスを適用しない
- AIレビュー時の `riskContext` にも逆行実績を記載

### データソース

- `ScoringRecord.rejectionReason = "market_halted"` + `ghostProfitPct >= 1.5` のレコードを過去90日でバッチ集計
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

この配点では、テクニカル指標が高得点でないと80点を超えない:

- テクニカル満点(65) + パターン良好(10) + 流動性普通(3) + ファンダ良好(6) = **84点** → AI候補
- テクニカル優秀(55) + パターン良好(12) + 流動性最大(10) + ファンダ最大(10) = **87点** → S候補
- テクニカル中程度(40) + パターン最大(15) + 流動性最大(10) + ファンダ最大(10) = **75点** → A止まり（テクニカル不足）

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
  technicalScore    Int   // 0-65
  patternScore      Int   // 0-15
  liquidityScore    Int   // 0-10
  fundamentalScore  Int   @default(0) // 0-10

  // カテゴリ内訳（JSON）
  technicalBreakdown   Json   // { rsi, ma, volume, macd, rs }
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

-- テクニカルスコアが高い銘柄の勝率
SELECT
  CASE WHEN technical_score >= 50 THEN 'high' ELSE 'low' END as tech_level,
  COUNT(*) as total,
  ROUND(100.0 * COUNT(CASE WHEN trade_result = 'win' THEN 1 END) / COUNT(*), 1) as win_rate
FROM "ScoringRecord"
WHERE trade_result IS NOT NULL
GROUP BY tech_level;
```

---

## 実装設計

### 変更対象ファイル

| ファイル | 変更内容 |
|----------|---------|
| `src/core/technical-scorer.ts` | 4カテゴリ方式全面改修 + RS受け入れ + 連続スコアリング + nullデフォルト是正 |
| `src/lib/constants/scoring.ts` | 新配点定数の定義（RS関連追加） |
| `src/core/technical-analysis.ts` | `formatScoreForAI`の最大値表記・RS表示を更新 |
| `src/jobs/market-scanner.ts` | RS計算のため2パス処理に変更 |
| `src/web/routes/scoring.ts` | `breakdownDetail`でtechnicalBreakdownの`rs`フィールドを表示 |

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
  nextEarningsDate?: Date | null;
  exDividendDate?: Date | null;
  rsScore?: number;  // 0-15, callerが事前計算
}

interface LogicScore {
  totalScore: number;          // 0-100
  rank: "S" | "A" | "B" | "C";

  technical: {
    total: number;             // 0-65
    rsi: number;               // 0-12
    ma: number;                // 0-18
    volume: number;            // 0-13
    volumeDirection: "accumulation" | "distribution" | "neutral";
    macd: number;              // 0-7
    rs: number;                // 0-15
  };
  pattern: {
    total: number;             // 0-15
    chart: number;             // 0-10
    candlestick: number;       // 0-5
  };
  liquidity: {
    total: number;             // 0-10
    tradingValue: number;      // 0-5
    spreadProxy: number;       // 0-3
    stability: number;         // 0-2
  };
  fundamental: {
    total: number;             // 0-10
    per: number;               // 0-4
    pbr: number;               // 0-3
    profitability: number;     // 0-2
    marketCap: number;         // 0-1
  };

  isDisqualified: boolean;
  disqualifyReason: string | null;
  topPattern: { name: string; rank: string; winRate: number; signal: string; } | null;
  technicalSignal: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
  weeklyTrendPenalty: number;
}
```

### 定数定義

```typescript
export const SCORING = {
  // カテゴリ配点
  CATEGORY_MAX: {
    TECHNICAL: 65,
    PATTERN: 15,
    LIQUIDITY: 10,
    FUNDAMENTAL: 10,
  },

  // サブ項目配点
  SUB_MAX: {
    // テクニカル (65点)
    RSI: 12,
    MA: 18,
    VOLUME_CHANGE: 13,
    MACD: 7,
    RELATIVE_STRENGTH: 15,
    // パターン (15点)
    CHART_PATTERN: 10,
    CANDLESTICK: 5,
    // 流動性 (10点)
    TRADING_VALUE: 5,
    SPREAD_PROXY: 3,
    STABILITY: 2,
    // ファンダメンタルズ (10点)
    PER: 4,
    PBR: 3,
    PROFITABILITY: 2,
    MARKET_CAP: 1,
  },

  // 閾値
  THRESHOLDS: {
    S_RANK: 80,
    A_RANK: 65,
    B_RANK: 50,
  },

  // 即死ルール
  DISQUALIFY: {
    MAX_PRICE: 3000,
    MAX_DAILY_SPREAD_PCT: 0.05,
    MAX_WEEKLY_VOLATILITY: 8,
    EARNINGS_DAYS_BEFORE: 5,
    EARNINGS_DAYS_AFTER: 2,
    EX_DIVIDEND_DAYS_BEFORE: 2,
    EX_DIVIDEND_DAYS_AFTER: 1,
  },

  // 週足トレンド
  WEEKLY_TREND: {
    PENALTY: 8,
    MIN_WEEKLY_BARS: 14,
  },

  // 相対強度
  RELATIVE_STRENGTH: {
    MAX_SCORE: 15,
    MIN_SECTOR_STOCKS: 2,
  },

  // 流動性閾値
  LIQUIDITY: {
    TRADING_VALUE_TIERS: [500_000_000, 300_000_000, 100_000_000, 50_000_000],
    SPREAD_PROXY_TIERS: [0.01, 0.02, 0.03, 0.05],
    STABILITY_CV_TIERS: [0.3, 0.5, 0.7],
  },

  // ファンダメンタルズ閾値
  FUNDAMENTAL: {
    PER_TIERS: [
      { min: 5, max: 15, score: 4 },
      { min: 15, max: 30, score: 3 },
      { min: 0, max: 5, score: 2 },
      { min: 30, max: 50, score: 1 },
    ],
    PER_DEFAULT: 0,
    PBR_TIERS: [
      { min: 0.5, max: 1.5, score: 3 },
      { min: 1.5, max: 3.0, score: 2 },
      { min: 0, max: 0.5, score: 1 },
      { min: 3.0, max: 5.0, score: 1 },
    ],
    PBR_DEFAULT: 0,
    PBR_OVER_5: 0,
    EPS_STRONG_RATIO: 0.05,
    EPS_POSITIVE: 1,
    EPS_NEGATIVE: 0,
    EPS_NULL: 0,
    MARKET_CAP_TIERS: [
      { min: 200_000_000_000, score: 1 },
    ],
    MARKET_CAP_DEFAULT: 0,
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

  MAX_CANDIDATES_FOR_AI: 20,
  MIN_CANDIDATES_FOR_AI: 5,
} as const;
```

### 処理フロー（market-scanner 内）

```
全銘柄（~90銘柄）
  ↓
Pass 1: データ取得（並列）
  ↓
Pass 1.5: RS値の事前計算（全候補のweekChangeRateからセクター内パーセンタイル）
  ↓
即死ルールチェック
  → 該当: score=0, isDisqualified=true, DBに棄却理由記録
  → 非該当: スコアリングへ
  ↓
4カテゴリスコアリング（rsScoreを含む）
  → テクニカル(65) + パターン(15) + 流動性(10) + ファンダメンタルズ(10) = 総合スコア
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
| 1 最優先 | ニュース・カタリスト | 悪材料 → スコア無関係にNo-Go。好材料の織り込み済み度を判断。ニュース情報なし → riskFlagsに「ニュース未確認」追加 |
| 2 | 地政学・マクロリスク | センチメントとの整合性、地政学イベントの影響 |
| 3 | セクター全体の流れ | 同セクターの資金フローと逆行していないか |
| 4 | チャートの綺麗さ | ダマシの可能性、出来高の裏付け |

**設計根拠**: テクニカルスコアリング（100点満点）は純テクニカルで完結させ、ニュース等の定性判断はAIレビューに集約する。これにより、スコアのバックテスト可能性を維持しつつ、ニュースリスクをAI層で確実にフィルタリングする。

### AIへの提示フォーマット

```
【総合スコア】85/100（Sランク）

【カテゴリ別】
  テクニカル: 55/65
    RSI: 12/12（RSI=55、トレンド継続ゾーン）
    移動平均: 18/18（パーフェクトオーダー成立）
    出来高変化: 10/13（1.8倍 / 買い集め）
    MACD: 5/7（ゴールデンクロス+減速）
    相対強度: 10/15
  パターン: 14/15
    チャートパターン: 10/10（逆三尊 / Sランク / 勝率89%）
    ローソク足: 4/5（大陽線）
  流動性: 8/10
    売買代金: 5/5（5.2億円）
    値幅率: 2/3（1.8%）
    安定性: 1/2（CV=0.35）
  ファンダメンタルズ: 8/10
    PER: 4/4
    PBR: 2/3
    収益性: 1/2
    時価総額: 1/1

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
7. 前日レコードに翌日価格を記録（`nextDayClosingPrice` / `nextDayProfitPct`）
8. 意思決定整合性評価（後述）
9. 逆行ウィナー分析（市場停止日のみ）

### 意思決定整合性評価

当日のスコアリング全体像と各判断の結果を集約し、AIでverdictを生成して `TradingDailySummary.decisionAudit` に保存する。

#### decisionAudit の構造

| フィールド | 内容 |
|-----------|------|
| `scoringSummary.totalScored` | 当日の総スコアリング銘柄数 |
| `scoringSummary.aiApproved` | AI承認（go）銘柄数 |
| `scoringSummary.rankBreakdown` | ランク別内訳（例: `{S: 2, A: 120, B: 130, C: 30}`） |
| `marketHalt` | 市場停止判断の詳細（停止時のみ。見送り銘柄のうち上昇した割合等） |
| `aiRejection` | AI却下（no_go）の精度（正確な却下 / 誤却下 / 精度%） |
| `scoreThreshold` | 閾値未達で却下された銘柄の上昇件数・平均利益率 |
| `overallVerdict` | AIが生成した200文字以内の意思決定評価 |

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

## スコアリング精度レポート（scoring-accuracy-report ジョブ / 土曜 11:00 JST）

ゴースト実績データをもとに、スコアリングシステムの弱点を定量的に集計・Slack通知するレポート。AI呼び出し不要の純粋な統計集計。

### レポート内容

| セクション | 内容 |
|-----------|------|
| カテゴリ別弱点 | 見逃し銘柄（却下 + ghostProfitPct >= 1%）のカテゴリ別欠損を平均集計 |
| ランク別実績 | S/A/B/Cランクごとの平均利益率・上昇率・件数 |
| rejectionReason別機会損失 | 各却下理由ごとの件数・上昇件数・平均利益率 |
| 週次/月次トレンド | 今週（7日）vs 30日ローリングの上昇率・平均利益率 |

### 定数

```typescript
export const SCORING_ACCURACY_REPORT = {
  WEEKLY_LOOKBACK_DAYS: 7,
  MONTHLY_LOOKBACK_DAYS: 30,
  MISSED_PROFIT_THRESHOLD: 1.0,  // 見逃し判定の最低利益率(%)
  MAX_MISSED_DISPLAY: 5,
};
```

### 実装ファイル

- `src/jobs/scoring-accuracy-report.ts`
- `.github/workflows/scoring-accuracy-report.yml`

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
日経平均キルスイッチ（前日比 <= -3% で全取引停止・全決済）
  ↓
セクターモメンタムフィルタ（弱セクター除外） ← ここ
  ↓
AIレビュー（Go/No-Go）
```

### 日経平均キルスイッチ

VIXは米国市場の指標であり、日本株の急落をリアルタイムに反映しきれない。日経平均の前日比が -3% 以下の場合、VIXレジームに関わらず **Crisisモード（全取引停止+全ポジション即時決済）** に移行する。

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

- **オーバー・アンダー比率（5点）**: 買い板の総数が売り板より明確に多いか
- **スプレッド / 厚み（5点）**: 1ティック差で取引可能、即約定状態か

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
