/**
 * 決算ギャップエントリー条件
 *
 * isGapUpSignal() に決算日ゲートを追加したもの。
 * 決算発表日のギャップアップのみをエントリー対象とする。
 */

import { isGapUpSignal } from "../gapup/entry-conditions";

/**
 * 決算日かつギャップアップシグナルが発生しているか判定
 *
 * @param params ギャップアップ判定パラメータ
 * @param earningsDates その銘柄の決算日セット
 * @param today 判定日（YYYY-MM-DD）
 */
export function isEarningsGapSignal(
  params: {
    open: number;
    close: number;
    prevClose: number;
    volume: number;
    avgVolume25: number;
    gapMinPct: number;
    volSurgeRatio: number;
  },
  earningsDates: Set<string> | undefined,
  today: string,
): boolean {
  // 決算日ゲート: 当日または前営業日が決算発表日であること
  // （決算発表は引け後が多いため、翌営業日にギャップが出る）
  if (!earningsDates || !earningsDates.has(today)) return false;

  return isGapUpSignal(params);
}
