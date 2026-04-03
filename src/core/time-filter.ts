/**
 * エントリー時間帯フィルタ
 *
 * 時間帯に応じたエントリー可否判定を行う。
 * - breakout: 9:00-9:30の寄付き直後はブロック（乱高下回避）
 * - gapup: 15:20-15:25のみエントリー可能（引け注文受付期限に合わせる）
 */

import { TIME_WINDOW, TIMEZONE } from "../lib/constants";
import { GAPUP } from "../lib/constants/gapup";
import type { TradingStrategy } from "./market-regime";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

export interface TimeWindowCheck {
  canTrade: boolean;
  reason: string;
  isOpeningVolatility: boolean;
}

/**
 * 現在時刻に基づいてエントリー可否を判定する
 *
 * @param strategy - トレード戦略（breakout / gapup）
 * @param now - 判定時刻（デフォルト: 現在のJST）
 */
export function checkTimeWindow(
  strategy: TradingStrategy,
  now?: dayjs.Dayjs,
): TimeWindowCheck {
  const jstNow = now ?? dayjs().tz(TIMEZONE);

  // 寄付き直後チェック（9:00-9:30）
  const openStart = jstNow.clone().hour(TIME_WINDOW.OPENING_VOLATILITY.start.hour).minute(TIME_WINDOW.OPENING_VOLATILITY.start.minute).second(0).millisecond(0);
  const openEnd = jstNow.clone().hour(TIME_WINDOW.OPENING_VOLATILITY.end.hour).minute(TIME_WINDOW.OPENING_VOLATILITY.end.minute).second(0).millisecond(0);
  const isOpeningVolatility = !jstNow.isBefore(openStart) && jstNow.isBefore(openEnd);

  // breakout: 寄付き30分は新規エントリー不可（乱高下回避）
  if (strategy === "breakout" && isOpeningVolatility) {
    return {
      canTrade: false,
      reason: "寄付き30分の乱高下回避（09:30以降にエントリー）",
      isOpeningVolatility: true,
    };
  }

  // gapup: 15:20-15:25のみエントリー可能（引け注文受付期限に合わせる）
  if (strategy === "gapup") {
    const gapupStart = jstNow.clone().hour(GAPUP.GUARD.SCAN_HOUR).minute(GAPUP.GUARD.SCAN_MINUTE).second(0).millisecond(0);
    const gapupEnd = jstNow.clone().hour(15).minute(25).second(0).millisecond(0);
    if (jstNow.isBefore(gapupStart) || !jstNow.isBefore(gapupEnd)) {
      return {
        canTrade: false,
        reason: "gapup戦略は15:20-15:25のみエントリー可能",
        isOpeningVolatility: false,
      };
    }
    return {
      canTrade: true,
      reason: "OK",
      isOpeningVolatility: false,
    };
  }

  return {
    canTrade: true,
    reason: isOpeningVolatility
      ? "寄付き直後（板が薄い時間帯）"
      : "OK",
    isOpeningVolatility,
  };
}
