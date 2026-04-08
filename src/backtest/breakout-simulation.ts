/**
 * ブレイクアウトバックテスト・シミュレーションエンジン
 *
 * 日次ループで出来高サージ + 高値ブレイクをシミュレーションする。
 * エントリー: dailyVolume / avgVolume25 >= triggerThreshold AND close > highN
 * 出口: 本番と同じ checkPositionExit() を直接呼出
 */

import type { OHLCVData } from "../core/technical-analysis";
import { analyzeTechnicals } from "../core/technical-analysis";
import { checkPositionExit } from "../core/exit-checker";
import { calculateCommission, calculateTax } from "../core/trading-costs";
import { getLimitDownPrice } from "../lib/constants/price-limits";
import { determineMarketRegime } from "../core/market-regime";
import { UNIT_SHARES } from "../lib/constants/trading";
import { getDynamicMaxPositionPct } from "../core/risk-manager";
import { TECHNICAL_MIN_DATA } from "../lib/constants";
import { calculateMetrics } from "./metrics";
import { RISK_PER_TRADE_PCT } from "./breakout-config";
import { computeScoreFilter } from "./scoring-filter";
import { isBreakoutSignal, passesUniverseGates } from "../core/breakout/entry-conditions";
import type {
  BreakoutBacktestConfig,
  BreakoutBacktestResult,
  SimulatedPosition,
  DailyEquity,
  RegimeLevel,
} from "./types";

const MIN_WINDOW_BARS = 80;

/**
 * walk-forward など複数コンボで共有できる事前計算データ。
 * dateIndexMap・tradingDays・dailyBreadth は設定ではなくデータと日付範囲に依存するため、
 * 同じ期間の全コンボで使い回すことで大幅に高速化できる。
 */
export interface PrecomputedSimData {
  dateIndexMap: Map<string, Map<string, number>>;
  tradingDays: string[];
  tradingDayIndex: Map<string, number>;
  /** marketTrendFilter 用。filter=false の場合は空Map */
  dailyBreadth: Map<string, number>;
  /** indexTrendFilter 用。filter=false または indexData がない場合は空Map */
  dailyIndexAboveSma: Map<string, boolean>;
  /** indexMomentumFilter 用。filter=false または indexData がない場合は空Map */
  dailyIndexMomentumPositive: Map<string, boolean>;
}

/**
 * 複数コンボで共有できる事前計算を一度だけ実行する。
 * walk-forward で IS/OOS それぞれ1回呼んで、全コンボに渡すことを想定。
 */
export function precomputeSimData(
  startDate: string,
  endDate: string,
  allData: Map<string, OHLCVData[]>,
  marketTrendFilter: boolean,
  indexTrendFilter: boolean,
  indexTrendSmaPeriod: number,
  indexData?: Map<string, number>,
  indexMomentumFilter?: boolean,
  indexMomentumDays?: number,
  indexTrendOffBufferPct?: number,
  indexTrendOnBufferPct?: number,
): PrecomputedSimData {
  // dateIndexMap
  const dateIndexMap = new Map<string, Map<string, number>>();
  for (const [ticker, bars] of allData) {
    const idxMap = new Map<string, number>();
    for (let i = 0; i < bars.length; i++) idxMap.set(bars[i].date, i);
    dateIndexMap.set(ticker, idxMap);
  }

  // tradingDays
  const allDatesSet = new Set<string>();
  for (const bars of allData.values()) {
    for (const bar of bars) {
      if (bar.date >= startDate && bar.date <= endDate) allDatesSet.add(bar.date);
    }
  }
  const tradingDays = [...allDatesSet].sort();
  const tradingDayIndex = new Map<string, number>();
  for (let i = 0; i < tradingDays.length; i++) tradingDayIndex.set(tradingDays[i], i);

  // dailyBreadth
  const dailyBreadth = new Map<string, number>();
  if (marketTrendFilter) {
    const SMA_LEN = 25;
    const tickerCloses = new Map<string, { dateIndex: Map<string, number>; closes: number[] }>();
    for (const [ticker, bars] of allData) {
      const di = new Map<string, number>();
      for (let i = 0; i < bars.length; i++) di.set(bars[i].date, i);
      tickerCloses.set(ticker, { dateIndex: di, closes: bars.map((b) => b.close) });
    }
    for (const day of tradingDays) {
      let above = 0;
      let total = 0;
      for (const [, data] of tickerCloses) {
        const idx = data.dateIndex.get(day);
        if (idx == null || idx < SMA_LEN - 1) continue;
        let sum = 0;
        for (let j = idx - SMA_LEN + 1; j <= idx; j++) sum += data.closes[j];
        const sma = sum / SMA_LEN;
        total++;
        if (data.closes[idx] > sma) above++;
      }
      dailyBreadth.set(day, total > 0 ? above / total : 0);
    }
  }

  // dailyIndexAboveSma（ヒステリシス付き）
  const dailyIndexAboveSma = new Map<string, boolean>();
  if (indexTrendFilter && indexData && indexData.size > 0) {
    const offBuffer = indexTrendOffBufferPct ?? 0;
    const onBuffer = indexTrendOnBufferPct ?? 0;
    const indexDates = [...indexData.keys()].sort();
    const indexCloses = indexDates.map((d) => indexData.get(d)!);
    const indexDateIdx = new Map<string, number>();
    for (let i = 0; i < indexDates.length; i++) indexDateIdx.set(indexDates[i], i);

    // ウォームアップ: startDate以前のデータでヒステリシス状態を確立
    let filterOn = true;
    for (let i = indexTrendSmaPeriod - 1; i < indexDates.length; i++) {
      if (indexDates[i] >= startDate) break;
      let sum = 0;
      for (let j = i - indexTrendSmaPeriod + 1; j <= i; j++) sum += indexCloses[j];
      const sma = sum / indexTrendSmaPeriod;
      if (filterOn) {
        if (indexCloses[i] < sma * (1 - offBuffer)) filterOn = false;
      } else {
        if (indexCloses[i] > sma * (1 + onBuffer)) filterOn = true;
      }
    }

    // tradingDays ループ（ヒステリシス状態を継続）
    for (const day of tradingDays) {
      const idx = indexDateIdx.get(day);
      if (idx == null || idx < indexTrendSmaPeriod - 1) {
        dailyIndexAboveSma.set(day, false);
        continue;
      }
      let sum = 0;
      for (let j = idx - indexTrendSmaPeriod + 1; j <= idx; j++) sum += indexCloses[j];
      const sma = sum / indexTrendSmaPeriod;
      if (filterOn) {
        if (indexCloses[idx] < sma * (1 - offBuffer)) filterOn = false;
      } else {
        if (indexCloses[idx] > sma * (1 + onBuffer)) filterOn = true;
      }
      dailyIndexAboveSma.set(day, filterOn);
    }
  }

  // dailyIndexMomentumPositive
  const dailyIndexMomentumPositive = new Map<string, boolean>();
  if (indexMomentumFilter && indexData && indexData.size > 0) {
    const momentumDays = indexMomentumDays ?? 60;
    const indexDates = [...indexData.keys()].sort();
    const indexCloses = indexDates.map((d) => indexData.get(d)!);
    const indexDateIdx = new Map<string, number>();
    for (let i = 0; i < indexDates.length; i++) indexDateIdx.set(indexDates[i], i);
    for (const day of tradingDays) {
      const idx = indexDateIdx.get(day);
      if (idx == null || idx < momentumDays) {
        dailyIndexMomentumPositive.set(day, false);
        continue;
      }
      dailyIndexMomentumPositive.set(day, indexCloses[idx] > indexCloses[idx - momentumDays]);
    }
  }

  return { dateIndexMap, tradingDays, tradingDayIndex, dailyBreadth, dailyIndexAboveSma, dailyIndexMomentumPositive };
}

/**
 * エントリーシグナルの事前計算結果（1銘柄分）。
 * cooldown / openPosition フィルターを除く全フィルターが適用済み。
 * atrMultiplier は walk-forward コンボで変化するため含めず、atr14 のみ保持する。
 */
export interface PrecomputedSignal {
  ticker: string;
  entryPrice: number;
  /** SL計算用: SL = entryPrice - atr14 * config.atrMultiplier */
  atr14: number;
  volumeSurgeRatio: number;
  /** ブレイクアウト強度: (signalClose - highN) / atr14 */
  breakoutStrength: number;
  /** 出来高トレンド: avgVolume5 / avgVolume25 */
  volumeTrendRatio: number;
}

/** entryDate → signals (volumeSurgeRatio 降順) */
export type PrecomputedSignals = Map<string, PrecomputedSignal[]>;

/**
 * エントリーシグナルを一括事前計算する。
 * walk-forward では IS/OOS それぞれ1回呼んで全コンボに渡すことで
 * analyzeTechnicals の呼び出し回数を 240 → 1 に削減できる。
 *
 * 前提: config のエントリー系パラメータ（triggerThreshold, highLookbackDays,
 * maxChaseAtr, marketTrendFilter/Threshold, confirmationEntry 等）が
 * 全コンボで共通であること。atrMultiplier はコンボ別に変化する SL 計算に
 * だけ影響するため、atr14 を保持してコンボ側で適用する。
 */
export function precomputeDailySignals(
  config: Pick<BreakoutBacktestConfig,
    | "maxPrice" | "minAtrPct" | "minAvgVolume25" | "minTurnover" | "triggerThreshold"
    | "highLookbackDays" | "maxChaseAtr" | "confirmationEntry" | "confirmationVolumeFilter"
    | "marketTrendFilter" | "marketTrendThreshold" | "indexTrendFilter"
    | "indexMomentumFilter" | "maxLossPct"
  >,
  allData: Map<string, OHLCVData[]>,
  precomputed: PrecomputedSimData,
): PrecomputedSignals {
  const result: PrecomputedSignals = new Map();
  const { tradingDays, dateIndexMap, dailyBreadth, dailyIndexAboveSma, dailyIndexMomentumPositive } = precomputed;
  const breadthThreshold = config.marketTrendThreshold ?? 0.5;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const today = tradingDays[dayIdx];

    // 市場フィルター（breadth / index / momentum）
    if (config.marketTrendFilter && (dailyBreadth.get(today) ?? 0) < breadthThreshold) continue;
    if (config.indexTrendFilter && !dailyIndexAboveSma.get(today)) continue;
    if (config.indexMomentumFilter && !dailyIndexMomentumPositive.get(today)) continue;

    const signalDate = config.confirmationEntry && dayIdx > 0
      ? tradingDays[dayIdx - 1]
      : today;

    const daySignals: PrecomputedSignal[] = [];

    for (const [ticker, bars] of allData) {
      const tickerIndex = dateIndexMap.get(ticker);
      const signalIdx = tickerIndex?.get(signalDate);
      if (signalIdx == null) continue;

      const todayIdx = config.confirmationEntry ? tickerIndex?.get(today) : signalIdx;
      if (todayIdx == null) continue;

      // ウィンドウスライス（シグナル日ベース）
      const windowEnd = signalIdx + 1;
      const windowStart = Math.max(0, windowEnd - MIN_WINDOW_BARS);
      const window = bars.slice(windowStart, windowEnd);
      if (window.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) continue;

      const signalBar = bars[signalIdx];

      const summary = analyzeTechnicals([...window].reverse());
      if (summary.atr14 == null) continue;

      const atrPct = (summary.atr14 / signalBar.close) * 100;
      const avgVolume25 = summary.volumeAnalysis.avgVolume20;
      if (avgVolume25 == null) continue;

      if (!passesUniverseGates({
        price: signalBar.close, avgVolume25, atrPct,
        maxPrice: config.maxPrice, minAvgVolume25: config.minAvgVolume25, minAtrPct: config.minAtrPct,
        minTurnover: config.minTurnover,
      })) continue;

      // 出来高トレンド: avgVolume5 / avgVolume25
      const vol5Start = Math.max(0, signalIdx - 4);
      const vol5Bars = bars.slice(vol5Start, signalIdx + 1);
      const avgVolume5 = vol5Bars.reduce((s, b) => s + b.volume, 0) / vol5Bars.length;
      const volumeTrendRatio = avgVolume25 > 0 ? avgVolume5 / avgVolume25 : 0;

      const volumeSurgeRatio = signalBar.volume / avgVolume25;

      // 高値ブレイク用: 過去N日の高値
      const lookbackStart = Math.max(0, signalIdx - config.highLookbackDays);
      const lookbackBars = bars.slice(lookbackStart, signalIdx);
      if (!lookbackBars.length) continue;
      const highN = Math.max(...lookbackBars.map((b) => b.high));

      const atr14 = summary.atr14;
      if (!isBreakoutSignal({
        price: signalBar.close, high20: highN, volumeSurgeRatio, atr14,
        triggerThreshold: config.triggerThreshold,
        maxChaseAtr: config.maxChaseAtr ?? Infinity,
      })) continue;

      // ブレイクアウト強度: (close - highN) / atr14
      const breakoutStrength = atr14 > 0 ? (signalBar.close - highN) / atr14 : 0;

      // 確認足
      if (config.confirmationEntry) {
        const todayBar = bars[todayIdx];
        if (todayBar.close <= highN) continue;
        if (config.confirmationVolumeFilter && todayBar.volume < avgVolume25) continue;
      }

      const entryPrice = bars[todayIdx].close;
      // SL プレビュー（riskPerShare <= 0 の銘柄を早期除外）
      const rawSL = entryPrice - atr14; // atrMultiplier=1.0 相当で確認
      if (rawSL >= entryPrice) continue;

      daySignals.push({
        ticker,
        entryPrice,
        atr14,
        volumeSurgeRatio: Math.round(volumeSurgeRatio * 100) / 100,
        breakoutStrength: Math.round(breakoutStrength * 100) / 100,
        volumeTrendRatio: Math.round(volumeTrendRatio * 100) / 100,
      });
    }

    if (daySignals.length > 0) {
      daySignals.sort((a, b) => b.volumeSurgeRatio - a.volumeSurgeRatio);
      result.set(today, daySignals);
    }
  }

  return result;
}

/**
 * ブレイクアウトバックテストを実行する
 */
export function runBreakoutBacktest(
  config: BreakoutBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData?: Map<string, number>,
  indexData?: Map<string, number>,
  precomputed?: PrecomputedSimData,
  precomputedSignals?: PrecomputedSignals,
): BreakoutBacktestResult {
  const openPositions: SimulatedPosition[] = [];
  const closedTrades: SimulatedPosition[] = [];
  const equityCurve: DailyEquity[] = [];
  const lastExitDayIdx = new Map<string, number>();
  let cash = config.initialBudget;
  const pendingSettlement: { amount: number; availableDayIdx: number }[] = [];

  // 各銘柄の date→index ルックアップを事前構築（precomputed があれば再利用）
  let dateIndexMap: Map<string, Map<string, number>>;
  let tradingDays: string[];
  let tradingDayIndex: Map<string, number>;
  let dailyBreadth: Map<string, number>;
  let dailyIndexAboveSma: Map<string, boolean>;
  let dailyIndexMomentumPositive: Map<string, boolean>;

  if (precomputed) {
    dateIndexMap = precomputed.dateIndexMap;
    tradingDays = precomputed.tradingDays;
    tradingDayIndex = precomputed.tradingDayIndex;
    dailyBreadth = precomputed.dailyBreadth;
    dailyIndexAboveSma = precomputed.dailyIndexAboveSma;
    dailyIndexMomentumPositive = precomputed.dailyIndexMomentumPositive;
  } else {
    // 単体実行時はインラインで計算（後方互換）
    dateIndexMap = new Map<string, Map<string, number>>();
    for (const [ticker, bars] of allData) {
      const indexMap = new Map<string, number>();
      for (let i = 0; i < bars.length; i++) {
        indexMap.set(bars[i].date, i);
      }
      dateIndexMap.set(ticker, indexMap);
    }

    const allDatesSet = new Set<string>();
    for (const bars of allData.values()) {
      for (const bar of bars) {
        if (bar.date >= config.startDate && bar.date <= config.endDate) {
          allDatesSet.add(bar.date);
        }
      }
    }
    tradingDays = [...allDatesSet].sort();

    tradingDayIndex = new Map<string, number>();
    for (let i = 0; i < tradingDays.length; i++) {
      tradingDayIndex.set(tradingDays[i], i);
    }

    // 市場breadth事前計算（marketTrendFilter用）
    dailyBreadth = new Map<string, number>();
    if (config.marketTrendFilter) {
      const SMA_LEN = 25;
      const tickerCloses = new Map<string, { dateIndex: Map<string, number>; closes: number[] }>();
      for (const [ticker, bars] of allData) {
        // ルックバック期間を含む全データを使用（startDate以前のデータもSMA25計算に必要）
        const di = new Map<string, number>();
        for (let i = 0; i < bars.length; i++) di.set(bars[i].date, i);
        tickerCloses.set(ticker, { dateIndex: di, closes: bars.map((b) => b.close) });
      }
      for (const day of tradingDays) {
        let above = 0;
        let total = 0;
        for (const [, data] of tickerCloses) {
          const idx = data.dateIndex.get(day);
          if (idx == null || idx < SMA_LEN - 1) continue;
          let sum = 0;
          for (let j = idx - SMA_LEN + 1; j <= idx; j++) sum += data.closes[j];
          const sma = sum / SMA_LEN;
          total++;
          if (data.closes[idx] > sma) above++;
        }
        dailyBreadth.set(day, total > 0 ? above / total : 0);
      }
    }

    // 指数トレンドフィルター事前計算（indexTrendFilter用、ヒステリシス付き）
    // indexData は date→close のMap（startDate前のlookback期間を含む）
    dailyIndexAboveSma = new Map<string, boolean>();
    if (config.indexTrendFilter && indexData && indexData.size > 0) {
      const smaPeriod = config.indexTrendSmaPeriod ?? 50;
      const offBuffer = config.indexTrendOffBufferPct ?? 0;
      const onBuffer = config.indexTrendOnBufferPct ?? 0;
      // date昇順で配列化
      const indexDates = [...indexData.keys()].sort();
      const indexCloses = indexDates.map((d) => indexData.get(d)!);
      const indexDateIdx = new Map<string, number>();
      for (let i = 0; i < indexDates.length; i++) indexDateIdx.set(indexDates[i], i);

      // ウォームアップ: startDate以前のデータでヒステリシス状態を確立
      let filterOn = true;
      for (let i = smaPeriod - 1; i < indexDates.length; i++) {
        if (indexDates[i] >= config.startDate) break;
        let sum = 0;
        for (let j = i - smaPeriod + 1; j <= i; j++) sum += indexCloses[j];
        const sma = sum / smaPeriod;
        if (filterOn) {
          if (indexCloses[i] < sma * (1 - offBuffer)) filterOn = false;
        } else {
          if (indexCloses[i] > sma * (1 + onBuffer)) filterOn = true;
        }
      }

      for (const day of tradingDays) {
        const idx = indexDateIdx.get(day);
        if (idx == null || idx < smaPeriod - 1) {
          dailyIndexAboveSma.set(day, false);
          continue;
        }
        let sum = 0;
        for (let j = idx - smaPeriod + 1; j <= idx; j++) sum += indexCloses[j];
        const sma = sum / smaPeriod;
        if (filterOn) {
          if (indexCloses[idx] < sma * (1 - offBuffer)) filterOn = false;
        } else {
          if (indexCloses[idx] > sma * (1 + onBuffer)) filterOn = true;
        }
        dailyIndexAboveSma.set(day, filterOn);
      }
    }

    // N225モメンタムフィルター事前計算（indexMomentumFilter用）
    dailyIndexMomentumPositive = new Map<string, boolean>();
    if (config.indexMomentumFilter && indexData && indexData.size > 0) {
      const momentumDays = config.indexMomentumDays ?? 60;
      const indexDates = [...indexData.keys()].sort();
      const indexCloses = indexDates.map((d) => indexData.get(d)!);
      const indexDateIdx = new Map<string, number>();
      for (let i = 0; i < indexDates.length; i++) indexDateIdx.set(indexDates[i], i);
      for (const day of tradingDays) {
        const idx = indexDateIdx.get(day);
        if (idx == null || idx < momentumDays) {
          dailyIndexMomentumPositive.set(day, false);
          continue;
        }
        dailyIndexMomentumPositive.set(day, indexCloses[idx] > indexCloses[idx - momentumDays]);
      }
    }
  }

  if (config.verbose) {
    console.log(`[breakout-bt] シミュレーション開始: ${tradingDays.length}営業日, ${allData.size}銘柄`);
  }

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const today = tradingDays[dayIdx];

    // T+2 受渡完了分をcashに解放
    for (let i = pendingSettlement.length - 1; i >= 0; i--) {
      if (pendingSettlement[i].availableDayIdx <= dayIdx) {
        cash += pendingSettlement[i].amount;
        pendingSettlement.splice(i, 1);
      }
    }

    // VIXレジーム判定
    const todayVix = vixData?.get(today);
    const todayRegime: RegimeLevel =
      todayVix != null ? determineMarketRegime(todayVix).level : "normal";

    // ──────────────────────────────────────────
    // 1. オープンポジションの出口判定
    // ──────────────────────────────────────────
    const toClose: number[] = [];
    for (let i = 0; i < openPositions.length; i++) {
      const pos = openPositions[i];
      const bars = allData.get(pos.ticker);
      if (!bars) continue;
      const barIdx = dateIndexMap.get(pos.ticker)?.get(today);
      if (barIdx == null) continue;
      const todayBar = bars[barIdx];

      const entryDayIdx = tradingDayIndex.get(pos.entryDate) ?? -1;
      const holdingDays = entryDayIdx >= 0 ? dayIdx - entryDayIdx : 0;

      // エントリー日はSL判定をスキップ（日中ノイズ防止）
      if (holdingDays === 0) {
        pos.maxHighDuringHold = Math.max(pos.maxHighDuringHold, todayBar.high);
        continue;
      }

      const exitResult = checkPositionExit(
        {
          entryPrice: pos.entryPrice,
          takeProfitPrice: pos.takeProfitPrice,
          stopLossPrice: pos.stopLossPrice,
          entryAtr: pos.entryAtr,
          maxHighDuringHold: pos.maxHighDuringHold,
          currentTrailingStop: pos.trailingStopPrice,
          strategy: "breakout",
          holdingBusinessDays: holdingDays,
          beActivationMultiplierOverride: config.beActivationMultiplier,
          trailMultiplierOverride: config.trailMultiplier,
          maxHoldingDaysOverride: config.maxExtendedHoldingDays,
          baseLimitHoldingDaysOverride: config.maxHoldingDays,
        },
        { open: todayBar.open, high: todayBar.high, low: todayBar.low, close: todayBar.close },
      );

      pos.maxHighDuringHold = exitResult.newMaxHigh;
      pos.trailingStopPrice = exitResult.trailingStopPrice;

      let exitPrice = exitResult.exitPrice;
      let exitReason: SimulatedPosition["exitReason"] = exitResult.exitReason;

      // 値幅制限シミュレーション
      if (config.priceLimitEnabled && exitPrice != null && exitReason === "stop_loss") {
        const prevBarIdx = dayIdx > 0 ? dateIndexMap.get(pos.ticker)?.get(tradingDays[dayIdx - 1]) : undefined;
        const prevBar = prevBarIdx != null ? bars[prevBarIdx] : null;
        if (prevBar) {
          const limitDown = getLimitDownPrice(prevBar.close);
          if (todayBar.open <= limitDown && todayBar.low <= limitDown && todayBar.close <= limitDown) {
            exitPrice = null;
            exitReason = null;
            pos.limitLockDays++;
            if (config.verbose) {
              console.log(`  [${today}] ${pos.ticker}: ストップ安張り付き（約定不可、${pos.limitLockDays}日目）`);
            }
          } else if (exitPrice < limitDown) {
            exitPrice = limitDown;
          }
        }
      }

      if (exitPrice != null && exitReason != null) {
        closePosition(pos, exitPrice, exitReason, today, dayIdx, tradingDays, config);
        const proceeds = exitPrice * pos.quantity - (pos.exitCommission ?? 0) - (pos.tax ?? 0);
        pendingSettlement.push({ amount: proceeds, availableDayIdx: dayIdx + 2 });
        toClose.push(i);
      }
    }

    for (let i = toClose.length - 1; i >= 0; i--) {
      const closedPos = openPositions[toClose[i]];
      closedTrades.push(closedPos);
      lastExitDayIdx.set(closedPos.ticker, dayIdx);
      openPositions.splice(toClose[i], 1);
    }

    // ──────────────────────────────────────────
    // 1.5 ディフェンシブモード
    // ──────────────────────────────────────────
    if ((todayRegime === "crisis" || todayRegime === "high") && openPositions.length > 0) {
      const defensiveToClose: number[] = [];
      for (let i = 0; i < openPositions.length; i++) {
        const pos = openPositions[i];
        const defBarIdx = dateIndexMap.get(pos.ticker)?.get(today);
        if (defBarIdx == null) continue;
        const todayBar = allData.get(pos.ticker)![defBarIdx];

        let shouldClose = false;
        if (todayRegime === "crisis") {
          shouldClose = true;
        }

        if (shouldClose) {
          closePosition(pos, todayBar.close, "defensive_exit", today, dayIdx, tradingDays, config);
          const proceeds = todayBar.close * pos.quantity - (pos.exitCommission ?? 0) - (pos.tax ?? 0);
          pendingSettlement.push({ amount: proceeds, availableDayIdx: dayIdx + 2 });
          defensiveToClose.push(i);
        }
      }

      for (let i = defensiveToClose.length - 1; i >= 0; i--) {
        const closedPos = openPositions[defensiveToClose[i]];
        closedTrades.push(closedPos);
        lastExitDayIdx.set(closedPos.ticker, dayIdx);
        openPositions.splice(defensiveToClose[i], 1);
      }
    }

    // ──────────────────────────────────────────
    // 2. ブレイクアウトエントリー検出
    // ──────────────────────────────────────────
    if (todayRegime === "crisis") {
      if (config.verbose) {
        console.log(`  [${today}] VIX crisis: 新規エントリースキップ`);
      }
    } else if (openPositions.length < config.maxPositions && cash > 0) {
      // A. 市場トレンドフィルター: breadth < 閾値 ならエントリースキップ
      const breadthThreshold = config.marketTrendThreshold ?? 0.5;
      const skipByBreadth = config.marketTrendFilter && (dailyBreadth.get(today) ?? 0) < breadthThreshold;
      // C. 指数トレンドフィルター: 日経225などの指数がSMA以下ならエントリースキップ
      const skipByIndex = config.indexTrendFilter && !dailyIndexAboveSma.get(today);
      // D. N225モメンタムフィルター: N225が60日前より低い場合はエントリースキップ
      const skipByMomentum = config.indexMomentumFilter && !dailyIndexMomentumPositive.get(today);
      if (skipByBreadth) {
        if (config.verbose) {
          const breadth = dailyBreadth.get(today) ?? 0;
          console.log(`  [${today}] 市場breadth ${(breadth * 100).toFixed(0)}% < ${(breadthThreshold * 100).toFixed(0)}%: エントリースキップ`);
        }
      } else if (skipByIndex) {
        if (config.verbose) {
          const smaPeriod = config.indexTrendSmaPeriod ?? 50;
          console.log(`  [${today}] 日経225 SMA${smaPeriod}以下: エントリースキップ`);
        }
      } else if (skipByMomentum) {
        if (config.verbose) {
          const momentumDays = config.indexMomentumDays ?? 60;
          console.log(`  [${today}] N225モメンタム（${momentumDays}日前比）ネガティブ: エントリースキップ`);
        }
      } else {
        // エントリー候補を取得（事前計算済みシグナルがあれば高速パス）
        let entries: BreakoutEntry[];
        if (precomputedSignals) {
          const rawSignals = precomputedSignals.get(today) ?? [];
          entries = [];
          for (const signal of rawSignals) {
            if (openPositions.some((p) => p.ticker === signal.ticker)) continue;
            if (config.cooldownDays > 0) {
              const lastExit = lastExitDayIdx.get(signal.ticker);
              if (lastExit != null && dayIdx - lastExit < config.cooldownDays) continue;
            }
            // エントリーフィルター（コンボ別）
            const minBA = config.minBreakoutAtr ?? 0;
            if (minBA > 0 && signal.breakoutStrength < minBA) continue;
            const vtt = config.volumeTrendThreshold ?? 1.0;
            if (signal.volumeTrendRatio < vtt) continue;

            const rawSL = signal.entryPrice - signal.atr14 * config.atrMultiplier;
            const maxSL = signal.entryPrice * (1 - config.maxLossPct);
            if (config.skipIfClamped && rawSL < maxSL) continue;
            const stopLossPrice = Math.round(Math.max(rawSL, maxSL));
            if (stopLossPrice >= signal.entryPrice) continue;
            entries.push({
              ticker: signal.ticker,
              entryPrice: signal.entryPrice,
              stopLossPrice,
              takeProfitPrice: Math.round(signal.entryPrice + signal.atr14 * 5),
              quantity: 0,
              volumeSurgeRatio: signal.volumeSurgeRatio,
              entryAtr: signal.atr14,
            });
          }
        } else {
          entries = detectBreakoutEntries(config, allData, today, cash, openPositions, lastExitDayIdx, dayIdx, tradingDays, dateIndexMap);
        }

        for (const entry of entries) {
          if (openPositions.length >= config.maxPositions) break;

          // 資金変動後の株数再計算（前のエントリーでcashが減っている場合に対応）
          const riskPerShare = entry.entryPrice - entry.stopLossPrice;
          if (riskPerShare <= 0) continue;
          const riskAmount = cash * (RISK_PER_TRADE_PCT / 100);
          const riskBasedShares = Math.floor(riskAmount / riskPerShare);
          const maxPositionPct = config.positionCapEnabled !== false ? getDynamicMaxPositionPct(cash, entry.entryPrice) : 100;
          const budgetBasedShares = Math.floor(cash * (maxPositionPct / 100) / entry.entryPrice);
          const quantity = Math.floor(Math.min(riskBasedShares, budgetBasedShares) / UNIT_SHARES) * UNIT_SHARES;
          if (quantity <= 0) continue;
          if (entry.entryPrice * quantity > cash) continue;
          entry.quantity = quantity;

          const tradeValue = entry.entryPrice * entry.quantity;
          const entryCommission = config.costModelEnabled ? calculateCommission(tradeValue) : 0;
          cash -= tradeValue + entryCommission;

          const position: SimulatedPosition = {
            ticker: entry.ticker,
            entryDate: today,
            entryPrice: entry.entryPrice,
            takeProfitPrice: entry.takeProfitPrice,
            stopLossPrice: entry.stopLossPrice,
            quantity: entry.quantity,
            volumeSurgeRatio: entry.volumeSurgeRatio,
            regime: todayRegime,
            maxHighDuringHold: entry.entryPrice,
            trailingStopPrice: null,
            entryAtr: entry.entryAtr,
            exitDate: null,
            exitPrice: null,
            exitReason: null,
            pnl: null,
            pnlPct: null,
            holdingDays: null,
            limitLockDays: 0,
            entryCommission,
            exitCommission: null,
            totalCost: null,
            tax: null,
            grossPnl: null,
            netPnl: null,
          };

          openPositions.push(position);

          if (config.verbose) {
            console.log(
              `  [${today}] ${entry.ticker} エントリー: ¥${entry.entryPrice} x${entry.quantity}` +
              ` (サージ${entry.volumeSurgeRatio.toFixed(1)}x, SL¥${entry.stopLossPrice})`,
            );
          }
        }
      }
    }

    // ──────────────────────────────────────────
    // 3. エクイティスナップショット
    // ──────────────────────────────────────────
    let positionsValue = 0;
    for (const pos of openPositions) {
      const eqBarIdx = dateIndexMap.get(pos.ticker)?.get(today);
      const markPrice = eqBarIdx != null ? allData.get(pos.ticker)![eqBarIdx].close : pos.entryPrice;
      positionsValue += markPrice * pos.quantity;
    }

    const pendingTotal = pendingSettlement.reduce((sum, s) => sum + s.amount, 0);
    equityCurve.push({
      date: today,
      cash: Math.round(cash),
      positionsValue: Math.round(positionsValue),
      totalEquity: Math.round(cash + positionsValue + pendingTotal),
      openPositionCount: openPositions.length,
    });
  }

  // 残りのオープンポジションを still_open として記録
  const allTrades = [...closedTrades];
  for (const pos of openPositions) {
    pos.exitReason = "still_open";
    allTrades.push(pos);
  }

  const metrics = calculateMetrics(allTrades, equityCurve, config.initialBudget);

  return { config, trades: allTrades, equityCurve, metrics };
}

// ====================================================
// 内部ヘルパー
// ====================================================

interface BreakoutEntry {
  ticker: string;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  quantity: number;
  volumeSurgeRatio: number;
  entryAtr: number;
}

/**
 * ブレイクアウトエントリー候補を検出
 */
function detectBreakoutEntries(
  config: BreakoutBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  today: string,
  cash: number,
  openPositions: SimulatedPosition[],
  lastExitDayIdx: Map<string, number>,
  currentDayIdx: number,
  tradingDays: string[],
  dateIndexMap: Map<string, Map<string, number>>,
): BreakoutEntry[] {
  const entries: BreakoutEntry[] = [];

  // B. 確認足エントリー: シグナル日 = 前日、確認日 = 今日
  const signalDate = config.confirmationEntry && currentDayIdx > 0
    ? tradingDays[currentDayIdx - 1]
    : today;

  for (const [ticker, bars] of allData) {
    // 同一銘柄のオープンポジションがある場合はスキップ
    if (openPositions.some((p) => p.ticker === ticker)) continue;

    // クールダウン
    if (config.cooldownDays > 0) {
      const lastExit = lastExitDayIdx.get(ticker);
      if (lastExit != null && currentDayIdx - lastExit < config.cooldownDays) continue;
    }

    // シグナル日のバーを取得（通常=today、確認足=yesterday）
    const tickerIndex = dateIndexMap.get(ticker);
    const signalIdx = tickerIndex?.get(signalDate);
    if (signalIdx == null) continue;

    // 確認足モード: 今日のバーも必要
    const todayIdx = config.confirmationEntry
      ? tickerIndex?.get(today)
      : signalIdx;
    if (todayIdx == null) continue;

    // ウィンドウスライス（シグナル日ベース）
    const windowEnd = signalIdx + 1;
    const windowStart = Math.max(0, windowEnd - MIN_WINDOW_BARS);
    const window = bars.slice(windowStart, windowEnd);

    if (window.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) continue;

    const signalBar = bars[signalIdx];

    // テクニカル分析（newest-first を期待）
    const newestFirst = [...window].reverse();
    const summary = analyzeTechnicals(newestFirst);

    if (summary.atr14 == null) continue;
    const atrPct = (summary.atr14 / signalBar.close) * 100;
    const avgVolume25 = summary.volumeAnalysis.avgVolume20;
    if (avgVolume25 == null) continue;

    // ユニバースゲート（共通関数）
    if (!passesUniverseGates({
      price: signalBar.close, avgVolume25, atrPct,
      maxPrice: config.maxPrice, minAvgVolume25: config.minAvgVolume25, minAtrPct: config.minAtrPct,
      minTurnover: config.minTurnover,
    })) continue;

    // ── ブレイクアウト条件チェック（共通関数） ──
    const volumeSurgeRatio = signalBar.volume / avgVolume25;

    const lookbackStart = Math.max(0, signalIdx - config.highLookbackDays);
    const lookbackBars = bars.slice(lookbackStart, signalIdx); // シグナル日を含まない
    if (!lookbackBars.length) continue;
    const highN = Math.max(...lookbackBars.map((b) => b.high));

    const atr14 = summary.atr14;
    if (!isBreakoutSignal({
      price: signalBar.close, high20: highN, volumeSurgeRatio, atr14,
      triggerThreshold: config.triggerThreshold,
      maxChaseAtr: config.maxChaseAtr ?? Infinity,
    })) continue;

    // ブレイクアウト強度フィルター
    const minBA = config.minBreakoutAtr ?? 0;
    if (minBA > 0 && atr14 > 0) {
      const breakoutStrength = (signalBar.close - highN) / atr14;
      if (breakoutStrength < minBA) continue;
    }

    // 出来高トレンドフィルター
    const vtt = config.volumeTrendThreshold ?? 1.0;
    if (avgVolume25 > 0) {
      const vol5Start = Math.max(0, signalIdx - 4);
      const vol5Bars = bars.slice(vol5Start, signalIdx + 1);
      const avgVolume5 = vol5Bars.reduce((s, b) => s + b.volume, 0) / vol5Bars.length;
      if (avgVolume5 / avgVolume25 < vtt) continue;
    }

    // B. 確認足: 今日のcloseがブレイクアウトレベル(highN)を上回っているか確認
    if (config.confirmationEntry) {
      const todayBar = bars[todayIdx];
      if (todayBar.close <= highN) continue;
      // 確認足＋出来高継続: 確認日の出来高が avgVolume25 以上か
      if (config.confirmationVolumeFilter && avgVolume25 != null) {
        if (todayBar.volume < avgVolume25) continue;
      }
    }

    // ── エントリー条件算出（確認足モード: 今日のclose、通常: シグナル日のclose）──
    const entryBar = bars[todayIdx];
    const entryPrice = entryBar.close;

    // SL: ATRベース、ハードキャップ適用
    const rawSL = entryPrice - atr14 * config.atrMultiplier;
    const maxSL = entryPrice * (1 - config.maxLossPct);
    if (config.skipIfClamped && rawSL < maxSL) continue;
    const stopLossPrice = Math.round(Math.max(rawSL, maxSL));

    // TP: 実質無効（TSに委ねる）
    const takeProfitPrice = Math.round(entryPrice + atr14 * 5);

    // ポジションサイジング（リスクベース）
    const riskPerShare = entryPrice - stopLossPrice;
    if (riskPerShare <= 0) continue;

    const riskAmount = cash * (RISK_PER_TRADE_PCT / 100);
    const rawQuantity = Math.floor(riskAmount / riskPerShare);
    const quantity = Math.floor(rawQuantity / UNIT_SHARES) * UNIT_SHARES;
    if (quantity <= 0) continue;
    if (entryPrice * quantity > cash) continue;

    // --- Score filter (optional) ---
    if (config.scoreFilter) {
      const score = computeScoreFilter(newestFirst);
      const { category, minScore } = config.scoreFilter;
      const scoreValue =
        category === "total" ? score.total :
        category === "trend" ? score.trend :
        category === "timing" ? score.timing :
        score.risk;
      if (scoreValue < minScore) continue;
    }

    entries.push({
      ticker,
      entryPrice,
      stopLossPrice,
      takeProfitPrice,
      quantity,
      volumeSurgeRatio: Math.round(volumeSurgeRatio * 100) / 100,
      entryAtr: atr14,
    });
  }

  // 出来高サージ倍率が高い順にソート（最も強いシグナルを優先）
  entries.sort((a, b) => b.volumeSurgeRatio - a.volumeSurgeRatio);

  return entries;
}

/**
 * ポジションをクローズ
 */
function closePosition(
  pos: SimulatedPosition,
  exitPrice: number,
  exitReason: NonNullable<SimulatedPosition["exitReason"]>,
  today: string,
  dayIdx: number,
  tradingDays: string[],
  config: BreakoutBacktestConfig,
): void {
  const grossPnl = (exitPrice - pos.entryPrice) * pos.quantity;
  const pnlPct = pos.entryPrice > 0
    ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
    : 0;
  const entryDayIdx = tradingDays.indexOf(pos.entryDate);
  const holdingDays = entryDayIdx >= 0 ? dayIdx - entryDayIdx : 1;

  const exitTradeValue = exitPrice * pos.quantity;
  const exitCommission = config.costModelEnabled ? calculateCommission(exitTradeValue) : 0;
  const totalCost = (pos.entryCommission ?? 0) + exitCommission;
  const tax = config.costModelEnabled ? calculateTax(grossPnl, totalCost) : 0;
  const netPnl = grossPnl - totalCost - tax;

  pos.exitDate = today;
  pos.exitPrice = exitPrice;
  pos.exitReason = exitReason;
  pos.pnl = Math.round(grossPnl);
  pos.pnlPct = Math.round(pnlPct * 100) / 100;
  pos.holdingDays = holdingDays;
  pos.exitCommission = exitCommission;
  pos.totalCost = Math.round(totalCost);
  pos.tax = Math.round(tax);
  pos.grossPnl = Math.round(grossPnl);
  pos.netPnl = Math.round(netPnl);

  if (config.verbose) {
    const sign = grossPnl >= 0 ? "+" : "";
    const costInfo = config.costModelEnabled
      ? ` 手数料¥${totalCost} 税¥${tax} 純${sign}¥${Math.round(netPnl)}`
      : "";
    console.log(
      `  [${today}] ${pos.ticker} 決済(${exitReason}): ¥${exitPrice} ${sign}¥${Math.round(grossPnl)} (${sign}${pos.pnlPct}%)${costInfo}`,
    );
  }
}
