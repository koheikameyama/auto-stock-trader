/**
 * SNS 投稿・公開ページで共有する「開示可能な成績スナップショット」（KOH-525）。
 *
 * 夜の日次ログ投稿（daily-social-post）と公開ページ（/live）の両方が同じ
 * 開示範囲・同じ計算で成績を出すための単一ソース。開示フィルタは呼び出し側と共通:
 *   - 銘柄名・戦略パラメータ・絶対額は返さない（% と局面情報のみ）
 *
 * 核になるのは「仕込み時の局面」の復元。GU/PSC は保有1〜7日のため、今日の決済は
 * 数日前の局面で仕込んだ結果であり、当日の局面と並べると因果を読み違える。
 * 決済トレードごとに TradingPosition.createdAt（仕込み日）時点の強気モニターを
 * detectRegimeShift({ asOfDate }) で復元して添える（新規の記録は不要）。
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { prisma } from "../lib/prisma";
import { getStartOfDayJST, getEndOfDayJST } from "../lib/market-date";
import { TIMEZONE } from "../lib/constants";
import {
  detectRegimeShift,
  getLevelEmoji,
  type SignalLevel,
} from "./regime-shift-detector";

dayjs.extend(utc);
dayjs.extend(timezone);

/** 仕込み日時点の局面（強気モニター復元値） */
export interface EntryContext {
  /** 仕込み日（JST, YYYY-MM-DD） */
  date: string;
  /** SMA25 上回り比率（%）。SNS・公開ページと同じ生値開示 */
  breadthPct: number;
  level: SignalLevel;
  emoji: string;
}

/** 決済済みトレード1件分の開示可能情報 */
export interface ClosedTradePerf {
  /** per-trade 損益率（%） */
  returnPct: number;
  /** 仕込み日（JST, YYYY-MM-DD） */
  entryDate: string;
  /** 決済日（JST, YYYY-MM-DD） */
  exitDate: string;
  /** 仕込み日の局面。復元失敗時は null（表示側で省略） */
  entry: EntryContext | null;
}

export interface PerformanceSnapshot {
  today: {
    newEntries: number;
    closed: ClosedTradePerf[];
    wins: number;
    losses: number;
    /** 決済分の資本加重リターン（Σpnl / Σcost, %） */
    weightedReturnPct: number;
  };
  /** 今月決済分。決済ゼロなら null */
  month: { wins: number; losses: number; pf: number | null } | null;
  /** 運用開始からの累計リターン%（TradingDailySummary 比）。算出不能なら null */
  cumulativeReturnPct: number | null;
  /** 直近の決済（新しい順、公開ページの実績リスト用） */
  recentClosed: ClosedTradePerf[];
}

interface RawClosed {
  entryPrice: unknown;
  exitPrice: unknown;
  quantity: number;
  createdAt: Date;
  exitedAt: Date | null;
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
export function weightedReturnPct(trades: ClosedTrade[]): number {
  let cost = 0;
  let pnl = 0;
  for (const t of trades) {
    cost += t.entry * t.qty;
    pnl += (t.exit - t.entry) * t.qty;
  }
  return cost > 0 ? (pnl / cost) * 100 : 0;
}

/** 決済分の Profit Factor（Σ利益 / Σ損失）。 */
export function profitFactor(trades: ClosedTrade[]): number | null {
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

/** JST の当月初（実インスタント）。exitedAt は実タイムスタンプなので tz 変換して使う。 */
function jstMonthStart(): Date {
  return dayjs().tz(TIMEZONE).startOf("month").toDate();
}

/**
 * 運用開始からの累計リターン%（金額は返さず % のみ）。
 * total equity = portfolioValue（保有評価額）+ cashBalance（現金/買余力）。
 * 最古と最新の TradingDailySummary の total equity 比から算出する。
 * サマリが1件以下 or 初日 equity が 0 の場合は null。
 */
export async function cumulativeReturnPct(): Promise<number | null> {
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

/**
 * 仕込み日の局面復元は detectRegimeShift（breadth 90日 + 日経/VIX 180日の DB 読み）
 * を日付ごとに叩くため、確定済みの過去日のみプロセス内でメモ化する。
 * 失敗（一時的な DB エラー等）はメモ化しない = 次回リトライされる。
 */
const entryContextMemo = new Map<string, EntryContext>();
const ENTRY_CONTEXT_MEMO_MAX = 60;

async function getEntryContext(jstDate: string): Promise<EntryContext | null> {
  const memoized = entryContextMemo.get(jstDate);
  if (memoized) return memoized;

  try {
    const [y, m, d] = jstDate.split("-").map(Number);
    // getTodayForDB と同じ「JST日付 = UTC 00:00」規約で asOfDate を渡す
    const regime = await detectRegimeShift({
      asOfDate: new Date(Date.UTC(y, m - 1, d)),
    });
    const ctx: EntryContext = {
      date: jstDate,
      breadthPct: regime.current.breadth * 100,
      level: regime.level,
      emoji: getLevelEmoji(regime.level),
    };
    // 当日はまだ引け確定が進む可能性があるため、過去日のみメモ化
    if (jstDate < dayjs().tz(TIMEZONE).format("YYYY-MM-DD")) {
      if (entryContextMemo.size >= ENTRY_CONTEXT_MEMO_MAX) {
        const oldest = entryContextMemo.keys().next().value;
        if (oldest !== undefined) entryContextMemo.delete(oldest);
      }
      entryContextMemo.set(jstDate, ctx);
    }
    return ctx;
  } catch (e) {
    console.warn(`仕込み日 ${jstDate} の局面復元に失敗（表示は省略）:`, e);
    return null;
  }
}

function jstDateOf(d: Date): string {
  return dayjs(d).tz(TIMEZONE).format("YYYY-MM-DD");
}

async function toPerf(rows: RawClosed[]): Promise<ClosedTradePerf[]> {
  // 同じ仕込み日はまとめて1回だけ復元する
  const uniqueDates = [...new Set(rows.map((r) => jstDateOf(r.createdAt)))];
  const contexts = new Map<string, EntryContext | null>();
  for (const date of uniqueDates) {
    contexts.set(date, await getEntryContext(date));
  }

  return rows.map((r) => {
    const t = toClosedTrade(r);
    const entryDate = jstDateOf(r.createdAt);
    return {
      returnPct: t.entry > 0 ? ((t.exit - t.entry) / t.entry) * 100 : 0,
      entryDate,
      exitDate: r.exitedAt ? jstDateOf(r.exitedAt) : entryDate,
      entry: contexts.get(entryDate) ?? null,
    };
  });
}

const CLOSED_SELECT = {
  entryPrice: true,
  exitPrice: true,
  quantity: true,
  createdAt: true,
  exitedAt: true,
} as const;

/**
 * SNS 投稿・公開ページ共通の成績スナップショットを構築する。
 * @param opts.recentLimit 直近決済の件数（既定5、公開ページの実績リスト用）
 */
export async function buildPerformanceSnapshot(
  opts: { recentLimit?: number } = {},
): Promise<PerformanceSnapshot> {
  const recentLimit = opts.recentLimit ?? 5;
  const start = getStartOfDayJST();
  const end = getEndOfDayJST();

  const [newEntries, closedTodayRaw, closedMonthRaw, recentRaw, cumPct] =
    await Promise.all([
      prisma.tradingPosition.count({
        where: { createdAt: { gte: start, lte: end } },
      }),
      prisma.tradingPosition.findMany({
        where: { status: "closed", exitedAt: { gte: start, lte: end } },
        select: CLOSED_SELECT,
        orderBy: { exitedAt: "asc" },
      }),
      prisma.tradingPosition.findMany({
        where: { status: "closed", exitedAt: { gte: jstMonthStart(), lte: end } },
        select: { entryPrice: true, exitPrice: true, quantity: true },
      }),
      prisma.tradingPosition.findMany({
        where: { status: "closed", exitedAt: { not: null } },
        select: CLOSED_SELECT,
        orderBy: { exitedAt: "desc" },
        take: recentLimit,
      }),
      cumulativeReturnPct(),
    ]);

  const closedTodayTrades = closedTodayRaw.map(toClosedTrade);
  const wins = closedTodayTrades.filter((t) => (t.exit - t.entry) * t.qty >= 0)
    .length;

  let month: PerformanceSnapshot["month"] = null;
  if (closedMonthRaw.length > 0) {
    const closedMonth = closedMonthRaw.map(toClosedTrade);
    const mWins = closedMonth.filter((t) => (t.exit - t.entry) * t.qty >= 0)
      .length;
    month = {
      wins: mWins,
      losses: closedMonth.length - mWins,
      pf: profitFactor(closedMonth),
    };
  }

  return {
    today: {
      newEntries,
      closed: await toPerf(closedTodayRaw),
      wins,
      losses: closedTodayTrades.length - wins,
      weightedReturnPct: weightedReturnPct(closedTodayTrades),
    },
    month,
    cumulativeReturnPct: cumPct,
    recentClosed: await toPerf(recentRaw),
  };
}
