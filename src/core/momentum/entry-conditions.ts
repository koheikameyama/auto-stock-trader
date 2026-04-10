/**
 * モメンタム戦略のエントリー条件
 *
 * 全銘柄を過去N日リターンでランキングし、上位銘柄を選択。
 * breakout/gapup のイベント駆動とは異なり、定期リバランスで入れ替える。
 */

import type { OHLCVData } from "../../core/technical-analysis";

export interface MomentumRanking {
  ticker: string;
  /** 過去 lookbackDays のリターン（%） */
  returnPct: number;
  /** 日足ATR14 */
  atr14: number;
  /** 直近終値 */
  currentPrice: number;
  /** 25日平均出来高 */
  avgVolume25: number;
}

/**
 * 全銘柄を過去リターンでランキングし、候補を返す。
 *
 * @param allData - 全銘柄のOHLCV（oldest-first）
 * @param dateIndexMap - ticker → (date → index)
 * @param tradingDays - シミュレーション期間の営業日リスト
 * @param todayDayIdx - 今日のインデックス（tradingDays内）
 * @param lookbackDays - リターン計測期間（営業日）
 * @param minReturnPct - 最低リターン閾値（%）
 * @returns returnPct 降順でソート済みの候補リスト
 */
export function rankByMomentum(
  allData: Map<string, OHLCVData[]>,
  dateIndexMap: Map<string, Map<string, number>>,
  tradingDays: string[],
  todayDayIdx: number,
  lookbackDays: number,
  minReturnPct: number,
): MomentumRanking[] {
  const today = tradingDays[todayDayIdx];
  const pastDayIdx = todayDayIdx - lookbackDays;
  if (pastDayIdx < 0) return [];
  const pastDate = tradingDays[pastDayIdx];

  const rankings: MomentumRanking[] = [];

  for (const [ticker, bars] of allData) {
    const tickerIndex = dateIndexMap.get(ticker);
    if (!tickerIndex) continue;

    const todayBarIdx = tickerIndex.get(today);
    const pastBarIdx = tickerIndex.get(pastDate);
    if (todayBarIdx == null || pastBarIdx == null) continue;

    const todayBar = bars[todayBarIdx];
    const pastBar = bars[pastBarIdx];
    if (!todayBar || !pastBar || pastBar.close <= 0) continue;

    const returnPct = ((todayBar.close - pastBar.close) / pastBar.close) * 100;
    if (returnPct < minReturnPct) continue;

    // 簡易ATR14計算（直近14日の平均True Range）
    const atrStart = Math.max(0, todayBarIdx - 14);
    const atrBars = bars.slice(atrStart, todayBarIdx + 1);
    if (atrBars.length < 2) continue;

    let trSum = 0;
    let trCount = 0;
    for (let i = 1; i < atrBars.length; i++) {
      const tr = Math.max(
        atrBars[i].high - atrBars[i].low,
        Math.abs(atrBars[i].high - atrBars[i - 1].close),
        Math.abs(atrBars[i].low - atrBars[i - 1].close),
      );
      trSum += tr;
      trCount++;
    }
    const atr14 = trCount > 0 ? trSum / trCount : 0;
    if (atr14 <= 0) continue;

    // 25日平均出来高
    const volStart = Math.max(0, todayBarIdx - 25);
    const volBars = bars.slice(volStart, todayBarIdx + 1);
    const avgVolume25 = volBars.reduce((s, b) => s + b.volume, 0) / volBars.length;

    rankings.push({
      ticker,
      returnPct: Math.round(returnPct * 100) / 100,
      atr14,
      currentPrice: todayBar.close,
      avgVolume25,
    });
  }

  // リターン降順でソート
  rankings.sort((a, b) => b.returnPct - a.returnPct);

  return rankings;
}
