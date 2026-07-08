/**
 * 日次ログ SNS 公開投稿（引け後 16:00 JST / 平日）
 *
 * 自動売買システムの「今日の相場環境 + 確定トレード成績」を1投稿にまとめ、
 * Bluesky に公開する。offseason の淡々とした日常を積み上げ、D期突入で跳ねる
 * ナラティブを外部に可視化する目的（CLAUDE.md「シーズン性を受け入れる」）。
 *
 * 決済トレードには「仕込み日の局面」を添える（KOH-525）。GU/PSC は保有1〜7日の
 * ため今日の決済は数日前の局面で仕込んだ結果であり、当日局面と並べるだけでは
 * 因果を読み違える。「🟢の日に仕込んだ玉が数日後に実る」を毎日可視化することが
 * 相場局面モニターの主張（局面が結果を決める）の実例になる。
 *
 * 公開投稿のため、以下の3フィルタを機械的に噛ませる:
 *   1. マスク  : 銘柄名・戦略パラメータ・生の資金額/残高は一切出さない
 *   2. 相対化  : リターンは % のみ（PF・勝率・損益率）。絶対額は出さない
 *   3. 非助言  : 「買い推奨」等の助言的文言を出さず、末尾に免責を常時付与
 *
 * 投稿失敗はワーカーの他ジョブに影響させない（呼び出し側で握りつぶす想定だが、
 * 本ジョブ内でもデータ取得は best-effort でフォールバックする）。
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { prisma } from "../lib/prisma";
import { postToBluesky } from "../lib/bluesky";
import { notifySlack, SNS_POST_SLACK_WEBHOOK_URL } from "../lib/slack";
import { TIMEZONE, PUBLIC_SITE_URL } from "../lib/constants";
import { detectRegimeShift, getLevelEmoji } from "../core/regime-shift-detector";
import {
  buildPerformanceSnapshot,
  type PerformanceSnapshot,
  type ClosedTradePerf,
} from "../core/public-performance";

dayjs.extend(utc);
dayjs.extend(timezone);

export const DISCLAIMER = "※個人の自動売買システムの記録です。投資助言ではありません";

/**
 * X の投稿画面を本文入りで開く Web Intent。
 * スマホ Slack でタップ → X が下書き入りで開く → 投稿するだけ（コピペ不要・API課金なし）。
 */
const X_INTENT_BASE = "https://twitter.com/intent/tweet";

export function buildXIntentUrl(text: string): string {
  return `${X_INTENT_BASE}?text=${encodeURIComponent(text)}`;
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

/** Bluesky の1投稿上限。超えると lib/bluesky が末尾（=免責）を切るため、ここで収める */
const MAX_POST_GRAPHEMES = 300;

/** 決済がこの件数以下なら1件ずつ仕込み時局面を添える（超えたらレンジ集約） */
const PER_TRADE_DETAIL_MAX = 3;

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/** "YYYY-MM-DD" → "M/D" */
function mdLabel(jstDate: string): string {
  const [, m, d] = jstDate.split("-").map(Number);
  return `${m}/${d}`;
}

function graphemeCount(text: string): number {
  return [...text].length;
}

/** 仕込み時局面の表示粒度 */
type EntryDetailMode = "per-trade" | "aggregate" | "none";

/** 決済1件の明細行: `└ +4.2%（6/30 🟢breadth 62%で仕込み）` */
function perTradeLine(t: ClosedTradePerf): string {
  const ret = fmtPct(t.returnPct);
  if (!t.entry) return `└ ${ret}`;
  return `└ ${ret}（${mdLabel(t.entryDate)} ${t.entry.emoji}breadth ${t.entry.breadthPct.toFixed(0)}%で仕込み）`;
}

/** 集約行: `仕込み: 6/30〜7/2（breadth 55〜62%）`。局面が1件も復元できなければ null */
function aggregateEntryLine(closed: ClosedTradePerf[]): string | null {
  const withCtx = closed.filter(
    (t): t is ClosedTradePerf & { entry: NonNullable<ClosedTradePerf["entry"]> } =>
      t.entry != null,
  );
  if (withCtx.length === 0) return null;

  const dates = [...new Set(withCtx.map((t) => t.entryDate))].sort();
  const breadths = withCtx.map((t) => t.entry.breadthPct);
  const minB = Math.min(...breadths).toFixed(0);
  const maxB = Math.max(...breadths).toFixed(0);

  const dateLabel =
    dates.length === 1
      ? mdLabel(dates[0])
      : `${mdLabel(dates[0])}〜${mdLabel(dates[dates.length - 1])}`;
  const breadthLabel = minB === maxB ? `breadth ${minB}%` : `breadth ${minB}〜${maxB}%`;
  // 日付が1つなら局面絵文字も添えられる
  const emoji = dates.length === 1 ? withCtx[0].entry.emoji : "";
  return `仕込み: ${dateLabel}（${emoji}${breadthLabel}）`;
}

/** 本日の稼働セクション（1〜複数行）を組み立てる */
function todaySection(perf: PerformanceSnapshot, mode: EntryDetailMode): string[] {
  const { newEntries, closed, wins, losses, weightedReturnPct } = perf.today;

  if (closed.length === 0) {
    return [
      newEntries === 0
        ? "本日: エントリーなし（休む局面）"
        : `本日: 新規${newEntries}件 ・ 決済なし`,
    ];
  }

  const retStr = fmtPct(weightedReturnPct);
  const headBase = `本日: 新規${newEntries}件 ・ 決済${closed.length}件（${wins}勝${losses}敗）損益 ${retStr}`;

  if (mode === "per-trade" && closed.length <= PER_TRADE_DETAIL_MAX) {
    return [headBase, ...closed.map(perTradeLine)];
  }

  if (mode === "per-trade" || mode === "aggregate") {
    const agg = aggregateEntryLine(closed);
    if (agg) return [headBase, agg];
  }

  // 従来形式（仕込み情報なし）: 少数なら per-trade 損益率を1行に添える
  let detail = "";
  if (closed.length <= PER_TRADE_DETAIL_MAX) {
    const perTrade = closed.map((t) => fmtPct(t.returnPct)).join(" / ");
    detail = ` [${perTrade}]`;
  }
  return [`${headBase}${detail}`];
}

export interface DailyPostInput {
  dayLabel: string;
  regimeLine: string;
  perf: PerformanceSnapshot;
}

/**
 * 投稿本文を組み立てる（純関数・テスト対象）。
 * 仕込み時局面は per-trade → 集約 → なし の順で試し、Bluesky の300 grapheme に
 * 収まる最初の形式を採用する。lib/bluesky の切り詰めに任せると末尾の免責が
 * 欠けるため、ここで必ず収める。
 */
export function renderDailyPost(input: DailyPostInput): string {
  const { dayLabel, regimeLine, perf } = input;

  const summaryParts: string[] = [];
  if (perf.month) {
    const pf = perf.month.pf;
    const pfStr = pf == null ? "—" : pf === Infinity ? "∞" : pf.toFixed(2);
    summaryParts.push(`今月: ${perf.month.wins}勝${perf.month.losses}敗 PF ${pfStr}`);
  }
  if (perf.cumulativeReturnPct != null) {
    summaryParts.push(`累計 ${fmtPct(perf.cumulativeReturnPct)}`);
  }
  const summaryLine = summaryParts.join(" ／ ");

  const assemble = (mode: EntryDetailMode) =>
    [
      `📊 自動売買ログ ${dayLabel}`,
      "",
      regimeLine,
      ...todaySection(perf, mode),
      ...(summaryLine ? [summaryLine] : []),
      "",
      "▼相場局面を毎日チェック",
      PUBLIC_SITE_URL,
      "",
      DISCLAIMER,
    ].join("\n");

  for (const mode of ["per-trade", "aggregate", "none"] as const) {
    const text = assemble(mode);
    if (graphemeCount(text) <= MAX_POST_GRAPHEMES) return text;
  }
  return assemble("none");
}

/** X 投稿用の短縮免責（Bluesky の DISCLAIMER より短く、Xの上限に収めやすくする） */
export const X_DISCLAIMER = "※投資助言ではありません";

export interface XPostInput {
  dayLabel: string;
  /** コンパクトな相場行。例: `🟢 強気3/5 ／ breadth 55% ／ VIX 18.5` */
  regimeCompact: string;
  perf: PerformanceSnapshot;
}

/**
 * X 投稿用のコンパクト本文（純関数・テスト対象）。
 * Bluesky（明細つき・最大300grapheme）と違い、X は無料枠の上限（280 weighted、
 * CJKは1文字=2）が厳しいので、per-trade明細を持たず1行ずつに凝縮する:
 *   1行目 見出し / 2行目 相場 / 3行目 本日+今月 / 4行目 URL / 5行目 短縮免責
 * URL（公開ページ誘導）と免責は集客・非助言スタンス上どちらも残す。
 */
export function renderXPost(input: XPostInput): string {
  const { dayLabel, regimeCompact, perf } = input;
  const { newEntries, closed, weightedReturnPct } = perf.today;

  const todayLine =
    closed.length === 0
      ? newEntries === 0
        ? "本日 エントリーなし（休む局面）"
        : `本日 新規${newEntries}件・決済なし`
      : `本日 決済${closed.length}件 損益${fmtPct(weightedReturnPct)}`;

  const summaryParts: string[] = [];
  if (perf.month) {
    const pf = perf.month.pf;
    const pfStr = pf == null ? "—" : pf === Infinity ? "∞" : pf.toFixed(2);
    summaryParts.push(`今月${perf.month.wins}勝${perf.month.losses}敗 PF${pfStr}`);
  }
  if (perf.cumulativeReturnPct != null) {
    summaryParts.push(`累計${fmtPct(perf.cumulativeReturnPct)}`);
  }
  const perfLine = summaryParts.length
    ? `${todayLine} ／ ${summaryParts.join(" ")}`
    : todayLine;

  return [
    `📊 自動売買ログ ${dayLabel}`,
    regimeCompact,
    perfLine,
    PUBLIC_SITE_URL,
    X_DISCLAIMER,
  ].join("\n");
}

export interface DailySocialTexts {
  /** Bluesky 用（per-trade明細あり・KOH-525 の「仕込み局面」ナラティブを維持） */
  blueskyText: string;
  /** X 用（per-trade明細を落とした簡潔版） */
  xText: string;
}

export async function buildDailySocialText(): Promise<DailySocialTexts> {
  const now = new Date();
  const dayLabel = `${dayjs(now).tz(TIMEZONE).format("M/D")}(${WEEKDAY_JA[dayjs(now).tz(TIMEZONE).day()]})`;

  // --- 相場環境（regime detector が breadth / vix / 段階を一括で返す） ---
  // Bluesky は従来の相場行、X は上限が厳しいので breadth を整数丸めしたコンパクト行を使う
  let regimeLine = "相場: データ取得中";
  let regimeCompact = "相場データ取得中";
  try {
    const regime = await detectRegimeShift({ asOfDate: now });
    const breadthFrac = regime.current.breadth;
    const breadthPct = (breadthFrac * 100).toFixed(1);
    const breadthPctInt = Math.round(breadthFrac * 100);
    const vix = regime.current.vix;
    const vixStr = Number.isFinite(vix) ? vix.toFixed(1) : "N/A";
    const emoji = getLevelEmoji(regime.level);
    regimeLine = `相場: breadth ${breadthPct}% ／ VIX ${vixStr} ／ ${emoji} 強気${regime.signalCount}/5`;
    regimeCompact = `${emoji} 強気${regime.signalCount}/5 ／ breadth ${breadthPctInt}% ／ VIX ${vixStr}`;
  } catch (e) {
    console.warn("regime 取得失敗、相場行はフォールバック:", e);
  }

  const perf = await buildPerformanceSnapshot();

  return {
    blueskyText: renderDailyPost({ dayLabel, regimeLine, perf }),
    xText: renderXPost({ dayLabel, regimeCompact, perf }),
  };
}

export async function main() {
  const { blueskyText, xText } = await buildDailySocialText();
  console.log("--- Bluesky 投稿内容 ---\n" + blueskyText + "\n----------------");
  console.log("--- X 投稿内容 ---\n" + xText + "\n----------------");

  // Bluesky は自動投稿。Slack には成否だけを通知する（本文は載せない）。
  let blueskyOk = false;
  try {
    await postToBluesky(blueskyText);
    blueskyOk = true;
  } catch (e) {
    console.error("Bluesky 投稿失敗:", e);
  }

  // X は手動投稿。per-trade明細を落とした簡潔版（xText）を Slack にそのまま載せ、
  // コピー or Web Intent リンクのタップで投稿できるようにする。
  // Slack 送信の失敗は投稿処理を巻き込まない（notifySlack は内部で握りつぶす）。
  const xIntentUrl = buildXIntentUrl(xText);
  await notifySlack({
    title: blueskyOk ? "🦋 Bluesky投稿OK ／ 📱 X下書き" : "⚠️ Bluesky投稿失敗 ／ 📱 X下書き",
    message: [
      blueskyOk ? "Bluesky: 投稿しました ✅" : "Bluesky: 投稿に失敗しました ❌",
      "",
      "📱 X投稿文（コピー、または下記リンクをタップ）:",
      xText,
      "",
      `<${xIntentUrl}|タップして X に投稿（下書きが開きます）>`,
    ].join("\n"),
    color: blueskyOk ? "good" : "danger",
    webhookUrl: SNS_POST_SLACK_WEBHOOK_URL,
  });
}

const isDirectRun = process.argv[1]?.includes("daily-social-post");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("daily-social-post エラー:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
