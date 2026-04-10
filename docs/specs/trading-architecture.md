# トレーディングアーキテクチャ仕様

## 概要

**完全ルールベースのトレーディングシステム。** AI（OpenAI/Langfuse）依存は全て削除済み。

市場評価・銘柄選定・売買判断・リスク管理の全てをルールベースで機械的に実行する。VIXレジーム + キルスイッチでリスク管理を行い、エントリー条件を満たした候補は自動承認される。

> **2026-04-10: breakout戦略のエントリーを無効化し、gapup単独運用に移行。**
> WF検証でbreakout戦略のエッジ消失を確認（OOS集計PF=0.27、6ウィンドウ中4休止）。
> gapupは堅牢（OOS集計PF=2.80、全6ウィンドウアクティブ）。
> `BREAKOUT.ENTRY_ENABLED = false` で制御。既存breakoutポジションのイグジット管理は継続。

### 設計思想

- **攻め（銘柄選定）**: ルールベースで機械的に絞り込み、フィルター通過銘柄は自動承認
- **守り（リスク管理）**: VIXレジーム・キルスイッチ・ドローダウン管理で機械的に実行

### フィルターパイプライン

```
┌─────────────────────────────────────────────────────┐
│ 第1フィルター: 数値ロジック（高速スクリーニング）      │
│ ─ テクニカル指標のスコアリング（CPU処理）             │
│ ─ RSI, MACD, BB, チャートパターン等を数式で評価       │
│ ─ 全銘柄 → 10〜20銘柄に絞り込み                      │
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
│ 自動承認: フィルター通過銘柄は全て候補として承認      │
│ ─ エントリー条件（出来高サージ + 高値ブレイク）で判定  │
│ ─ リスク管理（ポジションサイズ・セクター制限）で最終調整│
└─────────────────────────────────────────────────────┘
```

### 目標

- 正の期待値（期待値 > 0、Profit Factor ≥ 1.3）を維持
- 外部API依存の排除（OpenAI/Langfuse不要）
- 全ての判断がルールベースで再現可能

---

## 現在のフロー

```
第0関門: DB条件フィルタ
  ↓ 約90銘柄
第1関門: テクニカルスコアリング  ← ルールベース
  ↓ 上位10〜20銘柄に絞り込み
自動承認: フィルター通過銘柄は全て候補
  ↓
売買判断: エントリー条件で機械的に判定
  ↓ 指値・利確・損切はロジック算出
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

| カテゴリ         | 指標                     | ウェイト | スコア算出ルール                                                                   |
| ---------------- | ------------------------ | -------- | ---------------------------------------------------------------------------------- |
| トレンド         | 移動平均線の並び         | 20%      | パーフェクトオーダー（5>25>75）= 100、逆 = 0、それ以外 = 50                        |
| モメンタム       | RSI                      | 15%      | 30-40 = 100（反発ゾーン）、40-50 = 70、50-60 = 50、<30 = 30（売られすぎ）、>70 = 0 |
| モメンタム       | MACD                     | 10%      | シグナル上抜け = 100、ヒストグラム正 = 70、負 = 30、シグナル下抜け = 0             |
| ボラティリティ   | ボリンジャーバンド位置   | 10%      | 下限タッチ = 100、下限〜中央 = 70、中央〜上限 = 40、上限超え = 20                  |
| チャートパターン | 検出パターンの最高ランク | 20%      | Sランク = 100、Aランク = 85、Bランク = 70、Cランク = 55、Dランク = 40、なし = 0    |
| ローソク足       | 直近のパターン強度       | 10%      | そのまま強度値（0-100）を使用                                                      |
| 出来高           | 出来高比率               | 10%      | 平均比 2倍以上 = 100、1.5倍 = 80、1.0倍 = 50、0.5倍以下 = 20                       |
| サポート         | サポートラインとの距離   | 5%       | サポート付近（1%以内）= 100、2%以内 = 70、5%以内 = 50、遠い = 20                   |

#### スコアの閾値

| スコア  | 判定        | アクション                   |
| ------- | ----------- | ---------------------------- |
| 80〜100 | S（最有力） | 優先的にエントリー候補       |
| 65〜79  | A（有力）   | エントリー候補               |
| 50〜64  | B（候補）   | 候補が少ない場合のみ対象     |
| 0〜49   | C（見送り） | 候補から除外                 |

#### 出力インターフェース

```typescript
interface TechnicalScore {
  totalScore: number; // 0-100 の総合スコア
  rank: "S" | "A" | "B" | "C";
  breakdown: {
    trend: number; // 移動平均線スコア
    rsiMomentum: number; // RSIスコア
    macdMomentum: number; // MACDスコア
    bollingerPosition: number; // ボリンジャーバンド位置スコア
    chartPattern: number; // チャートパターンスコア
    candlestick: number; // ローソク足スコア
    volume: number; // 出来高スコア
    support: number; // サポートライン距離スコア
  };
  topPattern: {
    name: string; // 例: "逆三尊"
    rank: string; // 例: "S"
    winRate: number; // 例: 89
    signal: string; // "buy" | "sell" | "neutral"
  } | null;
  technicalSignal: string; // "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell"
}
```

### 定数定義

`src/lib/constants/scoring.ts` に以下を定義:

```typescript
export const SCORING = {
  WEIGHTS: {
    TREND: 0.2,
    RSI_MOMENTUM: 0.15,
    MACD_MOMENTUM: 0.1,
    BOLLINGER_POSITION: 0.1,
    CHART_PATTERN: 0.2,
    CANDLESTICK: 0.1,
    VOLUME: 0.1,
    SUPPORT: 0.05,
  },
  THRESHOLDS: {
    S_RANK: 80,
    A_RANK: 65,
    B_RANK: 50,
  },
  // 最大候補数
  MAX_CANDIDATES: 20,
  // 最低候補数（B_RANKまで広げるトリガー）
  MIN_CANDIDATES: 5,
} as const;
```

---

## Phase 2: market-scanner のフロー

### 実装箇所

`src/jobs/market-scanner.ts`

### フロー

```
1. 市場指標取得（VIX・日経平均等）
2. 市場評価: 固定 "normal"（VIXレジーム + キルスイッチでリスク管理）
   → shouldTrade = false（機械的ゲート不通過時）→ 保存して終了
3. DB条件フィルタ
   → 約90銘柄
4. テクニカル分析（並列実行）
   → 全候補の TechnicalSummary を取得
5. テクニカルスコアリング
   → scoreTechnicals(summary) で各銘柄に 0-100 スコア付与
   → スコア降順でソート
   → S・Aランク（+ 候補不足時はBランク）を抽出 → 上位10〜20銘柄
6. 自動承認: フィルター通過銘柄は全て候補として採用
7. 結果保存 + Slack通知
```

---

## Phase 3: 銘柄選定（自動承認）

AIレビューは廃止済み。フィルター通過銘柄は全て自動承認される。

---

## Phase 4: 損切りのロジック強制化

### 変更箇所

- `src/core/risk-manager.ts`（新規関数追加）
- `src/jobs/order-manager.ts`（損切り検証ロジック追加）

### 設計

算出された `stopLossPrice` をルールで検証し、必要に応じて補正する。

#### 検証ルール

```typescript
interface StopLossValidation {
  originalPrice: number; // 算出された損切り価格
  validatedPrice: number; // 検証後の損切り価格
  wasOverridden: boolean; // 上書きされたか
  reason: string; // 上書き理由
}
```

| ルール              | 条件                           | アクション                                   |
| ------------------- | ------------------------------ | -------------------------------------------- |
| 最大損失制限        | 損切り幅 > エントリー価格の 3% | 3%に強制設定                                 |
| ATRベース最低損切り | 損切り幅 < ATR × 0.5           | ATR × 1.0 に引き上げ（近すぎる損切りを防止） |
| ATRベース最大損切り | 損切り幅 > ATR × 2.0           | ATR × 1.5 に引き下げ                         |
| サポートライン考慮  | サポートラインが存在           | サポートライン - ATR × 0.3 に設定            |

#### 損切り強制実行

`position-monitor.ts` での損切り判定はルールベースで機械的に実行する。

```
損切り判定:
  安値 <= stopLossPrice → 強制決済
```

### 定数定義

`src/lib/constants/scoring.ts` に追加:

```typescript
export const STOP_LOSS = {
  MAX_LOSS_PCT: 0.03, // 最大損失率 3%
  ATR_MIN_MULTIPLIER: 0.5, // ATR最小倍率
  ATR_MAX_MULTIPLIER: 2.0, // ATR最大倍率
  ATR_DEFAULT_MULTIPLIER: 1.0, // ATRデフォルト倍率
  ATR_ADJUSTED_MULTIPLIER: 1.5, // ATR調整後倍率
  SUPPORT_BUFFER_ATR: 0.3, // サポートラインバッファ（ATR倍率）
} as const;
```

---

## Phase 5: 売買判断（ルールベース）

AIレビューは廃止済み。order-managerはエントリー条件を直接使用して注文を生成する。

### エントリー条件算出

`src/core/entry-calculator.ts`:

```typescript
interface EntryCondition {
  limitPrice: number; // 指値 = サポートライン or BB下限の近い方
  takeProfitPrice: number; // 利確 = レジスタンスライン or ATR×1.5
  stopLossPrice: number; // 損切り = ATR×1.0（Phase 4の検証済み）
  quantity: number; // 数量 = リスクベース（損切り幅考慮）と予算の厳しい方
  riskRewardRatio: number; // リスクリワード比
  strategy: "breakout" | "gapup";
}
```

Phase 4 の損切り検証ルールで自動チェックされる。

---

## 主要ファイル一覧

| ファイル                         | 内容                                     |
| -------------------------------- | ---------------------------------------- |
| `src/core/technical-scorer.ts`   | テクニカルスコアリングエンジン           |
| `src/core/entry-calculator.ts`   | エントリー条件算出（指値・利確・損切り） |
| `src/lib/constants/scoring.ts`   | スコアリング・損切り検証の定数           |
| `src/jobs/market-scanner.ts`     | 市場評価 + 銘柄スキャン（ルールベース）  |
| `src/jobs/order-manager.ts`      | エントリー条件算出 + 注文生成            |
| `src/core/risk-manager.ts`       | 損切り検証（`validateStopLoss()`）       |
| `src/core/position-manager.ts`   | ポジション管理・複利運用                 |

---

## 板情報フィルター（流動性チェック）

### 概要

エントリー直前に立花証券APIから最新の板情報（best ask/bid）を取得し、流動性が不十分な銘柄への発注を自動的にブロックする。

### 実装場所

- 流動性チェック関数: `src/core/market-data.ts` (`checkLiquidity()`)
- エントリーへの組み込み: `src/core/breakout/entry-executor.ts`（`canOpenPosition` の後、ブローカー発注の前）
- 定数: `src/lib/constants/trading.ts` (`LIQUIDITY_FILTER`)

### 判定ロジック

| チェック項目   | 判定基準                                                   | 不合格時のアクション |
| -------------- | ---------------------------------------------------------- | -------------------- |
| スプレッド     | `(askPrice - bidPrice) / price > 0.5%`                     | エントリー見送り     |
| 最良気配の厚み | `askSize < orderQuantity × MIN_BOARD_DEPTH_RATIO (1.0)`    | エントリー見送り     |
| 売り圧力       | `askSize / bidSize >= SELL_PRESSURE_THRESHOLD (3.0)`       | リスクフラグ付与     |

### インターフェース

```typescript
interface LiquidityCheckResult {
  isLiquid: boolean;       // 約定可能と判断されたか
  spreadPct: number | null; // スプレッド率（%）
  riskFlags: string[];     // ["板薄", "スプレッド大", "売り圧力大"] 等
  reason?: string;         // 不合格理由
}
```

### 動作

1. `executeEntry()` 内で `canOpenPosition()` 通過後に `fetchStockQuote()` で最新板情報を取得
2. `checkLiquidity()` でスプレッド・板厚・売り圧力を検証
3. 不合格 → `retryable: true` で返却（次スキャンで再試行可能）
4. リスクフラグ → ログ出力（ブロックはしない）
5. 板情報は `entrySnapshot.liquidity` に記録（事後分析用）

### 板情報が取得できない場合

yfinanceフォールバック時など板情報がない場合は、チェックをパス（`isLiquid: true`）として従来通り発注する。

### 将来の拡張

- 板の変動性チェック（急激に薄くなっていないか）
- 複数気配値の深さ分析（現在は best ask/bid の1本値のみ）
- エグジット時の流動性チェック

## 将来のフェーズ（本仕様のスコープ外）

### スコアリングシステム改善

8カテゴリ加重方式から3大カテゴリ（テクニカル40点・パターン30点・流動性30点）への再構成、即死ルール、スコアデータのDB保存。

詳細は [scoring-system.md](scoring-system.md) を参照。

### バックテスト機能

スコアリングエンジンの精度を過去データで検証する機能。ウェイトの最適化に使用。

---

## リスク管理: マーケットレジーム

### VIXベース機械的レジーム判定

VIX水準に応じて取引制限を自動適用する。

> **注**: 日経VI（`^JNV`）はYahoo Financeで取得不可となったため廃止。VIXと日経VIの相関は高く、VIXをプライマリ指標として使用する。

| VIX   | レジーム | 最大ポジション（BO/GU独立） | 最低スコア | 動作               |
| ----- | -------- | -------------------------- | ---------- | ------------------ |
| < 20  | normal   | BO: 3 / GU: 3              | 0（なし）  | 通常取引   |
| 20-25 | elevated | BO: 2 / GU: 2              | 60（A相当）| S/Aランクのみ |
| 25-30 | high     | BO: 1 / GU: 1              | 75（S相当）| Sランクのみ   |
| > 30  | crisis   | BO: 1 / GU: 1              | 75（S相当）| 1ポジション制限（暴落時のブレイクアウトは本物の強さ）|

### CME先物ナイトセッション乖離率チェック

CME日経先物（NKD=F、USD建て）のナイトセッション乖離率を算出し、前場前にギャップダウンリスクを判定する。

```
乖離率(%) = ((CME先物価格 × USDJPY) / 日経前日終値 - 1) × 100
```

| 乖離率  | アクション                             |
| ------- | -------------------------------------- |
| ≤ -3.0% | crisis（取引停止、ギャップダウン必至） |
| ≤ -1.5% | elevated以上に引き上げ（警戒モード）   |
| > -1.5% | レジームへの影響なし                   |

### 実装ファイル

- `src/core/market-regime.ts`: `determineMarketRegime(vix)`, `determinePreMarketRegime(cmeDivergencePct)`, `calculateCmeDivergence()`
- `src/lib/constants/trading.ts`: `VIX_THRESHOLDS`, `CME_NIGHT_DIVERGENCE`, `MARKET_REGIME`

### 日経平均キルスイッチ

日経平均の前日比が **-3%以下** の場合、VIXレジームに関わらずCrisisモード（全取引停止＋全ポジション即時決済）に自動移行する。

- **閾値**: `MARKET_INDEX.NIKKEI_CRISIS_THRESHOLD`（-3%）
- **実装**: `src/jobs/market-scanner.ts`（ステップ 1.8.5）

### market-scanner 判定フロー全体像

market-scannerの判定は「機械的ゲート → 戦略決定 → 銘柄スキャン」の順で実行される。全ての判断がルールベースで機械的に行われる。

#### フロー図

```
[1] 市場データ取得（VIX・CME先物・日経平均・USD/JPY）
  ↓
[2] ========== 機械的ゲート ==========
  │
  ├─ [1.7] CME先物乖離率チェック
  │   └─ ≤ -3.0% → 取引停止（crisis）
  │   └─ ≤ -1.5% → レジームをelevated以上に引き上げ
  │
  ├─ [1.8] VIXレジーム判定
  │   └─ VIX > 30 → crisis（最大1ポジション、スコア75以上）
  │   └─ VIX 25-30 → 最大1ポジション、Sランクのみ
  │   └─ VIX 20-25 → 最大2ポジション、S/Aランク
  │   └─ VIX < 20 → 制限なし
  │
  ├─ [1.8.5] 日経平均キルスイッチ
  │   └─ 前日比 ≤ -3% → 取引停止（crisis）
  │
  │   ※ N225 SMA50フィルターは廃止済み（2026-04-01）
  │     WF検証でbreadth73%で十分と判定。SMA50は遅行指標でリバウンド初期を逃すため。
  │
  └─ [1.9] ドローダウンチェック
      └─ 週次 -5% or 月次 -10% or 5連敗 → 取引停止
  ↓
  ゲート通過
  ↓
[3] ========== 銘柄スキャン（ルールベース） ==========
  │
  ├─ [2] 市場評価: 固定 "normal"（機械的ゲートでリスク管理済み）
  │   └─ shouldTrade = false（ゲート不通過時）→ 保存して終了
  │   └─ shouldTrade = true → 銘柄選定へ
  │
  ├─ [3-4] テクニカル分析 + スコアリング → 上位10-20銘柄に絞り込み
  │
  └─ [4] 自動承認: フィルター通過銘柄は全て候補
  ↓
[4] 注文生成 → order-managerへ
```

#### 取引停止条件一覧

| #   | 条件             | 閾値              | 種別   | 実装                                   | 動作                     |
| --- | ---------------- | ----------------- | ------ | -------------------------------------- | ------------------------ |
| 1   | CME先物乖離率    | ≤ -3.0%           | 機械的 | `determinePreMarketRegime()`           | 取引停止                 |
| 2   | VIX crisis       | > 30              | 機械的 | `determineMarketRegime()`              | 1ポジション制限（停止しない） |
| 3   | 日経平均急落     | 前日比 ≤ -3%      | 機械的 | `MARKET_INDEX.NIKKEI_CRISIS_THRESHOLD` | 取引停止                 |
| 4   | 週次ドローダウン | -5%               | 機械的 | `DRAWDOWN.WEEKLY_HALT_PCT`             | 取引停止                 |
| 5   | 月次ドローダウン | -10%              | 機械的 | `DRAWDOWN.MONTHLY_HALT_PCT`            | 取引停止                 |
| 6   | 連敗             | 5連敗             | 機械的 | `DRAWDOWN.COOLDOWN_HALT_TRIGGER`       | 取引停止                 |

VIX crisisのみ完全停止ではなく1ポジション制限。暴落時にブレイクアウトする銘柄は本物の強さを持つため。それ以外は機械的・無条件で停止。

#### 判断の担当一覧

| 判断                 | 方法                          | 備考                         |
| -------------------- | ----------------------------- | ---------------------------- |
| 取引停止             | VIX/CME/日経/ドローダウン閾値 | 機械的に実行                 |
| 市場評価             | 固定 "normal"                | VIXレジーム + キルスイッチでリスク管理 |
| ポジション制限       | VIXレジーム                   | 最大ポジション数・最低スコア |
| 銘柄選定             | スコアリング → 自動承認       | フィルター通過で自動承認     |
| エントリー条件       | ロジック算出                  | 損切りはATRベース            |
| 損切り実行           | ATRベース                     | 機械的に実行                 |
| トレーリングストップ | ATRベース                     | 自動引き上げ                 |

**原則**: 全ての判断をルールベースで機械的に処理する。外部AI依存なし。

#### 市場評価とレジームの整合性

市場評価は固定 "normal" とし、リスク管理はVIXレジームとキルスイッチで行う:

| VIX   | レジーム               | 動作                                   |
| ----- | ---------------------- | -------------------------------------- |
| < 20  | normal（制限なし）     | 通常取引                               |
| 20-25 | elevated（2ポジ・A）   | ポジション・スコア制限                 |
| 25-30 | high（1ポジ・S）       | ポジション制限                         |
| > 30  | crisis（1ポジ・S）     | 1ポジション制限+ディフェンシブ発動     |

---

## リスク管理: ドローダウン管理

### 週次・月次ドローダウン上限

TradingDailySummaryの確定損益を集計し、週次・月次の累積損失が閾値を超えた場合に取引停止する。

| 期間 | 停止閾値 | 計算方法                                         |
| ---- | -------- | ------------------------------------------------ |
| 週次 | 5%       | 今週月曜以降のTradingDailySummary.totalPnlを合算 |
| 月次 | 10%      | 今月1日以降のTradingDailySummary.totalPnlを合算  |

### 連敗クールダウン

直近のクローズ済みポジションの`realizedPnl`から連敗数を動的計算する（`getLosingStreak()`）。

| 連敗数 | アクション |
| ------ | ------------------------------------- |
| 0-2    | 制限なし |
| 3-4    | リスク%を50%に縮小（2% → 1%） + 最大1ポジションに制限 |
| 5+     | 取引停止 |

**解除条件**: 連敗カウントは動的計算のため、次のトレードで勝てば自動リセット。週次/月次は期間経過で自動リセット。

### ピークエクイティ（ハイウォーターマーク）

`TradingConfig.peakEquity` に資産の最高値を記録。end-of-dayで現在の資産が過去最高を超えていれば更新。

### 実装ファイル

- `src/core/drawdown-manager.ts`: `calculateDrawdownStatus()`, `updatePeakEquity()`, `getLosingStreak()`
- `src/lib/constants/trading.ts`: `DRAWDOWN`, `LOSING_STREAK`

---

## 取引判定の表示方針

取引判定（取引許可/見送り）は**ダッシュボード（Home）の市場評価カードのみ**に表示する。

- **ダッシュボード**: 3ゲート（VIXレジーム・市場評価・ドローダウン）の結果を統合した最終判定バッジ + sentimentバッジ
- **Riskページ**: 数値モニターに徹する。判定ラベル（許可/停止/正常等）は表示しない
  - マーケットレジーム: VIX値・最大ポジション数・最低ランクのみ
  - ドローダウン管理: 週次/月次P&L・DD%・連敗数・ピークエクイティのみ

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

## リスク管理: リスクベースポジションサイジング

### 概要

ポジションサイズを「予算比率」だけでなく「損切り幅（リスク）」に基づいて決定する。高ボラティリティ銘柄（ATR大）は自動的にポジションが小さくなり、低ボラティリティ銘柄は大きくなる。1トレードあたりの最大損失額を統一できるため、リスク管理が安定する。

### 計算式

```
RR = (利確参考値 - エントリー価格) / (エントリー価格 - 損切り価格)
リスク% = RR_RISK_TABLE から RR に応じた値を取得
リスク許容額 = 総資金 × リスク%
1株あたりリスク = エントリー価格 - 損切り価格
リスクベース数量 = リスク許容額 / 1株あたりリスク

最終数量 = min(リスクベース数量, 予算ベース数量) → 100株単位に切捨て
```

### RR別リスク%テーブル

RRが高いトレードほど期待値が高いため、ポジションを厚くする。

| RR | リスク% | 理由 |
|----|---------|------|
| ≥ 2.5 | 2.5% | 期待値が高いトレードに厚く張る |
| ≥ 2.0 | 2.0% | 標準 |
| ≥ 0 | 1.5% | ゲートギリギリは控えめに |

### 例

| 項目             | 低ボラ銘柄 | 高ボラ銘柄   |
| ---------------- | ---------- | ------------ |
| 総資金           | 100,000円  | 100,000円    |
| エントリー価格   | 1,000円    | 1,000円      |
| ATR(14)          | 20円       | 80円         |
| 損切り価格       | 980円      | 920円        |
| 1株リスク        | 20円       | 80円         |
| リスク%          | 2%         | 2%           |
| リスク許容額     | 2,000円    | 2,000円      |
| リスクベース数量 | 100株      | 25株→**0株** |

高ボラ銘柄は損切り幅が広いため、同じリスク許容額でも購入できる株数が少なくなる。

> **注**: リスク%はフラット2%（`POSITION_SIZING.RISK_PER_TRADE_PCT`）。SLとTPが共にATRベースのためRR比は常に固定値（≈5.0）となり、RR傾斜は機能しないため廃止した。連��時は`LOSING_STREAK.SCALE_FACTOR`（50%）でリスク%を縮小する。

### 連敗クールダウン

直近のクローズ済みポジションの`realizedPnl`から連敗数を動的計算し、段階的にリスクを縮小する。

| 連敗数 | アクション |
| ------ | ------------------------------------- |
| 0-2    | 制限なし |
| 3-4    | リスク%を50%に縮小 + 最大1ポジションに制限 |
| 5+     | 取引停止 |

**解除条件**: 連敗カウントは動的計算のため、次のトレードで勝てば自動リセット。

### エントリー優先順位

複数のトリガーが同時に発火した場合、以下の優先順位で並べ替えて直列実行する。

| 優先度 | 基準 | ソート | 理由 |
|--------|------|--------|------|
| 1st | リスクリワード比（RR） | 降順 | 期待値に直結。RR 2.0 と 1.5 では期待値が異なる |
| 2nd | ストップ幅（対価格%） | 昇順 | 同じRRなら損切りが浅い方がリスク効率が良い |
| 3rd | 出来高サージ比率 | 降順 | ブレイクアウトの確度。逆行ボーナスで微調整 |

### 実装ファイル

- `src/core/risk-manager.ts`: `canOpenPosition()`（連敗チェック含む）
- `src/core/breakout/entry-executor.ts`: フラットリスク% + 連敗スケールダウン
- `src/core/drawdown-manager.ts`: `getLosingStreak()`
- `src/lib/constants/trading.ts`: `LOSING_STREAK`
- `src/jobs/breakout-monitor.ts`: RR→SL%→出来高サージによる優先順位ソート
- `src/core/gapup/gapup-scanner.ts`: 同上

---

## 資金管理: 複利運用

### 概要

ポジション決済時に確定損益（realizedPnl）を `TradingConfig.totalBudget` に自動加算する。利益も損失もtotalBudgetに反映され、複利で資金が成長する。

### 仕組み

```
ポジションクローズ
  ↓
grossPnl = (exitPrice - entryPrice) × quantity
  ↓
取引コスト差引（手数料 + 税金）
  ↓
realizedPnl = grossPnl - 手数料(買い+売り) - 税金(利益時のみ)
  ↓
totalBudget += realizedPnl（利益なら増加、損失なら減少）
  ↓
次回トレードはこの新しいtotalBudgetを基準に資金管理
```

### 取引コストモデル

`src/core/trading-costs.ts` で計算される。バックテストとライブ取引の両方で同じモジュールを使用。

| コスト | 計算                                                      |
| ------ | --------------------------------------------------------- |
| 手数料 | 立花証券e支店 現物定額コース（按分概算、買い+売りの往復） |
| 税金   | 利益×20.315%（特定口座・源泉徴収あり）                    |

詳細は [backtest.md](backtest.md#取引コストモデル) を参照。

### リスク抑制（既存の仕組みで対応済み）

- 日次損失上限 3%: 1日の損失（確定損益 + 含み損益）がtotalBudgetの3%に達したら新規トレード停止
- 損切り ATRベース（最大3%）: ポジション単位のリスク制限
- 最大3ポジション: 集中投資の抑制
- タイムストップ: トレーリング未発動のまま10営業日で強制クローズ（トレーリング発動中は適用しない）

### 実装箇所

- `src/core/position-manager.ts` の `closePosition()` 内トランザクション

---

## 出口判定モジュール（exit-checker）

### 概要

ポジションの出口判定を行う**純粋関数**。`position-monitor.ts`（ライブ取引）とバックテスト `simulation-engine`（日足シミュレーション）で同一ロジックを共有する。DB操作は一切行わない。

### 判定フロー

```
checkPositionExit(position, bar)
  │
  ├─ 1. maxHigh更新: max(保有中最高値, 当日高値)
  │
  ├─ 2. calculateTrailingStop()
  │     └─ maxHigh >= BE閾値 → 発動（TP無効化, SL=トレーリング価格）
  │     └─ maxHigh <  BE閾値 → 未発動（固定TP/SLそのまま）
  │
  ├─ 3. TP判定: effectiveTP != null かつ bar.high >= effectiveTP → take_profit
  │     ├─ bar.open > effectiveTP → exitPrice = bar.open（ギャップアップ有利約定）
  │     └─ それ以外 → exitPrice = effectiveTP
  │     ※ トレーリング発動中は effectiveTP = null のためスキップ
  │
  ├─ 4. SL判定: bar.low <= effectiveSL → stop_loss / trailing_profit
  │     ├─ bar.open < effectiveSL → exitPrice = bar.open（ギャップダウンスリッページ）
  │     └─ それ以外 → exitPrice = effectiveSL
  │     ※ TPより後に判定 → SLが最終優先（TPを上書き）
  │     ※ トレーリング発動中は exitReason = "trailing_profit"
  │
  └─ 5. タイムストップ: 以下2条件すべて満たす場合のみ判定
        ├─ exit未決定（TP/SLどちらも非該当）
        └─ トレーリング未発動
        条件:
        ├─ 保有日数 >= ハードキャップ → time_stop（bar.closeで決済）
        └─ 保有日数 >= ベースリミット かつ 含み損 → time_stop
```

### 猶予期間

| 呼び出し元 | 猶予 | 理由 |
|---|---|---|
| position-monitor.ts（ライブ） | `EXIT_GRACE_PERIOD_MS`（1分） | 日足OHLCに買い前の高値/安値が含まれるため |
| バックテスト | エントリー日（holdingDays=0）はスキップ | 同上（日足ベース） |

### 実装ファイル

| ファイル | 内容 |
|---|---|
| `src/core/exit-checker.ts` | 出口判定ロジック |
| `src/core/trailing-stop.ts` | トレーリングストップ算出 |
| `src/core/__tests__/exit-checker.test.ts` | 出口判定テスト（21ケース） |
| `src/core/__tests__/trailing-stop.test.ts` | トレーリングストップテスト（18ケース） |

---

## トレーリングストップ

### 概要

保有中の最高値更新に応じて損切りラインを動的に引き上げる機能。固定利確（+3%）では大きな上昇を取り逃がす問題を解決する。

**設計思想**: 「損小利大 — 利益を伸ばし、損失を限定する」— トレーリングストップを出口戦略の主軸とし、固定利確は廃止。タイムストップで動かない銘柄の塩漬けを防止するが、トレーリング発動中のポジションには適用せず利益を伸ばす。

### 仕組み

```
1. エントリー後、価格がBE発動閾値以上に上昇
   → トレーリングストップが発動（BE発動がゲート）

2. 発動後:
   - trailingStopPrice = maxHighDuringHold - ATR × trailMultiplier
   - ストップは上方向にのみ移動（ラチェット）
   - 固定TP/SLは無効化 → 上値を追い続ける
   - フロア制約: max(rawTrailingStop, originalStopLoss, entryPrice)

3. 価格がトレーリングストップ以下に下落
   → 「トレーリング利確」として決済
```

### パラメータ

| パラメータ | breakout | gapup | 説明 |
|---|---|---|---|
| BE発動閾値 | ATR × 1.0 | ATR × 0.3 | **実際の発動ゲート**（この閾値でトレーリング開始） |
| TS発動閾値 | ATR × 1.5 | ATR × 0.5 | 表示・レポート用に計算（発動判定には使用しない） |
| トレール幅 | ATR × 1.5 | ATR × 0.3 | 最高値からの距離 |

**ATR不明時のフォールバック（%ベース）:**

| パラメータ | breakout | gapup | 説明 |
|---|---|---|---|
| BE発動% | 2.0% | 0.5% | entryPrice × (1 + %) |
| TS発動% | 3.0% | 0.8% | 表示用 |
| トレール% | 2.0% | 0.5% | maxHighDuringHold × % |

> **注**: BE発動閾値がトレーリング開始のゲート。BE発動時点からトレーリング開始する。

### ラチェット（下がらない）

トレーリングストップ価格は常に上方向にのみ移動する。

```
newTrailingStop = max(
  maxHighDuringHold - trailWidth,   // 新しい計算値
  currentTrailingStop,               // 既存値（下がらない）
  originalStopLoss,                  // 元のSL以上を保証
  entryPrice                         // 最低でも建値以上
)
```

### TP/SLとの関係

| 状態 | Stop Loss | Take Profit | 動作 |
|---|---|---|---|
| **未発動** | 固定SL | 固定TP（参考値） | SL/TP監視 |
| **発動** | トレーリングストップ | **なし（null）** | 上値を追う |

> **注**: 元の仕様にあった「BE発動」状態（エントリー価格にSL引き上げ）は、現在のコードではラチェットのフロア制約（`max(..., entryPrice)`）で自動的に実現される。BE発動=トレーリング発動として統合されている。

### タイムストップ

保有期間を制限する。**トレーリングストップが発動中のポジションにはタイムストップを適用しない**（利益を伸ばすためトレーリングに委ねる）。

| 条件 | breakout | gapup | 動作 |
|---|---|---|---|
| ベースリミット + 含み損 | 7日 | 3日 | 成行決済（トレンド不発と判断） |
| ハードキャップ（損益問わず） | 10日 | 5日 | 強制決済 |
| ベースリミット + 含み益 | — | — | 延長（ハードキャップまで待つ） |
| トレーリング発動中 | — | — | タイムストップ不適用 |

```typescript
// exit-checker.ts の判定ロジック
const inProfit = bar.close > position.entryPrice;
const hitHardCap = holdingBusinessDays >= hardCap;       // breakout:10, gapup:5
const hitBaseLimitWithNoProfit = holdingBusinessDays >= baseLimit && !inProfit; // breakout:7, gapup:3
```

| ポジション状態 | タイムストップ | 出口判定 |
|---|---|---|
| 含み損 or 横ばい（トレーリング未発動） | ベースリミットで発動 | 成行決済 |
| 含み益（トレーリング未発動） | ハードキャップで発動 | 成行決済 |
| 含み益（トレーリング発動中） | 適用しない | トレーリングストップに委ねる |

### 約定時TP/SL再検証

注文時のTP/SLはlimitPrice（指値）基準で計算されるが、実際の約定価格（filledPrice）はlimitPriceと異なる場合がある。約定時にfilledPriceベースで`validateStopLoss`を再実行し、以下を保証する:

- SLがエントリー価格の3%以内
- ATR範囲内（ATR×0.5〜ATR×2.0）
- RR比≥1.5（SL修正時にTPも連動して再計算）

既存のオープンポジションについても、position-monitorの監視ループ内で同様のチェックを行い、3%ルール違反を自動修正する。

### RRフィルタ（エントリー前）

エントリー条件算出時にリスクリワード比（RR）を計算し、RR < 1.5 の場合はエントリーを見送る（quantity = 0）。これにより、リスクに見合わないトレードを事前に排除する。

### 実装ファイル

| ファイル                       | 内容                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `src/core/trailing-stop.ts`    | トレーリングストップ + ブレイクイーブンストップ算出ロジック |
| `src/lib/constants/jobs.ts`    | `TRAILING_STOP`、`BREAK_EVEN_STOP` 定数                     |
| `src/jobs/position-monitor.ts` | モニタリングループへの統合                                  |
| `src/core/position-manager.ts` | `entryAtr` パラメータ追加                                   |

### データモデル

`TradingPosition` に追加:

| カラム              | 型       | 説明                                            |
| ------------------- | -------- | ----------------------------------------------- |
| `trailingStopPrice` | Decimal? | 現在のトレーリングストップ価格（null = 未発動） |
| `entryAtr`          | Decimal? | エントリー時のATR(14)                           |

---

## ディフェンシブモード

### 概要

市場評価がcrisisの場合、既存ポジションを全て即時決済する。通常の防衛機能（VIXレジーム、ドローダウン管理等）は新規ポジションの参入を止めるだけだが、ディフェンシブモードは既存ポジションにも介入する。

**設計思想**: 「不確実な状況ではキャッシュが最強のポジション」

### 動作

| センチメント | 含み益ポジション         | 含み損ポジション         |
| ------------ | ------------------------ | ------------------------ |
| normal      | 通常TP/SL監視            | 通常TP/SL監視            |
| crisis       | 全決済（市場価格で決済） | 全決済（市場価格で決済） |

### crisis時に全ポジション決済する理由

- crisis時はSL自体がギャップダウンで機能しないリスクがある
- 「まだ大丈夫」が最も危険な判断
- 全資金をキャッシュにして嵐が過ぎるのを待つ

### センチメントとディフェンシブモード

sentimentは normal/crisis の2値のみ。position-monitorは毎分 `sentiment` を読み取り、crisisのときにディフェンシブモードを発動する。

| VIXレジーム | sentiment | ディフェンシブモード |
| ----------- | --------- | -------------------- |
| normal      | normal   | 未発動               |
| elevated    | normal   | 未発動               |
| high        | normal   | 未発動               |
| crisis      | crisis    | 全ポジション決済     |

### position-monitor内の実行位置

```
[1/3] 未約定注文の約定チェック
[2/3] TP/SL/トレーリングストップチェック
[2.5/3] ★ ディフェンシブモード判定  ← ここ
```

TP/SLチェック後に実行することで、通常の損切り・利確が先に処理され、ディフェンシブモードは残存ポジションのみを対象とする。

### 実装ファイル

| ファイル                       | 内容                             |
| ------------------------------ | -------------------------------- |
| `src/jobs/position-monitor.ts` | ディフェンシブモードの判定・実行 |

---

## 取引停止時の保持銘柄の扱い

### 概要

取引停止（shouldTrade = false）は**新規買い注文の抑制**のみを行い、既存ポジションには直接影響しない。保持銘柄の防衛決済は、取引停止とは独立した**ディフェンシブモード**（sentiment連動）で制御される。

### 取引停止トリガーと保持銘柄への影響

| トリガー      | 停止条件                   | 新規注文 | 保持銘柄         | sentimentへの影響             |
| ------------- | -------------------------- | -------- | ---------------- | ----------------------------- |
| VIXレジーム   | VIX > 30                   | 1ポジ制限 | **直接影響なし** | crisis → ディフェンシブ発動   |
| CME先物乖離率 | ≤ -3.0%                    | 停止     | **直接影響なし** | crisis → ディフェンシブ発動   |
| 日経平均急落  | 前日比 ≤ -3%               | 停止     | **直接影響なし** | crisis → ディフェンシブ発動   |
| ドローダウン  | 週次≥5% / 月次≥10% / 5連敗 | 停止     | **直接影響なし** | 直前sentimentを維持           |
| 市場評価      | shouldTrade = false        | 停止     | **直接影響なし** | sentiment次第                 |

### 保持銘柄に対するアクション（sentimentベース）

保持銘柄の防衛決済は `position-monitor`（毎分実行）のフェーズ2.5で、`MarketAssessment.sentiment` を参照して判定する。

```
position-monitor 実行フロー:
  [1/3] 未約定注文の約定チェック
    └─ crisis中 → pending買い注文をキャンセル
  [2/3] TP/SL/トレーリングストップチェック  ← 常に稼働
  [2.5/3] ディフェンシブモード判定          ← sentiment連動
    └─ crisis → 全ポジション即時決済
```

| sentiment | 含み益ポジション | 含み損ポジション | 根拠                                                            |
| --------- | ---------------- | ---------------- | --------------------------------------------------------------- |
| normal   | 通常SL/TP監視    | 通常SL/TP監視    | -                                                               |
| crisis    | **全決済**       | **全決済**       | SL自体がギャップダウンで機能しないリスク / キャッシュ防衛最優先 |

### 取引停止中も常に稼働する仕組み

以下の出口判定はsentimentや取引停止状態に関わらず、**常にposition-monitorで稼働**する。

| 出口判定                 | 動作                                            | 実装                               |
| ------------------------ | ----------------------------------------------- | ---------------------------------- |
| ストップロス（損切り）   | 安値 ≤ SL → 強制決済                            | `checkPositionExit()`              |
| トレーリングストップ     | 最高値更新に追従、下落時に利確決済              | `checkPositionExit()`              |
| タイムストップ           | トレーリング未発動のまま10営業日経過 → 強制決済 | `checkPositionExit()`              |
| コーポレートイベント調整 | 配当落ち・株式分割 → SL/TS自動調整              | `applyCorporateEventAdjustments()` |

#### 出口判定の猶予期間（EXIT_GRACE_PERIOD）

ポジションOpen直後（1分以内）は出口判定をスキップする。

**理由**: リアルタイムクォートの `high`/`low` は当日の日足OHLCであり、買い約定前の高値/安値が含まれる。Open直後に出口判定を行うと、買い前の値動きでTP/SLが誤発動し、即座に売却されてしまう。

**対象**:
- TP/SL/トレーリングストップ判定（Phase 2）
- 決算前強制決済

**例外**: crisis（資本防衛）は猶予なしで即時決済する。

### 取引停止〜保持銘柄処理の全体フロー図

```
取引停止トリガー発動
  │
  ├─ 新規注文: 停止
  │    ├─ market-scanner → shouldTrade=false, selectedStocks=[] 保存
  │    ├─ order-manager → shouldTrade=false確認 → 注文作成せず終了
  │    └─ position-monitor → pending買い注文キャンセル（ディフェンシブ時）
  │
  └─ 保持銘柄: sentiment に応じて処理
       │
       ├─ [常時] TP/SL/トレーリングストップ/タイムストップ → 通常通り稼働
       │
       └─ [crisis] ディフェンシブモード
            └─ 全ポジション即時決済（資本防衛）
```

### 関連ファイル

| ファイル                       | 役割                                         |
| ------------------------------ | -------------------------------------------- |
| `src/jobs/market-scanner.ts`   | 取引停止判定、MarketAssessment保存           |
| `src/jobs/order-manager.ts`    | shouldTrade/ディフェンシブ判定で新規注文抑制 |
| `src/jobs/position-monitor.ts` | TP/SL常時監視 + ディフェンシブモード実行     |
| `src/core/market-regime.ts`    | VIX/CMEレジーム判定                          |
| `src/core/drawdown-manager.ts` | ドローダウン停止判定                         |
| `src/core/exit-checker.ts`     | 出口判定ロジック（SL/TP/TS/タイムストップ）  |
| `src/lib/constants/jobs.ts`    | `DEFENSIVE_MODE` 定数                        |
| `src/lib/constants/trading.ts` | `VIX_THRESHOLDS`, `DRAWDOWN` 等              |

---

## コーポレートイベント対応

### 配当落ち日対応

`Stock.exDividendDate` / `Stock.dividendPerShare` で次回配当落ち日を管理する。

#### エントリー禁止（即死ルール）

配当落ち日前後はエントリーを禁止する。配当落ち日には理論上、配当額分だけ株価が下落するため、テクニカル指標が歪みエントリーの前提が崩れる。

- 配当落ち日の前2日〜後1日は即死ルール（`ex_dividend_upcoming`）で棄却
- 定数: `SCORING.DISQUALIFY.EX_DIVIDEND_DAYS_BEFORE`（2）、`SCORING.DISQUALIFY.EX_DIVIDEND_DAYS_AFTER`（1）

#### 保有中の配当落ち日対応

ポジション保有中に配当落ち日を迎えた場合、損切り・トレーリングストップを配当額分引き下げる。配当落ちによる株価下落は本質的な価値毀損ではないため、機械的な損切りを回避する。

```
調整後stopLossPrice = stopLossPrice - dividendPerShare
調整後trailingStopPrice = trailingStopPrice - dividendPerShare
```

#### 監査証跡

`CorporateEventLog` テーブルで調整記録を保存する。

```prisma
model CorporateEventLog {
  id              String   @id @default(cuid())
  positionId      String
  eventType       String   // "ex_dividend" | "stock_split"
  eventDate       DateTime @db.Date
  description     String   // 調整内容の説明
  adjustments     Json     // { stopLossPrice: { before, after }, trailingStopPrice: { before, after } }
  createdAt       DateTime @default(now())

  @@index([positionId])
  @@index([eventDate(sort: Desc)])
}
```

### 株式分割対応

yahoo-finance2 の `defaultKeyStatistics.lastSplitDate` / `lastSplitFactor` で株式分割を検知する。

#### ポジション自動調整

分割当日にポジション情報を自動調整する。

```
調整対象:
  entryPrice     = entryPrice / splitFactor
  quantity       = quantity × splitFactor
  stopLossPrice  = stopLossPrice / splitFactor
  trailingStopPrice = trailingStopPrice / splitFactor（発動済みの場合）
  entryAtr       = entryAtr / splitFactor
```

#### 異常値除外の修正

`removeAnomalies()` で分割日のバーを異常値として除外しないよう修正する。分割日は前日比で大きな価格変動が発生するが、これは異常値ではなく正常なコーポレートアクションであるため、除外対象から除く。

#### 監査証跡

配当落ち日と同様に `CorporateEventLog` テーブルで調整記録を保存する。`eventType: "stock_split"` として記録し、調整前後の値を `adjustments` フィールドに保存する。

### 値幅制限シミュレーション

`src/lib/constants/price-limits.ts` にJPX値幅制限テーブルを実装する。

#### バックテストでの適用

バックテストで損切り判定時にストップ安チェックを追加する。

- 損切り価格がストップ安価格を下回る場合、約定不可と判定
- ストップ安張り付き時は翌営業日に持ち越し（翌日の寄り付きで約定を試行）
- `--price-limits` フラグで有効化（デフォルト無効）

```
損切り判定フロー（--price-limits 有効時）:
  1. low <= stopLossPrice → 損切りトリガー
  2. 当日のストップ安価格を算出（前日終値ベース）
  3. open <= ストップ安価格 → 約定不可（翌日持ち越し）
  4. open > ストップ安価格 → 通常通り約定（open or stopLossPrice）
```

---

## ギャップダウン対応（シミュレーション精度向上）

### 概要

ストップロスやテイクプロフィット価格をギャップして寄り付いた場合、実際の約定価格は寄り付き値になる。この現実を反映し、シミュレーションの精度を向上させる。

### 動作

| 条件                       | 従来の約定価格 | 修正後の約定価格 |
| -------------------------- | -------------- | ---------------- |
| low <= SL かつ open >= SL  | SL             | SL（変更なし）   |
| low <= SL かつ open < SL   | SL（楽観的）   | open（現実的）   |
| high >= TP かつ open <= TP | TP             | TP（変更なし）   |
| high >= TP かつ open > TP  | TP（悲観的）   | open（現実的）   |

### 実装ファイル

| ファイル                       | 内容                                        |
| ------------------------------ | ------------------------------------------- |
| `src/core/order-executor.ts`   | `checkOrderFill()` にopen価格パラメータ追加 |
| `src/jobs/position-monitor.ts` | TP/SLチェック時のギャップ対応               |

---

## 課題・改善候補

### 資金稼働率が低い（約25%）

**現状**: バックテスト（50万〜500万）でいずれも資金稼働率が22〜25%程度で頭打ち。

**原因**: ユニバース内で戦略の条件を満たすシグナル数が限られており、ポジション枠より先に「シグナルが出ない」が制約になっている。資金を増やしてもトレード数はほぼ変わらず（例: 500K→5M で 201→258件）。

**含意**:
- ポジション枠の増減はリターン%にほぼ影響しない（枠より資金が先に余る）
- 稼働率を上げるにはシグナル数を増やす方向（ユニバース拡大・別戦略追加）が効果的
- 現在の50万規模は適切（資金を増やしてもリターン%は改善しない）

### ポジション枠の戦略別分離（2026-04-08 対応済み）

**変更前**: BreakoutとGapUpが同じ枠を共有（合計3枠）。GapUp 1枚持つとBreakout 2枚しか取れない。

**変更後**: 戦略別独立（BO: 3枠、GU: 3枠）。

**根拠**:
- 平均保有期間が根本的に異なる（GU: 1.2日 / BO: 3〜10日）のでリスクの性質が別物
- バックテスト比較で合算3枠（NetRet 124.8%, MaxDD 8.7%）より独立3+3（130.8%, 7.6%）が改善
- ただし稼働率22%台で資金制約が先に来るため、実際は上限に達することはほぼない

**実装ファイル**: `src/lib/constants/trading.ts`（`MAX_POSITIONS_BO/GU`）、`src/core/risk-manager.ts`（`canOpenPosition`）
