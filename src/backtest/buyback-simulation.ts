/**
 * 自社株買いカタリスト シグナル事前計算 (KOH-502)
 *
 * combined BT で 6戦略目として動かすため、外部JSON(開示イベント)から日次シグナルを
 * Map<date, USEtfSignal[]> に precompute する。出口が ETF と同型のため USEtfSignal 型を
 * 再利用し、processEtfExits をそのまま流用する。
 *
 * シグナル源: TDnet「自己株式取得に係る事項の決定」の (銘柄, エントリー営業日)。
 * エントリー日は開示の引け後/前を考慮して事前にシフト済み (Python側 export)。
 */

import type { OHLCVData } from "../core/technical-analysis";
import type { USEtfBacktestConfig } from "./us-etf-config";
import type { USEtfSignal, PrecomputedUSEtfSignals } from "./us-etf-simulation";

/** 外部JSON形式: { events: [{ ticker, date }] }。ticker→Set<entryDate> に変換 */
export function buildBuybackEventMap(
  events: { ticker: string; date: string }[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const e of events) {
    if (!e.ticker || !e.date) continue;
    if (!map.has(e.ticker)) map.set(e.ticker, new Set());
    map.get(e.ticker)!.add(e.date);
  }
  return map;
}

/**
 * 自社株買いシグナルを precompute する。
 *
 * @param eventMap ticker -> Set<エントリー営業日>
 * @param allData ticker -> OHLCV[] (combined universe。買い銘柄がここに無ければ取引不可としてスキップ)
 * @param dateIndexMap ticker -> (date -> barIndex)
 * @param dailyBreadth date -> japan breadth (0.0-1.0)
 * @param config BUYBACK_DEFAULT_CONFIG
 */
export function precomputeBuybackSignals(
  eventMap: Map<string, Set<string>>,
  allData: Map<string, OHLCVData[]>,
  dateIndexMap: Map<string, Map<string, number>>,
  dailyBreadth: Map<string, number>,
  config: USEtfBacktestConfig,
): PrecomputedUSEtfSignals {
  const result: PrecomputedUSEtfSignals = new Map();

  for (const [ticker, dates] of eventMap) {
    const bars = allData.get(ticker);
    const idxMap = dateIndexMap.get(ticker);
    if (!bars || !idxMap) continue; // universe外 → 取引不可

    for (const date of dates) {
      const bi = idxMap.get(date);
      if (bi == null) continue; // 非営業日 / データ欠損

      // idle帯 (breadth < 54%) のみ発火。BT自身の breadth 定義に準拠
      const breadth = dailyBreadth.get(date);
      if (breadth == null || breadth >= config.breadthMax) continue;

      const entryPrice = bars[bi].close;
      if (!(entryPrice > 0)) continue;
      const stopLossPrice = entryPrice * (1 - config.slPct);

      const signal: USEtfSignal = {
        ticker,
        date,
        entryPrice,
        stopLossPrice,
        gap: 0,
        volumeSurgeRatio: 1,
        breadthAtEntry: breadth,
      };
      const arr = result.get(date) ?? [];
      arr.push(signal);
      result.set(date, arr);
    }
  }

  return result;
}
