/**
 * 日次ログ SNS 公開投稿（引け後 16:00 JST / 平日）
 *
 * 自動売買システムの「今日の相場環境 + 確定トレード成績」を1投稿にまとめ、
 * Bluesky に公開する。offseason の淡々とした日常を積み上げ、D期突入で跳ねる
 * ナラティブを外部に可視化する目的（CLAUDE.md「シーズン性を受け入れる」）。
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
import { notifySlack } from "../lib/slack";
import { getStartOfDayJST, getEndOfDayJST } from "../lib/market-date";
import { TIMEZONE } from "../lib/constants";
import { detectRegimeShift, getLevelEmoji } from "../core/regime-shift-detector";

dayjs.extend(utc);
dayjs.extend(timezone);

const DISCLAIMER = "※個人の自動売買システムの記録です。投資助言ではありません";

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/** JST の当月初（実インスタント）。exitedAt は @db.Date ではなく実タイムスタンプなので tz 変換して使う。 */
function jstMonthStart(): Date {
  return dayjs().tz(TIMEZONE).startOf("month").toDate();
}

interface ClosedTrade {
  entry: number;
  exit: number;
  qty: number;
}

function toClosedTrade(p: {
  entryPrice: unknown;
  exitPrice: unknown;
  quantity: number;
}): ClosedTrade {
  const entry = Number(p.entryPrice);
  const exit = p.exitPrice != null ? Number(p.exitPrice) : entry;
  return { entry, exit, qty: p.quantity };
}

/** 資本加重リターン（決済分の (Σpnl / Σcost)）。絶対額は返さず % のみ。 */
function weightedReturnPct(trades: ClosedTrade[]): number {
  let cost = 0;
  let pnl = 0;
  for (const t of trades) {
    cost += t.entry * t.qty;
    pnl += (t.exit - t.entry) * t.qty;
  }
  return cost > 0 ? (pnl / cost) * 100 : 0;
}

/** 決済分の Profit Factor（Σ利益 / Σ損失）。 */
function profitFactor(trades: ClosedTrade[]): number | null {
  let gross = 0;
  let loss = 0;
  for (const t of trades) {
    const pnl = (t.exit - t.entry) * t.qty;
    if (pnl >= 0) gross += pnl;
    else loss += -pnl;
  }
  if (loss === 0) return gross > 0 ? Infinity : null;
  return gross / loss;
}

/**
 * 運用開始からの累計リターン%（金額は返さず % のみ）。
 * total equity = portfolioValue（保有評価額）+ cashBalance（現金/買余力）。
 * 最古と最新の TradingDailySummary の total equity 比から算出する。
 * サマリが1件以下 or 初日 equity が 0 の場合は null。
 */
async function cumulativeReturnPct(): Promise<number | null> {
  const [first, last] = await Promise.all([
    prisma.tradingDailySummary.findFirst({
      orderBy: { date: "asc" },
      select: { portfolioValue: true, cashBalance: true },
    }),
    prisma.tradingDailySummary.findFirst({
      orderBy: { date: "desc" },
      select: { portfolioValue: true, cashBalance: true },
    }),
  ]);
  if (!first || !last) return null;

  const base = Number(first.portfolioValue) + Number(first.cashBalance);
  const latest = Number(last.portfolioValue) + Number(last.cashBalance);
  if (base <= 0) return null;

  return (latest / base - 1) * 100;
}

export async function buildDailySocialText(): Promise<string> {
  const now = new Date();
  const dayLabel = `${dayjs(now).tz(TIMEZONE).format("M/D")}(${WEEKDAY_JA[dayjs(now).tz(TIMEZONE).day()]})`;

  // --- 相場環境（regime detector が breadth / vix / 段階を一括で返す） ---
  let regimeLine = "相場: データ取得中";
  try {
    const regime = await detectRegimeShift({ asOfDate: now });
    const breadthPct = (regime.current.breadth * 100).toFixed(1);
    const vix = regime.current.vix;
    const vixStr = Number.isFinite(vix) ? vix.toFixed(1) : "N/A";
    regimeLine = `相場: breadth ${breadthPct}% ／ VIX ${vixStr} ／ ${getLevelEmoji(regime.level)} 強気${regime.signalCount}/5`;
  } catch (e) {
    console.warn("regime 取得失敗、相場行はフォールバック:", e);
  }

  // --- 本日の稼働（新規エントリー / 決済） ---
  const start = getStartOfDayJST();
  const end = getEndOfDayJST();

  const [newEntries, closedTodayRaw] = await Promise.all([
    prisma.tradingPosition.count({
      where: { createdAt: { gte: start, lte: end } },
    }),
    prisma.tradingPosition.findMany({
      where: { status: "closed", exitedAt: { gte: start, lte: end } },
      select: { entryPrice: true, exitPrice: true, quantity: true },
    }),
  ]);

  const closedToday = closedTodayRaw.map(toClosedTrade);
  const wins = closedToday.filter((t) => (t.exit - t.entry) * t.qty >= 0).length;
  const losses = closedToday.length - wins;

  let todayLine: string;
  if (closedToday.length === 0) {
    todayLine =
      newEntries === 0
        ? "本日: エントリーなし（休む局面）"
        : `本日: 新規${newEntries}件 ・ 決済なし`;
  } else {
    const retStr = fmtPct(weightedReturnPct(closedToday));
    let detail = "";
    // 決済が少数なら各トレードの損益率も出す（銘柄名は出さない）
    if (closedToday.length <= 3) {
      const perTrade = closedToday
        .map((t) => fmtPct(((t.exit - t.entry) / t.entry) * 100))
        .join(" / ");
      detail = ` [${perTrade}]`;
    }
    todayLine = `本日: 新規${newEntries}件 ・ 決済${closedToday.length}件（${wins}勝${losses}敗）損益 ${retStr}${detail}`;
  }

  // --- 今月の成績（PF・勝敗）＋ 運用開始からの累計リターン% ---
  const [closedMonthRaw, cumPct] = await Promise.all([
    prisma.tradingPosition.findMany({
      where: { status: "closed", exitedAt: { gte: jstMonthStart(), lte: end } },
      select: { entryPrice: true, exitPrice: true, quantity: true },
    }),
    cumulativeReturnPct(),
  ]);

  const summaryParts: string[] = [];
  if (closedMonthRaw.length > 0) {
    const closedMonth = closedMonthRaw.map(toClosedTrade);
    const mWins = closedMonth.filter((t) => (t.exit - t.entry) * t.qty >= 0).length;
    const mLosses = closedMonth.length - mWins;
    const pf = profitFactor(closedMonth);
    const pfStr = pf == null ? "—" : pf === Infinity ? "∞" : pf.toFixed(2);
    summaryParts.push(`今月: ${mWins}勝${mLosses}敗 PF ${pfStr}`);
  }
  if (cumPct != null) {
    summaryParts.push(`累計 ${fmtPct(cumPct)}`);
  }
  const summaryLine = summaryParts.join(" ／ ");

  const lines = [
    `📊 自動売買ログ ${dayLabel}`,
    "",
    regimeLine,
    todayLine,
    ...(summaryLine ? [summaryLine] : []),
    "",
    DISCLAIMER,
  ];

  return lines.join("\n");
}

export async function main() {
  const text = await buildDailySocialText();
  console.log("--- 投稿内容 ---\n" + text + "\n----------------");
  await postToBluesky(text);

  // 成功時は投稿内容をそのまま Slack にも流す（投稿できたか目視確認するため）。
  // Slack 送信の失敗は投稿処理を巻き込まない（notifySlack は内部で握りつぶす）。
  await notifySlack({
    title: "🦋 Bluesky 日次投稿",
    message: text,
    color: "good",
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
