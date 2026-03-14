# スコアリング精度分析 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ghost Review ジョブを「スコアリング精度分析」に拡張し、accepted + rejected 銘柄の4象限精度分析（Precision / Recall / F1）を日次・週次で測定する。

**Architecture:** 既存の `ghost-review.ts` を `scoring-accuracy.ts` にリネームし、全 ScoringRecord の終値を取得して TP/FP/FN/TN を分類する。FP 銘柄にも AI 分析を追加。週次レポートに Precision/Recall トレンドを追加。

**Tech Stack:** TypeScript, Prisma, OpenAI API (gpt-4o-mini), Slack Webhook, cron-job.org API

**Spec:** `docs/superpowers/specs/2026-03-14-scoring-accuracy-design.md`

---

## File Structure

### 新規作成
- `src/prompts/scoring-accuracy.ts` — FN + FP 分析のシステムプロンプト・スキーマ
- `src/jobs/scoring-accuracy.ts` — メインジョブ（ghost-review.ts のリネーム + 拡張）
- `.github/workflows/cronjob_scoring-accuracy.yml` — workflow（リネーム）

### 変更
- `src/lib/constants/scoring.ts` — `GHOST_TRADING` → `SCORING_ACCURACY` リネーム
- `src/lib/slack.ts` — `notifyGhostReview` → `notifyScoringAccuracy` リネーム + 4象限通知
- `src/jobs/scoring-accuracy-report.ts` — 週次レポートに Precision/Recall トレンド追加
- `src/web/routes/cron.ts` — import パスとジョブキー変更
- `src/web/routes/contrarian.ts` — `GHOST_TRADING` → `SCORING_ACCURACY` 参照変更
- `src/jobs/market-scanner.ts` — `GHOST_TRADING` → `SCORING_ACCURACY` 参照変更
- `package.json` — npm script リネーム

### 削除
- `src/prompts/ghost-analysis.ts` — scoring-accuracy.ts に移行後に削除
- `src/jobs/ghost-review.ts` — scoring-accuracy.ts に移行後に削除
- `.github/workflows/cronjob_ghost-review.yml` — リネーム後に削除

---

## Chunk 1: 定数・プロンプト・Slack通知（基盤レイヤー）

### Task 1: 定数リネーム（GHOST_TRADING → SCORING_ACCURACY）

**Files:**
- Modify: `src/lib/constants/scoring.ts:115-124`

- [ ] **Step 1: 定数をリネーム**

`src/lib/constants/scoring.ts` の `GHOST_TRADING` を `SCORING_ACCURACY` にリネームし、FP 分析用の定数を追加する。

```typescript
export const SCORING_ACCURACY = {
  /** 追跡対象の最低スコア */
  MIN_SCORE_FOR_TRACKING: 60,
  /** FN分析（見逃し）の最大件数/日 */
  MAX_AI_FN_ANALYSIS: 5,
  /** FP分析（誤買い）の最大件数/日 */
  MAX_AI_FP_ANALYSIS: 5,
  /** FN分析トリガーの最低利益率(%) */
  MIN_PROFIT_PCT_FOR_FN_ANALYSIS: 1.0,
  /** FP分析トリガーの最低損失率(%) */
  MIN_LOSS_PCT_FOR_FP_ANALYSIS: 1.0,
  /** AI並列数 */
  AI_CONCURRENCY: 3,
} as const;
```

- [ ] **Step 2: 全参照箇所を更新**

以下のファイルで `GHOST_TRADING` → `SCORING_ACCURACY` に変更：

`src/jobs/market-scanner.ts:26` — import 文：
```typescript
// Before
import { GHOST_TRADING, ... } from "../lib/constants";
// After
import { SCORING_ACCURACY, ... } from "../lib/constants";
```

`src/jobs/market-scanner.ts:661` — 使用箇所：
```typescript
// Before
c.score.totalScore >= GHOST_TRADING.MIN_SCORE_FOR_TRACKING &&
// After
c.score.totalScore >= SCORING_ACCURACY.MIN_SCORE_FOR_TRACKING &&
```

`src/web/routes/contrarian.ts:16` — import 文：
```typescript
// Before
import { CONTRARIAN, GHOST_TRADING, SCORING, getSectorGroup } from "../../lib/constants";
// After
import { CONTRARIAN, SCORING_ACCURACY, SCORING, getSectorGroup } from "../../lib/constants";
```

`src/web/routes/contrarian.ts` — 使用箇所3件（123行, 887行, 953行）すべて `GHOST_TRADING` → `SCORING_ACCURACY` に置換。

- [ ] **Step 3: constants の re-export 確認**

`src/lib/constants/index.ts`（または `src/lib/constants.ts`）から `SCORING_ACCURACY` が正しくエクスポートされていることを確認。旧名 `GHOST_TRADING` のエクスポートを削除。

- [ ] **Step 4: market-scanner.ts の Ghost 関連コメント・変数名を更新**

`src/jobs/market-scanner.ts` 内の ghost 関連のコメントと変数名を更新。全6箇所：

- 657行: コメント `// Ghost追跡:` → `// 精度追跡:`
- 659行: `const ghostCandidates = ...` → `const accuracyTrackingCandidates = ...`
- 748行: コメント `// filtered + ghostCandidates を` → `// filtered + accuracyTrackingCandidates を`
- 751行: `...ghostCandidates,` → `...accuracyTrackingCandidates,`
- 866行: コメント `// Ghost追跡候補` → `// 精度追跡候補`
- 867行: `...ghostCandidates.map(` → `...accuracyTrackingCandidates.map(`

- [ ] **Step 5: contrarian.ts の Ghost 関連コメントを更新**

`src/web/routes/contrarian.ts` 内の ghost 関連コメントを更新：

- 50行: `// 最新日の上昇確認銘柄: ghost-review 後に...` → `// 最新日の上昇確認銘柄: scoring-accuracy 後に...`
- 119行付近: `// 低スコア上昇銘柄: ghost追跡下限...` → `// 低スコア上昇銘柄: 精度追跡下限...`

注意: `ghostProfitPct` は Prisma フィールド名のため変更しない。

- [ ] **Step 6: ビルド確認**

```bash
npx tsc --noEmit
```

Expected: `ghost-review.ts` が `GHOST_TRADING` を参照しているためビルドエラーが出る。Task 4 で `ghost-review.ts` を置き換えるまでの一時的な状態。

- [ ] **Step 7: コミット**

```bash
git add src/lib/constants/scoring.ts src/jobs/market-scanner.ts src/web/routes/contrarian.ts src/lib/constants/index.ts
git commit -m "refactor: GHOST_TRADING定数をSCORING_ACCURACYにリネーム"
```

---

### Task 2: FP分析プロンプト作成 + FN分析移行

**Files:**
- Create: `src/prompts/scoring-accuracy.ts`
- Delete: `src/prompts/ghost-analysis.ts`（内容を移行後）

- [ ] **Step 1: 新しいプロンプトファイルを作成**

`src/prompts/scoring-accuracy.ts` を作成する。既存の FN 分析（ghost-analysis.ts）をそのまま移行し、FP 分析を追加：

```typescript
/**
 * スコアリング精度分析プロンプト
 *
 * FN分析: 見送った銘柄のうち実際に上昇したケースの偽陰性分析
 * FP分析: 買った銘柄のうち実際に下落したケースの偽陽性分析
 */

// ===== FN分析（偽陰性 — 見送ったが上昇） =====

export const FN_ANALYSIS_SYSTEM_PROMPT = `あなたは投資判断の品質管理アナリストです。
自動売買システムが「見送った」銘柄のうち、実際には利益が出ていたケースについて分析してください。

あなたの役割:
1. なぜシステムの判断が外れたのか（偽陰性の原因）を特定する
2. 同じパターンが出た場合、次回はGoサインを出すべきか判断する
3. スコアリング閾値やAI判断基準の改善提案を述べる

重要: 結果論（後知恵バイアス）ではなく、事前に判断可能だった要素に焦点を当ててください。`;

export const FN_ANALYSIS_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "fn_analysis",
    strict: true,
    schema: {
      type: "object",
      properties: {
        misjudgmentType: {
          type: "string",
          enum: [
            "threshold_too_strict",
            "ai_overcautious",
            "pattern_not_recognized",
            "market_context_changed",
            "acceptable_miss",
          ],
          description:
            "偽陰性の分類: threshold_too_strict=閾値が厳しすぎた, ai_overcautious=AIが慎重すぎた, pattern_not_recognized=パターンを見落とした, market_context_changed=市場環境が変わった, acceptable_miss=見送りは妥当だった（結果論）",
        },
        analysis: {
          type: "string",
          description: "なぜ判断が外れたかの分析（100文字以内）",
        },
        recommendation: {
          type: "string",
          enum: [
            "lower_threshold",
            "adjust_ai_criteria",
            "add_pattern_rule",
            "no_change_needed",
          ],
          description:
            "改善提案: lower_threshold=閾値を下げるべき, adjust_ai_criteria=AI判断基準を調整すべき, add_pattern_rule=パターンルールを追加すべき, no_change_needed=変更不要",
        },
        reasoning: {
          type: "string",
          description: "改善提案の理由（150文字以内）",
        },
      },
      required: ["misjudgmentType", "analysis", "recommendation", "reasoning"],
      additionalProperties: false,
    },
  },
};

// ===== FP分析（偽陽性 — 買ったが下落） =====

export const FP_ANALYSIS_SYSTEM_PROMPT = `あなたは投資判断の品質管理アナリストです。
自動売買システムが「買い」と判断した銘柄のうち、実際には下落したケースについて分析してください。

あなたの役割:
1. なぜシステムが誤って買いシグナルを出したのか（偽陽性の原因）を特定する
2. スコアリングのどの要素が過大評価されていたか分析する
3. AI審査で見抜けなかったリスク要因を特定する

重要: 結果論（後知恵バイアス）ではなく、事前に判断可能だった要素に焦点を当ててください。`;

export const FP_ANALYSIS_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "fp_analysis",
    strict: true,
    schema: {
      type: "object",
      properties: {
        misjudgmentType: {
          type: "string",
          enum: [
            "score_inflated",
            "ai_overconfident",
            "market_shift",
            "acceptable_loss",
          ],
          description:
            "偽陽性の分類: score_inflated=スコアが過大評価, ai_overconfident=AIが楽観的すぎた, market_shift=市場環境が変化した, acceptable_loss=損失は許容範囲（想定内）",
        },
        analysis: {
          type: "string",
          description: "なぜ誤った買い判断をしたかの分析（100文字以内）",
        },
        recommendation: {
          type: "string",
          enum: [
            "tighten_threshold",
            "adjust_ai_criteria",
            "add_risk_filter",
            "no_change_needed",
          ],
          description:
            "改善提案: tighten_threshold=閾値を厳しくすべき, adjust_ai_criteria=AI判断基準を調整すべき, add_risk_filter=リスクフィルターを追加すべき, no_change_needed=変更不要",
        },
        reasoning: {
          type: "string",
          description: "改善提案の理由（150文字以内）",
        },
      },
      required: ["misjudgmentType", "analysis", "recommendation", "reasoning"],
      additionalProperties: false,
    },
  },
};
```

- [ ] **Step 2: ghost-analysis.ts を削除**

`src/prompts/ghost-analysis.ts` を削除する。

- [ ] **Step 3: ビルド確認**

```bash
npx tsc --noEmit
```

Expected: `ghost-analysis` の import エラーが出る（ghost-review.ts がまだ旧ファイルを参照）。これは Task 3 で解消するので OK。

- [ ] **Step 4: コミット**

```bash
git add src/prompts/scoring-accuracy.ts
git rm src/prompts/ghost-analysis.ts
git commit -m "refactor: ghost-analysisプロンプトをscoring-accuracyに移行しFP分析を追加"
```

---

### Task 3: Slack通知関数の更新

**Files:**
- Modify: `src/lib/slack.ts:370-423`

- [ ] **Step 1: notifyGhostReview を notifyScoringAccuracy にリネーム・拡張**

`src/lib/slack.ts` の `notifyGhostReview` 関数（370-423行）を以下に置き換える：

```typescript
/** スコアリング精度分析 日次通知 */
export async function notifyScoringAccuracy(data: {
  confusionMatrix: {
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
  };
  byRank: Record<string, { tp: number; fp: number; fn: number; tn: number; precision: number | null }>;
  fpList: Array<{
    tickerCode: string;
    score: number;
    rank: string;
    profitPct: number;
    misjudgmentType?: string;
  }>;
  fnList: Array<{
    tickerCode: string;
    score: number;
    rank: string;
    profitPct: number;
    rejectionReason: string;
    misjudgmentType?: string;
  }>;
}): Promise<void> {
  const { tp, fp, fn, tn, precision, recall, f1 } = data.confusionMatrix;

  const precisionStr = precision != null ? `${precision.toFixed(1)}%` : "N/A";
  const recallStr = recall != null ? `${recall.toFixed(1)}%` : "N/A";
  const f1Str = f1 != null ? `${f1.toFixed(1)}%` : "N/A";

  // ランク別 Precision
  const rankLines = Object.entries(data.byRank)
    .filter(([, v]) => v.tp + v.fp > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rank, v]) => {
      const total = v.tp + v.fp;
      const pStr = v.precision != null ? `${v.precision.toFixed(1)}%` : "N/A";
      return `${rank}: ${pStr} (${v.tp}/${total})`;
    })
    .join(" | ");

  const reasonLabel: Record<string, string> = {
    below_threshold: "閾値未達",
    ai_no_go: "AI見送り",
    disqualified: "即死ルール",
    market_halted: "市場停止",
  };

  // FP注目銘柄
  const fpLines =
    data.fpList
      .map(
        (m, i) =>
          `${i + 1}. ${m.tickerCode} [${m.rank}:${m.score}点] ${m.profitPct.toFixed(2)}%${m.misjudgmentType ? ` → ${m.misjudgmentType}` : ""}`,
      )
      .join("\n") || "なし";

  // FN注目銘柄
  const fnLines =
    data.fnList
      .map(
        (m, i) =>
          `${i + 1}. ${m.tickerCode} [${m.rank}:${m.score}点] +${m.profitPct.toFixed(2)}% (${reasonLabel[m.rejectionReason] || m.rejectionReason})${m.misjudgmentType ? ` → ${m.misjudgmentType}` : ""}`,
      )
      .join("\n") || "なし";

  const message = [
    "━━ 精度メトリクス ━━",
    `Precision: ${precisionStr} | Recall: ${recallStr} | F1: ${f1Str}`,
    "",
    "━━ 4象限 ━━",
    `✅ TP（買い→上昇）: ${tp}件  |  ❌ FP（買い→下落）: ${fp}件`,
    `⚠️ FN（見送り→上昇）: ${fn}件 | ✅ TN（見送り→下落）: ${tn}件`,
    "",
    rankLines ? `━━ ランク別 Precision ━━\n${rankLines}` : "",
    "",
    "━━ FP注目銘柄（買ったが下落） ━━",
    fpLines,
    "",
    "━━ FN注目銘柄（見逃し） ━━",
    fnLines,
  ]
    .filter(Boolean)
    .join("\n");

  await notifySlack({
    title: "📊 スコアリング精度分析",
    message,
    color: fp > 0 || fn > 0 ? "warning" : "good",
    fields: [
      { title: "Precision", value: precisionStr, short: true },
      { title: "Recall", value: recallStr, short: true },
      { title: "総スコアリング数", value: `${tp + fp + fn + tn}件`, short: true },
      { title: "F1", value: f1Str, short: true },
    ],
  });
}
```

- [ ] **Step 2: ビルド確認**

```bash
npx tsc --noEmit
```

Expected: `notifyGhostReview` の参照エラー（ghost-review.ts がまだ旧関数を使用）。Task 4 で解消。

- [ ] **Step 3: コミット**

```bash
git add src/lib/slack.ts
git commit -m "refactor: notifyGhostReviewをnotifyScoringAccuracyにリネーム・拡張"
```

---

## Chunk 2: メインジョブのリファクタ

### Task 4: scoring-accuracy.ts メインジョブ作成

**Files:**
- Create: `src/jobs/scoring-accuracy.ts`（ghost-review.ts ベースで大幅改修）
- Delete: `src/jobs/ghost-review.ts`

これが最も大きなタスク。ghost-review.ts の全549行を書き換える。変更点：

1. 全 ScoringRecord（accepted + rejected）の終値を取得する
2. 4象限分類（TP/FP/FN/TN）を追加する
3. FP銘柄の AI 分析を追加する
4. decisionAudit に confusionMatrix / byRank / fpAnalysis を追加する
5. Slack通知を新しい notifyScoringAccuracy に切り替える
6. ログ・コメントを「スコアリング精度分析」に統一する

- [ ] **Step 1: scoring-accuracy.ts を作成**

`src/jobs/scoring-accuracy.ts` を新規作成する。以下が完全なコード。

**ファイルヘッダー:**
```typescript
/**
 * スコアリング精度分析（16:10 JST / 平日）
 *
 * スコアリングシステムの判断精度を4象限で評価する。
 *
 * 1. 今日の全ScoringRecordを取得（accepted + rejected）
 * 2. 終値をバッチ取得（fetchStockQuotes）
 * 3. 4象限に分類（TP/FP/FN/TN）+ Precision/Recall/F1算出
 * 4. FN銘柄（見逃し）のAI分析
 * 5. FP銘柄（誤買い）のAI分析
 * 6. 結果をDB更新 + Slack通知
 * 7. 前日レコードに翌日価格を記録
 * 8. 意思決定整合性評価
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB, getDaysAgoForDB } from "../lib/date-utils";
import { SCORING_ACCURACY, CONTRARIAN, OPENAI_CONFIG } from "../lib/constants";
import { fetchStockQuotes } from "../core/market-data";
import { getOpenAIClient } from "../lib/openai";
import {
  FN_ANALYSIS_SYSTEM_PROMPT,
  FN_ANALYSIS_SCHEMA,
  FP_ANALYSIS_SYSTEM_PROMPT,
  FP_ANALYSIS_SCHEMA,
} from "../prompts/scoring-accuracy";
import { notifyScoringAccuracy, notifyContrarianWinners } from "../lib/slack";
import {
  isNoTradeDay,
  getTodayContrarianWinners,
  getContrarianHistoryBatch,
} from "../core/contrarian-analyzer";
import pLimit from "p-limit";
```

**型定義:**
```typescript
interface AnalysisResult {
  misjudgmentType: string;
  analysis: string;
  recommendation: string;
  reasoning: string;
}

interface RecordWithPnl {
  id: string;
  tickerCode: string;
  totalScore: number;
  rank: string;
  rejectionReason: string | null;
  aiDecision: string | null;
  aiReasoning: string | null;
  technicalBreakdown: unknown;
  patternBreakdown: unknown;
  liquidityBreakdown: unknown;
  entryPrice: number;
  closingPrice: number;
  pnlPct: number;
}
```

**FN分析プロンプト構築（既存ロジックそのまま）:**
```typescript
function buildFnAnalysisPrompt(record: {
  tickerCode: string;
  totalScore: number;
  rank: string;
  rejectionReason: string | null;
  aiReasoning: string | null;
  technicalBreakdown: unknown;
  patternBreakdown: unknown;
  liquidityBreakdown: unknown;
  entryPrice: number;
  closingPrice: number;
  pnlPct: number;
}): string {
  const reasonLabel: Record<string, string> = {
    below_threshold: "スコアが閾値未達（AI審査に送られなかった）",
    ai_no_go: "AIが定性的リスクを理由に否決",
    market_halted: "市場環境により取引停止（シャドウスコアリング）",
  };

  return `以下の銘柄は自動売買システムが見送りましたが、実際には利益が出ていました。

【銘柄】${record.tickerCode}
【スコア】${record.totalScore}/100（${record.rank}ランク）
【見送り理由】${reasonLabel[record.rejectionReason ?? ""] ?? record.rejectionReason}
${record.aiReasoning ? `【AIの否決理由】${record.aiReasoning}` : ""}
【スコア内訳】
  テクニカル: ${JSON.stringify(record.technicalBreakdown)}
  パターン: ${JSON.stringify(record.patternBreakdown)}
  流動性: ${JSON.stringify(record.liquidityBreakdown)}
【スコアリング時株価】¥${record.entryPrice.toLocaleString()}
【終値】¥${record.closingPrice.toLocaleString()}
【仮想損益】+${record.pnlPct.toFixed(2)}%

この銘柄について偽陰性分析を行ってください。`;
}
```

**FP分析プロンプト構築（新規）:**
```typescript
function buildFpAnalysisPrompt(record: {
  tickerCode: string;
  totalScore: number;
  rank: string;
  aiReasoning: string | null;
  technicalBreakdown: unknown;
  patternBreakdown: unknown;
  liquidityBreakdown: unknown;
  entryPrice: number;
  closingPrice: number;
  pnlPct: number;
}): string {
  return `以下の銘柄は自動売買システムが買いと判断しましたが、実際には下落しました。

【銘柄】${record.tickerCode}
【スコア】${record.totalScore}/100（${record.rank}ランク）
${record.aiReasoning ? `【AIの承認理由】${record.aiReasoning}` : ""}
【スコア内訳】
  テクニカル: ${JSON.stringify(record.technicalBreakdown)}
  パターン: ${JSON.stringify(record.patternBreakdown)}
  流動性: ${JSON.stringify(record.liquidityBreakdown)}
【スコアリング時株価】¥${record.entryPrice.toLocaleString()}
【終値】¥${record.closingPrice.toLocaleString()}
【損益】${record.pnlPct.toFixed(2)}%

この銘柄について偽陽性分析を行ってください。`;
}
```

**AI分析の共通ヘルパー:**
```typescript
async function runAiAnalysis(
  records: RecordWithPnl[],
  type: "fn" | "fp",
): Promise<Array<{ id: string; tickerCode: string; result: AnalysisResult }>> {
  if (records.length === 0) return [];

  const openai = getOpenAIClient();
  const aiLimit = pLimit(SCORING_ACCURACY.AI_CONCURRENCY);

  const systemPrompt =
    type === "fn" ? FN_ANALYSIS_SYSTEM_PROMPT : FP_ANALYSIS_SYSTEM_PROMPT;
  const schema = type === "fn" ? FN_ANALYSIS_SCHEMA : FP_ANALYSIS_SCHEMA;
  const buildPrompt = type === "fn" ? buildFnAnalysisPrompt : buildFpAnalysisPrompt;

  const analyses = await Promise.all(
    records.map((record) =>
      aiLimit(async () => {
        try {
          const response = await openai.chat.completions.create({
            model: OPENAI_CONFIG.MODEL,
            temperature: OPENAI_CONFIG.TEMPERATURE,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: buildPrompt(record) },
            ],
            response_format: schema,
          });

          const result = JSON.parse(
            response.choices[0].message.content!,
          ) as AnalysisResult;
          return { id: record.id, tickerCode: record.tickerCode, result };
        } catch (error) {
          console.error(`  AI ${type.toUpperCase()} 分析エラー: ${record.tickerCode}`, error);
          return null;
        }
      }),
    ),
  );

  return analyses.filter((a): a is NonNullable<typeof a> => a !== null);
}
```

**メイン関数:**
```typescript
export async function main() {
  console.log("=== スコアリング精度分析 開始 ===");

  const today = getTodayForDB();

  // 1. 今日の全ScoringRecordを取得（accepted + rejected）
  console.log("[1/8] ScoringRecord取得中...");
  const allRecords = await prisma.scoringRecord.findMany({
    where: {
      date: today,
      entryPrice: { not: null },
    },
  });

  if (allRecords.length === 0) {
    console.log("  スコアリングデータなし。終了します。");
    console.log("=== スコアリング精度分析 終了 ===");
    return;
  }

  const acceptedCount = allRecords.filter((r) => r.rejectionReason === null).length;
  const rejectedCount = allRecords.filter((r) => r.rejectionReason !== null).length;
  console.log(`  全銘柄: ${allRecords.length}件（accepted: ${acceptedCount}, rejected: ${rejectedCount}）`);

  // 2. 終値をバッチ取得
  console.log("[2/8] 終値取得中...");
  const tickerCodes = allRecords.map((r) => r.tickerCode);
  const quotes = await fetchStockQuotes(tickerCodes);

  const priceMap = new Map<string, number>();
  for (let i = 0; i < tickerCodes.length; i++) {
    const quote = quotes[i];
    if (quote) {
      priceMap.set(tickerCodes[i], quote.price);
    }
  }

  console.log(`  終値取得: ${priceMap.size}/${tickerCodes.length}件`);

  // 3. 全銘柄の損益算出
  console.log("[3/8] 損益算出中...");
  const allRecordsWithPnl: RecordWithPnl[] = allRecords
    .filter((r) => priceMap.has(r.tickerCode) && r.entryPrice)
    .map((r) => {
      const entryPrice = Number(r.entryPrice);
      const closingPrice = priceMap.get(r.tickerCode)!;
      const pnlPct = ((closingPrice - entryPrice) / entryPrice) * 100;

      return {
        id: r.id,
        tickerCode: r.tickerCode,
        totalScore: r.totalScore,
        rank: r.rank,
        rejectionReason: r.rejectionReason,
        aiDecision: r.aiDecision,
        aiReasoning: r.aiReasoning,
        technicalBreakdown: r.technicalBreakdown,
        patternBreakdown: r.patternBreakdown,
        liquidityBreakdown: r.liquidityBreakdown,
        entryPrice,
        closingPrice,
        pnlPct,
      };
    });

  // accepted / rejected に分離
  const acceptedRecords = allRecordsWithPnl.filter((r) => r.rejectionReason === null);
  const rejectedRecords = allRecordsWithPnl.filter((r) => r.rejectionReason !== null);

  // 4象限分類
  const tp = acceptedRecords.filter((r) => r.pnlPct > 0);
  const fp = acceptedRecords.filter((r) => r.pnlPct <= 0);
  const fn = rejectedRecords.filter((r) => r.pnlPct > 0);
  const tn = rejectedRecords.filter((r) => r.pnlPct <= 0);

  const precision =
    tp.length + fp.length > 0
      ? (tp.length / (tp.length + fp.length)) * 100
      : null;
  const recall =
    tp.length + fn.length > 0
      ? (tp.length / (tp.length + fn.length)) * 100
      : null;
  const f1 =
    precision != null && recall != null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  console.log(
    `  4象限: TP=${tp.length} FP=${fp.length} FN=${fn.length} TN=${tn.length}`,
  );
  console.log(
    `  Precision=${precision?.toFixed(1) ?? "N/A"}% Recall=${recall?.toFixed(1) ?? "N/A"}% F1=${f1?.toFixed(1) ?? "N/A"}%`,
  );

  // 4. DB更新（全銘柄の終値 + 損益）
  console.log("[4/8] DB更新中...");
  const updateLimit = pLimit(10);
  await Promise.all(
    allRecordsWithPnl.map((r) =>
      updateLimit(() =>
        prisma.scoringRecord.update({
          where: { id: r.id },
          data: {
            closingPrice: r.closingPrice,
            ghostProfitPct: r.pnlPct,
          },
        }),
      ),
    ),
  );

  console.log(`  DB更新: ${allRecordsWithPnl.length}件`);

  // 5. FN分析（見逃し銘柄のAI分析）
  console.log("[5/8] FN分析中...");
  const fnTargets = fn
    .filter((r) => r.pnlPct >= SCORING_ACCURACY.MIN_PROFIT_PCT_FOR_FN_ANALYSIS)
    .sort((a, b) => b.pnlPct - a.pnlPct)
    .slice(0, SCORING_ACCURACY.MAX_AI_FN_ANALYSIS);

  const fnResults = await runAiAnalysis(fnTargets, "fn");
  const dbLimit = pLimit(10);
  await Promise.all(
    fnResults.map((a) =>
      dbLimit(() =>
        prisma.scoringRecord.update({
          where: { id: a.id },
          data: { ghostAnalysis: JSON.stringify(a.result) },
        }),
      ),
    ),
  );
  console.log(
    fnTargets.length > 0
      ? `  FN分析完了: ${fnResults.length}件`
      : `  FN分析対象なし（利益率${SCORING_ACCURACY.MIN_PROFIT_PCT_FOR_FN_ANALYSIS}%以上の銘柄なし）`,
  );

  // 6. FP分析（誤買い銘柄のAI分析）
  console.log("[6/8] FP分析中...");
  const fpTargets = fp
    .filter((r) => r.pnlPct <= -SCORING_ACCURACY.MIN_LOSS_PCT_FOR_FP_ANALYSIS)
    .sort((a, b) => a.pnlPct - b.pnlPct)
    .slice(0, SCORING_ACCURACY.MAX_AI_FP_ANALYSIS);

  const fpResults = await runAiAnalysis(fpTargets, "fp");
  await Promise.all(
    fpResults.map((a) =>
      dbLimit(() =>
        prisma.scoringRecord.update({
          where: { id: a.id },
          data: { ghostAnalysis: JSON.stringify(a.result) },
        }),
      ),
    ),
  );
  console.log(
    fpTargets.length > 0
      ? `  FP分析完了: ${fpResults.length}件`
      : `  FP分析対象なし（損失率${SCORING_ACCURACY.MIN_LOSS_PCT_FOR_FP_ANALYSIS}%以上の銘柄なし）`,
  );

  // 7. Slack通知
  console.log("[7/8] Slack通知中...");
  const fnAnalysisMap = new Map(fnResults.map((a) => [a.tickerCode, a.result]));
  const fpAnalysisMap = new Map(fpResults.map((a) => [a.tickerCode, a.result]));

  // ランク別精度
  const byRank: Record<string, { tp: number; fp: number; fn: number; tn: number; precision: number | null }> = {};
  for (const r of allRecordsWithPnl) {
    if (!byRank[r.rank]) {
      byRank[r.rank] = { tp: 0, fp: 0, fn: 0, tn: 0, precision: null };
    }
    const bucket = byRank[r.rank];
    if (r.rejectionReason === null) {
      if (r.pnlPct > 0) bucket.tp++;
      else bucket.fp++;
    } else {
      if (r.pnlPct > 0) bucket.fn++;
      else bucket.tn++;
    }
  }
  for (const v of Object.values(byRank)) {
    v.precision =
      v.tp + v.fp > 0 ? (v.tp / (v.tp + v.fp)) * 100 : null;
  }

  await notifyScoringAccuracy({
    confusionMatrix: {
      tp: tp.length,
      fp: fp.length,
      fn: fn.length,
      tn: tn.length,
      precision,
      recall,
      f1,
    },
    byRank,
    fpList: fp
      .sort((a, b) => a.pnlPct - b.pnlPct)
      .slice(0, 10)
      .map((r) => ({
        tickerCode: r.tickerCode,
        score: r.totalScore,
        rank: r.rank,
        profitPct: r.pnlPct,
        misjudgmentType: fpAnalysisMap.get(r.tickerCode)?.misjudgmentType,
      })),
    fnList: fn
      .sort((a, b) => b.pnlPct - a.pnlPct)
      .slice(0, 10)
      .map((r) => ({
        tickerCode: r.tickerCode,
        score: r.totalScore,
        rank: r.rank,
        profitPct: r.pnlPct,
        rejectionReason: r.rejectionReason ?? "unknown",
        misjudgmentType: fnAnalysisMap.get(r.tickerCode)?.misjudgmentType,
      })),
  });

  // 8. 前日レコードの翌日価格を記録
  console.log("[8/8] 前日レコードに翌日価格を記録中...");
  const yesterday = getDaysAgoForDB(1);
  const prevDayRecords = await prisma.scoringRecord.findMany({
    where: {
      date: yesterday,
      closingPrice: { not: null },
      nextDayClosingPrice: null,
    },
    select: { id: true, tickerCode: true, closingPrice: true },
  });

  if (prevDayRecords.length > 0) {
    const prevTickers = prevDayRecords.map((r) => r.tickerCode);
    const prevQuotes = await fetchStockQuotes(prevTickers);
    const nextDayPriceMap = new Map<string, number>();
    for (let i = 0; i < prevTickers.length; i++) {
      const quote = prevQuotes[i];
      if (quote) nextDayPriceMap.set(prevTickers[i], quote.price);
    }

    const nextDayLimit = pLimit(10);
    await Promise.all(
      prevDayRecords
        .filter((r) => nextDayPriceMap.has(r.tickerCode))
        .map((r) =>
          nextDayLimit(() => {
            const nextDayPrice = nextDayPriceMap.get(r.tickerCode)!;
            const prevClose = Number(r.closingPrice);
            const nextDayProfitPct =
              prevClose > 0
                ? ((nextDayPrice - prevClose) / prevClose) * 100
                : 0;
            return prisma.scoringRecord.update({
              where: { id: r.id },
              data: { nextDayClosingPrice: nextDayPrice, nextDayProfitPct },
            });
          }),
        ),
    );
    console.log(`  翌日価格記録: ${nextDayPriceMap.size}/${prevDayRecords.length}件`);
  } else {
    console.log("  前日レコードなし（スキップ）");
  }

  // 意思決定整合性評価
  console.log("[8.5/9] 意思決定整合性評価中...");
  try {
    const todayAssessment = await prisma.marketAssessment.findUnique({
      where: { date: today },
    });

    const allTodayRecords = await prisma.scoringRecord.findMany({
      where: { date: today },
      select: { aiDecision: true, rejectionReason: true, rank: true },
    });
    const aiGoCount = allTodayRecords.filter((r) => r.aiDecision === "go").length;
    const rankCounts = allTodayRecords.reduce(
      (acc, r) => { acc[r.rank] = (acc[r.rank] || 0) + 1; return acc; },
      {} as Record<string, number>,
    );

    const marketHaltedToday = rejectedRecords.filter((r) => r.rejectionReason === "market_halted");
    const aiNoGoToday = rejectedRecords.filter((r) => r.rejectionReason === "ai_no_go");
    const belowThresholdToday = rejectedRecords.filter((r) => r.rejectionReason === "below_threshold");

    const mhRising = marketHaltedToday.filter((r) => r.pnlPct > 0);
    const aiRising = aiNoGoToday.filter((r) => r.pnlPct > 0);
    const btRising = belowThresholdToday.filter((r) => r.pnlPct > 0);

    const auditData = {
      scoringSummary: {
        totalScored: allTodayRecords.length,
        aiApproved: aiGoCount,
        rankBreakdown: rankCounts,
      },
      marketHalt: todayAssessment
        ? {
            wasHalted: !todayAssessment.shouldTrade,
            sentiment: todayAssessment.sentiment,
            nikkeiChange: todayAssessment.nikkeiChange
              ? Number(todayAssessment.nikkeiChange)
              : null,
            totalScored: marketHaltedToday.length,
            risingCount: mhRising.length,
            risingRate:
              marketHaltedToday.length > 0
                ? Math.round((mhRising.length / marketHaltedToday.length) * 100)
                : null,
          }
        : null,
      aiRejection: {
        total: aiNoGoToday.length,
        correctlyRejected: aiNoGoToday.length - aiRising.length,
        falselyRejected: aiRising.length,
        accuracy:
          aiNoGoToday.length > 0
            ? Math.round(((aiNoGoToday.length - aiRising.length) / aiNoGoToday.length) * 100)
            : null,
      },
      scoreThreshold: {
        total: belowThresholdToday.length,
        rising: btRising.length,
        avgRisingPct:
          btRising.length > 0
            ? btRising.reduce((s, r) => s + r.pnlPct, 0) / btRising.length
            : null,
      },
      // 新規: 4象限メトリクス
      confusionMatrix: {
        tp: tp.length,
        fp: fp.length,
        fn: fn.length,
        tn: tn.length,
        precision,
        recall,
        f1,
      },
      byRank,
      fpAnalysis: fpResults.map((a) => {
        const record = fp.find((r) => r.id === a.id)!;
        return {
          tickerCode: a.tickerCode,
          score: record.totalScore,
          rank: record.rank,
          profitPct: record.pnlPct,
          misjudgmentType: a.result.misjudgmentType,
        };
      }),
      overallVerdict: "",
    };

    // AI verdict 生成
    const rankSummary = Object.entries(auditData.scoringSummary.rankBreakdown)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rank, count]) => `${rank}=${count}`)
      .join(", ");

    const verdictPrompt = `本日の自動売買システムの意思決定を評価してください。

【スコアリング全体像】
- 総スコアリング銘柄: ${auditData.scoringSummary.totalScored}件（${rankSummary}）
- AI承認（go）: ${auditData.scoringSummary.aiApproved}件
- AI却下（no_go）: ${auditData.aiRejection.total}件

【4象限精度】
- Precision: ${precision?.toFixed(1) ?? "N/A"}% | Recall: ${recall?.toFixed(1) ?? "N/A"}% | F1: ${f1?.toFixed(1) ?? "N/A"}%
- TP=${tp.length} FP=${fp.length} FN=${fn.length} TN=${tn.length}

【市場停止判断】
${auditData.marketHalt ? `- 判定: ${auditData.marketHalt.wasHalted ? "取引停止" : "取引実行"}（センチメント: ${auditData.marketHalt.sentiment}）
- 日経変化率: ${auditData.marketHalt.nikkeiChange != null ? `${auditData.marketHalt.nikkeiChange.toFixed(2)}%` : "不明"}
- 市場停止による見送り: ${auditData.marketHalt.totalScored}件のうち上昇 ${auditData.marketHalt.risingCount}件 (${auditData.marketHalt.risingRate ?? "-"}%)` : "- 市場評価データなし"}

【AI却下精度】
${auditData.aiRejection.total > 0 ? `- 却下銘柄: ${auditData.aiRejection.total}件
- 正確な却下: ${auditData.aiRejection.correctlyRejected}件
- 誤却下: ${auditData.aiRejection.falselyRejected}件
- 精度: ${auditData.aiRejection.accuracy}%` : "- AI却下銘柄なし"}

200文字以内で本日の意思決定の整合性を評価してください。`;

    try {
      const openai = getOpenAIClient();
      const verdictResponse = await openai.chat.completions.create({
        model: OPENAI_CONFIG.MODEL,
        temperature: 0.3,
        messages: [{ role: "user", content: verdictPrompt }],
        max_tokens: 200,
      });
      auditData.overallVerdict = verdictResponse.choices[0].message.content ?? "";
    } catch (e) {
      console.error("  AI verdict 生成エラー:", e);
    }

    await prisma.tradingDailySummary.upsert({
      where: { date: today },
      create: {
        date: today,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        portfolioValue: 0,
        cashBalance: 0,
        decisionAudit: auditData as object,
      },
      update: { decisionAudit: auditData as object },
    });

    console.log(
      `  整合性評価保存: Precision=${precision?.toFixed(1) ?? "N/A"}% Recall=${recall?.toFixed(1) ?? "N/A"}%`,
    );
  } catch (error) {
    console.error("  意思決定整合性評価エラー:", error);
  }

  // 逆行ウィナー分析（市場停止日のみ）
  const noTrade = await isNoTradeDay();
  if (noTrade) {
    console.log("[9/9] 逆行ウィナー分析中...");
    const winners = await getTodayContrarianWinners();

    if (winners.length > 0) {
      const historyMap = await getContrarianHistoryBatch(
        winners.map((w) => w.tickerCode),
      );

      const totalHalted = rejectedRecords.filter(
        (r) => r.rejectionReason === "market_halted",
      ).length;

      await notifyContrarianWinners({
        totalHalted,
        winners: winners
          .slice(0, CONTRARIAN.MAX_REPORT_WINNERS)
          .map((w) => ({
            tickerCode: w.tickerCode,
            score: w.totalScore,
            rank: w.rank,
            ghostProfitPct: w.ghostProfitPct,
            contrarianWins: historyMap.get(w.tickerCode)?.wins,
          })),
      });

      console.log(`  逆行ウィナー: ${winners.length}銘柄通知`);
    } else {
      console.log("  逆行ウィナーなし");
    }
  }

  console.log("=== スコアリング精度分析 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("scoring-accuracy");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("スコアリング精度分析エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
```

- [ ] **Step 2: ghost-review.ts を削除**

```bash
git rm src/jobs/ghost-review.ts
```

- [ ] **Step 3: ビルド確認**

```bash
npx tsc --noEmit
```

Expected: `cron.ts` でのインポートエラー（Task 5 で解消）

- [ ] **Step 4: コミット**

```bash
git add src/jobs/scoring-accuracy.ts
git commit -m "feat: ghost-reviewをscoring-accuracyに拡張（4象限精度分析+FP分析）"
```

---

## Chunk 3: インフラ・週次レポート

### Task 5: cron ルート・package.json・worker 更新

**Files:**
- Modify: `src/web/routes/cron.ts:24,48`
- Modify: `package.json:17`
- Modify: `src/worker.ts:118`（コメントのみ）

- [ ] **Step 1: cron.ts の import とジョブキーを更新**

`src/web/routes/cron.ts`:

24行目のインポート:
```typescript
// Before
import { main as runGhostReview } from "../../jobs/ghost-review";
// After
import { main as runScoringAccuracy } from "../../jobs/scoring-accuracy";
```

48行目のジョブ定義:
```typescript
// Before
"ghost-review": { fn: runGhostReview, requiresMarketDay: true },
// After
"scoring-accuracy": { fn: runScoringAccuracy, requiresMarketDay: true },
```

- [ ] **Step 2: package.json の npm script を更新**

```json
// Before
"ghost": "tsx src/jobs/ghost-review.ts",
// After
"scoring-accuracy": "tsx src/jobs/scoring-accuracy.ts",
```

- [ ] **Step 3: worker.ts のコメントを更新**

`src/worker.ts:118`:
```typescript
// Before
// ※ news-collector, market-scanner, ghost-review, weekly-review は
// After
// ※ news-collector, market-scanner, scoring-accuracy, weekly-review は
```

- [ ] **Step 4: ビルド確認**

```bash
npx tsc --noEmit
```

Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/web/routes/cron.ts package.json src/worker.ts
git commit -m "refactor: cron/package.jsonのghost-review参照をscoring-accuracyに更新"
```

---

### Task 6: GitHub Actions workflow リネーム

**Files:**
- Create: `.github/workflows/cronjob_scoring-accuracy.yml`
- Delete: `.github/workflows/cronjob_ghost-review.yml`

- [ ] **Step 1: 新しい workflow ファイルを作成**

`.github/workflows/cronjob_scoring-accuracy.yml` を作成。既存の `cronjob_ghost-review.yml` をベースに以下を変更：

- `name`: `"[cron-job.org] Scoring Accuracy"`
- `concurrency.group`: `scoring-accuracy`
- ジョブ名: `ghost-review` → `scoring-accuracy`
- `run: npm run ghost` → `run: npm run scoring-accuracy`
- Slack通知のタイトル・メッセージを「スコアリング精度分析」に変更

```yaml
name: "[cron-job.org] Scoring Accuracy"

on:
  workflow_dispatch:
    inputs:
      skip_market_day_check:
        description: "休場日チェックをスキップ"
        type: boolean
        default: false

concurrency:
  group: scoring-accuracy
  cancel-in-progress: false

env:
  DATABASE_URL: ${{ secrets.DATABASE_URL }}
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
  MARKET_DATA_PROVIDER: yahoo

jobs:
  check-market-day:
    runs-on: ubuntu-latest
    outputs:
      should_run: ${{ steps.result.outputs.should_run }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: ".tool-versions"
          cache: "npm"
      - run: npm ci
      - run: npx prisma generate

      - name: Check market day and system active
        id: check
        run: |
          RESULT=$(npx tsx scripts/check-market-day.ts)
          echo "should_run=$RESULT" >> "$GITHUB_OUTPUT"

      - name: Determine final result
        id: result
        run: |
          SKIP="${{ github.event.inputs.skip_market_day_check }}"
          CHECK="${{ steps.check.outputs.should_run }}"
          if [ "$SKIP" = "true" ]; then
            echo "should_run=true" >> "$GITHUB_OUTPUT"
          else
            echo "should_run=$CHECK" >> "$GITHUB_OUTPUT"
          fi

  scoring-accuracy:
    needs: check-market-day
    if: needs.check-market-day.outputs.should_run == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: ".tool-versions"
          cache: "npm"
      - run: npm ci
      - run: npx prisma generate
      - run: npm run scoring-accuracy

  notify-success:
    needs: scoring-accuracy
    if: success()
    runs-on: ubuntu-latest
    steps:
      - name: Notify Slack on success
        uses: rtCamp/action-slack-notify@v2
        env:
          SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK_URL }}
          SLACK_TITLE: "スコアリング精度分析 完了"
          SLACK_MESSAGE: "スコアリング精度分析が正常に完了しました"
          SLACK_COLOR: good
          SLACK_FOOTER: "Stock Buddy"

  notify-failure:
    needs: scoring-accuracy
    if: failure()
    runs-on: ubuntu-latest
    steps:
      - name: Notify Slack on failure
        uses: rtCamp/action-slack-notify@v2
        env:
          SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK_URL }}
          SLACK_TITLE: "スコアリング精度分析 失敗"
          SLACK_MESSAGE: |
            スコアリング精度分析が失敗しました。
            詳細はGitHub Actionsログを確認してください。
          SLACK_COLOR: danger
          SLACK_FOOTER: "Stock Buddy"
```

- [ ] **Step 2: 旧 workflow を削除**

```bash
git rm .github/workflows/cronjob_ghost-review.yml
```

- [ ] **Step 3: コミット**

```bash
git add .github/workflows/cronjob_scoring-accuracy.yml
git commit -m "ci: ghost-review workflowをscoring-accuracyにリネーム"
```

---

### Task 7: 週次レポートの拡張

**Files:**
- Modify: `src/jobs/scoring-accuracy-report.ts`
- Modify: `src/lib/slack.ts`（`notifyScoringAccuracyReport` の引数拡張）

- [ ] **Step 1: ファイルヘッダーコメントから「ゴースト」を削除**

`src/jobs/scoring-accuracy-report.ts` のファイルヘッダー（1-11行目）を更新：

```typescript
/**
 * スコアリング精度レポート（土曜 11:00 JST）
 *
 * スコアリング実績データをもとにシステムの弱点を定量集計し、Slackに送信する。
 *
 * 1. 直近7日間のScoringRecordを取得（実績あり）
 * 2. カテゴリ別の見逃し要因分析
 * 3. ランク別の的中率集計
 * 4. rejectionReason別の機会損失集計
 * 5. 週次/月次トレンド比較
 * 6. 4象限メトリクス（Precision/Recall/F1）トレンド
 * 7. FPパターン分布
 * 8. Slackにレポート送信
 */
```

- [ ] **Step 2: 週次レポートに Precision/Recall トレンド + FPパターン分布を追加**

`src/jobs/scoring-accuracy-report.ts` の `main()` 関数内、既存の集計の後に以下を追加:

```typescript
  // 4象限メトリクスの集計（decisionAudit から取得）
  console.log("  4象限メトリクス集計中...");
  const dailySummaries = await prisma.tradingDailySummary.findMany({
    where: {
      date: {
        gte: getDaysAgoForDB(SCORING_ACCURACY_REPORT.MONTHLY_LOOKBACK_DAYS),
      },
      decisionAudit: { not: Prisma.DbNull },
    },
    select: { date: true, decisionAudit: true },
    orderBy: { date: "asc" },
  });

  interface ConfusionMatrix {
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
  }

  const weeklyDate = getDaysAgoForDB(SCORING_ACCURACY_REPORT.WEEKLY_LOOKBACK_DAYS);

  const extractMatrix = (audit: unknown): ConfusionMatrix | null => {
    const data = audit as Record<string, unknown> | null;
    return (data?.confusionMatrix as ConfusionMatrix) ?? null;
  };

  const weeklyMatrices = dailySummaries
    .filter((s) => s.date >= weeklyDate)
    .map((s) => extractMatrix(s.decisionAudit))
    .filter((m): m is ConfusionMatrix => m !== null);

  const monthlyMatrices = dailySummaries
    .map((s) => extractMatrix(s.decisionAudit))
    .filter((m): m is ConfusionMatrix => m !== null);

  const avgMetric = (
    matrices: ConfusionMatrix[],
    key: "precision" | "recall" | "f1",
  ): number | null => {
    const values = matrices
      .map((m) => m[key])
      .filter((v): v is number => v !== null);
    return values.length > 0
      ? values.reduce((s, v) => s + v, 0) / values.length
      : null;
  };

  const precisionTrend = {
    weekly: avgMetric(weeklyMatrices, "precision"),
    monthly: avgMetric(monthlyMatrices, "precision"),
  };
  const recallTrend = {
    weekly: avgMetric(weeklyMatrices, "recall"),
    monthly: avgMetric(monthlyMatrices, "recall"),
  };
  const f1Trend = {
    weekly: avgMetric(weeklyMatrices, "f1"),
    monthly: avgMetric(monthlyMatrices, "f1"),
  };

  console.log(
    `  Precision: 週次=${precisionTrend.weekly?.toFixed(1) ?? "N/A"}% 月次=${precisionTrend.monthly?.toFixed(1) ?? "N/A"}%`,
  );

  // FPパターン分布（週次の ghostAnalysis から集計）
  // weeklyRaw は accepted + rejected 両方含む（ghostProfitPct != null でフィルタ済み）
  // FP分析結果は rejected=null（accepted）かつ ghostAnalysis が存在するレコード
  const fpPatternDist: Record<string, number> = {};
  for (const r of weeklyRaw) {
    if (r.rejectionReason !== null || !r.ghostAnalysis) continue;
    try {
      const analysis = JSON.parse(r.ghostAnalysis as string) as { misjudgmentType: string };
      fpPatternDist[analysis.misjudgmentType] = (fpPatternDist[analysis.misjudgmentType] || 0) + 1;
    } catch {
      // skip invalid JSON
    }
  }
```

`notifyScoringAccuracyReport` の呼び出しに新しいデータを追加:

```typescript
  await notifyScoringAccuracyReport({
    // 既存フィールド（そのまま）
    periodLabel,
    totalRecords: weeklyRows.length,
    missedCount: missedStocks.length,
    categoryWeakness,
    rankAccuracy,
    rejectionCost,
    weeklyStats,
    monthlyStats,
    // 新規追加
    precisionTrend,
    recallTrend,
    f1Trend,
    fpPatternDist,
  });
```

ファイル先頭に Prisma の import を追加：

```typescript
import { Prisma } from "@prisma/client";
```

- [ ] **Step 3: Slack通知関数の引数を拡張**

`src/lib/slack.ts` の `notifyScoringAccuracyReport` 関数の引数型に以下を追加:

```typescript
  precisionTrend: { weekly: number | null; monthly: number | null };
  recallTrend: { weekly: number | null; monthly: number | null };
  f1Trend: { weekly: number | null; monthly: number | null };
  fpPatternDist: Record<string, number>;
```

通知メッセージの `message` 配列の末尾（`trendLines` の後）に4象限トレンドセクションと FP パターン分布を追加：

```typescript
    const fmtPct = (v: number | null) =>
      v != null ? `${v.toFixed(1)}%` : "N/A";

    const matrixTrend = [
      "━━ 4象限メトリクス推移 ━━",
      `Precision: 週次${fmtPct(data.precisionTrend.weekly)} / 月次${fmtPct(data.precisionTrend.monthly)}`,
      `Recall: 週次${fmtPct(data.recallTrend.weekly)} / 月次${fmtPct(data.recallTrend.monthly)}`,
      `F1: 週次${fmtPct(data.f1Trend.weekly)} / 月次${fmtPct(data.f1Trend.monthly)}`,
    ].join("\n");

    const fpPatternLabel: Record<string, string> = {
      score_inflated: "スコア過大評価",
      ai_overconfident: "AI楽観",
      market_shift: "市場変化",
      acceptable_loss: "許容範囲",
    };
    const fpPatternEntries = Object.entries(data.fpPatternDist);
    const fpPatternLines = fpPatternEntries.length > 0
      ? fpPatternEntries
          .sort(([, a], [, b]) => b - a)
          .map(([type, count]) => `${fpPatternLabel[type] || type}: ${count}件`)
          .join(" / ")
      : "データなし";
    const fpPatternSection = `━━ FPパターン分布 ━━\n${fpPatternLines}`;
```

`matrixTrend` と `fpPatternSection` を既存の `message` 配列に追加する。

- [ ] **Step 4: ビルド確認**

```bash
npx tsc --noEmit
```

Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/jobs/scoring-accuracy-report.ts src/lib/slack.ts
git commit -m "feat: 週次レポートにPrecision/Recall/F1トレンド+FPパターン分布を追加"
```

---

### Task 8: cron-job.org のジョブタイトル更新

**Files:** なし（API 操作のみ）

- [ ] **Step 1: cron-job.org のジョブ一覧を確認**

```bash
curl -s -H "Authorization: Bearer $CRONJOB_API_KEY" \
  "https://api.cron-job.org/jobs" | jq '.jobs[] | select(.title | test("ghost|Ghost")) | {jobId, title, url}'
```

Expected: ghost-review のジョブが見つかる

- [ ] **Step 2: ジョブタイトルと URL を更新**

`{jobId}` を Step 1 で取得した値に置き換え、URL の `ghost-review` を `scoring-accuracy` に変更:

```bash
curl -s -X PATCH -H "Authorization: Bearer $CRONJOB_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.cron-job.org/jobs/{jobId}" \
  -d '{
    "job": {
      "title": "Scoring Accuracy",
      "url": "https://{APP_URL}/api/cron/scoring-accuracy"
    }
  }'
```

- [ ] **Step 3: 更新確認**

```bash
curl -s -H "Authorization: Bearer $CRONJOB_API_KEY" \
  "https://api.cron-job.org/jobs/{jobId}" | jq '{title: .jobDetails.title, url: .jobDetails.url}'
```

Expected: タイトルと URL が更新されている

---

### Task 9: 仕様書の更新

**Files:**
- Modify: `docs/specs/batch-processing.md`

- [ ] **Step 1: batch-processing.md 内の ghost-review 関連記述を更新**

`ghost-review` → `scoring-accuracy` にリネームし、処理内容の説明を「スコアリング精度分析（4象限精度分析 + AI分析）」に更新する。

- [ ] **Step 2: コミット**

```bash
git add docs/specs/batch-processing.md
git commit -m "docs: batch-processing.mdのghost-reviewをscoring-accuracyに更新"
```

---

### Task 10: 最終ビルド確認・設計ファイル削除

- [ ] **Step 1: 全体ビルド確認**

```bash
npx tsc --noEmit
```

Expected: エラーなし

- [ ] **Step 2: `GHOST_TRADING` の残存参照がないことを確認**

```bash
rg "GHOST_TRADING|ghost-review|ghost_review|notifyGhostReview|ghost-analysis|ghostCandidates" src/ --type ts
```

Expected: マッチなし

注意: `ghostProfitPct`、`ghostAnalysis` は Prisma スキーマのフィールド名（DB カラム名）のため意図的に残す。スキーマ変更なしの方針。

- [ ] **Step 3: 設計ファイルを削除**

```bash
rm docs/superpowers/specs/2026-03-14-scoring-accuracy-design.md
rm docs/superpowers/plans/2026-03-14-scoring-accuracy.md
```

- [ ] **Step 4: 最終コミット**

```bash
git add -A
git commit -m "chore: 実装済み設計ファイルを削除"
```
