/**
 * 東証（TSE）の営業日判定
 *
 * 休場条件:
 * 1. 土日
 * 2. 日本の祝日（国民の祝日・振替休日含む）
 * 3. 年末年始（12/31〜1/3）
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import holiday_jp from "@holiday-jp/holiday_jp";

dayjs.extend(utc);
dayjs.extend(timezone);

const JST = "Asia/Tokyo";

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
