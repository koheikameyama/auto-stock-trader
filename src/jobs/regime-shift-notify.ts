/**
 * 強気相場モニター → Slack 通知
 *
 * 引け後 (breadth-notify と同タイミング) に毎日実行する。
 *
 * 通知ポリシー (ノイズ抑制):
 *   - STRONG_BULL (5/5): 必ず通知
 *   - MODERATE_BULL (4/5): 必ず通知
 *   - EARLY_SIGNAL (3/5): 前日からレベル上昇した時のみ通知
 *   - NEUTRAL: 前日が EARLY 以上から落ちた時のみ通知 (注意喚起)
 *
 * 状態管理: 前営業日を遡って detectRegimeShift を再計算するステートレス設計。
 */

import dayjs from "dayjs";
import {
  detectRegimeShift,
  formatBullMarketMessage,
  getLevelEmoji,
  getLevelLabel,
  SIGNAL_LEVEL_ORDER,
  type SignalLevel,
} from "../core/regime-shift-detector";
import { notifySlack } from "../lib/slack";
import { getTodayForDB } from "../lib/market-date";

const COLOR_BY_LEVEL: Record<SignalLevel, "good" | "warning" | "danger"> = {
  STRONG_BULL: "good",
  MODERATE_BULL: "good",
  EARLY_SIGNAL: "warning",
  NEUTRAL: "warning",
};

function levelRank(level: SignalLevel): number {
  return SIGNAL_LEVEL_ORDER.indexOf(level);
}

async function main() {
  const today = getTodayForDB();
  const current = await detectRegimeShift({ asOfDate: today });

  // 前営業日のレベルも計算 (ステートレス)
  // 暦日で 3日前を渡せば直近営業日に丸まる
  const previousDate = dayjs(today).subtract(3, "day").toDate();
  let previous: typeof current | null = null;
  try {
    previous = await detectRegimeShift({ asOfDate: previousDate });
  } catch (e) {
    console.warn(
      `前日 (${dayjs(previousDate).format("YYYY-MM-DD")}) の signal 計算失敗: ${e instanceof Error ? e.message : e}`,
    );
  }

  const todayRank = levelRank(current.level);
  const previousRank = previous ? levelRank(previous.level) : -1;

  console.log(
    `[regime-shift] today=${current.level} (${current.signalCount}/5)${
      previous ? `, previous=${previous.level} (${previous.signalCount}/5)` : ""
    }`,
  );

  // 通知判定
  let shouldNotify = false;
  let titlePrefix = "";

  if (current.level === "STRONG_BULL") {
    shouldNotify = true;
    titlePrefix = "🔥 強気相場モニター";
  } else if (current.level === "MODERATE_BULL") {
    shouldNotify = true;
    titlePrefix = "🟢 強気相場モニター";
  } else if (current.level === "EARLY_SIGNAL" && previous && todayRank > previousRank) {
    shouldNotify = true;
    titlePrefix = "🟡 強気サイン点灯";
  } else if (
    current.level === "NEUTRAL" &&
    previous &&
    previousRank >= levelRank("EARLY_SIGNAL")
  ) {
    shouldNotify = true;
    titlePrefix = "⚠️ 強気シグナル消灯";
  }

  const body = formatBullMarketMessage(current);
  console.log(body);

  if (!shouldNotify) {
    console.log(
      `通知スキップ: level=${current.level}, prevLevel=${previous?.level ?? "N/A"}`,
    );
    return;
  }

  // 状態変化の文言
  let transitionLine = "";
  if (previous && current.level !== previous.level) {
    transitionLine = `\n\n変化: ${getLevelEmoji(previous.level)} ${getLevelLabel(previous.level)} → ${getLevelEmoji(current.level)} ${getLevelLabel(current.level)}`;
  }

  await notifySlack({
    title: `${titlePrefix}: ${current.signalCount}/5`,
    message: body + transitionLine,
    color: COLOR_BY_LEVEL[current.level],
  });
}

main().catch((e) => {
  console.error("regime-shift-notify failed:", e);
  process.exit(1);
});
