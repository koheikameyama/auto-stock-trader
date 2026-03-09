# トレーディングアーキテクチャ改善仕様

## 概要

**「ロジックが主役、AIが最終審判」**へアーキテクチャを移行する。

現状はスクリーニング（DB条件フィルタ）→ AI銘柄選定 → AI売買判断という流れで、銘柄選定と売買判断をAIに大きく依存している。これを、ロジック（テクニカル分析・パターン検出）でスコアリング・絞り込みを行い、AIは最終的な Go/No-Go 判断のみに集中させる構成に変更する。

### 設計思想

- **攻め（銘柄選定）**: ロジックで機械的に絞り込み、AIが最終承認
- **守り（リスク管理）**: ロジックで冷徹に実行、AIの判断を上書き可能

### 3段フィルターパイプライン

AIに「計算」させず「解釈」に集中させるため、3段のフィルターを通す。

```
┌─────────────────────────────────────────────────────┐
│ 第1フィルター: 数値ロジック（高速スクリーニング）      │
│ ─ テクニカル指標のスコアリング（CPU処理）             │
│ ─ RSI, MACD, BB, チャートパターン等を数式で評価       │
│ ─ 全銘柄 → 10〜20銘柄に絞り込み                      │
│ ─ AIには無駄な銘柄を見せない                          │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ 第2フィルター: 板情報ロジック（約定可能性）※将来実装  │
│ ─ 板（BOARD）の厚みを確認（API処理）                 │
│ ─ 「100株買っただけで価格が跳ね上がらないか？」       │
│ ─ 買い/売り比率（オーバー・アンダー）が良好か確認     │
│ ─ 「買いたいけど買えない」事故を防止                  │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ 第3フィルター: AI判断（最終承認）                     │
│ ─ ロジックのスコア + マクロ指標をAIに提示（AI処理）   │
│ ─ AIには「計算」ではなく「解釈」をさせる              │
│ ─ 地政学リスク・センチメント等の定性的判断のみ         │
│ ─ Go/No-Go の最終判断                               │
└─────────────────────────────────────────────────────┘
```

各フィルターの役割が明確に分離されていることで、「なぜその判断をしたか」が追跡可能になる。ロジックが選んだ理由（数字）と、AIが承認した理由（空気感）がセットで記録される。

### 目標

- 勝率 70% 以上を維持
- AIトークン消費の削減（候補数を10〜20銘柄に絞ってからAIに渡す）
- AIの計算ミス・幻覚リスクの排除（数値計算はすべてロジック側で実行）

---

## 現状と課題

### 現在のフロー

```
DB条件フィルタ（価格・出来高・時価総額）
  ↓ 約90銘柄がそのまま通過
テクニカル分析（全候補に対して実行）
  ↓ 結果をテキスト形式でAIに渡す
AI銘柄選定（selectStocks）
  ↓ AIがスコアリング（score >= 50）
AI売買判断（decideTrade）
  ↓ AIが指値・利確・損切を決定
注文生成
```

### 課題

| # | 課題 | 影響 |
|---|------|------|
| 1 | スクリーニングがDB条件（3条件）だけで、テクニカル的に弱い銘柄もAIに渡される | AIトークン浪費、ノイズ増加 |
| 2 | テクニカル分析結果がテキスト形式でAIに渡される | AIが数値を再解釈する必要あり、誤解リスク |
| 3 | 銘柄選定をAIに丸投げ | ロジックで判断できる部分もAIに依存 |
| 4 | 損切り価格がAI判断依存 | AIが楽観的な判断をするリスク |
| 5 | AIへの指示が「分析して選んでください」型 | AIの役割が曖昧 |

---

## 改善後のフロー

```
第0関門: DB条件フィルタ（既存）
  ↓ 約90銘柄
第1関門: テクニカルスコアリング（新規）  ← ロジック
  ↓ 上位10〜20銘柄に絞り込み
第2関門: AI最終審判（変更）             ← AI
  ↓ Go/No-Go + 戦略タイプ
売買判断: ロジック主導 + AI補助（変更）
  ↓ 指値・利確・損切はロジック算出、AIはレビュー
注文生成
```

---

## Phase 1: テクニカルスコアリングエンジン

### 目的

テクニカル分析の結果を統一スコア（0〜100）に変換し、ロジックだけで銘柄の優先順位を決定できるようにする。

### 新規ファイル

`src/core/technical-scorer.ts`

### スコアリングロジック

各テクニカル指標にウェイトを割り当て、加重平均でトータルスコアを算出する。

#### 買いスコアの構成

| カテゴリ | 指標 | ウェイト | スコア算出ルール |
|----------|------|---------|----------------|
| トレンド | 移動平均線の並び | 20% | パーフェクトオーダー（5>25>75）= 100、逆 = 0、それ以外 = 50 |
| モメンタム | RSI | 15% | 30-40 = 100（反発ゾーン）、40-50 = 70、50-60 = 50、<30 = 30（売られすぎ）、>70 = 0 |
| モメンタム | MACD | 10% | シグナル上抜け = 100、ヒストグラム正 = 70、負 = 30、シグナル下抜け = 0 |
| ボラティリティ | ボリンジャーバンド位置 | 10% | 下限タッチ = 100、下限〜中央 = 70、中央〜上限 = 40、上限超え = 20 |
| チャートパターン | 検出パターンの最高ランク | 20% | Sランク = 100、Aランク = 85、Bランク = 70、Cランク = 55、Dランク = 40、なし = 0 |
| ローソク足 | 直近のパターン強度 | 10% | そのまま強度値（0-100）を使用 |
| 出来高 | 出来高比率 | 10% | 平均比 2倍以上 = 100、1.5倍 = 80、1.0倍 = 50、0.5倍以下 = 20 |
| サポート | サポートラインとの距離 | 5% | サポート付近（1%以内）= 100、2%以内 = 70、5%以内 = 50、遠い = 20 |

#### スコアの閾値

| スコア | 判定 | アクション |
|--------|------|-----------|
| 80〜100 | S（最有力） | AIに優先的に提示 |
| 65〜79 | A（有力） | AIに提示 |
| 50〜64 | B（候補） | 候補が少ない場合のみAIに提示 |
| 0〜49 | C（見送り） | AIに渡さない |

#### 出力インターフェース

```typescript
interface TechnicalScore {
  totalScore: number;          // 0-100 の総合スコア
  rank: "S" | "A" | "B" | "C";
  breakdown: {
    trend: number;             // 移動平均線スコア
    rsiMomentum: number;       // RSIスコア
    macdMomentum: number;      // MACDスコア
    bollingerPosition: number; // ボリンジャーバンド位置スコア
    chartPattern: number;      // チャートパターンスコア
    candlestick: number;       // ローソク足スコア
    volume: number;            // 出来高スコア
    support: number;           // サポートライン距離スコア
  };
  topPattern: {
    name: string;              // 例: "逆三尊"
    rank: string;              // 例: "S"
    winRate: number;           // 例: 89
    signal: string;            // "buy" | "sell" | "neutral"
  } | null;
  technicalSignal: string;     // "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell"
}
```

### 定数定義

`src/lib/constants/scoring.ts` に以下を定義:

```typescript
export const SCORING = {
  WEIGHTS: {
    TREND: 0.20,
    RSI_MOMENTUM: 0.15,
    MACD_MOMENTUM: 0.10,
    BOLLINGER_POSITION: 0.10,
    CHART_PATTERN: 0.20,
    CANDLESTICK: 0.10,
    VOLUME: 0.10,
    SUPPORT: 0.05,
  },
  THRESHOLDS: {
    S_RANK: 80,
    A_RANK: 65,
    B_RANK: 50,
  },
  // AIに渡す最大候補数
  MAX_CANDIDATES_FOR_AI: 20,
  // 最低候補数（B_RANKまで広げるトリガー）
  MIN_CANDIDATES_FOR_AI: 5,
} as const;
```

---

## Phase 2: market-scanner のフロー変更

### 変更箇所

`src/jobs/market-scanner.ts`

### 変更後フロー

```
1. 市場指標取得（既存）
2. ニュース分析取得（既存）
3. AI市場評価 assessMarket()（既存）
   → shouldTrade = false → 保存して終了
4. DB条件フィルタ（既存）
   → 約90銘柄
5. テクニカル分析（既存、並列実行）
   → 全候補の TechnicalSummary を取得
6. ★新規: テクニカルスコアリング
   → scoreTechnicals(summary) で各銘柄に 0-100 スコア付与
   → スコア降順でソート
   → S・Aランク（+ 候補不足時はBランク）を抽出 → 上位10〜20銘柄
7. ★変更: AI銘柄選定（レビュー型に変更）
   → ロジックが選んだ銘柄リスト + スコア内訳をAIに提示
   → AIは Go/No-Go のみ判断
8. 結果保存 + Slack通知（既存）
```

### Slack通知の変更

候補銘柄の通知にテクニカルスコアを追加:

```
📊 市場スキャン結果
市場評価: 🟢 Bullish

候補銘柄:
1. 7203 トヨタ [S: 85点] 逆三尊(89%) / RSI:35
2. 6758 ソニー [A: 72点] ダブルボトム(88%) / MACD上抜け
3. 8306 三菱UFJ [A: 68点] 上昇トライアングル(83%) / 出来高2.1倍
```

---

## Phase 3: AIプロンプトの「レビュー型」への変更

### 変更箇所

`src/prompts/stock-selection.ts`

### 変更の方針

AIの役割を「分析官」から「ベテラン投資家（上司）」に変更する。

#### Before（現状）

```
あなたは経験豊富な日本株トレーダーです。
以下の候補銘柄からトレードに適した銘柄を選定してください。
[テクニカル指標のテキスト一覧]
```

#### After（変更後）

```
あなたはベテラン投資家です。
ロジック（テクニカル分析エンジン）が以下の銘柄を推薦しました。
各銘柄にはスコアとその内訳が付いています。
あなたの役割は、ロジックが見落としがちな「定性的リスク」を判断し、
各銘柄を承認（Go）または見送り（No-Go）してください。

判断基準:
- 地政学リスクとの関連
- 市場の空気感（センチメント）
- チャートパターンの「綺麗さ」（ダマシの可能性）
- セクター全体の流れとの整合性
- ニュースカタリストの信頼性

重要: ロジックのスコアが高い銘柄を却下する場合は、
明確な定性的理由を述べてください。
数値的な判断（RSIが高い等）はロジックが既に行っています。
```

### AI出力スキーマの変更

```typescript
// Before
interface StockSelectionResult {
  tickerCode: string;
  strategy: "day_trade" | "swing";
  score: number;        // AIがスコアリング
  reasoning: string;
}

// After
interface StockReviewResult {
  tickerCode: string;
  decision: "go" | "no_go";
  strategy: "day_trade" | "swing";
  reasoning: string;    // 定性的な判断理由のみ
  riskFlags: string[];  // ["地政学リスク", "セクター逆風"] 等
}
```

### AIに渡す情報の変更

`formatTechnicalForAI()` をスコア形式に変更する。

#### Before（テキスト形式）

```
【価格】現在値: 3,515円（前日比 +1.2%）
【RSI】52.3（中立圏）
【移動平均線】SMA5: 3,480 / SMA25: 3,420 / SMA75: 3,350（上昇トレンド）
【MACD】+15.2（シグナル上抜け）
...
```

#### After（スコア形式）

```
【総合スコア】85/100（Sランク）
【スコア内訳】
  トレンド: 100/100（パーフェクトオーダー成立）
  RSIモメンタム: 90/100（RSI=35、反発ゾーン）
  MACDモメンタム: 100/100（シグナル上抜け）
  ボリンジャー位置: 80/100（下限タッチ）
  チャートパターン: 95/100（逆三尊 / Sランク / 勝率89%）
  ローソク足: 75/100（大陽線）
  出来高: 80/100（平均比1.8倍）
  サポート距離: 70/100（サポートまで1.5%）
【検出パターン】逆三尊（完成度: 高 / ブレイクアウト: 済）
【ロジック判定】strong_buy
```

---

## Phase 4: 損切りのロジック強制化

### 変更箇所

- `src/core/risk-manager.ts`（新規関数追加）
- `src/jobs/order-manager.ts`（損切り検証ロジック追加）

### 設計

AIが決定した `stopLossPrice` をロジック側で検証し、必要に応じて上書きする。

#### 検証ルール

```typescript
interface StopLossValidation {
  originalPrice: number;   // AIが決定した損切り価格
  validatedPrice: number;  // ロジックが検証後の損切り価格
  wasOverridden: boolean;  // 上書きされたか
  reason: string;          // 上書き理由
}
```

| ルール | 条件 | アクション |
|--------|------|-----------|
| 最大損失制限 | 損切り幅 > エントリー価格の 3% | 3%に強制設定 |
| ATRベース最低損切り | 損切り幅 < ATR × 0.5 | ATR × 1.0 に引き上げ（近すぎる損切りを防止） |
| ATRベース最大損切り | 損切り幅 > ATR × 2.0 | ATR × 1.5 に引き下げ |
| サポートライン考慮 | サポートラインが存在 | サポートライン - ATR × 0.3 に設定 |

#### 損切り強制実行

`position-monitor.ts` での損切り判定はAIを介さず、ロジックだけで実行する（現状もそうなっているが、明示的にルール化）。

```
損切り判定:
  安値 <= stopLossPrice → 強制決済（AIの「まだ大丈夫」は無視）
```

### 定数定義

`src/lib/constants/scoring.ts` に追加:

```typescript
export const STOP_LOSS = {
  MAX_LOSS_PCT: 0.03,           // 最大損失率 3%
  ATR_MIN_MULTIPLIER: 0.5,     // ATR最小倍率
  ATR_MAX_MULTIPLIER: 2.0,     // ATR最大倍率
  ATR_DEFAULT_MULTIPLIER: 1.0, // ATRデフォルト倍率
  ATR_ADJUSTED_MULTIPLIER: 1.5,// ATR調整後倍率
  SUPPORT_BUFFER_ATR: 0.3,     // サポートラインバッファ（ATR倍率）
} as const;
```

---

## Phase 5: trade-decision プロンプトの変更

### 変更箇所

`src/prompts/trade-decision.ts`

### 変更の方針

AIの役割を「指値・損切りを決定する」から「ロジックが算出したエントリー条件をレビューする」に変更する。

#### ロジック側で算出する項目（新規）

`src/core/entry-calculator.ts` を新規作成:

```typescript
interface EntryCondition {
  limitPrice: number;        // 指値 = サポートライン or BB下限の近い方
  takeProfitPrice: number;   // 利確 = レジスタンスライン or ATR×1.5
  stopLossPrice: number;     // 損切り = ATR×1.0（Phase 4の検証済み）
  quantity: number;           // 数量 = リスク管理ルールに基づく
  riskRewardRatio: number;   // リスクリワード比
  strategy: "day_trade" | "swing";
}
```

#### AIの新しい役割

```
ロジックが以下のエントリー条件を算出しました:

銘柄: 前田工繊（7821）
テクニカルスコア: 85/100（Sランク）
指値: 2,190円（サポートライン付近）
利確: 2,280円（+4.1%, レジスタンスライン）
損切: 2,150円（-1.8%, ATR×1.0）
リスクリワード比: 1:2.3
数量: 100株

ニュースコンテキスト:
- 今夜は米雇用統計の発表があります
- セクター: 建設、直近は横ばい

このトレードを承認しますか？
承認する場合は "approve"、条件付き承認は "approve_with_modification"、
見送りは "reject" でお答えください。
```

#### AI出力スキーマの変更

```typescript
// Before
interface TradeDecisionResult {
  action: "buy" | "skip";
  limitPrice: number | null;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  quantity: number;
  strategy: "day_trade" | "swing";
  reasoning: string;
}

// After
interface TradeReviewResult {
  decision: "approve" | "approve_with_modification" | "reject";
  reasoning: string;
  modification: {
    adjustLimitPrice: number | null;     // null = ロジックのまま
    adjustTakeProfitPrice: number | null;
    adjustStopLossPrice: number | null;  // ※ Phase 4 の検証で再チェック
    adjustQuantity: number | null;
  } | null;
  riskFlags: string[];
}
```

**重要**: AIが `adjustStopLossPrice` を変更した場合でも、Phase 4 の損切り検証ルールで再チェックする。ロジックの損切りルールはAIより優先。

---

## 実装順序と依存関係

```
Phase 1: テクニカルスコアリングエンジン
  └─ 新規ファイル作成のみ、既存に影響なし
  └─ src/core/technical-scorer.ts
  └─ src/lib/constants/scoring.ts

Phase 2: market-scanner のフロー変更
  └─ Phase 1 に依存
  └─ src/jobs/market-scanner.ts の変更

Phase 3: AIプロンプトの「レビュー型」への変更
  └─ Phase 1 に依存
  └─ src/prompts/stock-selection.ts の変更
  └─ src/core/ai-decision.ts の selectStocks() 変更

Phase 4: 損切りのロジック強制化
  └─ 独立して実装可能
  └─ src/core/risk-manager.ts に関数追加
  └─ src/lib/constants/scoring.ts に定数追加
  └─ src/jobs/order-manager.ts の変更

Phase 5: trade-decision プロンプトの変更
  └─ Phase 1, 4 に依存
  └─ src/core/entry-calculator.ts 新規作成
  └─ src/prompts/trade-decision.ts の変更
  └─ src/core/ai-decision.ts の decideTrade() 変更
  └─ src/jobs/order-manager.ts の変更
```

---

## 変更対象ファイル一覧

### 新規作成

| ファイル | 内容 |
|----------|------|
| `src/core/technical-scorer.ts` | テクニカルスコアリングエンジン |
| `src/core/entry-calculator.ts` | エントリー条件算出（指値・利確・損切り） |
| `src/lib/constants/scoring.ts` | スコアリング・損切り検証の定数 |

### 変更

| ファイル | 変更内容 |
|----------|---------|
| `src/jobs/market-scanner.ts` | スコアリング→絞り込み→AIレビューのフロー変更 |
| `src/jobs/order-manager.ts` | エントリー条件算出→AIレビュー→損切り検証のフロー変更 |
| `src/core/ai-decision.ts` | `selectStocks()` → `reviewStocks()`、`decideTrade()` → `reviewTrade()` に変更 |
| `src/prompts/stock-selection.ts` | レビュー型プロンプト + 新スキーマ |
| `src/prompts/trade-decision.ts` | レビュー型プロンプト + 新スキーマ |
| `src/core/risk-manager.ts` | `validateStopLoss()` 関数追加 |
| `src/core/technical-analysis.ts` | `formatScoreForAI()` 関数追加 |

### 変更なし

| ファイル | 理由 |
|----------|------|
| `src/lib/technical-indicators.ts` | 計算ロジック自体は変更不要 |
| `src/lib/candlestick-patterns.ts` | パターン検出は変更不要（スコアはscorer側で変換） |
| `src/lib/chart-patterns.ts` | パターン検出は変更不要（スコアはscorer側で変換） |
| `src/core/order-executor.ts` | 約定ロジックは変更不要 |
| `src/core/position-manager.ts` | `closePosition()` で realizedPnl を totalBudget に加算（複利運用） |
| `src/prompts/market-assessment.ts` | 市場評価のAI判断は現状のまま（ここはAIの仕事） |

---

## 将来のフェーズ（本仕様のスコープ外）

### 板情報フィルター（第2フィルター）

立花証券API等から板データを取得し、第1フィルターを通過した銘柄の「物理的な約定可能性」をロジックで判定する。

#### 目的

テクニカル的に有望でも、板が薄ければ「買いたいけど買えない（または高く買わされる）」事故が起きる。板情報を第2フィルターとして追加することで、実戦での約定リスクを排除する。

#### 実装場所

`src/core/market-data.ts` への追加

#### 判定ロジック

| チェック項目 | 判定基準 | 不合格時のアクション |
|-------------|---------|-------------------|
| 最良気配の厚み | 自分の注文数量に対して十分な板厚があるか | 候補から除外 |
| スプレッド | 買い気配と売り気配の差が許容範囲内か | 候補から除外 |
| 買い/売り比率 | オーバー（売り超過）が極端でないか | リスクフラグ付与 |
| 板の変動性 | 板が急激に薄くなっていないか | リスクフラグ付与 |

#### インターフェース

```typescript
interface OrderBookScore {
  buyPressure: number;      // 買い板の厚さ（株数）
  sellPressure: number;     // 売り板の厚さ（株数）
  ratio: number;            // 買い/売り比率
  spread: number;           // スプレッド（円）
  spreadPct: number;        // スプレッド率（%）
  isLiquid: boolean;        // 約定可能と判断されたか
  score: number;            // 0-100
  riskFlags: string[];      // ["板薄", "スプレッド大"] 等
}
```

#### パイプラインへの組み込み

```typescript
async function marketScanner() {
  // 1. ロジックで全銘柄スキャン（CPU処理）
  const logicalCandidates = await scanByLogic(allTickers);

  // 2. 板情報で約定可能性チェック（API処理）※将来実装
  const liquidityCandidates = await checkLiquidity(logicalCandidates);

  // 3. AIに最終確認（AI処理）
  for (const candidate of liquidityCandidates) {
    const decision = await ai.askFinalApproval(candidate, marketContext);
    if (decision.isApproved) {
      await orderManager.createOrder(candidate);
    }
  }
}
```

#### 前提条件

- 立花証券API（またはそれに相当する板データ提供API）の利用開始
- リアルタイム板データの取得環境の構築

### スコアリングシステム改善

8カテゴリ加重方式から3大カテゴリ（テクニカル40点・パターン30点・流動性30点）への再構成、即死ルール、スコアデータのDB保存。

詳細は [scoring-system.md](scoring-system.md) を参照。

### バックテスト機能

スコアリングエンジンの精度を過去データで検証する機能。ウェイトの最適化に使用。

---

## リスク管理: マーケットレジーム

### VIXベース機械的レジーム判定

VIX水準に応じてAI判断の前段で取引制限を自動適用する。AIは暴落局面で楽観的な判断をするリスクがあるため、VIX > 30 ではAI判断を待たず機械的に取引停止する。

| VIX | レジーム | 最大ポジション | 最低ランク | 動作 |
|-----|---------|--------------|-----------|------|
| < 20 | normal | 3（制限なし） | B | 通常取引 |
| 20-25 | elevated | 2 | A | S/Aランクのみ |
| 25-30 | high | 1 | S | Sランクのみ |
| > 30 | crisis | 0 | - | 取引停止（AI不要） |

### 実装ファイル

- `src/core/market-regime.ts`: `determineMarketRegime(vix)`
- `src/lib/constants/trading.ts`: `VIX_THRESHOLDS`, `MARKET_REGIME`

### market-scannerフロー内の位置

```
市場データ取得（VIX含む）
  ↓
★ VIXレジーム判定（機械的）
  └─ crisis → 即停止、MarketAssessment保存して終了
  ↓
★ ドローダウンチェック（機械的）
  └─ 停止条件該当 → 即停止
  ↓
AI市場評価（shouldTrade判定）
  ↓
テクニカル分析 + スコアリング
```

---

## リスク管理: ドローダウン管理

### 週次・月次ドローダウン上限

TradingDailySummaryの確定損益を集計し、週次・月次の累積損失が閾値を超えた場合に取引停止する。

| 期間 | 停止閾値 | 計算方法 |
|------|---------|---------|
| 週次 | 5% | 今週月曜以降のTradingDailySummary.totalPnlを合算 |
| 月次 | 10% | 今月1日以降のTradingDailySummary.totalPnlを合算 |

### 連敗クールダウン

直近のクローズ済みポジションのrealizedPnlから連敗数を動的計算する。

| 連敗数 | アクション |
|--------|-----------|
| 0-2 | 制限なし |
| 3-4 | 最大1ポジションに制限（クールダウン） |
| 5+ | 取引停止 |

**解除条件**: 連敗カウントは動的計算のため、次のトレードで勝てば自動リセット。週次/月次は期間経過で自動リセット。

### ピークエクイティ（ハイウォーターマーク）

`TradingConfig.peakEquity` に資産の最高値を記録。end-of-dayで現在の資産が過去最高を超えていれば更新。

### 実装ファイル

- `src/core/drawdown-manager.ts`: `calculateDrawdownStatus()`, `updatePeakEquity()`
- `src/lib/constants/trading.ts`: `DRAWDOWN`

---

## リスク管理: セクター集中制限

### 同一セクター保有制限

同一セクターグループ（SECTOR_MASTERの11グループ）に最大1ポジションまで。3ポジション中2ポジションが同セクターだと、セクター固有リスク（業界ニュース等）で同時に損失を被るリスクが高い。

### チェックポイント

`canOpenPosition()` 内でセクター集中チェックを実行。新規銘柄のセクターグループが既存オープンポジションと重複する場合は不許可。

### 実装ファイル

- `src/core/sector-analyzer.ts`: `canAddToSector()`
- `src/lib/constants/trading.ts`: `SECTOR_RISK.MAX_SAME_SECTOR_POSITIONS`

---

## 資金管理: 複利運用

### 概要

ポジション決済時に確定損益（realizedPnl）を `TradingConfig.totalBudget` に自動加算する。利益も損失もtotalBudgetに反映され、複利で資金が成長する。

### 仕組み

```
ポジションクローズ
  ↓
realizedPnl = (exitPrice - entryPrice) × quantity
  ↓
totalBudget += realizedPnl（利益なら増加、損失なら減少）
  ↓
次回トレードはこの新しいtotalBudgetを基準に資金管理
```

### リスク抑制（既存の仕組みで対応済み）

- 日次損失上限 3%: 1日の損失がtotalBudgetの3%に達したら新規トレード停止
- 損切り 2%: ポジション単位のリスク制限
- 最大3ポジション: 集中投資の抑制

### 実装箇所

- `src/core/position-manager.ts` の `closePosition()` 内トランザクション

---

## トレーリングストップ

### 概要

保有中の最高値更新に応じて損切りラインを動的に引き上げる機能。固定利確（+3%）では大きな上昇を取り逃がす問題を解決する。

**設計思想**: 「利益を伸ばし、損失を限定する」— トレーリングストップが発動したら固定TP/SLを両方置き換え、上値を追う。

### 仕組み

```
1. エントリー後、価格が一定以上上昇（ATR × activationMultiplier）
   → トレーリングストップが発動

2. 発動後:
   - trailingStopPrice = maxHighDuringHold - ATR × trailMultiplier
   - ストップは上方向にのみ移動（ラチェット）
   - 固定TP/SLは無効化 → 上値を追い続ける

3. 価格がトレーリングストップ以下に下落
   → 「トレーリング利確」として決済
```

### パラメータ

| パラメータ | デイトレ | スイング | 説明 |
|-----------|---------|---------|------|
| アクティベーション閾値 | ATR × 0.5 | ATR × 0.75 | エントリー価格からの上昇幅 |
| トレール幅 | ATR × 1.0 | ATR × 1.5 | 最高値からの距離 |
| フォールバック発動% | 1.0% | 1.5% | ATR不明時 |
| フォールバックトレール% | 1.5% | 2.5% | ATR不明時 |

### TP/SLとの関係

| 状態 | Stop Loss | Take Profit | 動作 |
|------|-----------|-------------|------|
| **未発動** | 固定SL | 固定TP | 従来と同じ |
| **発動後** | トレーリングストップ | なし（無効化） | 上値を追う |

### 実装ファイル

| ファイル | 内容 |
|----------|------|
| `src/core/trailing-stop.ts` | トレーリングストップ算出ロジック |
| `src/lib/constants/jobs.ts` | `TRAILING_STOP` 定数 |
| `src/jobs/position-monitor.ts` | モニタリングループへの統合 |
| `src/core/position-manager.ts` | `entryAtr` パラメータ追加 |

### データモデル

`TradingPosition` に追加:

| カラム | 型 | 説明 |
|--------|-----|------|
| `trailingStopPrice` | Decimal? | 現在のトレーリングストップ価格（null = 未発動） |
| `entryAtr` | Decimal? | エントリー時のATR(14) |

---

## ディフェンシブモード

### 概要

市場評価がbearish/crisisの場合、既存ポジションに対して防衛的な決済を行う。通常の防衛機能（VIXレジーム、ドローダウン管理等）は新規ポジションの参入を止めるだけだが、ディフェンシブモードは既存ポジションにも市場環境の悪化を反映する。

**設計思想**: 「不確実な状況ではキャッシュが最強のポジション」

### 動作

| センチメント | 含み益ポジション | 含み損ポジション |
|-------------|----------------|----------------|
| bullish/neutral | 通常TP/SL監視 | 通常TP/SL監視 |
| bearish | 微益撤退（市場価格で決済） | 通常SL監視を継続 |
| crisis | 全決済（市場価格で決済） | 全決済（市場価格で決済） |

### パラメータ

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| MIN_PROFIT_PCT_FOR_RETREAT | 0.3% | bearish時に微益撤退する最小利益率 |

### bearish時の判断根拠

- 含み益+1%のポジションをbearish市場で保持する期待値:
  - 上昇確率40% × +1% = +0.4%
  - 下落確率60% × -2%(SL) = -1.2%
  - 期待値 = -0.8%（マイナス）
- 微益撤退（+1%確定）の方が期待値は高い

### bearish時に含み損ポジションを決済しない理由

- 含み損ポジションはSLまでの距離が近い（追加の下落余地が限定的）
- パニック売りで最大損失を確定するより、SLに任せた方がリスク管理として健全
- SLにヒットしない場合は反発の可能性もある

### crisis時に全ポジション決済する理由

- crisis時はSL自体がギャップダウンで機能しないリスクがある
- 「まだ大丈夫」が最も危険な判断
- 全資金をキャッシュにして嵐が過ぎるのを待つ

### position-monitor内の実行位置

```
[1/3] 未約定注文の約定チェック
[2/3] TP/SL/トレーリングストップチェック
[2.5/3] ★ ディフェンシブモード判定  ← ここ
[3/3] デイトレ強制決済チェック
```

TP/SLチェック後に実行することで、通常の損切り・利確が先に処理され、ディフェンシブモードは残存ポジションのみを対象とする。

### 実装ファイル

| ファイル | 内容 |
|----------|------|
| `src/jobs/position-monitor.ts` | ディフェンシブモードの判定・実行 |
| `src/lib/constants/jobs.ts` | `DEFENSIVE_MODE` 定数 |

---

## ギャップダウン対応（シミュレーション精度向上）

### 概要

ストップロスやテイクプロフィット価格をギャップして寄り付いた場合、実際の約定価格は寄り付き値になる。この現実を反映し、シミュレーションの精度を向上させる。

### 動作

| 条件 | 従来の約定価格 | 修正後の約定価格 |
|------|--------------|----------------|
| low <= SL かつ open >= SL | SL | SL（変更なし） |
| low <= SL かつ open < SL | SL（楽観的） | open（現実的） |
| high >= TP かつ open <= TP | TP | TP（変更なし） |
| high >= TP かつ open > TP | TP（悲観的） | open（現実的） |

### 実装ファイル

| ファイル | 内容 |
|----------|------|
| `src/core/order-executor.ts` | `checkOrderFill()` にopen価格パラメータ追加 |
| `src/jobs/position-monitor.ts` | TP/SLチェック時のギャップ対応 |
