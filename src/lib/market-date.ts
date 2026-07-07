/**
 * 日付ユーティリティ + 東証営業日判定
 *
 * 全ての日付計算はJST（日本時間）基準で統一する。
 * @db.Date カラムにはJSTの日付がそのまま保存されるように、
 * UTC 00:00:00 としてDateオブジェクトを作成する。
 *
 * 例: 2024-06-10 10:00 JST に実行した場合
 * - getTodayForDB() → 2024-06-10T00:00:00.000Z（PostgreSQL date型で 2024-06-10 として保存）
 * - getDaysAgoForDB(7) → 2024-06-03T00:00:00.000Z（PostgreSQL date型で 2024-06-03 として保存）
 *
 * 営業日判定の休場条件:
 * 1. 土日
 * 2. 日本の祝日（国民の祝日・振替休日含む）
 * 3. 年末年始（12/31〜1/3）
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import holiday_jp from "@holiday-jp/holiday_jp";
import { TIMEZONE } from "./constants";
import { BROKER_ORDER_BLACKOUT } from "./constants/broker";

dayjs.extend(utc);
dayjs.extend(timezone);

const JST = TIMEZONE;

// ─── 日付変換ユーティリティ ───

/**
 * JSTの日付をそのままUTC 00:00のDateオブジェクトとして返す
 * PostgreSQLの date 型に正しいJST日付が保存される
 */
export function jstDateAsUTC(d: dayjs.Dayjs): Date {
  return new Date(Date.UTC(d.year(), d.month(), d.date()));
}

/**
 * 今日の日付（JST基準）
 * DB保存・検索用
 */
export function getTodayForDB(): Date {
  return jstDateAsUTC(dayjs().tz(JST).startOf("day"));
}

/**
 * N日前の日付（JST基準）
 * DB検索用（範囲検索など）
 */
export function getDaysAgoForDB(days: number): Date {
  return jstDateAsUTC(dayjs().tz(JST).subtract(days, "day").startOf("day"));
}

/**
 * 指定日時をJST基準の日付に変換
 */
export function toJSTDateForDB(date: Date | string): Date {
  return jstDateAsUTC(dayjs(date).tz(JST).startOf("day"));
}

/**
 * JST基準の今日の開始時刻（タイムスタンプ列クエリ用）
 * getTodayForDB() とは異なり、UTCに正しく変換された時刻を返す
 * 例: JST 2024-06-10 00:00:00 → UTC 2024-06-09 15:00:00
 */
export function getStartOfDayJST(date?: Date): Date {
  return dayjs(date).tz(JST).startOf("day").toDate();
}

/**
 * JST基準の今日の終了時刻（タイムスタンプ列クエリ用）
 * 例: JST 2024-06-10 23:59:59.999 → UTC 2024-06-10 14:59:59.999
 */
export function getEndOfDayJST(date?: Date): Date {
  return dayjs(date).tz(JST).endOf("day").toDate();
}

// ─── 東証営業日判定 ───

/**
 * 指定日が東証の営業日かどうかを判定
 * 引数なしの場合は現在のJST日付で判定
 */
export function isMarketDay(date?: Date): boolean {
  const d = dayjs(date).tz(JST);
  const day = d.day(); // 0=日, 6=土

  // 土日
  if (day === 0 || day === 6) return false;

  // 日本の祝日
  const dateStr = d.format("YYYY-MM-DD");
  if (holiday_jp.isHoliday(dateStr)) return false;

  // 年末年始（12/31, 1/1〜1/3）
  // ※1/1は祝日（元日）としても判定されるが、12/31, 1/2, 1/3はTSE固有の休場日
  const month = d.month() + 1; // dayjs month is 0-indexed
  const dayOfMonth = d.date();

  if (month === 12 && dayOfMonth === 31) return false;
  if (month === 1 && dayOfMonth <= 3) return false;

  return true;
}

const MAX_LOOKAHEAD_DAYS = 30;

/**
 * 指定日の翌日から次の営業日までの連続非営業日数を返す
 *
 * @param date - 判定日（デフォルト: 現在のJST日付）
 * @returns 連続非営業日数（0 = 翌日が営業日）
 */
export function countNonTradingDaysAhead(date?: Date): number {
  const d = dayjs(date).tz(JST);
  let count = 0;
  let check = d.add(1, "day");

  while (count < MAX_LOOKAHEAD_DAYS) {
    if (isMarketDay(check.toDate())) {
      return count;
    }
    count++;
    check = check.add(1, "day");
  }

  return count;
}

/**
 * fromExclusive の翌日から toInclusive までの「営業日（トレーディングデー）」数を返す。
 *
 * 保有営業日数の算出に使う。BT（combined-simulation）の holdingDays =
 * tradingDays index 差（祝日除外の実営業日数）と定義を一致させるためのヘルパー。
 * 土日・日本の祝日・TSE固有休場（12/31, 1/2, 1/3）は数えない。
 *
 * 例: 金曜エントリー → 翌月曜時点で 1（土日は数えない）。間に祝日があればその分も除外。
 */
export function countTradingDaysBetween(fromExclusive: Date, toInclusive: Date): number {
  let count = 0;
  let d = dayjs(fromExclusive).tz(JST).add(1, "day");
  const end = dayjs(toInclusive).tz(JST);
  while (d.isBefore(end, "day") || d.isSame(end, "day")) {
    if (isMarketDay(d.toDate())) count++;
    d = d.add(1, "day");
  }
  return count;
}

/**
 * 指定日が非営業日の場合、直後の営業日に調整する
 * 営業日であればそのまま返す
 *
 * 用途: 注文期日(sOrderExpireDay)がカレンダー日加算で非営業日に
 * なるケースを防ぐ（立花APIは非営業日の期日を拒否する）
 */
export function adjustToTradingDay(date: Date): Date {
  let d = dayjs(date).tz(JST);
  let attempts = 0;
  while (!isMarketDay(d.toDate()) && attempts < MAX_LOOKAHEAD_DAYS) {
    d = d.add(1, "day");
    attempts++;
  }
  // JST日付をUTC 00:00として返す（getNextTradingDayと同じ形式）
  return new Date(Date.UTC(d.year(), d.month(), d.date()));
}

/**
 * 現在時刻が東証の取引時間内かどうかを判定
 * 前場: 9:00〜11:30 / 後場: 12:30〜15:30 JST（営業日のみ）
 */
export function isMarketOpen(): boolean {
  const now = dayjs().tz(JST);
  if (!isMarketDay(now.toDate())) return false;

  const t = now.hour() * 60 + now.minute();
  return (t >= 9 * 60 && t < 11 * 60 + 30) || (t >= 12 * 60 + 30 && t < 15 * 60 + 30);
}

/**
 * 現在が立花の「大引け後〜翌日注文受付開始前」の注文受付停止窓（15:30〜17:00 JST）かどうか。
 *
 * この窓では新規注文（逆指値SL含む）が sOrderResultCode=11102「只今の時間帯は受付できません」で
 * 拒否される。引け成行約定(15:30)直後の即時SL発注は必ずここに入るため、呼び出し側はこの窓では
 * 即時発注をスキップし ensure-broker-sl(17:00〜) に委譲する。場中のリカバリ約定検知時は false を
 * 返すので従来通り即時発注される（保護の穴を作らない）。
 */
export function isPostCloseOrderBlackout(now: Date = new Date()): boolean {
  const t = dayjs(now).tz(JST);
  const minutes = t.hour() * 60 + t.minute();
  return (
    minutes >= BROKER_ORDER_BLACKOUT.START_MINUTE_JST &&
    minutes < BROKER_ORDER_BLACKOUT.END_MINUTE_JST
  );
}

/**
 * 次の営業日の日付を返す
 *
 * @param from 起点日（デフォルト: 現在のJST日付）
 * @returns JST日付をUTC 00:00のDateとして返す（getTodayForDBと同じ形式）
 */
export function getNextTradingDay(from?: Date): Date {
  let d = dayjs(from).tz(JST).add(1, "day");
  while (!isMarketDay(d.toDate())) {
    d = d.add(1, "day");
  }
  return new Date(Date.UTC(d.year(), d.month(), d.date()));
}

/**
 * 前の営業日の日付を返す（getNextTradingDay の逆）
 *
 * @param from 起点日（デフォルト: 現在のJST日付）
 * @returns JST日付をUTC 00:00のDateとして返す（getTodayForDBと同じ形式）
 */
export function getPreviousTradingDay(from?: Date): Date {
  let d = dayjs(from).tz(JST).subtract(1, "day");
  while (!isMarketDay(d.toDate())) {
    d = d.subtract(1, "day");
  }
  return new Date(Date.UTC(d.year(), d.month(), d.date()));
}

/**
 * 指定日からN営業日後の日付を返す
 *
 * @param from 起点日
 * @param n 営業日数
 * @returns JST日付をUTC 00:00のDateとして返す（getTodayForDBと同じ形式）
 */
export function addTradingDays(from: Date, n: number): Date {
  let d = dayjs(from).tz(JST);
  let count = 0;
  while (count < n) {
    d = d.add(1, "day");
    if (isMarketDay(d.toDate())) count++;
  }
  return new Date(Date.UTC(d.year(), d.month(), d.date()));
}
