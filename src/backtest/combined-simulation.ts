/**
 * 統合バックテスト シミュレーションエンジン
 *
 * Breakout + GapUp を共有資金プールで同時運用するシミュレーション。
 * CLI (combined-run.ts) と ジョブ (run-backtest.ts) から共用。
 */

import dayjs from "dayjs";
import { RISK_PER_TRADE_PCT } from "./breakout-config";
import { GAPUP_RISK_PER_TRADE_PCT } from "./gapup-config";
import { WEEKLY_BREAK_RISK_PER_TRADE_PCT } from "./weekly-break-config";
import { PSC_RISK_PER_TRADE_PCT } from "./post-surge-consolidation-config";
import { type PrecomputedSimData, precomputeDailySignals } from "./breakout-simulation";
import { precomputeGapUpDailySignals } from "./gapup-simulation";
import type { PrecomputedWeeklyBreakSignals } from "./weekly-break-simulation";
import type { PrecomputedPSCSignals } from "./post-surge-consolidation-simulation";
import { checkPositionExit } from "../core/exit-checker";
import { calculateCommission, calculateTax } from "../core/trading-costs";
import { getLimitDownPrice } from "../lib/constants/price-limits";
import { determineMarketRegime } from "../core/market-regime";
import { UNIT_SHARES, DRAWDOWN } from "../lib/constants/trading";
import { calculateMetrics } from "./metrics";
import type {
  BreakoutBacktestConfig,
  GapUpBacktestConfig,
  WeeklyBreakBacktestConfig,
  PostSurgeConsolidationBacktestConfig,
  SimulatedPosition,
  DailyEquity,
  PerformanceMetrics,
  RegimeLevel,
} from "./types";
import type { OHLCVData } from "../core/technical-analysis";

// ──────────────────────────────────────────
// 型
// ──────────────────────────────────────────
export interface SimContext {
  boConfig?: BreakoutBacktestConfig;
  guConfig: GapUpBacktestConfig;
  wbConfig?: WeeklyBreakBacktestConfig;
  pscConfig?: PostSurgeConsolidationBacktestConfig;
  pscSignals?: PrecomputedPSCSignals;
  budget: number;
  verbose: boolean;
  allData: Map<string, OHLCVData[]>;
  precomputed: PrecomputedSimData;
  breakoutSignals?: ReturnType<typeof precomputeDailySignals>;
  gapupSignals: ReturnType<typeof precomputeGapUpDailySignals>;
  weeklyBreakSignals?: PrecomputedWeeklyBreakSignals;
  vixData?: Map<string, number>;
  /** 月次資金追加額（0 = 追加なし） */
  monthlyAddAmount: number;
  /** エクイティカーブSMAフィルター期間（0 = 無効） */
  equityCurveSmaPeriod: number;
  /** VIXレジーム別戦略フィルター: このレベル以上でBreakoutエントリーを停止（undefined = crisisのみ停止） */
  boVixSkipLevel?: RegimeLevel;
  /** VIXレジーム別戦略フィルター: このレベル以上でGapUpエントリーを停止（undefined = crisisのみ停止） */
  guVixSkipLevel?: RegimeLevel;
  /** 受渡日数（デフォルト2 = T+2、信用取引シミュレーション時は0） */
  settlementDays?: number;
  /** リスク%上書き（全戦略共通、デフォルト = 各戦略の定数を使用） */
  riskPctOverride?: number;
  /** WB専用リスク%上書き（ハーフサイズ検証用。riskPctOverrideより優先） */
  wbRiskPctOverride?: number;
}

export interface SimResult {
  totalMetrics: PerformanceMetrics;
  boMetrics: PerformanceMetrics;
  guMetrics: PerformanceMetrics;
  wbMetrics: PerformanceMetrics;
  pscMetrics: PerformanceMetrics;
  equityCurve: DailyEquity[];
  allTrades: SimulatedPosition[];
  /** 累計入金額（初期資金 + 月次追加の合計） */
  totalCapitalAdded: number;
  /** ドローダウンハルトが発動した営業日数 */
  haltDays: number;
}

// ──────────────────────────────────────────
// VIXレジーム別エントリーフィルター
// ──────────────────────────────────────────
const REGIME_ORDER: Record<RegimeLevel, number> = { normal: 0, elevated: 1, high: 2, crisis: 3 };

function shouldSkipByVixRegime(currentRegime: RegimeLevel, skipLevel: RegimeLevel | undefined): boolean {
  if (skipLevel == null) return currentRegime === "crisis";
  return REGIME_ORDER[currentRegime] >= REGIME_ORDER[skipLevel];
}

// ──────────────────────────────────────────
// closePosition
// ──────────────────────────────────────────
function closePosition(
  pos: SimulatedPosition,
  exitPrice: number,
  exitReason: NonNullable<SimulatedPosition["exitReason"]>,
  dayIdx: number,
  tradingDays: string[],
  costModelEnabled: boolean,
  verbose: boolean,
): void {
  const grossPnl = (exitPrice - pos.entryPrice) * pos.quantity;
  const pnlPct = pos.entryPrice > 0
    ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
    : 0;
  const entryDayIdx = tradingDays.indexOf(pos.entryDate);
  const holdingDays = entryDayIdx >= 0 ? dayIdx - entryDayIdx : 1;

  const exitTradeValue = exitPrice * pos.quantity;
  const exitCommission = costModelEnabled ? calculateCommission(exitTradeValue) : 0;
  const totalCost = (pos.entryCommission ?? 0) + exitCommission;
  const tax = costModelEnabled ? calculateTax(grossPnl, totalCost) : 0;
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

  if (verbose) {
    const sign = grossPnl >= 0 ? "+" : "";
    console.log(
      `  [${tradingDays[dayIdx]}] ${pos.ticker} 決済(${exitReason}): ¥${exitPrice} ${sign}¥${Math.round(grossPnl)} (${sign}${pos.pnlPct}%)`,
    );
  }
}

// ──────────────────────────────────────────
// 出口判定
// ──────────────────────────────────────────
function processExits(
  positions: SimulatedPosition[],
  config: { beActivationMultiplier: number; trailMultiplier: number; maxExtendedHoldingDays: number; maxHoldingDays: number; priceLimitEnabled: boolean; costModelEnabled: boolean },
  strategy: "breakout" | "gapup" | "weekly-break" | "post-surge-consolidation",
  dayIdx: number,
  today: string,
  tradingDays: string[],
  tradingDayIndex: Map<string, number>,
  dateIndexMap: Map<string, Map<string, number>>,
  allData: Map<string, OHLCVData[]>,
  pendingSettlement: { amount: number; availableDayIdx: number }[],
  closedTrades: SimulatedPosition[],
  lastExitDayIdx: Map<string, number>,
  verbose: boolean,
  settlementDays: number,
): void {
  const toClose: number[] = [];
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const bars = allData.get(pos.ticker);
    if (!bars) continue;
    const barIdx = dateIndexMap.get(pos.ticker)?.get(today);
    if (barIdx == null) continue;
    const todayBar = bars[barIdx];

    const entryDayIdx = tradingDayIndex.get(pos.entryDate) ?? -1;
    const holdingDays = entryDayIdx >= 0 ? dayIdx - entryDayIdx : 0;

    if (holdingDays === 0) {
      pos.maxHighDuringHold = Math.max(pos.maxHighDuringHold, todayBar.high);
        pos.minLowDuringHold = Math.min(pos.minLowDuringHold, todayBar.low);
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
        strategy,
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
      closePosition(pos, exitPrice, exitReason, dayIdx, tradingDays, config.costModelEnabled, verbose);
      const proceeds = exitPrice * pos.quantity - (pos.exitCommission ?? 0) - (pos.tax ?? 0);
      pendingSettlement.push({ amount: proceeds, availableDayIdx: dayIdx + settlementDays });
      toClose.push(i);
    }
  }

  for (let i = toClose.length - 1; i >= 0; i--) {
    const closedPos = positions[toClose[i]];
    closedTrades.push(closedPos);
    lastExitDayIdx.set(closedPos.ticker, dayIdx);
    positions.splice(toClose[i], 1);
  }
}

// ──────────────────────────────────────────
// ディフェンシブモード
// ──────────────────────────────────────────
function processDefensive(
  positions: SimulatedPosition[],
  todayRegime: RegimeLevel,
  dayIdx: number,
  today: string,
  tradingDays: string[],
  dateIndexMap: Map<string, Map<string, number>>,
  allData: Map<string, OHLCVData[]>,
  pendingSettlement: { amount: number; availableDayIdx: number }[],
  closedTrades: SimulatedPosition[],
  lastExitDayIdx: Map<string, number>,
  costModelEnabled: boolean,
  verbose: boolean,
  settlementDays: number,
): void {
  if (todayRegime !== "crisis" && todayRegime !== "high") return;
  if (positions.length === 0) return;

  const defClose: number[] = [];
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const defBarIdx = dateIndexMap.get(pos.ticker)?.get(today);
    if (defBarIdx == null) continue;
    const todayBar = allData.get(pos.ticker)![defBarIdx];

    let shouldClose = false;
    if (todayRegime === "crisis") {
      shouldClose = true;
    }

    if (shouldClose) {
      closePosition(pos, todayBar.close, "defensive_exit", dayIdx, tradingDays, costModelEnabled, verbose);
      const proceeds = todayBar.close * pos.quantity - (pos.exitCommission ?? 0) - (pos.tax ?? 0);
      pendingSettlement.push({ amount: proceeds, availableDayIdx: dayIdx + settlementDays });
      defClose.push(i);
    }
  }

  for (let i = defClose.length - 1; i >= 0; i--) {
    const closedPos = positions[defClose[i]];
    closedTrades.push(closedPos);
    lastExitDayIdx.set(closedPos.ticker, dayIdx);
    positions.splice(defClose[i], 1);
  }
}

// ──────────────────────────────────────────
// ドローダウンハルト判定
// ──────────────────────────────────────────

/**
 * 週次/月次ドローダウンが閾値を超えた場合、新規エントリーを禁止する。
 * ライブシステム（drawdown-manager.ts）と同じロジック。
 *
 * - 週次: カレンダー上の月曜日を週の起点とし、前営業日のエクイティからの下落率
 * - 月次: カレンダー上の月初を起点とし、前営業日のエクイティからの下落率
 */
function checkDrawdownHalt(
  today: string,
  dayIdx: number,
  tradingDays: string[],
  equityCurve: DailyEquity[],
  initialBudget: number,
): { shouldTrade: boolean; weeklyDDPct: number; monthlyDDPct: number } {
  if (dayIdx === 0) {
    return { shouldTrade: true, weeklyDDPct: 0, monthlyDDPct: 0 };
  }

  const currentEquity = equityCurve[dayIdx - 1].totalEquity;

  // 週初エクイティ: 今週月曜以降の最初の営業日の「前営業日」エクイティ
  const todayDow = dayjs(today).day(); // 0=Sun, 1=Mon, ...
  let weekStartEquity = currentEquity;
  for (let i = dayIdx - 1; i >= 0; i--) {
    const dow = dayjs(tradingDays[i]).day();
    if (dow < todayDow || (todayDow === 1 && i === dayIdx - 1)) {
      // 前の週に入った → i+1 が今週最初の営業日
      weekStartEquity = i > 0 ? equityCurve[i - 1].totalEquity : initialBudget;
      break;
    }
    if (i === 0) {
      weekStartEquity = initialBudget;
    }
  }

  // 月初エクイティ: 今月最初の営業日の「前営業日」エクイティ
  const currentMonth = today.substring(0, 7);
  let monthStartEquity = initialBudget;
  for (let i = 0; i < dayIdx; i++) {
    if (tradingDays[i].substring(0, 7) === currentMonth) {
      monthStartEquity = i > 0 ? equityCurve[i - 1].totalEquity : initialBudget;
      break;
    }
  }

  const weeklyDDPct = weekStartEquity > 0
    ? Math.max(0, ((weekStartEquity - currentEquity) / weekStartEquity) * 100)
    : 0;
  const monthlyDDPct = monthStartEquity > 0
    ? Math.max(0, ((monthStartEquity - currentEquity) / monthStartEquity) * 100)
    : 0;

  const shouldTrade =
    weeklyDDPct < DRAWDOWN.WEEKLY_HALT_PCT &&
    monthlyDDPct < DRAWDOWN.MONTHLY_HALT_PCT;

  return { shouldTrade, weeklyDDPct, monthlyDDPct };
}

// ──────────────────────────────────────────
// エクイティカーブフィルター
// ──────────────────────────────────────────

/**
 * エクイティカーブ・トレード判定。
 * エクイティが自身のSMAを下回っていたらエントリー停止。
 * 「戦略が機能していない期間」を自動検知する。
 */
function checkEquityCurveFilter(
  dayIdx: number,
  equityCurve: DailyEquity[],
  smaPeriod: number,
): boolean {
  if (smaPeriod <= 0 || dayIdx < smaPeriod) return true;

  let sum = 0;
  for (let i = dayIdx - smaPeriod; i < dayIdx; i++) {
    sum += equityCurve[i].totalEquity;
  }
  const sma = sum / smaPeriod;

  return equityCurve[dayIdx - 1].totalEquity >= sma;
}

// ──────────────────────────────────────────
// シミュレーション本体
// ──────────────────────────────────────────
export interface PositionLimits {
  /** ブレイクアウト戦略の最大ポジション数 */
  boMax: number;
  /** ギャップアップ戦略の最大ポジション数 */
  guMax: number;
  /** 週足レンジブレイク戦略の最大ポジション数 */
  wbMax?: number;
  /** Post-Surge Consolidation戦略の最大ポジション数 */
  pscMax?: number;
  /** 全戦略合算の最大ポジション数（undefined = 制限なし） */
  totalMax?: number;
}

export function runCombinedSimulation(
  ctx: SimContext,
  maxPositions: number | PositionLimits,
): SimResult {
  const limits: PositionLimits =
    typeof maxPositions === "number"
      ? { boMax: maxPositions, guMax: maxPositions, wbMax: maxPositions, pscMax: maxPositions, totalMax: maxPositions }
      : maxPositions;
  const { boConfig, guConfig, wbConfig, pscConfig, pscSignals, budget, verbose, allData, precomputed, breakoutSignals, gapupSignals, weeklyBreakSignals, vixData, monthlyAddAmount, equityCurveSmaPeriod, boVixSkipLevel, guVixSkipLevel, settlementDays: settlementDaysOpt, riskPctOverride, wbRiskPctOverride } = ctx;
  const { tradingDays, tradingDayIndex, dateIndexMap } = precomputed;
  const settlementDays = settlementDaysOpt ?? 2;

  const boConfigLocal = { ...boConfig };
  const guConfigLocal = { ...guConfig };
  const wbConfigLocal = wbConfig ? { ...wbConfig } : null;
  const pscConfigLocal = pscConfig ? { ...pscConfig } : null;
  const wbMaxPos = limits.wbMax ?? 0;
  const pscMaxPos = limits.pscMax ?? 0;

  let cash = budget;
  let totalCapitalAdded = budget;
  let haltDays = 0;
  const pendingSettlement: { amount: number; availableDayIdx: number }[] = [];
  const boPositions: SimulatedPosition[] = [];
  const guPositions: SimulatedPosition[] = [];
  const wbPositions: SimulatedPosition[] = [];
  const pscPositions: SimulatedPosition[] = [];
  const boClosedTrades: SimulatedPosition[] = [];
  const guClosedTrades: SimulatedPosition[] = [];
  const wbClosedTrades: SimulatedPosition[] = [];
  const pscClosedTrades: SimulatedPosition[] = [];
  const lastExitDayIdx = new Map<string, number>();
  const equityCurve: DailyEquity[] = [];

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const today = tradingDays[dayIdx];

    // T+2 受渡完了分をcashに解放
    for (let i = pendingSettlement.length - 1; i >= 0; i--) {
      if (pendingSettlement[i].availableDayIdx <= dayIdx) {
        cash += pendingSettlement[i].amount;
        pendingSettlement.splice(i, 1);
      }
    }

    // 月初の資金追加
    let capitalAddedToday = 0;
    if (monthlyAddAmount > 0 && dayIdx > 0) {
      const prevMonth = tradingDays[dayIdx - 1].substring(0, 7);
      const currentMonth = today.substring(0, 7);
      if (currentMonth !== prevMonth) {
        cash += monthlyAddAmount;
        totalCapitalAdded += monthlyAddAmount;
        capitalAddedToday = monthlyAddAmount;
        if (verbose) {
          console.log(`  [${today}] 月次資金追加: +¥${monthlyAddAmount.toLocaleString()} (累計入金: ¥${totalCapitalAdded.toLocaleString()})`);
        }
      }
    }

    // VIXレジーム判定
    const todayVix = vixData?.get(today);
    const todayRegime: RegimeLevel =
      todayVix != null ? determineMarketRegime(todayVix).level : "normal";

    // ── 1. 出口判定 ──
    processExits(boPositions, boConfigLocal, "breakout", dayIdx, today, tradingDays, tradingDayIndex, dateIndexMap, allData, pendingSettlement, boClosedTrades, lastExitDayIdx, verbose, settlementDays);
    processExits(guPositions, guConfigLocal, "gapup", dayIdx, today, tradingDays, tradingDayIndex, dateIndexMap, allData, pendingSettlement, guClosedTrades, lastExitDayIdx, verbose, settlementDays);
    if (wbConfigLocal) {
      processExits(wbPositions, wbConfigLocal, "weekly-break", dayIdx, today, tradingDays, tradingDayIndex, dateIndexMap, allData, pendingSettlement, wbClosedTrades, lastExitDayIdx, verbose, settlementDays);
    }
    if (pscConfigLocal) {
      processExits(pscPositions, pscConfigLocal, "post-surge-consolidation", dayIdx, today, tradingDays, tradingDayIndex, dateIndexMap, allData, pendingSettlement, pscClosedTrades, lastExitDayIdx, verbose, settlementDays);
    }

    // ── 1.5 ディフェンシブモード ──
    processDefensive(boPositions, todayRegime, dayIdx, today, tradingDays, dateIndexMap, allData, pendingSettlement, boClosedTrades, lastExitDayIdx, boConfigLocal.costModelEnabled, verbose, settlementDays);
    processDefensive(guPositions, todayRegime, dayIdx, today, tradingDays, dateIndexMap, allData, pendingSettlement, guClosedTrades, lastExitDayIdx, guConfigLocal.costModelEnabled, verbose, settlementDays);
    if (wbConfigLocal) {
      processDefensive(wbPositions, todayRegime, dayIdx, today, tradingDays, dateIndexMap, allData, pendingSettlement, wbClosedTrades, lastExitDayIdx, wbConfigLocal.costModelEnabled, verbose, settlementDays);
    }
    if (pscConfigLocal) {
      processDefensive(pscPositions, todayRegime, dayIdx, today, tradingDays, dateIndexMap, allData, pendingSettlement, pscClosedTrades, lastExitDayIdx, pscConfigLocal.costModelEnabled, verbose, settlementDays);
    }

    // ── 1.6 ドローダウンハルト判定（全戦略に適用） ──
    const ddHalt = checkDrawdownHalt(today, dayIdx, tradingDays, equityCurve, budget);
    let boShouldTrade = ddHalt.shouldTrade;
    const guShouldTrade = ddHalt.shouldTrade;
    const wbShouldTrade = ddHalt.shouldTrade;
    const { weeklyDDPct, monthlyDDPct } = ddHalt;
    if (!ddHalt.shouldTrade) {
      haltDays++;
      if (verbose) {
        const reasons: string[] = [];
        if (weeklyDDPct >= DRAWDOWN.WEEKLY_HALT_PCT) reasons.push(`週次 ${weeklyDDPct.toFixed(1)}% ≥ ${DRAWDOWN.WEEKLY_HALT_PCT}%`);
        if (monthlyDDPct >= DRAWDOWN.MONTHLY_HALT_PCT) reasons.push(`月次 ${monthlyDDPct.toFixed(1)}% ≥ ${DRAWDOWN.MONTHLY_HALT_PCT}%`);
        console.log(`  [${today}] DDハルト: ${reasons.join(" / ")}`);
      }
    }

    // ── 1.7 エクイティカーブフィルター（Breakoutのみ停止、GapUpは継続） ──
    if (boShouldTrade && !checkEquityCurveFilter(dayIdx, equityCurve, equityCurveSmaPeriod)) {
      boShouldTrade = false;
      if (ddHalt.shouldTrade) haltDays++; // DDハルトと重複カウントしない
      if (verbose) {
        console.log(`  [${today}] エクイティフィルター: SMA${equityCurveSmaPeriod}下回り（BO停止/GU継続）`);
      }
    }

    // 全ポジションの銘柄リスト（重複排除用）
    const allOpenTickers = new Set([
      ...boPositions.map((p) => p.ticker),
      ...guPositions.map((p) => p.ticker),
      ...wbPositions.map((p) => p.ticker),
      ...pscPositions.map((p) => p.ticker),
    ]);

    // ── 2a. Breakout エントリー ──
    const totalPositions = () => boPositions.length + guPositions.length + wbPositions.length + pscPositions.length;
    const totalUnderLimit = () => limits.totalMax === undefined || totalPositions() < limits.totalMax;
    if (boShouldTrade && !shouldSkipByVixRegime(todayRegime, boVixSkipLevel) && boPositions.length < limits.boMax && totalUnderLimit() && cash > 0) {
      const rawSignals = breakoutSignals?.get(today) ?? [];
      for (const signal of rawSignals) {
        if (boPositions.length >= limits.boMax || !totalUnderLimit()) break;
        if (allOpenTickers.has(signal.ticker)) continue;

        const lastExit = lastExitDayIdx.get(signal.ticker);
        if (lastExit != null && dayIdx - lastExit < boConfigLocal.cooldownDays) continue;

        const rawSL = signal.entryPrice - signal.atr14 * boConfigLocal.atrMultiplier;
        const maxSL = signal.entryPrice * (1 - boConfigLocal.maxLossPct);
        const stopLossPrice = Math.round(Math.max(rawSL, maxSL));
        if (stopLossPrice >= signal.entryPrice) continue;

        const riskPerShare = signal.entryPrice - stopLossPrice;
        if (riskPerShare <= 0) continue;
        const riskAmount = cash * ((riskPctOverride ?? RISK_PER_TRADE_PCT) / 100);
        const rawQuantity = Math.floor(riskAmount / riskPerShare);
        let quantity = Math.floor(rawQuantity / UNIT_SHARES) * UNIT_SHARES;
        if (todayRegime === "elevated") quantity = Math.floor(quantity / 2 / UNIT_SHARES) * UNIT_SHARES;
        if (quantity <= 0) continue;
        if (signal.entryPrice * quantity > cash) continue;

        const tradeValue = signal.entryPrice * quantity;
        const entryCommission = boConfigLocal.costModelEnabled ? calculateCommission(tradeValue) : 0;
        cash -= tradeValue + entryCommission;

        boPositions.push({
          ticker: signal.ticker, entryDate: today, entryPrice: signal.entryPrice,
          takeProfitPrice: Math.round(signal.entryPrice + signal.atr14 * 5), stopLossPrice, quantity,
          volumeSurgeRatio: signal.volumeSurgeRatio, regime: todayRegime,
          maxHighDuringHold: signal.entryPrice, minLowDuringHold: signal.entryPrice, trailingStopPrice: null, entryAtr: signal.atr14,
          exitDate: null, exitPrice: null, exitReason: null, pnl: null, pnlPct: null, holdingDays: null,
          limitLockDays: 0, entryCommission, exitCommission: null, totalCost: null, tax: null, grossPnl: null, netPnl: null,
        });
        allOpenTickers.add(signal.ticker);
      }
    }

    // ── 2b. GapUp エントリー ──
    if (guShouldTrade && !shouldSkipByVixRegime(todayRegime, guVixSkipLevel) && guPositions.length < limits.guMax && totalUnderLimit() && cash > 0) {
      const signals = gapupSignals.get(today) ?? [];
      for (const signal of signals) {
        if (guPositions.length >= limits.guMax || !totalUnderLimit()) break;
        if (allOpenTickers.has(signal.ticker)) continue;

        const lastExit = lastExitDayIdx.get(signal.ticker);
        if (lastExit != null && dayIdx - lastExit < guConfigLocal.cooldownDays) continue;

        const rawSL = signal.entryPrice - signal.atr14 * guConfigLocal.atrMultiplier;
        const maxSL = signal.entryPrice * (1 - guConfigLocal.maxLossPct);
        const stopLossPrice = Math.round(Math.max(rawSL, maxSL));
        if (stopLossPrice >= signal.entryPrice) continue;

        const riskPerShare = signal.entryPrice - stopLossPrice;
        if (riskPerShare <= 0) continue;
        const riskAmount = cash * ((riskPctOverride ?? GAPUP_RISK_PER_TRADE_PCT) / 100);
        const rawQuantity = Math.floor(riskAmount / riskPerShare);
        let quantity = Math.floor(rawQuantity / UNIT_SHARES) * UNIT_SHARES;
        if (todayRegime === "elevated") quantity = Math.floor(quantity / 2 / UNIT_SHARES) * UNIT_SHARES;
        if (quantity <= 0) continue;
        if (signal.entryPrice * quantity > cash) continue;

        const tradeValue = signal.entryPrice * quantity;
        const entryCommission = guConfigLocal.costModelEnabled ? calculateCommission(tradeValue) : 0;
        cash -= tradeValue + entryCommission;

        guPositions.push({
          ticker: signal.ticker, entryDate: today, entryPrice: signal.entryPrice,
          takeProfitPrice: Math.round(signal.entryPrice + signal.atr14 * 5), stopLossPrice, quantity,
          volumeSurgeRatio: signal.volumeSurgeRatio, regime: todayRegime,
          maxHighDuringHold: signal.entryPrice, minLowDuringHold: signal.entryPrice, trailingStopPrice: null, entryAtr: signal.atr14,
          exitDate: null, exitPrice: null, exitReason: null, pnl: null, pnlPct: null, holdingDays: null,
          limitLockDays: 0, entryCommission, exitCommission: null, totalCost: null, tax: null, grossPnl: null, netPnl: null,
        });
        allOpenTickers.add(signal.ticker);
      }
    }

    // ── 2c. WeeklyBreak エントリー ──
    if (wbConfigLocal && wbShouldTrade && todayRegime !== "crisis" && wbPositions.length < wbMaxPos && totalUnderLimit() && cash > 0) {
      const signals = weeklyBreakSignals?.get(today) ?? [];
      for (const signal of signals) {
        if (wbPositions.length >= wbMaxPos || !totalUnderLimit()) break;
        if (allOpenTickers.has(signal.ticker)) continue;

        const lastExit = lastExitDayIdx.get(signal.ticker);
        if (lastExit != null && dayIdx - lastExit < wbConfigLocal.cooldownDays) continue;

        const rawSL = signal.entryPrice - signal.atr14 * wbConfigLocal.atrMultiplier;
        const maxSL = signal.entryPrice * (1 - wbConfigLocal.maxLossPct);
        const stopLossPrice = Math.round(Math.max(rawSL, maxSL));
        if (stopLossPrice >= signal.entryPrice) continue;

        const riskPerShare = signal.entryPrice - stopLossPrice;
        if (riskPerShare <= 0) continue;
        const riskAmount = cash * ((wbRiskPctOverride ?? riskPctOverride ?? WEEKLY_BREAK_RISK_PER_TRADE_PCT) / 100);
        const rawQuantity = Math.floor(riskAmount / riskPerShare);
        let quantity = Math.floor(rawQuantity / UNIT_SHARES) * UNIT_SHARES;
        if (todayRegime === "elevated") quantity = Math.floor(quantity / 2 / UNIT_SHARES) * UNIT_SHARES;
        if (quantity <= 0) continue;
        if (signal.entryPrice * quantity > cash) continue;

        const tradeValue = signal.entryPrice * quantity;
        const entryCommission = wbConfigLocal.costModelEnabled ? calculateCommission(tradeValue) : 0;
        cash -= tradeValue + entryCommission;

        wbPositions.push({
          ticker: signal.ticker, entryDate: today, entryPrice: signal.entryPrice,
          takeProfitPrice: Math.round(signal.entryPrice + signal.atr14 * 5), stopLossPrice, quantity,
          volumeSurgeRatio: signal.weeklyVolSurge, regime: todayRegime,
          maxHighDuringHold: signal.entryPrice, minLowDuringHold: signal.entryPrice, trailingStopPrice: null, entryAtr: signal.atr14,
          exitDate: null, exitPrice: null, exitReason: null, pnl: null, pnlPct: null, holdingDays: null,
          limitLockDays: 0, entryCommission, exitCommission: null, totalCost: null, tax: null, grossPnl: null, netPnl: null,
        });
        allOpenTickers.add(signal.ticker);
      }
    }

    // ── 2d. PSC エントリー ──
    if (pscConfigLocal && pscSignals && guShouldTrade && todayRegime !== "crisis" && pscPositions.length < pscMaxPos && totalUnderLimit() && cash > 0) {
      const signals = pscSignals.get(today) ?? [];
      for (const signal of signals) {
        if (pscPositions.length >= pscMaxPos || !totalUnderLimit()) break;
        if (allOpenTickers.has(signal.ticker)) continue;

        const lastExit = lastExitDayIdx.get(signal.ticker);
        if (lastExit != null && dayIdx - lastExit < pscConfigLocal.cooldownDays) continue;

        const rawSL = signal.entryPrice - signal.atr14 * pscConfigLocal.atrMultiplier;
        const maxSL = signal.entryPrice * (1 - pscConfigLocal.maxLossPct);
        const stopLossPrice = Math.round(Math.max(rawSL, maxSL));
        if (stopLossPrice >= signal.entryPrice) continue;

        const riskPerShare = signal.entryPrice - stopLossPrice;
        if (riskPerShare <= 0) continue;
        const riskAmount = cash * ((riskPctOverride ?? PSC_RISK_PER_TRADE_PCT) / 100);
        const rawQuantity = Math.floor(riskAmount / riskPerShare);
        let quantity = Math.floor(rawQuantity / UNIT_SHARES) * UNIT_SHARES;
        if (todayRegime === "elevated") quantity = Math.floor(quantity / 2 / UNIT_SHARES) * UNIT_SHARES;
        if (quantity <= 0) continue;
        if (signal.entryPrice * quantity > cash) continue;

        const tradeValue = signal.entryPrice * quantity;
        const entryCommission = pscConfigLocal.costModelEnabled ? calculateCommission(tradeValue) : 0;
        cash -= tradeValue + entryCommission;

        pscPositions.push({
          ticker: signal.ticker, entryDate: today, entryPrice: signal.entryPrice,
          takeProfitPrice: Math.round(signal.entryPrice + signal.atr14 * 5), stopLossPrice, quantity,
          volumeSurgeRatio: signal.volumeSurgeRatio, regime: todayRegime,
          maxHighDuringHold: signal.entryPrice, minLowDuringHold: signal.entryPrice, trailingStopPrice: null, entryAtr: signal.atr14,
          exitDate: null, exitPrice: null, exitReason: null, pnl: null, pnlPct: null, holdingDays: null,
          limitLockDays: 0, entryCommission, exitCommission: null, totalCost: null, tax: null, grossPnl: null, netPnl: null,
        });
        allOpenTickers.add(signal.ticker);
      }
    }

    // ── 3. エクイティスナップショット ──
    let positionsValue = 0;
    for (const pos of [...boPositions, ...guPositions, ...wbPositions, ...pscPositions]) {
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
      openPositionCount: boPositions.length + guPositions.length + wbPositions.length + pscPositions.length,
      ...(capitalAddedToday > 0 ? { capitalAdded: capitalAddedToday } : {}),
    });
  }

  for (const pos of [...boPositions, ...guPositions, ...wbPositions, ...pscPositions]) pos.exitReason = "still_open";

  const allTrades = [...boClosedTrades, ...guClosedTrades, ...wbClosedTrades, ...pscClosedTrades, ...boPositions, ...guPositions, ...wbPositions, ...pscPositions];
  const boAllTrades = [...boClosedTrades, ...boPositions.filter((p) => p.exitReason === "still_open")];
  const guAllTrades = [...guClosedTrades, ...guPositions.filter((p) => p.exitReason === "still_open")];
  const wbAllTrades = [...wbClosedTrades, ...wbPositions.filter((p) => p.exitReason === "still_open")];
  const pscAllTrades = [...pscClosedTrades, ...pscPositions.filter((p) => p.exitReason === "still_open")];

  return {
    totalMetrics: calculateMetrics(allTrades, equityCurve, budget),
    boMetrics: calculateMetrics(boAllTrades, equityCurve, budget),
    guMetrics: calculateMetrics(guAllTrades, equityCurve, budget),
    wbMetrics: calculateMetrics(wbAllTrades, equityCurve, budget),
    pscMetrics: calculateMetrics(pscAllTrades, equityCurve, budget),
    equityCurve,
    allTrades,
    totalCapitalAdded,
    haltDays,
  };
}
