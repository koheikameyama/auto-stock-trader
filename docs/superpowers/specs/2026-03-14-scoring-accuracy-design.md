# スコアリング精度分析 設計書

## 概要

既存の Ghost Review ジョブを拡張し、rejected 銘柄だけでなく accepted 銘柄の結果も含めた4象限の精度分析に変更する。スコアリングシステム全体の精度を日次で測定・改善するための基盤。

## 背景

現行の Ghost Review は rejected 銘柄（見送り）のみを追跡し、False Negative（見逃し）のパターンを特定している。しかし、スコアリングシステムの精度改善には False Positive（誤って買った）の分析も必要。両面を測定することで初めて Precision / Recall のバランスが見える。

## 4象限モデル

全 ScoringRecord に対して、`entryPrice`（スコアリング時価格）vs `closingPrice`（当日終値）で判定する。

|  | 終値 > エントリー価格（上昇） | 終値 <= エントリー価格（下落） |
|---|---|---|
| **accepted**（rejectionReason = null） | **TP**（正しく買った） | **FP**（誤って買った） |
| **rejected**（rejectionReason != null） | **FN**（見逃し） | **TN**（正しく見送った） |

### メトリクス

- **Precision**: TP / (TP + FP) — 買った銘柄の正解率
- **Recall**: TP / (TP + FN) — 上がった銘柄の捕捉率
- **F1 Score**: 2 * (Precision * Recall) / (Precision + Recall)

### エッジケース

- **市場停止日（market_halted）**: 全銘柄が rejected になるため TP=0, FP=0。Precision は `null`（0/0）として記録する。エラーではなく正常な状態として扱う。
- **終値 = エントリー価格**: FP（下落側）に分類する。手数料を考慮すると横ばいは実質損失のため。

## データ収集の変更

### 現行

- rejected 銘柄のみ終値取得 → `closingPrice`、`ghostProfitPct` を ScoringRecord に記録
- `rejectedRecords.length === 0` で早期リターン

### 変更後

- **全 ScoringRecord**（accepted + rejected）の終値を取得
- 早期リターン条件を「当日の ScoringRecord が0件」に変更（rejected が0件でも accepted があれば処理続行）
- `closingPrice` フィールドは全銘柄に記録する
- accepted 銘柄の利益率は `ghostProfitPct` フィールドを共用する（スキーマ変更を避ける）
- 翌日価格記録（`nextDayClosingPrice`、`nextDayProfitPct`）も全銘柄に拡張（既存のクエリが `closingPrice: { not: null }` でフィルタしているため、accepted 銘柄も自動的に対象になる）
- `tradeResult`、`profitPct`、`tradingOrderId` の未使用フィールドは今回触れず、将来のトレード実績紐付け用に残す

### 実装上の変数スコープ

現行の `recordsWithPnl` は rejected のみ。変更後は以下の構造にする：

```typescript
// 全銘柄（accepted + rejected）の終値付きレコード
const allRecordsWithPnl = [...]; // 全 ScoringRecord に closingPrice を付与

// accepted / rejected に分離（各フェーズで使い分け）
const acceptedRecords = allRecordsWithPnl.filter(r => r.rejectionReason === null);
const rejectedRecords = allRecordsWithPnl.filter(r => r.rejectionReason !== null);

// 4象限分類
const tp = acceptedRecords.filter(r => r.profitPct > 0);
const fp = acceptedRecords.filter(r => r.profitPct <= 0);
const fn = rejectedRecords.filter(r => r.profitPct > 0);
const tn = rejectedRecords.filter(r => r.profitPct <= 0);
```

既存の意思決定整合性評価（`marketHaltedToday`、`aiNoGoToday`、`belowThresholdToday`）は `rejectedRecords` から抽出する（現行と同じロジック）。

## AI分析の拡張

### FN分析（既存）

見逃し銘柄の偽陰性パターン特定。現行の enum 値をそのまま維持する：

- misjudgmentType: `threshold_too_strict` / `ai_overcautious` / `pattern_not_recognized` / `market_context_changed` / `acceptable_miss`
- recommendation: `lower_threshold` / `adjust_ai_criteria` / `add_pattern_rule` / `no_change_needed`

### FP分析（新規）

買ったが下落した銘柄の偽陽性パターン特定。

- 対象: `ghostProfitPct <= -SCORING_ACCURACY.MIN_LOSS_PCT_FOR_ANALYSIS` の FP 銘柄上位（上限 `SCORING_ACCURACY.MAX_AI_FP_ANALYSIS` 件）
- プロンプト: 「なぜスコアリング+AIが通したのに下落したか」を分析
- misjudgmentType:
  - `score_inflated` — スコア過大評価
  - `ai_overconfident` — AI楽観
  - `market_shift` — 市場変化
  - `acceptable_loss` — 許容範囲
- recommendation:
  - `tighten_threshold` — 閾値を厳しく
  - `adjust_ai_criteria` — AI基準を調整
  - `add_risk_filter` — リスクフィルター追加
  - `no_change_needed` — 変更不要

### プロンプトファイル構成

`src/prompts/scoring-accuracy.ts` に統合。FN用とFP用で別々のシステムプロンプト・スキーマを export する：

```typescript
// FN分析（既存の ghost-analysis.ts から移行、enum値そのまま）
export const FN_ANALYSIS_SYSTEM_PROMPT = "...";
export const FN_ANALYSIS_SCHEMA = { ... };

// FP分析（新規）
export const FP_ANALYSIS_SYSTEM_PROMPT = "...";
export const FP_ANALYSIS_SCHEMA = { ... };
```

DB の `ghostAnalysis` フィールドに保存する JSON は、FN/FP で異なる misjudgmentType 値を持つが、構造（misjudgmentType, analysis, recommendation, reasoning）は同じ。既存の FN データとの後方互換性を維持する。

### 定数

```typescript
export const SCORING_ACCURACY = {
  MIN_PROFIT_PCT_FOR_FN_ANALYSIS: 1.0,  // FN分析の最低利益率閾値
  MIN_LOSS_PCT_FOR_FP_ANALYSIS: 1.0,    // FP分析の最低損失率閾値
  MAX_AI_FN_ANALYSIS: 5,                // FN分析の最大件数
  MAX_AI_FP_ANALYSIS: 5,                // FP分析の最大件数
  AI_CONCURRENCY: 3,                    // AI並列数
};
```

## decisionAudit の拡張

`TradingDailySummary.decisionAudit` の JSON 構造に追加するフィールド：

```typescript
// 既存フィールドはすべて維持

// 新規追加
confusionMatrix: {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;  // accepted が0件の場合 null
  recall: number | null;     // 上昇銘柄が0件の場合 null
  f1: number | null;
};
byRank: Record<string, {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
}>;
fpAnalysis: Array<{
  tickerCode: string;
  score: number;
  rank: string;
  profitPct: number;
  misjudgmentType: string;
}>;
```

### 後方互換性

過去の `decisionAudit` レコードには `confusionMatrix` フィールドが存在しない。週次レポートで集計する際はオプショナルチェーン（`?.confusionMatrix`）で安全にアクセスし、フィールドが無い日はスキップする。データバックフィルは行わない。

## Slack通知

### 日次通知

`notifyGhostReview()` → `notifyScoringAccuracy()` にリネーム・拡張。

```
📊 スコアリング精度分析（2026-03-14）

【精度メトリクス】
Precision: 72.3% | Recall: 58.1% | F1: 64.4%

【4象限】
✅ TP（買い→上昇）: 8件  |  ❌ FP（買い→下落）: 3件
⚠️ FN（見送り→上昇）: 6件 | ✅ TN（見送り→下落）: 15件

【ランク別 Precision】
S: 83.3% (5/6) | A: 60.0% (3/5)

【FP注目銘柄（買ったが下落）】
1234 スコア78(A) -2.1% → スコア過大評価
5678 スコア82(S) -1.3% → 市場変化

【FN注目銘柄（見逃し）】
9012 スコア62(B) +3.2% → 閾値が厳しすぎ
```

逆行ウィナー通知（`notifyContrarianWinners`）はそのまま維持。

### 週次レポート

既存の `scoring-accuracy-report.ts` を拡張：

- **Precision / Recall / F1 のトレンド**: 直近7日・30日の推移（decisionAudit.confusionMatrix から集計。フィールドが無い日はスキップ）
- **ランク別 Precision トレンド**: S/A ランクの精度推移
- **FP パターン集計**: 偽陽性の misjudgmentType 分布
- 既存のカテゴリ弱点分析・却下コスト分析はそのまま維持
- 既存の `analyzeRankAccuracy` 等の関数は rejected 銘柄のみの分析として維持し、新しい4象限メトリクスは `decisionAudit` からの集計として別セクションにする（既存メトリクスの意味が変わらないようにする）

## リネーム一覧

| 対象 | 現在 | 変更後 |
|---|---|---|
| ジョブファイル | `src/jobs/ghost-review.ts` | `src/jobs/scoring-accuracy.ts` |
| npm script | `npm run ghost` | `npm run scoring-accuracy` |
| workflow | `cronjob_ghost-review.yml` | `cronjob_scoring-accuracy.yml` |
| Slack通知関数 | `notifyGhostReview()` | `notifyScoringAccuracy()` |
| プロンプト | `src/prompts/ghost-analysis.ts` | `src/prompts/scoring-accuracy.ts`（FN分析 + FP分析を統合） |
| 定数 | `GHOST_TRADING` | `SCORING_ACCURACY` |
| cron-job.org | タイトル変更 | API で更新 |

ログやコメント内の「ゴースト」「Ghost Review」も「スコアリング精度分析」に統一。逆行ウィナー関連（`contrarian-analyzer.ts`、`notifyContrarianWinners`）は変更なし。

## バックテストとの住み分け

| | スコアリング精度分析（本設計） | バックテスト |
|---|---|---|
| データ | 当日のリアル運用結果 | ヒストリカルデータ |
| AI判断 | 含む（go/no-go精度を測定） | 含まない（ロジック層のみ） |
| 目的 | 今日の判断は正しかったか？ | パラメータの最適値は？ |
| 期間 | 1日（週次で集計） | 数ヶ月〜 |

## スケジュール

- 日次: 16:10 JST（平日）— 既存と同じタイミング
- 週次: 土曜 11:00 JST — 既存と同じタイミング

## 影響範囲

### 変更ファイル

- `src/jobs/ghost-review.ts` → `src/jobs/scoring-accuracy.ts`（リネーム + 拡張）
- `src/jobs/scoring-accuracy-report.ts`（拡張）
- `src/prompts/ghost-analysis.ts` → `src/prompts/scoring-accuracy.ts`（リネーム + FP分析追加）
- `src/lib/slack.ts`（関数リネーム + 通知内容変更）
- `src/lib/constants/scoring.ts`（定数リネーム）
- `.github/workflows/cronjob_ghost-review.yml` → `cronjob_scoring-accuracy.yml`
- `package.json`（npm script リネーム）
- cron-job.org（API でタイトル変更）

### 変更なし

- `src/core/contrarian-analyzer.ts` — そのまま維持
- `prisma/schema.prisma` — スキーマ変更なし
- バックテスト関連 — 影響なし
