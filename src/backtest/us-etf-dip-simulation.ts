/**
 * 米株/指数 ETF 押し目(dip / mean-reversion)シグナル事前計算
 *
 * combined BT で GU/PSC と共有資金プールで動かすための日次シグナル precompute。
 * gap-momentum 版 (precomputeUSEtfSignals) と同じ USEtfSignal 型を返すため、
 * combined-simulation.ts の既存 ETF 出口・サイジング機構 (processEtfExits, SL+timeStop)
 * をそのまま再利用できる。
 *
 * エントリー (WF で堅牢✓ を確認した構造、_walk-forward-us-etf-dip.ts):
 *   - 上昇トレンドゲート: close > SMA(trendPeriod)
 *   - dip トリガー: Wilder RSI(2) <= rsiMax
 *   - breadth フィルターなし (mean-reversion はレジーム非依存、常時回すのが堅牢)
 */

import dayjs from "dayjs";
import type { OHLCVData } from "../core/technical-analysis";
import type { USEtfBacktestConfig } from "./us-etf-config";
import type { PrecomputedUSEtfSignals, USEtfSignal } from "./us-etf-simulation";

export interface USEtfDipParams {
  /** dip トリガー: RSI(2) <= この値 */
  rsiMax: number;
  /** 上昇トレンドゲート SMA 期間 */
  trendPeriod: number;
}

export const US_ETF_DIP_PARAMS: USEtfDipParams = {
  rsiMax: 5, // WF で 12/14 窓が選択した安定値
  trendPeriod: 50,
};

/** 単純移動平均（i 番目 = 直近 period 本の平均、未確定は null） */
function sma(bars: OHLCVData[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Wilder の RSI（先読みなし、未確定は null） */
function wilderRsi(bars: OHLCVData[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    if (ch >= 0) avgGain += ch;
    else avgLoss -= ch;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < bars.length; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    const gain = ch >= 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * ETF 押し目シグナルを全期間 precompute する。
 *
 * @param etfData ETF ticker -> OHLCV[] (date昇順)
 * @param config USEtfBacktestConfig (slPct のみ参照。gap/vol/breadth 系フィールドは未使用)
 * @param dipParams dip エントリーパラメータ
 */
export function precomputeUSEtfDipSignals(
  etfData: Map<string, OHLCVData[]>,
  config: USEtfBacktestConfig,
  dipParams: USEtfDipParams = US_ETF_DIP_PARAMS,
  dailyBreadth?: Map<string, number>,
): PrecomputedUSEtfSignals {
  const result: PrecomputedUSEtfSignals = new Map();
  const { rsiMax, trendPeriod } = dipParams;
  // config.breadthMax < 1.0 なら idle帯フィルター有効（前日 breadth < breadthMax の日のみ発火）
  const useIdleFilter = config.breadthMax < 1.0 && dailyBreadth != null;

  for (const ticker of config.tickers) {
    const bars = etfData.get(ticker);
    if (!bars || bars.length < trendPeriod + 2) continue;

    const trendSma = sma(bars, trendPeriod);
    const rsi2 = wilderRsi(bars, 2);

    for (let i = trendPeriod + 1; i < bars.length; i++) {
      const today = bars[i];

      // 上昇トレンドゲート
      const ts = trendSma[i];
      if (ts == null || today.close <= ts) continue;

      // dip トリガー: RSI(2) 売られすぎ
      const r = rsi2[i];
      if (r == null || r > rsiMax) continue;

      // idle帯フィルター（combined で GU/PSC と資金競合しないよう既存OFF時のみ動かす場合）
      let breadthAtEntry = -1;
      if (useIdleFilter) {
        const prevDate = dayjs(bars[i - 1].date).format("YYYY-MM-DD");
        const b = dailyBreadth!.get(prevDate);
        if (b == null || b >= config.breadthMax) continue;
        breadthAtEntry = b;
      }

      const entryPrice = today.close;
      const stopLossPrice = entryPrice * (1 - config.slPct);

      const signal: USEtfSignal = {
        ticker,
        date: dayjs(today.date).format("YYYY-MM-DD"),
        entryPrice,
        stopLossPrice,
        gap: 0, // dip 戦略では未使用
        volumeSurgeRatio: 0, // dip 戦略では未使用
        breadthAtEntry,
      };

      const arr = result.get(signal.date) ?? [];
      arr.push(signal);
      result.set(signal.date, arr);
    }
  }

  return result;
}
