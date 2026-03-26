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
import { DEFENSIVE_MODE } from "../lib/constants";
import { TECHNICAL_MIN_DATA } from "../lib/constants";
import { calculateMetrics } from "./metrics";
import { RISK_PER_TRADE_PCT } from "./breakout-config";
import { computeScoreFilter } from "./scoring-filter";
import type {
  BreakoutBacktestConfig,
  BreakoutBacktestResult,
  SimulatedPosition,
  DailyEquity,
  RegimeLevel,
} from "./types";

const MIN_WINDOW_BARS = 80;

/**
 * ブレイクアウトバックテストを実行する
 */
export function runBreakoutBacktest(
  config: BreakoutBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData?: Map<string, number>,
): BreakoutBacktestResult {
  const openPositions: SimulatedPosition[] = [];
  const closedTrades: SimulatedPosition[] = [];
  const equityCurve: DailyEquity[] = [];
  const lastExitDayIdx = new Map<string, number>();
  let cash = config.initialBudget;

  // 全銘柄の営業日をマージしてソート
  const allDatesSet = new Set<string>();
  for (const bars of allData.values()) {
    for (const bar of bars) {
      if (bar.date >= config.startDate && bar.date <= config.endDate) {
        allDatesSet.add(bar.date);
      }
    }
  }
  const tradingDays = [...allDatesSet].sort();

  if (config.verbose) {
    console.log(`[breakout-bt] シミュレーション開始: ${tradingDays.length}営業日, ${allData.size}銘柄`);
  }

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const today = tradingDays[dayIdx];

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
      const todayBar = bars?.find((b) => b.date === today);
      if (!todayBar) continue;

      const entryDayIdx = tradingDays.indexOf(pos.entryDate);
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
          strategy: "swing",
          holdingBusinessDays: holdingDays,
          beActivationMultiplierOverride: config.beActivationMultiplier,
          activationMultiplierOverride: config.tsActivationMultiplier,
          trailMultiplierOverride: config.trailMultiplier,
          maxHoldingDaysOverride: config.maxExtendedHoldingDays,
        },
        { open: todayBar.open, high: todayBar.high, low: todayBar.low, close: todayBar.close },
      );

      pos.maxHighDuringHold = exitResult.newMaxHigh;
      pos.trailingStopPrice = exitResult.trailingStopPrice;

      let exitPrice = exitResult.exitPrice;
      let exitReason: SimulatedPosition["exitReason"] = exitResult.exitReason;

      // 値幅制限シミュレーション
      if (config.priceLimitEnabled && exitPrice != null && exitReason === "stop_loss") {
        const prevBar = dayIdx > 0 ? bars?.find((b) => b.date === tradingDays[dayIdx - 1]) : null;
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
        cash += exitPrice * pos.quantity - (pos.exitCommission ?? 0) - (pos.tax ?? 0);
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
        const bars = allData.get(pos.ticker);
        const todayBar = bars?.find((b) => b.date === today);
        if (!todayBar) continue;

        const currentProfitPct = ((todayBar.close - pos.entryPrice) / pos.entryPrice) * 100;
        let shouldClose = false;
        if (todayRegime === "crisis") {
          shouldClose = true;
        } else if (currentProfitPct >= DEFENSIVE_MODE.MIN_PROFIT_PCT_FOR_RETREAT) {
          shouldClose = true;
        }

        if (shouldClose) {
          closePosition(pos, todayBar.close, "defensive_exit", today, dayIdx, tradingDays, config);
          cash += todayBar.close * pos.quantity - (pos.exitCommission ?? 0) - (pos.tax ?? 0);
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
      const entries = detectBreakoutEntries(config, allData, today, cash, openPositions, lastExitDayIdx, dayIdx, tradingDays);

      for (const entry of entries) {
        if (openPositions.length >= config.maxPositions) break;

        // 資金変動後の株数再計算（前のエントリーでcashが減っている場合に対応）
        const riskPerShare = entry.entryPrice - entry.stopLossPrice;
        if (riskPerShare <= 0) continue;
        const riskAmount = cash * (RISK_PER_TRADE_PCT / 100);
        const rawQuantity = Math.floor(riskAmount / riskPerShare);
        const quantity = Math.floor(rawQuantity / UNIT_SHARES) * UNIT_SHARES;
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

    // ──────────────────────────────────────────
    // 3. エクイティスナップショット
    // ──────────────────────────────────────────
    let positionsValue = 0;
    for (const pos of openPositions) {
      const bars = allData.get(pos.ticker);
      const todayBar = bars?.find((b) => b.date === today);
      const markPrice = todayBar?.close ?? pos.entryPrice;
      positionsValue += markPrice * pos.quantity;
    }

    equityCurve.push({
      date: today,
      cash: Math.round(cash),
      positionsValue: Math.round(positionsValue),
      totalEquity: Math.round(cash + positionsValue),
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
  _tradingDays: string[],
): BreakoutEntry[] {
  const entries: BreakoutEntry[] = [];

  for (const [ticker, bars] of allData) {
    // 同一銘柄のオープンポジションがある場合はスキップ
    if (openPositions.some((p) => p.ticker === ticker)) continue;

    // クールダウン
    if (config.cooldownDays > 0) {
      const lastExit = lastExitDayIdx.get(ticker);
      if (lastExit != null && currentDayIdx - lastExit < config.cooldownDays) continue;
    }

    const todayIdx = bars.findIndex((b) => b.date === today);
    if (todayIdx < 0) continue;

    // ウィンドウスライス
    const windowEnd = todayIdx + 1;
    const windowStart = Math.max(0, windowEnd - MIN_WINDOW_BARS);
    const window = bars.slice(windowStart, windowEnd);

    if (window.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) continue;

    const latest = window[window.length - 1];

    // ゲートフィルター
    if (latest.close > config.maxPrice) continue;
    if (latest.close <= 0) continue;

    // テクニカル分析（newest-first を期待）
    const newestFirst = [...window].reverse();
    const summary = analyzeTechnicals(newestFirst);

    // ATR% フィルター
    if (summary.atr14 == null) continue;
    const atrPct = (summary.atr14 / latest.close) * 100;
    if (atrPct < config.minAtrPct) continue;

    // 平均出来高フィルター
    const avgVolume25 = summary.volumeAnalysis.avgVolume20;
    if (avgVolume25 == null || avgVolume25 < config.minAvgVolume25) continue;

    // ── ブレイクアウト条件チェック ──

    // 出来高サージ: dailyVolume / avgVolume25
    const volumeSurgeRatio = latest.volume / avgVolume25;
    if (volumeSurgeRatio < config.triggerThreshold) continue;

    // 高値ブレイク: close > 過去N日の高値
    const lookbackStart = Math.max(0, todayIdx - config.highLookbackDays);
    const lookbackBars = bars.slice(lookbackStart, todayIdx); // 当日を含まない
    if (!lookbackBars.length) continue;
    const highN = Math.max(...lookbackBars.map((b) => b.high));
    if (latest.close <= highN) continue;

    // 高値追いフィルター: highNからATR×maxChaseAtr以上乖離していたらスキップ
    const atr14 = summary.atr14;
    if (config.maxChaseAtr != null && atr14 > 0) {
      const chaseAmount = latest.close - highN;
      if (chaseAmount > atr14 * config.maxChaseAtr) continue;
    }

    // ── エントリー条件算出 ──
    const entryPrice = latest.close;

    // SL: ATRベース、ハードキャップ適用
    const rawSL = entryPrice - atr14 * config.atrMultiplier;
    const maxSL = entryPrice * (1 - config.maxLossPct);
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
