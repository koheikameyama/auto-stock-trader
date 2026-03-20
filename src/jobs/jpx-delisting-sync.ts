/**
 * JPX廃止予定同期ジョブ（土曜 9:00 JST）
 *
 * JPX公式サイトから上場廃止予定銘柄を取得し、
 * Stockテーブルの delistingDate / isRestricted を更新する。
 *
 * 1. JPX廃止予定ページをfetch
 * 2. HTMLテーブルから廃止データを抽出
 * 3. Stockレコードを更新
 * 4. 廃止日を過ぎた銘柄を isDelisted = true に
 * 5. StockStatusLog に記録
 */

import { prisma } from "../lib/prisma";
import { JPX_DELISTING } from "../lib/constants";
import { normalizeTickerCode } from "../lib/ticker-utils";
import { getTodayForDB } from "../lib/date-utils";
import { notifySlack } from "../lib/slack";
import * as cheerio from "cheerio";
import dayjs from "dayjs";

interface DelistingEntry {
  code: string;
  name: string;
  delistingDate: Date;
  reason: string;
}

/**
 * JPX廃止予定ページからデータを取得・パース
 */
async function fetchDelistingSchedule(): Promise<DelistingEntry[]> {
  const response = await fetch(JPX_DELISTING.SCHEDULE_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; StockBuddy/1.0)",
      "Accept-Language": "ja",
    },
  });

  if (!response.ok) {
    throw new Error(`JPXページ取得失敗: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const entries: DelistingEntry[] = [];

  // JPXの廃止銘柄テーブルを解析
  // テーブル構造: 銘柄コード | 銘柄名 | 市場 | 上場廃止日 | ...
  $("table tbody tr, table.component-normal-table tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 4) return;

    const code = $(cells[0]).text().trim();
    const name = $(cells[1]).text().trim();
    // 廃止日は複数カラムパターンがあるため柔軟にパース
    let dateStr = "";
    let reason = "";

    // テーブル構造に応じてカラムを調整
    for (let i = 2; i < cells.length; i++) {
      const cellText = $(cells[i]).text().trim();
      // 日付パターン（YYYY/MM/DD or YYYY年MM月DD日）を検出
      if (!dateStr && /\d{4}[/年]\d{1,2}[/月]\d{1,2}/.test(cellText)) {
        dateStr = cellText;
      } else if (dateStr && !reason && cellText.length > 0) {
        reason = cellText;
      }
    }

    // 数字4桁のコードのみ（ETFやREITなどの英字入りも含む）
    if (!code || !/^\d{4}[A-Z]?$/.test(code)) return;
    if (!dateStr) return;

    // 日付をパース
    const normalized = dateStr
      .replace(/年/g, "/")
      .replace(/月/g, "/")
      .replace(/日/g, "");
    const parsed = dayjs(normalized, "YYYY/M/D");
    if (!parsed.isValid()) return;

    // JST日付をUTC 00:00として保存（date-utils.tsパターン）
    const delistingDate = new Date(
      Date.UTC(parsed.year(), parsed.month(), parsed.date()),
    );

    entries.push({
      code,
      name,
      delistingDate,
      reason: reason || "不明",
    });
  });

  return entries;
}

export async function main() {
  console.log("=== JPX廃止予定同期 開始 ===");

  // 1. JPXサイトからデータ取得
  console.log("[1/4] JPX廃止予定ページ取得中...");
  let entries: DelistingEntry[];
  try {
    entries = await fetchDelistingSchedule();
  } catch (error) {
    console.error("  JPXページ取得失敗:", error);
    await notifySlack({
      title: "⚠ JPX廃止予定同期: ページ取得失敗",
      message: `JPX公式サイトからのデータ取得に失敗しました。\nURL: ${JPX_DELISTING.SCHEDULE_URL}\n${error}`,
      color: "warning",
    }).catch(() => {});
    return;
  }
  console.log(`  取得: ${entries.length}件`);

  if (entries.length === 0) {
    console.log("  廃止予定銘柄なし");
    console.log("=== JPX廃止予定同期 終了 ===");
    return;
  }

  const today = getTodayForDB();
  const restrictionThreshold = new Date(
    today.getTime() + JPX_DELISTING.RESTRICTION_DAYS_BEFORE * 24 * 60 * 60 * 1000,
  );
  let updatedCount = 0;
  let restrictedCount = 0;
  let delistedCount = 0;
  const newDelistings: string[] = [];

  const statusLogs: Array<{
    tickerCode: string;
    changeType: string;
    oldValue: string | null;
    newValue: string | null;
    source: string;
    detail: string | null;
  }> = [];

  // 2. 各廃止エントリーをDB反映
  console.log("[2/4] DB更新中...");
  for (const entry of entries) {
    const tickerCode = normalizeTickerCode(entry.code);
    const stock = await prisma.stock.findUnique({
      where: { tickerCode },
      select: { id: true, delistingDate: true, isRestricted: true, isDelisted: true },
    });

    if (!stock) {
      console.log(`  スキップ: ${tickerCode} (DBに存在しない)`);
      continue;
    }

    // 既に廃止済みならスキップ
    if (stock.isDelisted) continue;

    const isNewDelisting = stock.delistingDate === null;
    const isPastDelisting = entry.delistingDate <= today;
    const shouldRestrict = entry.delistingDate <= restrictionThreshold;

    const updateData: Record<string, unknown> = {
      delistingDate: entry.delistingDate,
    };

    if (isPastDelisting) {
      updateData.isDelisted = true;
      updateData.isActive = false;
      delistedCount++;
      statusLogs.push({
        tickerCode,
        changeType: "delisting_set",
        oldValue: null,
        newValue: dayjs(entry.delistingDate).format("YYYY-MM-DD"),
        source: "jpx_delisting",
        detail: `上場廃止確定: ${entry.name} (理由: ${entry.reason})`,
      });
    } else if (shouldRestrict && !stock.isRestricted) {
      updateData.isRestricted = true;
      restrictedCount++;
      statusLogs.push({
        tickerCode,
        changeType: "restricted_set",
        oldValue: "false",
        newValue: "true",
        source: "jpx_delisting",
        detail: `廃止${JPX_DELISTING.RESTRICTION_DAYS_BEFORE}日前のため制限: ${entry.name} (廃止日: ${dayjs(entry.delistingDate).format("YYYY-MM-DD")})`,
      });
    }

    await prisma.stock.update({
      where: { id: stock.id },
      data: updateData,
    });
    updatedCount++;

    if (isNewDelisting) {
      newDelistings.push(
        `${tickerCode} ${entry.name} (廃止日: ${dayjs(entry.delistingDate).format("YYYY-MM-DD")}, 理由: ${entry.reason})`,
      );
    }
  }

  // 3. 既にdelistingDateが設定されているが廃止日を過ぎた銘柄を isDelisted に
  console.log("[3/4] 廃止日超過チェック...");
  const pastDelistings = await prisma.stock.findMany({
    where: {
      delistingDate: { not: null, lt: today },
      isDelisted: false,
    },
    select: { id: true, tickerCode: true, name: true, delistingDate: true },
  });

  for (const stock of pastDelistings) {
    await prisma.stock.update({
      where: { id: stock.id },
      data: { isDelisted: true, isActive: false },
    });
    delistedCount++;
    statusLogs.push({
      tickerCode: stock.tickerCode,
      changeType: "delisting_set",
      oldValue: "active",
      newValue: "delisted",
      source: "jpx_delisting",
      detail: `廃止日超過: ${stock.name}`,
    });
  }

  // 4. ステータスログ保存
  console.log("[4/4] ステータスログ保存...");
  if (statusLogs.length > 0) {
    await prisma.stockStatusLog.createMany({
      data: statusLogs,
    });
  }

  // サマリー
  console.log("\n=== JPX廃止予定同期 完了 ===");
  console.log(`  検出: ${entries.length}件`);
  console.log(`  DB更新: ${updatedCount}件`);
  console.log(`  制限設定: ${restrictedCount}件`);
  console.log(`  廃止確定: ${delistedCount}件`);

  // Slack通知（新規廃止予定がある場合のみ）
  if (newDelistings.length > 0) {
    await notifySlack({
      title: "📋 新規上場廃止予定を検出",
      message: newDelistings.join("\n"),
      color: "warning",
    }).catch(() => {});
  }
}

const isDirectRun = process.argv[1]?.includes("jpx-delisting-sync");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("JPX廃止予定同期 エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
