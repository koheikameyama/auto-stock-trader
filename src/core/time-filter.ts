/**
 * エントリー時間帯フィルタ
 *
 * 時間帯に応じたエントリー可否判定を行う。
 * - デイトレ: 14:30以降の新規エントリーをブロック
 * - 全戦略: 9:00-9:30の寄付き直後はリスクフラグを付与（ブロックはしない）
 */

import { TIME_WINDOW } from "../lib/constants";
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
 * @param strategy - トレード戦略（day_trade / swing）
 * @param now - 判定時刻（デフォルト: 現在のJST）
 */
export function checkTimeWindow(
  strategy: "day_trade" | "swing",
  now?: dayjs.Dayjs,
): TimeWindowCheck {
  const jstNow = now ?? dayjs().tz("Asia/Tokyo");
  const hour = jstNow.hour();
  const minute = jstNow.minute();
  const timeMinutes = hour * 60 + minute;

  // 寄付き直後チェック（9:00-9:30）
  const openStart =
    TIME_WINDOW.OPENING_VOLATILITY.start.hour * 60 +
    TIME_WINDOW.OPENING_VOLATILITY.start.minute;
  const openEnd =
    TIME_WINDOW.OPENING_VOLATILITY.end.hour * 60 +
    TIME_WINDOW.OPENING_VOLATILITY.end.minute;
  const isOpeningVolatility = timeMinutes >= openStart && timeMinutes < openEnd;

  // デイトレ: 14:30以降は新規エントリー不可
  if (strategy === "day_trade") {
    const cutoff =
      TIME_WINDOW.DAY_TRADE_ENTRY_CUTOFF.hour * 60 +
      TIME_WINDOW.DAY_TRADE_ENTRY_CUTOFF.minute;

    if (timeMinutes >= cutoff) {
      return {
        canTrade: false,
        reason: `デイトレ新規エントリー締切（${TIME_WINDOW.DAY_TRADE_ENTRY_CUTOFF.hour}:${String(TIME_WINDOW.DAY_TRADE_ENTRY_CUTOFF.minute).padStart(2, "0")}以降）`,
        isOpeningVolatility,
      };
    }
  }

  return {
    canTrade: true,
    reason: isOpeningVolatility
      ? "寄付き直後（板が薄い時間帯）"
      : "OK",
    isOpeningVolatility,
  };
}
