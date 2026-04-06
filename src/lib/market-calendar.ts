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
import { TIMEZONE } from "./constants";

dayjs.extend(utc);
dayjs.extend(timezone);

const JST = TIMEZONE;

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
