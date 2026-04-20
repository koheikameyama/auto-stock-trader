/**
 * ギャップアップバックテスト・シミュレーションエンジン
 *
 * 日次ループでギャップアップシグナルを検出し、当日終値でエントリー。
 * エグジットは既存の checkPositionExit() を再利用。
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
import { GAPUP_RISK_PER_TRADE_PCT } from "./gapup-config";
import { isGapUpSignal } from "../core/gapup/entry-conditions";
import { passesUniverseGates } from "../core/breakout/entry-conditions";
import { precomputeSimData, type PrecomputedSimData } from "./breakout-simulation";
import type {
  GapUpBacktestConfig,
  GapUpBacktestResult,
  SimulatedPosition,
  DailyEquity,
  RegimeLevel,
} from "./types";

const MIN_WINDOW_BARS = 80;

/**
 * 日本市場のday Tに対して、直前のUS営業日のS&P500リターンを返す。
 * S&P500のday T-1 close は JST day T の 5:00AM に確定。
 */
function getPreviousUSReturn(jpDate: string, sp500DailyReturn: Map<string, number>): number | null {
  let bestDate: string | null = null;
  for (const [usDate] of sp500DailyReturn) {
    if (usDate < jpDate && (!bestDate || usDate > bestDate)) bestDate = usDate;
  }
  return bestDate ? sp500DailyReturn.get(bestDate) ?? null : null;
}

/**
 * ギャップアップシグナルの事前計算結果（1銘柄分）
 */
export interface PrecomputedGapUpSignal {
  ticker: string;
  entryPrice: number;
  gapPct: number;
  atr14: number;
  volumeSurgeRatio: number;
}

/** entryDate → signals (gapPct 降順) */
export type PrecomputedGapUpSignals = Map<string, PrecomputedGapUpSignal[]>;

/**
 * ギャップアップシグナルを一括事前計算する。
 * WFでは IS/OOS それぞれ1回呼んで全コンボに渡す。
 */
export function precomputeGapUpDailySignals(
  config: Pick<GapUpBacktestConfig,
    | "maxPrice" | "minAtrPct" | "minAvgVolume25" | "minTurnover" | "minPrice"
    | "gapMinPct" | "volSurgeRatio"
    | "marketTrendFilter" | "marketTrendThreshold" | "indexTrendFilter"
    | "atrMultiplier" | "maxLossPct" | "signalSortMethod"
    | "gapRelaxVolThreshold" | "gapMinPctRelaxed"
    | "sp500MaxReturn"
  >,
  allData: Map<string, OHLCVData[]>,
  precomputed: PrecomputedSimData,
  sp500DailyReturn?: Map<string, number>,
): PrecomputedGapUpSignals {
  const result: PrecomputedGapUpSignals = new Map();
  const { tradingDays, dateIndexMap, dailyBreadth, dailyIndexAboveSma } = precomputed;
  const breadthThreshold = config.marketTrendThreshold ?? 0.5;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const today = tradingDays[dayIdx];

    // マーケットフィルター
    if (config.marketTrendFilter && (dailyBreadth.get(today) ?? 0) < breadthThreshold) continue;
    if (config.indexTrendFilter && !dailyIndexAboveSma.get(today)) continue;

    // S&P500フィルター: 前夜のUS市場リターンが閾値を超えたらスキップ
    if (config.sp500MaxReturn != null && sp500DailyReturn) {
      const usRet = getPreviousUSReturn(today, sp500DailyReturn);
      if (usRet != null && usRet > config.sp500MaxReturn) continue;
    }

    const daySignals: PrecomputedGapUpSignal[] = [];

    for (const [ticker, bars] of allData) {
      const tickerIndex = dateIndexMap.get(ticker);
      const todayIdx = tickerIndex?.get(today);
      if (todayIdx == null || todayIdx < 1) continue;

      const todayBar = bars[todayIdx];
      const prevBar = bars[todayIdx - 1];
      if (!todayBar || !prevBar) continue;

      // テクニカル指標計算用ウィンドウ
      const windowEnd = todayIdx + 1;
      const windowStart = Math.max(0, windowEnd - MIN_WINDOW_BARS);
      const window = bars.slice(windowStart, windowEnd);
      if (window.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) continue;

      const summary = analyzeTechnicals([...window].reverse());
      if (summary.atr14 == null) continue;

      const atrPct = (summary.atr14 / todayBar.close) * 100;
      const avgVolume25 = summary.volumeAnalysis.avgVolume20;
      if (avgVolume25 == null) continue;

      // ユニバースフィルター
      if (!passesUniverseGates({
        price: todayBar.close, avgVolume25, atrPct,
        maxPrice: config.maxPrice, minAvgVolume25: config.minAvgVolume25, minAtrPct: config.minAtrPct,
        minTurnover: config.minTurnover, minPrice: config.minPrice,
      })) continue;

      const volumeSurgeRatio = todayBar.volume / avgVolume25;

      // ギャップアップ判定
      if (!isGapUpSignal({
        open: todayBar.open,
        close: todayBar.close,
        prevClose: prevBar.close,
        volume: todayBar.volume,
        avgVolume25,
        gapMinPct: config.gapMinPct,
        volSurgeRatio: config.volSurgeRatio,
        gapRelaxVolThreshold: config.gapRelaxVolThreshold,
        gapMinPctRelaxed: config.gapMinPctRelaxed,
      })) continue;

      const gapPct = (todayBar.open - prevBar.close) / prevBar.close;
      const entryPrice = todayBar.close;
      const atr14 = summary.atr14;

      // SL プレビュー（riskPerShare <= 0 の銘柄を早期除外）
      const rawSL = entryPrice - atr14;
      if (rawSL >= entryPrice) continue;

      daySignals.push({
        ticker,
        entryPrice,
        gapPct: Math.round(gapPct * 10000) / 10000,
        atr14,
        volumeSurgeRatio: Math.round(volumeSurgeRatio * 100) / 100,
      });
    }

    if (daySignals.length > 0) {
      const sortMethod = config.signalSortMethod ?? "gapvol";
      if (sortMethod === "rr") {
        // RR比→SL%→出来高サージ（ライブスキャナーと同一ロジック）
        const slAtrMul = config.atrMultiplier;
        const maxLossPct = config.maxLossPct; // 0.03
        daySignals.sort((a, b) => {
          const aRawSL = a.entryPrice - a.atr14 * slAtrMul;
          const aMaxSL = a.entryPrice * (1 - maxLossPct);
          const aRisk = a.entryPrice - Math.max(aRawSL, aMaxSL);
          const aRR = aRisk > 0 ? (a.atr14 * 5.0) / aRisk : 0;
          const aSlPct = aRisk / a.entryPrice;

          const bRawSL = b.entryPrice - b.atr14 * slAtrMul;
          const bMaxSL = b.entryPrice * (1 - maxLossPct);
          const bRisk = b.entryPrice - Math.max(bRawSL, bMaxSL);
          const bRR = bRisk > 0 ? (b.atr14 * 5.0) / bRisk : 0;
          const bSlPct = bRisk / b.entryPrice;

          if (Math.abs(bRR - aRR) >= 0.1) return bRR - aRR;
          if (Math.abs(aSlPct - bSlPct) >= 0.001) return aSlPct - bSlPct;
          return b.volumeSurgeRatio - a.volumeSurgeRatio;
        });
      } else if (sortMethod === "volume") {
        // 出来高サージ降順のみ
        daySignals.sort((a, b) => b.volumeSurgeRatio - a.volumeSurgeRatio);
      } else {
        // デフォルト: gapPct × volumeSurgeRatio 降順
        daySignals.sort((a, b) => (b.gapPct * b.volumeSurgeRatio) - (a.gapPct * a.volumeSurgeRatio));
      }
      result.set(today, daySignals);
    }
  }

  return result;
}

/**
 * ギャップアップバックテストを実行する
 */
export function runGapUpBacktest(
  config: GapUpBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData?: Map<string, number>,
  indexData?: Map<string, number>,
  precomputed?: PrecomputedSimData,
  precomputedSignals?: PrecomputedGapUpSignals,
  sp500DailyReturn?: Map<string, number>,
): GapUpBacktestResult {
  const openPositions: SimulatedPosition[] = [];
  const closedTrades: SimulatedPosition[] = [];
  const equityCurve: DailyEquity[] = [];
  const lastExitDayIdx = new Map<string, number>();
  let cash = config.initialBudget;
  const pendingSettlement: { amount: number; availableDayIdx: number }[] = [];

  let dateIndexMap: Map<string, Map<string, number>>;
  let tradingDays: string[];
  let tradingDayIndex: Map<string, number>;

  if (precomputed) {
    dateIndexMap = precomputed.dateIndexMap;
    tradingDays = precomputed.tradingDays;
    tradingDayIndex = precomputed.tradingDayIndex;
  } else {
    const computed = precomputeSimData(
      config.startDate, config.endDate, allData,
      config.marketTrendFilter ?? false,
      config.indexTrendFilter ?? false,
      config.indexTrendSmaPeriod ?? 50,
      indexData,
      undefined,
      undefined,
      config.indexTrendOffBufferPct,
      config.indexTrendOnBufferPct,
    ) as PrecomputedSimData;
    dateIndexMap = computed.dateIndexMap;
    tradingDays = computed.tradingDays;
    tradingDayIndex = computed.tradingDayIndex;

    // シグナルも計算
    precomputedSignals = precomputeGapUpDailySignals(config, allData, computed, sp500DailyReturn);
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

    // ── 1. オープンポジションの出口判定 ──
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

      // エントリー日はSL判定をスキップ
      if (holdingDays === 0) {
        pos.maxHighDuringHold = Math.max(pos.maxHighDuringHold, todayBar.high);
        pos.minLowDuringHold = Math.min(pos.minLowDuringHold, todayBar.low);
        continue;
      }

      const exitMode = config.exitMode ?? "trail";

      // 固定クローズモード（next_open / next_close / day2_close）
      if (exitMode !== "trail") {
        let fixedExitPrice: number | null = null;
        let fixedExitReason: SimulatedPosition["exitReason"] = null;

        // SL判定（gap-down時はopen、それ以外はSL価格）
        if (todayBar.open <= pos.stopLossPrice) {
          fixedExitPrice = todayBar.open;
          fixedExitReason = "stop_loss";
        } else if (todayBar.low <= pos.stopLossPrice) {
          fixedExitPrice = pos.stopLossPrice;
          fixedExitReason = "stop_loss";
        }

        // 値幅制限シミュレーション
        if (config.priceLimitEnabled && fixedExitPrice != null && fixedExitReason === "stop_loss") {
          const prevBarIdx = dayIdx > 0 ? dateIndexMap.get(pos.ticker)?.get(tradingDays[dayIdx - 1]) : undefined;
          const prevBar = prevBarIdx != null ? bars[prevBarIdx] : null;
          if (prevBar) {
            const limitDown = getLimitDownPrice(prevBar.close);
            if (todayBar.open <= limitDown && todayBar.low <= limitDown && todayBar.close <= limitDown) {
              fixedExitPrice = null;
              fixedExitReason = null;
              pos.limitLockDays++;
            } else if (fixedExitPrice < limitDown) {
              fixedExitPrice = limitDown;
            }
          }
        }

        // 強制クローズ判定
        if (fixedExitPrice == null) {
          const targetHoldingDay = exitMode === "day2_close" ? 2 : 1;
          if (holdingDays >= targetHoldingDay) {
            fixedExitPrice = exitMode === "next_open" ? todayBar.open : todayBar.close;
            fixedExitReason = "time_stop";
          }
        }

        if (fixedExitPrice != null && fixedExitReason != null) {
          closePosition(pos, fixedExitPrice, fixedExitReason, dayIdx, closedTrades, tradingDays, config);
          toClose.push(i);
          const proceeds = fixedExitPrice * pos.quantity - (pos.exitCommission ?? 0) - (pos.tax ?? 0);
          pendingSettlement.push({ amount: proceeds, availableDayIdx: dayIdx + 2 });
          lastExitDayIdx.set(pos.ticker, dayIdx);
        }
        continue;
      }

      const exitResult = checkPositionExit(
        {
          entryPrice: pos.entryPrice,
          takeProfitPrice: pos.takeProfitPrice,
          stopLossPrice: pos.stopLossPrice,
          entryAtr: pos.entryAtr,
          maxHighDuringHold: pos.maxHighDuringHold,
          minLowDuringHold: pos.minLowDuringHold,
          currentTrailingStop: pos.trailingStopPrice,
          strategy: "gapup",
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
          } else if (exitPrice < limitDown) {
            exitPrice = limitDown;
          }
        }
      }

      // タイムストップ
      if (exitPrice == null && holdingDays >= config.maxHoldingDays) {
        const hasProfit = todayBar.close > pos.entryPrice;
        const hasTrailingStop = pos.trailingStopPrice != null;
        if (!hasProfit || holdingDays >= config.maxExtendedHoldingDays || !hasTrailingStop) {
          exitPrice = todayBar.close;
          exitReason = "time_stop";
        }
      }

      if (exitPrice != null && exitReason != null) {
        closePosition(pos, exitPrice, exitReason, dayIdx, closedTrades, tradingDays, config);
        toClose.push(i);
        const proceeds = exitPrice * pos.quantity - (pos.exitCommission ?? 0) - (pos.tax ?? 0);
        pendingSettlement.push({ amount: proceeds, availableDayIdx: dayIdx + 2 });
        lastExitDayIdx.set(pos.ticker, dayIdx);
      }
    }

    // クローズしたポジションを除去（逆順）
    for (let i = toClose.length - 1; i >= 0; i--) {
      openPositions.splice(toClose[i], 1);
    }

    // ── 1.5 ディフェンシブ: crisis 時の強制クローズ ──
    if (todayRegime === "crisis") {
      const defClose: number[] = [];
      for (let i = 0; i < openPositions.length; i++) {
        const pos = openPositions[i];
        const defBarIdx = dateIndexMap.get(pos.ticker)?.get(today);
        if (defBarIdx == null) continue;
        const todayBar = allData.get(pos.ticker)![defBarIdx];
        closePosition(pos, todayBar.close, "defensive_exit", dayIdx, closedTrades, tradingDays, config);
        defClose.push(i);
        const defProceeds = todayBar.close * pos.quantity - (pos.exitCommission ?? 0) - (pos.tax ?? 0);
        pendingSettlement.push({ amount: defProceeds, availableDayIdx: dayIdx + 2 });
        lastExitDayIdx.set(pos.ticker, dayIdx);
      }
      for (let i = defClose.length - 1; i >= 0; i--) {
        openPositions.splice(defClose[i], 1);
      }
    }

    // ── 2. エントリー ──
    if (todayRegime !== "crisis" && openPositions.length < config.maxPositions) {
      const signals = precomputedSignals?.get(today) ?? [];
      let dailyEntryCount = 0;

      for (const signal of signals) {
        if (openPositions.length >= config.maxPositions) break;
        if (config.maxDailyEntries != null && dailyEntryCount >= config.maxDailyEntries) break;

        // 重複排除
        if (openPositions.some((p) => p.ticker === signal.ticker)) continue;

        // クールダウン
        const lastExit = lastExitDayIdx.get(signal.ticker);
        if (lastExit != null && dayIdx - lastExit < config.cooldownDays) continue;

        // SL計算
        const rawSL = signal.entryPrice - signal.atr14 * config.atrMultiplier;
        const maxSL = signal.entryPrice * (1 - config.maxLossPct);
        const stopLossPrice = Math.round(Math.max(rawSL, maxSL));
        if (stopLossPrice >= signal.entryPrice) continue;

        // TP（実質無効、TSに委ねる）
        const takeProfitPrice = Math.round(signal.entryPrice + signal.atr14 * 5);

        // ポジションサイジング（リスクベース + 資金上限キャップ）
        const riskPerShare = signal.entryPrice - stopLossPrice;
        if (riskPerShare <= 0) continue;
        const riskAmount = cash * (GAPUP_RISK_PER_TRADE_PCT / 100);
        const riskBasedShares = Math.floor(riskAmount / riskPerShare);
        const maxPositionPct = config.positionCapEnabled !== false ? getDynamicMaxPositionPct(cash, signal.entryPrice) : 100;
        const budgetBasedShares = Math.floor(cash * (maxPositionPct / 100) / signal.entryPrice);
        const quantity = Math.floor(Math.min(riskBasedShares, budgetBasedShares) / UNIT_SHARES) * UNIT_SHARES;
        if (quantity <= 0) continue;
        if (signal.entryPrice * quantity > cash) continue;

        // VIX elevated: サイズ半減
        const finalQuantity = todayRegime === "elevated"
          ? Math.floor(quantity / 2 / UNIT_SHARES) * UNIT_SHARES
          : quantity;
        if (finalQuantity <= 0) continue;

        const tradeValue = signal.entryPrice * finalQuantity;
        const entryCommission = config.costModelEnabled ? calculateCommission(tradeValue) : 0;
        cash -= tradeValue + entryCommission;

        const position: SimulatedPosition = {
          ticker: signal.ticker,
          entryDate: today,
          entryPrice: signal.entryPrice,
          takeProfitPrice,
          stopLossPrice,
          quantity: finalQuantity,
          volumeSurgeRatio: signal.volumeSurgeRatio,
          regime: todayRegime,
          maxHighDuringHold: signal.entryPrice,
          minLowDuringHold: signal.entryPrice,
          trailingStopPrice: null,
          entryAtr: signal.atr14,
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
        dailyEntryCount++;

        if (config.verbose) {
          console.log(
            `  [${today}] ${signal.ticker} エントリー: ¥${signal.entryPrice} x${finalQuantity}` +
            ` (gap${(signal.gapPct * 100).toFixed(1)}%, vol${signal.volumeSurgeRatio.toFixed(1)}x, SL¥${stopLossPrice})`,
          );
        }
      }
    }

    // ── 3. エクイティ更新 ──
    let positionsValue = 0;
    for (const pos of openPositions) {
      const eqBarIdx = dateIndexMap.get(pos.ticker)?.get(today);
      const markPrice = eqBarIdx != null ? allData.get(pos.ticker)![eqBarIdx].close : pos.entryPrice;
      positionsValue += markPrice * pos.quantity;
    }
    const pendingTotal = pendingSettlement.reduce((sum, s) => sum + s.amount, 0);
    equityCurve.push({
      date: today,
      cash,
      positionsValue,
      totalEquity: cash + positionsValue + pendingTotal,
      openPositionCount: openPositions.length,
    });
  }

  // 未クローズポジションを still_open としてマーク
  for (const pos of openPositions) {
    pos.exitReason = "still_open";
    closedTrades.push(pos);
  }

  const allTrades = [...closedTrades];
  const metrics = calculateMetrics(allTrades, equityCurve, config.initialBudget);

  return { config, trades: allTrades, equityCurve, metrics };
}

/** ポジションクローズ共通処理 */
function closePosition(
  pos: SimulatedPosition,
  exitPrice: number,
  exitReason: SimulatedPosition["exitReason"],
  dayIdx: number,
  closedTrades: SimulatedPosition[],
  tradingDays: string[],
  config: GapUpBacktestConfig,
): void {
  const grossPnl = (exitPrice - pos.entryPrice) * pos.quantity;
  const pnlPct = pos.entryPrice > 0
    ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
    : 0;
  const entryDayIdx = tradingDays.indexOf(pos.entryDate);
  const holdingDays = entryDayIdx >= 0 ? dayIdx - entryDayIdx : 1;

  const exitValue = exitPrice * pos.quantity;
  const exitCommission = config.costModelEnabled ? calculateCommission(exitValue) : 0;
  const totalCost = (pos.entryCommission ?? 0) + exitCommission;
  const tax = grossPnl > 0 && config.costModelEnabled ? calculateTax(grossPnl, totalCost) : 0;
  const netPnl = grossPnl - totalCost - tax;

  pos.exitDate = tradingDays[dayIdx];
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

  closedTrades.push(pos);

  if (config.verbose) {
    console.log(
      `  [${tradingDays[dayIdx]}] ${pos.ticker} ${exitReason}: ¥${exitPrice} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%, ${holdingDays}日)`,
    );
  }
}
