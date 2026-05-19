/**
 * セクター・ローテーション
 *
 * 各営業日について、セクター別の N日 return を計算する。
 * combined-simulation で「強いセクター上位 X% に属する銘柄のみシグナル通過」フィルターを実装するための事前計算。
 */

import type { OHLCVData } from "../core/technical-analysis";

/** dateStr -> sector -> N日 return (%) */
export type DailySectorMomentum = Map<string, Map<string, number>>;

export interface SectorRotationConfig {
  /** ルックバック日数（デフォルト 20） */
  lookbackDays: number;
  /** 上位何%のセクターを通すか (0.0-1.0)。例: 0.3 = top 30% */
  topPct: number;
}

/**
 * 各営業日について、各セクターの平均 N日 return を計算する。
 *
 * セクター return = そのセクターに属する全銘柄の N日 return の平均
 */
export function precomputeSectorMomentum(
  allData: Map<string, OHLCVData[]>,
  tickerSectorMap: Map<string, string>,
  lookbackDays: number,
): DailySectorMomentum {
  // 全営業日のリスト
  const allDates = new Set<string>();
  for (const bars of allData.values()) {
    for (const b of bars) allDates.add(b.date);
  }
  const tradingDays = [...allDates].sort();

  const result: DailySectorMomentum = new Map();

  // 各銘柄について、date -> bar の index map を構築
  const tickerBarIndex = new Map<string, Map<string, number>>();
  for (const [ticker, bars] of allData) {
    const idx = new Map<string, number>();
    for (let i = 0; i < bars.length; i++) idx.set(bars[i].date, i);
    tickerBarIndex.set(ticker, idx);
  }

  for (const today of tradingDays) {
    const sectorReturns = new Map<string, number[]>();

    for (const [ticker, bars] of allData) {
      const sector = tickerSectorMap.get(ticker);
      if (!sector) continue;

      const idx = tickerBarIndex.get(ticker)?.get(today);
      if (idx == null || idx < lookbackDays) continue;

      const today_close = bars[idx].close;
      const past_close = bars[idx - lookbackDays].close;
      if (past_close <= 0 || today_close <= 0) continue;

      const ret = (today_close - past_close) / past_close;
      const arr = sectorReturns.get(sector) ?? [];
      arr.push(ret);
      sectorReturns.set(sector, arr);
    }

    // セクター平均
    const sectorAvg = new Map<string, number>();
    for (const [sector, rets] of sectorReturns) {
      if (rets.length < 3) continue; // サンプル少なすぎる sector はスキップ
      const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
      sectorAvg.set(sector, avg);
    }

    result.set(today, sectorAvg);
  }

  return result;
}

/**
 * 指定日について、指定セクターが上位 topPct に入っているか判定
 */
export function isSectorInTop(
  date: string,
  sector: string,
  momentumMap: DailySectorMomentum,
  topPct: number,
): boolean {
  const sectorScores = momentumMap.get(date);
  if (!sectorScores || sectorScores.size === 0) return true; // データなしの日は通す（safety）

  const sorted = [...sectorScores.entries()].sort((a, b) => b[1] - a[1]);
  const cutIdx = Math.max(1, Math.ceil(sorted.length * topPct));
  const topSectors = new Set(sorted.slice(0, cutIdx).map((e) => e[0]));
  return topSectors.has(sector);
}
