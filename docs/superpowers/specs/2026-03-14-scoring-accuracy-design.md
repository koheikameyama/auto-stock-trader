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

## データ収集の変更

### 現行

- rejected 銘柄のみ終値取得 → `closingPrice`、`ghostProfitPct` を ScoringRecord に記録

### 変更後

- **全 ScoringRecord**（accepted + rejected）の終値を取得
- `closingPrice` フィールドは全銘柄に記録する
- accepted 銘柄の利益率は `ghostProfitPct` フィールドを共用する（スキーマ変更を避ける）
- 翌日価格記録（`nextDayClosingPrice`、`nextDayProfitPct`）も全銘柄に拡張
- `tradeResult`、`profitPct`、`tradingOrderId` の未使用フィールドは今回触れず、将来のトレード実績紐付け用に残す

## AI分析の拡張

### FN分析（既存）

見逃し銘柄の偽陰性パターン特定。現行の ghost-analysis プロンプトをそのまま移行。

### FP分析（新規）

買ったが下落した銘柄の偽陽性パターン特定。

- 対象: `ghostProfitPct <= -1.0%` の FP 銘柄上位（上限5件）
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
  precision: number | null;
  recall: number | null;
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

- **Precision / Recall / F1 のトレンド**: 直近7日・30日の推移（decisionAudit から集計）
- **ランク別 Precision トレンド**: S/A ランクの精度推移
- **FP パターン集計**: 偽陽性の misjudgmentType 分布
- 既存のカテゴリ弱点分析・却下コスト分析はそのまま維持

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
