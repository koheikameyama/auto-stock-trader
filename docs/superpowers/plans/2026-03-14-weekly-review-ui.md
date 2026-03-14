# 週次レビューUI表示 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 週次レビュー結果をDBに保存し、`/weekly` ページで過去履歴・累積損益チャートと共に閲覧可能にする

**Architecture:** `TradingWeeklySummary` モデルをPrismaに追加し、既存の `weekly-review.ts` ジョブにDB保存を追加。UIは既存のHono SSRパターン（`history.ts` と同様）で `/weekly` ルートを新設。

**Tech Stack:** Prisma, Hono SSR, OpenAI structured output, dayjs, SVG sparklineChart

**Spec:** `docs/superpowers/specs/2026-03-14-weekly-review-ui-design.md`

---

## Chunk 1: DB・定数・ユーティリティ

### Task 1: Prismaスキーマに `TradingWeeklySummary` モデルを追加

**Files:**
- Modify: `prisma/schema.prisma:305`（`TradingDailySummary` の直後）

- [ ] **Step 1: スキーマにモデルを追加**

`prisma/schema.prisma` の `TradingDailySummary` モデル（305行目の `}` ）の直後に追加:

```prisma
// 週次取引サマリー
model TradingWeeklySummary {
  id             String   @id @default(cuid())
  weekStart      DateTime @db.Date           // 月曜日
  weekEnd        DateTime @db.Date @unique   // 金曜日（upsertキー）
  tradingDays    Int
  totalTrades    Int      @default(0)
  wins           Int      @default(0)
  losses         Int      @default(0)
  totalPnl       Decimal  @default(0) @db.Decimal(12, 2)
  portfolioValue Decimal  @db.Decimal(12, 0)
  cashBalance    Decimal  @db.Decimal(12, 0)
  aiReview       Json                        // 構造化AIレビュー

  createdAt DateTime @default(now())

  @@index([weekEnd(sort: Desc)])
}
```

- [ ] **Step 2: マイグレーションを作成**

Run: `npx prisma migrate dev --name add_trading_weekly_summary`

**重要:** 実行前に `grep DATABASE_URL .env` でローカルDBであることを確認すること。

- [ ] **Step 3: Prisma Clientを生成**

Run: `npx prisma generate`

- [ ] **Step 4: コミット**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: TradingWeeklySummary モデルを追加"
```

### Task 2: `jstDateAsUTC` を export に変更

**Files:**
- Modify: `src/lib/date-utils.ts:26`

- [ ] **Step 1: `function` を `export function` に変更**

`src/lib/date-utils.ts` 26行目:

```typescript
// Before
function jstDateAsUTC(d: dayjs.Dayjs): Date {

// After
export function jstDateAsUTC(d: dayjs.Dayjs): Date {
```

- [ ] **Step 2: 既存の利用箇所に影響がないことを確認**

`jstDateAsUTC` は同ファイル内の `getTodayForDB`, `getDaysAgoForDB`, `toJSTDateForDB`, `getStartOfDayJST` から使われている。export にしても既存動作に影響なし。

- [ ] **Step 3: コミット**

```bash
git add src/lib/date-utils.ts
git commit -m "refactor: jstDateAsUTC を export に変更"
```

### Task 3: `QUERY_LIMITS` に `WEEKLY_SUMMARIES` を追加

**Files:**
- Modify: `src/lib/constants/web.ts:17-22`

- [ ] **Step 1: QUERY_LIMITS に追加**

`src/lib/constants/web.ts` の `QUERY_LIMITS` オブジェクトに `WEEKLY_SUMMARIES: 12` を追加:

```typescript
export const QUERY_LIMITS = {
  ORDERS_TODAY: 30,
  POSITIONS_CLOSED: 20,
  HISTORY_SUMMARIES: 30,
  SCORING_RECORDS: 50,
  WEEKLY_SUMMARIES: 12,
} as const;
```

- [ ] **Step 2: コミット**

```bash
git add src/lib/constants/web.ts
git commit -m "feat: QUERY_LIMITS に WEEKLY_SUMMARIES を追加"
```

---

## Chunk 2: ジョブ変更（`weekly-review.ts`）

### Task 4: `weekly-review.ts` に構造化出力 + DB保存を追加

**Files:**
- Modify: `src/jobs/weekly-review.ts`

- [ ] **Step 1: import に `jstDateAsUTC` と `utc`/`timezone` プラグインを追加**

`src/jobs/weekly-review.ts` の先頭 import セクション（1-13行目）を以下に置換。既存の `prisma`, `OPENAI_CONFIG`, `WEEKLY_REVIEW`, `getOpenAIClient`, `notifySlack`, `dayjs` は維持し、`jstDateAsUTC` と dayjs プラグインを追加:

```typescript
/**
 * 週次レビュー（土曜 10:00 JST）
 *
 * 1. 週間パフォーマンス集計
 * 2. AIによる戦略レビュー（構造化出力）
 * 3. DB保存
 * 4. Slackにレポート送信
 */

import { prisma } from "../lib/prisma";
import { OPENAI_CONFIG, WEEKLY_REVIEW } from "../lib/constants";
import { getOpenAIClient } from "../lib/openai";
import { notifySlack } from "../lib/slack";
import { jstDateAsUTC } from "../lib/date-utils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

const JST = "Asia/Tokyo";
```

**注意:** 既存の `main()` 関数本体（15行目以降）は変更しない。集計ロジック（`dailySummaries` クエリ、`totalTrades` 等の変数計算）はそのまま残る。

- [ ] **Step 2: 構造化出力スキーマを定義**

import セクションの直後（`const JST` の後）に追加:

```typescript
const WEEKLY_REVIEW_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "weekly_review",
    strict: true,
    schema: {
      type: "object",
      properties: {
        performance: { type: "string", description: "今週のパフォーマンス評価（50文字以内）" },
        strengths: { type: "string", description: "良かった点（50文字以内）" },
        improvements: { type: "string", description: "改善すべき点（50文字以内）" },
        nextWeekStrategy: { type: "string", description: "来週の戦略提案（50文字以内）" },
      },
      required: ["performance", "strengths", "improvements", "nextWeekStrategy"],
      additionalProperties: false,
    },
  },
};

type WeeklyAIReview = {
  performance: string;
  strengths: string;
  improvements: string;
  nextWeekStrategy: string;
};
```

- [ ] **Step 3: weekStart/weekEnd 計算を追加**

`main()` 関数の冒頭（`console.log("=== Weekly Review 開始 ===");` の直後）に追加:

```typescript
  // 直前の月〜金を対象とする（土曜実行前提、他の曜日でも安全）
  const now = dayjs().tz(JST);
  // 直近の金曜を確実に取得: 金曜以降ならそのまま、それ以外は前週の金曜
  const friday = now.day() >= 5
    ? now.day(5)
    : now.subtract(1, "week").day(5);
  const monday = friday.day(1); // 同じ週の月曜
  const weekStart = jstDateAsUTC(monday);
  const weekEnd = jstDateAsUTC(friday);
```

- [ ] **Step 4: OpenAI呼び出しを構造化出力に変更**

既存の OpenAI 呼び出し部分（`let aiReview = ""` から `catch` ブロックの `}` まで）を以下に置換:

```typescript
  let aiReview: WeeklyAIReview | null = null;
  try {
    const openai = getOpenAIClient();
    const response = await openai.chat.completions.create({
      model: OPENAI_CONFIG.MODEL,
      temperature: 0.5,
      response_format: WEEKLY_REVIEW_SCHEMA,
      messages: [
        {
          role: "user",
          content: `週次の自動売買シミュレーション結果をレビューしてください。

【週間サマリー】
- 取引日数: ${tradingDays}日
- 取引数: ${totalTrades}件（${totalWins}勝 ${totalLosses}敗）
- 勝率: ${winRate}%
- 確定損益: ¥${totalPnl.toLocaleString()}
- ポートフォリオ時価: ¥${portfolioValue.toLocaleString()}
- 現金残高: ¥${cashBalance.toLocaleString()}

【クローズポジション詳細】
${positionSummary || "なし"}

各項目を50文字以内で簡潔に述べてください。`,
        },
      ],
      max_tokens: 500,
    });

    aiReview = JSON.parse(response.choices[0].message.content ?? "{}");
  } catch (error) {
    console.error("AIレビュー生成エラー:", error);
  }
```

- [ ] **Step 5: DB保存を追加**

AIレビュー生成の後、Slack通知の前に追加:

```typescript
  // DB保存
  try {
    await prisma.tradingWeeklySummary.upsert({
      where: { weekEnd },
      create: {
        weekStart,
        weekEnd,
        tradingDays,
        totalTrades,
        wins: totalWins,
        losses: totalLosses,
        totalPnl,
        portfolioValue,
        cashBalance,
        aiReview: aiReview ?? {},
      },
      update: {
        weekStart,
        tradingDays,
        totalTrades,
        wins: totalWins,
        losses: totalLosses,
        totalPnl,
        portfolioValue,
        cashBalance,
        aiReview: aiReview ?? {},
      },
    });
    console.log("  週次サマリーをDBに保存しました");
  } catch (error) {
    console.error("DB保存エラー:", error);
  }
```

- [ ] **Step 6: Slack通知を構造化フィールドから組み立てに変更**

既存のSlack通知部分（`const pnlEmoji` から `notifySlack` の `});` まで）を以下に置換:

```typescript
  // Slack通知
  const pnlEmoji = totalPnl >= 0 ? "📈" : "📉";
  const slackMessage = aiReview
    ? [
        `📊 ${aiReview.performance}`,
        `💪 ${aiReview.strengths}`,
        `🔧 ${aiReview.improvements}`,
        `🎯 ${aiReview.nextWeekStrategy}`,
      ].join("\n")
    : "AIレビューの生成に失敗しました";

  await notifySlack({
    title: `📊 週次レビュー（${monday.format("MM/DD")}〜${friday.format("MM/DD")}）`,
    message: slackMessage,
    color: totalPnl >= 0 ? "good" : "danger",
    fields: [
      {
        title: "週間損益",
        value: `${pnlEmoji} ¥${totalPnl.toLocaleString()}`,
        short: true,
      },
      {
        title: "勝率",
        value: `${totalWins}勝${totalLosses}敗 (${winRate}%)`,
        short: true,
      },
      {
        title: "取引日数",
        value: `${tradingDays}日`,
        short: true,
      },
      {
        title: "ポートフォリオ",
        value: `¥${portfolioValue.toLocaleString()}`,
        short: true,
      },
    ],
  });
```

- [ ] **Step 7: TypeScriptの型チェックを実行**

Run: `npx tsc --noEmit`

Expected: エラーなし

- [ ] **Step 8: コミット**

```bash
git add src/jobs/weekly-review.ts
git commit -m "feat: 週次レビューに構造化出力とDB保存を追加"
```

---

## Chunk 3: UIページ + ルート登録

### Task 5: `/weekly` ページを作成

**Files:**
- Create: `src/web/routes/weekly.ts`

- [ ] **Step 1: weekly.ts ルートファイルを作成**

`src/web/routes/weekly.ts` を新規作成:

```typescript
/**
 * 週次レビューページ（GET /weekly）
 */

import { Hono } from "hono";
import { html } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { QUERY_LIMITS } from "../../lib/constants";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlText,
  emptyState,
  sparklineChart,
  detailRow,
} from "../views/components";

const app = new Hono();

app.get("/", async (c) => {
  const summaries = await prisma.tradingWeeklySummary.findMany({
    orderBy: { weekEnd: "desc" },
    take: QUERY_LIMITS.WEEKLY_SUMMARIES,
  });

  const latest = summaries[0];

  // Cumulative PnL chart data (oldest first)
  const chartData = [...summaries].reverse().reduce<
    { label: string; value: number }[]
  >((acc, s) => {
    const prev = acc.length > 0 ? acc[acc.length - 1].value : 0;
    acc.push({
      label: dayjs(s.weekEnd).format("M/D"),
      value: prev + Number(s.totalPnl),
    });
    return acc;
  }, []);

  const content = html`
    <!-- Latest Week Summary -->
    <p class="section-title">最新の週次レビュー</p>
    ${latest
      ? html`
          <div class="card">
            <p style="color:#94a3b8;font-size:12px;margin-bottom:8px">
              ${dayjs(latest.weekStart).format("M/D")}〜${dayjs(latest.weekEnd).format("M/D")}
            </p>
            ${detailRow("週間損益", pnlText(Number(latest.totalPnl)))}
            ${detailRow(
              "勝敗",
              latest.totalTrades > 0
                ? `${latest.wins}W ${latest.losses}L`
                : "-",
            )}
            ${detailRow("取引数", `${latest.totalTrades}件`)}
            ${detailRow("ポートフォリオ", `¥${formatYen(Number(latest.portfolioValue))}`)}
            ${detailRow("現金残高", `¥${formatYen(Number(latest.cashBalance))}`)}
          </div>

          <!-- AI Review -->
          ${(() => {
            const review = latest.aiReview as {
              performance?: string;
              strengths?: string;
              improvements?: string;
              nextWeekStrategy?: string;
            } | null;
            if (!review) return "";
            return html`
              <p class="section-title">AIレビュー</p>
              ${review.performance
                ? html`<div class="card">
                    <p style="font-size:12px;color:#94a3b8;margin-bottom:4px">📊 パフォーマンス評価</p>
                    <p style="font-size:13px">${review.performance}</p>
                  </div>`
                : ""}
              ${review.strengths
                ? html`<div class="card">
                    <p style="font-size:12px;color:#94a3b8;margin-bottom:4px">💪 良かった点</p>
                    <p style="font-size:13px">${review.strengths}</p>
                  </div>`
                : ""}
              ${review.improvements
                ? html`<div class="card">
                    <p style="font-size:12px;color:#94a3b8;margin-bottom:4px">🔧 改善すべき点</p>
                    <p style="font-size:13px">${review.improvements}</p>
                  </div>`
                : ""}
              ${review.nextWeekStrategy
                ? html`<div class="card">
                    <p style="font-size:12px;color:#94a3b8;margin-bottom:4px">🎯 来週の戦略</p>
                    <p style="font-size:13px">${review.nextWeekStrategy}</p>
                  </div>`
                : ""}
            `;
          })()}
        `
      : html`<div class="card">${emptyState("週次レビューはまだありません")}</div>`}

    <!-- Cumulative PnL Chart -->
    <p class="section-title">累積損益（週次）</p>
    <div class="chart-container">
      ${chartData.length >= 2
        ? sparklineChart(chartData, 340, 140)
        : emptyState("データ不足")}
    </div>

    <!-- Weekly Summary Table -->
    <p class="section-title">過去の週次レビュー</p>
    ${summaries.length > 0
      ? html`
          <div class="card table-wrap responsive-table">
            <table>
              <thead>
                <tr>
                  <th>期間</th>
                  <th>取引</th>
                  <th>勝敗</th>
                  <th>損益</th>
                </tr>
              </thead>
              <tbody>
                ${summaries.map((s) => {
                  const review = s.aiReview as {
                    performance?: string;
                  } | null;
                  return html`
                    <tr>
                      <td data-label="期間">
                        ${dayjs(s.weekStart).format("M/D")}〜${dayjs(s.weekEnd).format("M/D")}
                      </td>
                      <td data-label="取引">${s.totalTrades}</td>
                      <td data-label="勝敗">
                        ${s.totalTrades > 0
                          ? `${s.wins}W ${s.losses}L`
                          : "-"}
                      </td>
                      <td data-label="損益">${pnlText(Number(s.totalPnl))}</td>
                    </tr>
                    ${review?.performance
                      ? html`
                          <tr class="review-row">
                            <td
                              colspan="4"
                              style="font-size:11px;color:#64748b;padding:4px 8px 12px"
                            >
                              ${review.performance}
                            </td>
                          </tr>
                        `
                      : ""}
                  `;
                })}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("週次レビューなし")}</div>`}
  `;

  return c.html(layout("週次レビュー", "/weekly", content));
});

export default app;
```

- [ ] **Step 2: コミット**

```bash
git add src/web/routes/weekly.ts
git commit -m "feat: 週次レビューページを作成"
```

### Task 6: ルート登録 + ナビゲーション追加

**Files:**
- Modify: `src/web/app.ts:16,135`
- Modify: `src/web/views/layout.ts:42-46`

- [ ] **Step 1: `app.ts` にルートを登録**

`src/web/app.ts` に import を追加（17行目、`cronRoute` の後）:

```typescript
import weeklyRoute from "./routes/weekly";
```

ルート登録を追加（`scoringRoute` の後、136行目付近）:

```typescript
app.route("/weekly", weeklyRoute);
```

- [ ] **Step 2: `layout.ts` のナビに `/weekly` を追加**

`src/web/views/layout.ts` の `NAV_ITEMS` 配列で、`/history`（履歴）エントリの後に追加:

```typescript
  {
    path: "/weekly",
    label: "週次",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  },
```

- [ ] **Step 3: TypeScriptの型チェックを実行**

Run: `npx tsc --noEmit`

Expected: エラーなし

- [ ] **Step 4: コミット**

```bash
git add src/web/app.ts src/web/views/layout.ts
git commit -m "feat: 週次レビューのルート登録とナビ追加"
```

---

## Chunk 4: 仕様書更新 + 動作確認

### Task 7: 仕様書を更新

**Files:**
- Modify: `docs/specs/batch-processing.md`

- [ ] **Step 1: `batch-processing.md` の週次レビューセクションにDB保存を追記**

週次レビュー（`weekly-review`）の説明に、DB保存の記述を追加。具体的な内容は既存のフォーマットに合わせて、「AIレビュー結果を `TradingWeeklySummary` に保存し、`/weekly` ページで閲覧可能」である旨を追記する。

- [ ] **Step 2: コミット**

```bash
git add docs/specs/batch-processing.md
git commit -m "docs: batch-processing に週次レビューDB保存を追記"
```

### Task 8: ローカル動作確認

- [ ] **Step 1: ビルド確認**

Run: `npx tsc --noEmit`

Expected: エラーなし

- [ ] **Step 2: サーバー起動して `/weekly` ページにアクセス**

Run: `npm run dev`（またはプロジェクトの起動コマンド）

ブラウザで `/weekly` にアクセスし、以下を確認:
- ページが表示される（データがない場合は空状態メッセージが表示される）
- ナビゲーションに「週次」タブが表示される
- ナビの「週次」タブをクリックして遷移できる

- [ ] **Step 3: ナビが10個で収まるか確認**

モバイル表示（ブラウザのDevTools で幅を375pxに設定）で、ボトムナビの10アイテムが適切に表示されるか確認。はみ出す場合は `styles.ts` のナビのフォントサイズ・アイコンサイズを調整する。
