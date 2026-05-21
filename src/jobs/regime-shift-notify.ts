/**
 * D期入りシグナル検出 → Slack 通知
 *
 * 引け後の breadth-notify と同タイミングで実行する。
 * 5シグナル全て揃った場合は 🚀 D期入り通知、それ以外は黙る (毎日通知してノイズ化を避ける)。
 *
 * 将来的に「ENTRY_ENABLED auto-on」など自動化につなげる土台。
 */

import { detectRegimeShift, formatRegimeShiftMessage } from "../core/regime-shift-detector";
import { notifySlack } from "../lib/slack";
import { getTodayForDB } from "../lib/market-date";

async function main() {
  const today = getTodayForDB();
  const result = await detectRegimeShift({ asOfDate: today });

  const body = formatRegimeShiftMessage(result);

  console.log(`[regime-shift] signalCount=${result.signalCount}/5, isRegimeShift=${result.isRegimeShift}`);
  console.log(body);

  if (result.isRegimeShift) {
    await notifySlack({
      title: "🚀 D期入り検出: 強気相場シグナル発火",
      message: body,
      color: "good",
    });
  } else {
    console.log("D期入りシグナル未達のため Slack 通知はスキップ");
  }
}

main().catch((e) => {
  console.error("regime-shift-notify failed:", e);
  process.exit(1);
});
