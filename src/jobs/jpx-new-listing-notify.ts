/**
 * JPX新規上場（IPO）通知ジョブ
 *
 * JPX公式の「新規上場銘柄一覧」ページをfetchし、
 * 直近上場・上場予定のIPO銘柄をSlackに週次通知する（情報通知専用）。
 *
 * 背景:
 *   本ツールの発注先である立花証券 e支店 はIPO（新規公開株）の抽選を取り扱わない。
 *   そのためIPOへの参加・購入は楽天証券など別口座で手動で行う前提とし、
 *   このジョブは「どの銘柄がいつ上場するか」を知らせる情報レーダーに徹する。
 *   DBは更新しない（listingDate の記録は jpx-csv-sync.ts が担当）。
 *
 * 実行タイミング:
 *   - 週次（GitHub Actions cron）。時間の正確性は不要なためGitHub Actions cronを使用。
 *
 * 注意:
 *   JPXがHTML構造を変更するとパースが壊れる。0件検出時は warning 通知して可視化する。
 *   セレクタは jpx-delisting-sync.ts と同じ「セルを走査して日付/コード/市場を柔軟に拾う」方式。
 */

import { JPX_NEW_LISTING, MARKET_BREADTH } from "../lib/constants";
import { getTodayForDB } from "../lib/market-date";
import { notifySlack } from "../lib/slack";
import {
  detectRegimeShift,
  getLevelEmoji,
  getLevelLabel,
  type SignalLevel,
} from "../core/regime-shift-detector";
import * as cheerio from "cheerio";
import dayjs from "dayjs";

interface NewListingEntry {
  code: string;
  name: string;
  listingDate: Date;
  market: string;
}

/** Tier A 分析: 相場環境スコア（IPO初値が伸びやすい局面かを判定） */
interface IpoMarketEnvironment {
  emoji: string;
  headline: string;
}

/**
 * 相場環境をIPO初値の伸びやすさの観点で分類する。
 *
 * 本ツールのシーズン性の知見（弱気相場＝breadth<54% では IPO も公募割れが増え初値が伸びにくい、
 * D期＝大強気相場では初値が跳ねやすい）を IPO 判断に転用する。
 */
function classifyIpoEnvironment(
  breadth: number | null,
  level: SignalLevel | null,
): IpoMarketEnvironment | null {
  if (breadth == null) return null;
  const pct = `breadth ${Math.round(breadth * 100)}%`;
  const levelStr = level ? `・${getLevelLabel(level)}` : "";

  // D期（大強気）に近い = IPO初値が最も伸びやすい
  if (level === "STRONG_BULL" || level === "MODERATE_BULL") {
    return {
      emoji: "🟢",
      headline: `${pct}${levelStr} → 強気相場。IPO初値が伸びやすい局面`,
    };
  }
  // 過熱: 初値popは出やすいが上場後の調整リスク
  if (breadth >= MARKET_BREADTH.UPPER_CAP) {
    return {
      emoji: "🟠",
      headline: `${pct}${levelStr} → 過熱気味。初値popは出やすいが上場直後の調整に注意`,
    };
  }
  // band内: 良好
  if (breadth >= MARKET_BREADTH.THRESHOLD) {
    return {
      emoji: "🟢",
      headline: `${pct}${levelStr} → 良好な地合い。IPO初値は伸びやすい寄り`,
    };
  }
  // idle / offseason: 弱気。公募割れ増
  return {
    emoji: "🔴",
    headline: `${pct}${levelStr} → 弱気・offseason。公募割れが増えやすく初値も伸びにくい。当選しても初値売り徹底推奨`,
  };
}

/** 市場区分から初値傾向のヒントを返す（Tier A 分析） */
function marketSegmentHint(market: string): string {
  if (market.includes("グロース")) return "小型・初値跳ねやすい傾向";
  if (market.includes("スタンダード")) return "中型";
  if (market.includes("プライム")) return "大型・初値は伸びにくい傾向";
  return "";
}

/** 4桁の証券コード（数字4桁、または2024年以降の英数字混在コード 例: 130A）。市場名等の誤検出を避ける */
const CODE_PATTERN = /^(?=.*\d)[0-9A-Z]{4}$/;
/** 日付パターン（YYYY/MM/DD or YYYY年MM月DD日） */
const DATE_PATTERN = /\d{4}[/年]\d{1,2}[/月]\d{1,2}/;
/** 市場区分らしさ判定 */
const MARKET_PATTERN = /(プライム|スタンダード|グロース|PRO\s*Market|REIT|ETF|ETN)/i;

function parseJpDate(text: string): Date | null {
  const match = text.match(DATE_PATTERN);
  if (!match) return null;
  const normalized = match[0]
    .replace(/年/g, "/")
    .replace(/月/g, "/")
    .replace(/日/g, "");
  const parsed = dayjs(normalized, "YYYY/M/D");
  if (!parsed.isValid()) return null;
  // JST日付をUTC 00:00として扱う（market-date.tsパターン）
  return new Date(Date.UTC(parsed.year(), parsed.month(), parsed.date()));
}

/**
 * JPX新規上場銘柄一覧ページからデータを取得・パース
 *
 * テーブル構造はJPX側で変わりうるため、各行のセルを走査して
 * 「日付セル（上場日）」「コードセル」「市場区分セル」「銘柄名セル」を柔軟に拾う。
 */
async function fetchNewListings(): Promise<NewListingEntry[]> {
  const response = await fetch(JPX_NEW_LISTING.LIST_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; StockBuddy/1.0)",
      "Accept-Language": "ja",
    },
  });

  if (!response.ok) {
    throw new Error(
      `JPX新規上場ページ取得失敗: ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const entries: NewListingEntry[] = [];
  const seen = new Set<string>();

  $("table tbody tr, table tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 3) return;

    const cellTexts = cells
      .map((__, c) => $(c).text().trim())
      .get();

    let listingDate: Date | null = null;
    let code = "";
    let market = "";

    for (const text of cellTexts) {
      if (!listingDate) {
        const d = parseJpDate(text);
        if (d) {
          listingDate = d;
          continue;
        }
      }
      if (!code && CODE_PATTERN.test(text)) {
        code = text;
        continue;
      }
      if (!market && MARKET_PATTERN.test(text)) {
        market = text;
      }
    }

    if (!listingDate || !code) return;

    // 銘柄名: 日付/コード/市場のいずれでもない、最も長い非空セルを採用
    const name = cellTexts
      .filter(
        (text) =>
          text !== code &&
          text !== market &&
          !DATE_PATTERN.test(text) &&
          text.length > 0,
      )
      .sort((a, b) => b.length - a.length)[0] ?? "";

    const key = `${code}-${dayjs(listingDate).format("YYYYMMDD")}`;
    if (seen.has(key)) return;
    seen.add(key);

    entries.push({ code, name, listingDate, market: market || "—" });
  });

  return entries;
}

function formatEntry(
  entry: NewListingEntry,
  today: Date,
  sameDayCount: number,
): string {
  const dateStr = dayjs(entry.listingDate).format("YYYY-MM-DD");
  const isUpcoming = entry.listingDate.getTime() > today.getTime();
  const marker = isUpcoming ? "🆕 上場予定" : "✅ 上場済";

  const segHint = marketSegmentHint(entry.market);
  const segPart = segHint ? `｜${segHint}` : "";

  // 同日上場集中度（需要分散リスク）。3件以上で警告マーク
  const concentration =
    sameDayCount >= 3
      ? `｜⚠ 同日上場 ${sameDayCount}件（需要分散注意）`
      : `｜同日上場 ${sameDayCount}件`;

  return `${marker} ${dateStr}  ${entry.code}  ${entry.name}（${entry.market}${segPart}）${concentration}`;
}

export async function main() {
  console.log("=== JPX新規上場（IPO）通知 開始 ===");

  let entries: NewListingEntry[];
  try {
    entries = await fetchNewListings();
  } catch (error) {
    console.error("  JPX新規上場ページ取得失敗:", error);
    await notifySlack({
      title: "⚠ IPO通知: JPXページ取得失敗",
      message: `JPX新規上場ページからのデータ取得に失敗しました。\nURL: ${JPX_NEW_LISTING.LIST_URL}\n${error}`,
      color: "warning",
    }).catch(() => {});
    process.exitCode = 1;
    return;
  }

  console.log(`  パース: ${entries.length}件`);

  if (entries.length === 0) {
    // 0件 = JPXのHTML構造変化でパースが壊れた可能性が高い。可視化する。
    console.warn("  パース結果0件。JPXのHTML構造変更の可能性あり");
    await notifySlack({
      title: "⚠ IPO通知: 上場銘柄を1件も抽出できませんでした",
      message:
        "JPX新規上場ページのパース結果が0件でした。" +
        "ページ構造が変更された可能性があります。\n" +
        `URL: ${JPX_NEW_LISTING.LIST_URL}`,
      color: "warning",
    }).catch(() => {});
    return;
  }

  const today = getTodayForDB();
  const recentThreshold = new Date(
    today.getTime() - JPX_NEW_LISTING.RECENT_DAYS * 24 * 60 * 60 * 1000,
  );
  const upcomingThreshold = new Date(
    today.getTime() + JPX_NEW_LISTING.UPCOMING_DAYS * 24 * 60 * 60 * 1000,
  );

  // 直近上場（RECENT_DAYS以内）〜上場予定（UPCOMING_DAYS以内）に絞り、日付昇順
  const relevant = entries
    .filter(
      (e) =>
        e.listingDate.getTime() >= recentThreshold.getTime() &&
        e.listingDate.getTime() <= upcomingThreshold.getTime(),
    )
    .sort((a, b) => a.listingDate.getTime() - b.listingDate.getTime());

  console.log(`  通知対象（直近/予定）: ${relevant.length}件`);

  if (relevant.length === 0) {
    console.log("  直近・予定のIPOなし。通知はスキップ");
    console.log("=== JPX新規上場（IPO）通知 終了 ===");
    return;
  }

  const upcomingCount = relevant.filter(
    (e) => e.listingDate.getTime() > today.getTime(),
  ).length;

  // Tier A 分析: 同日上場の集中度（需要分散リスク）
  const sameDayCounts = new Map<string, number>();
  for (const e of relevant) {
    const key = dayjs(e.listingDate).format("YYYYMMDD");
    sameDayCounts.set(key, (sameDayCounts.get(key) ?? 0) + 1);
  }

  // Tier A 分析: 相場環境スコア（ツールのシーズン性知見を流用）
  let envBlock = "";
  try {
    const regime = await detectRegimeShift({});
    const env = classifyIpoEnvironment(regime.current.breadth, regime.level);
    if (env) {
      envBlock = `${getLevelEmoji(regime.level)} 相場環境: ${env.emoji} ${env.headline}\n\n`;
    }
  } catch (error) {
    // 相場データ未整備でも通知自体は継続する（分析はベストエフォート）
    console.warn("  相場環境スコアの算出に失敗（分析をスキップ）:", error);
  }

  const message = relevant
    .map((e) =>
      formatEntry(
        e,
        today,
        sameDayCounts.get(dayjs(e.listingDate).format("YYYYMMDD")) ?? 1,
      ),
    )
    .join("\n");

  await notifySlack({
    title: `📈 IPO 上場カレンダー（予定 ${upcomingCount}件 / 直近${JPX_NEW_LISTING.RECENT_DAYS}日含む計 ${relevant.length}件）`,
    message:
      envBlock +
      message +
      "\n\n※ 立花e支店はIPO抽選を扱いません。参加は楽天証券など別口座で手動で行ってください。" +
      `\n出典: ${JPX_NEW_LISTING.LIST_URL}`,
    color: "good",
  }).catch(() => {});

  console.log("=== JPX新規上場（IPO）通知 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("jpx-new-listing-notify");
if (isDirectRun) {
  main().catch((error) => {
    console.error("JPX新規上場通知 エラー:", error);
    process.exit(1);
  });
}
