/**
 * バックテスト・シミュレーションエンジン
 *
 * 日次ループでスコアリング→エントリー→TP/SL判定をシミュレーションする。
 * 既存のコアモジュールをそのまま再利用し、AIコールは行わない。
 */

import type { OHLCVData } from "../core/technical-analysis";
import { analyzeTechnicals } from "../core/technical-analysis";
import { scoreTechnicals } from "../core/technical-scorer";
import type { LogicScore } from "../core/technical-scorer";
import { calculateEntryCondition } from "../core/entry-calculator";
import { detectChartPatterns } from "../lib/chart-patterns";
import { analyzeSingleCandle } from "../lib/candlestick-patterns";
import { TECHNICAL_MIN_DATA, SCORING } from "../lib/constants";
import { calculateMetrics } from "./metrics";
import type {
  BacktestConfig,
  BacktestResult,
  SimulatedPosition,
  DailyEquity,
} from "./types";

const MIN_WINDOW_BARS = 80;

/**
 * バックテストを実行する
 */
export function runBacktest(
  config: BacktestConfig,
  allData: Map<string, OHLCVData[]>,
): BacktestResult {
  const openPositions: SimulatedPosition[] = [];
  const closedTrades: SimulatedPosition[] = [];
  const equityCurve: DailyEquity[] = [];
  let cash = config.initialBudget;

  // 全銘柄の営業日をマージしてソート（重複排除）
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
    console.log(`[backtest] シミュレーション開始: ${tradingDays.length}営業日`);
  }

  // ペンディング注文: D日に出して D+1 でフィル判定
  let pendingOrders: PendingOrder[] = [];

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const today = tradingDays[dayIdx];

    // 1. ペンディング注文のフィル判定（前日に出した注文）
    const filledOrders: PendingOrder[] = [];
    const remainingOrders: PendingOrder[] = [];

    for (const order of pendingOrders) {
      const bars = allData.get(order.ticker);
      const todayBar = bars?.find((b) => b.date === today);

      if (!todayBar) {
        remainingOrders.push(order);
        continue;
      }

      // 安値が指値以下 → 約定
      if (todayBar.low <= order.limitPrice) {
        if (openPositions.length < config.maxPositions && cash >= order.limitPrice * order.quantity) {
          const hasExisting = openPositions.some((p) => p.ticker === order.ticker);
          if (!hasExisting) {
            filledOrders.push(order);
          }
        }
      }
    }
    pendingOrders = [];

    for (const order of filledOrders) {
      const cost = order.limitPrice * order.quantity;
      cash -= cost;

      const position: SimulatedPosition = {
        ticker: order.ticker,
        entryDate: today,
        entryPrice: order.limitPrice,
        takeProfitPrice: order.takeProfitPrice,
        stopLossPrice: order.stopLossPrice,
        quantity: order.quantity,
        rank: order.rank,
        score: order.score,
        exitDate: null,
        exitPrice: null,
        exitReason: null,
        pnl: null,
        pnlPct: null,
        holdingDays: null,
      };

      openPositions.push(position);

      if (config.verbose) {
        console.log(
          `  [${today}] ${order.ticker} 約定: ¥${order.limitPrice} x${order.quantity} (${order.rank}:${order.score}pt)`,
        );
      }
    }

    // 2. オープンポジションの TP/SL 判定
    const toClose: number[] = [];
    for (let i = 0; i < openPositions.length; i++) {
      const pos = openPositions[i];
      const bars = allData.get(pos.ticker);
      const todayBar = bars?.find((b) => b.date === today);
      if (!todayBar) continue;

      let exitPrice: number | null = null;
      let exitReason: SimulatedPosition["exitReason"] = null;

      const slHit = todayBar.low <= pos.stopLossPrice;
      const tpHit = todayBar.high >= pos.takeProfitPrice;

      if (slHit && tpHit) {
        // 両方ヒット → 保守的にSL優先
        exitPrice = pos.stopLossPrice;
        exitReason = "stop_loss";
      } else if (slHit) {
        exitPrice = pos.stopLossPrice;
        exitReason = "stop_loss";
      } else if (tpHit) {
        exitPrice = pos.takeProfitPrice;
        exitReason = "take_profit";
      }

      // デイトレ: 当日中にTP/SLヒットしなければ引けで決済
      if (!exitPrice && config.strategy === "day_trade") {
        exitPrice = todayBar.close;
        exitReason = todayBar.close >= pos.entryPrice ? "take_profit" : "stop_loss";
      }

      if (exitPrice != null && exitReason != null) {
        const pnl = (exitPrice - pos.entryPrice) * pos.quantity;
        const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const entryDayIdx = tradingDays.indexOf(pos.entryDate);
        const holdingDays = entryDayIdx >= 0 ? dayIdx - entryDayIdx : 1;

        pos.exitDate = today;
        pos.exitPrice = exitPrice;
        pos.exitReason = exitReason;
        pos.pnl = Math.round(pnl);
        pos.pnlPct = Math.round(pnlPct * 100) / 100;
        pos.holdingDays = holdingDays;

        cash += exitPrice * pos.quantity;
        toClose.push(i);

        if (config.verbose) {
          const sign = pnl >= 0 ? "+" : "";
          console.log(
            `  [${today}] ${pos.ticker} 決済(${exitReason}): ¥${exitPrice} ${sign}¥${Math.round(pnl)} (${sign}${pos.pnlPct}%)`,
          );
        }
      }
    }

    // クローズ済みを移動
    for (let i = toClose.length - 1; i >= 0; i--) {
      closedTrades.push(openPositions[toClose[i]]);
      openPositions.splice(toClose[i], 1);
    }

    // 3. 新規エントリー評価
    if (openPositions.length < config.maxPositions && cash > 0) {
      const candidates = evaluateTickers(
        config,
        allData,
        today,
        cash,
        openPositions,
      );

      // スコア上位から注文を作成
      for (const candidate of candidates) {
        if (openPositions.length + pendingOrders.length >= config.maxPositions) break;
        if (cash < candidate.entry.limitPrice * candidate.entry.quantity) break;

        const hasDuplicate =
          openPositions.some((p) => p.ticker === candidate.ticker) ||
          pendingOrders.some((o) => o.ticker === candidate.ticker);
        if (hasDuplicate) continue;

        pendingOrders.push({
          ticker: candidate.ticker,
          limitPrice: candidate.entry.limitPrice,
          takeProfitPrice: candidate.entry.takeProfitPrice,
          stopLossPrice: candidate.entry.stopLossPrice,
          quantity: candidate.entry.quantity,
          rank: candidate.score.rank,
          score: candidate.score.totalScore,
        });
      }
    }

    // 4. エクイティスナップショット
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

  return {
    config,
    trades: allTrades,
    equityCurve,
    metrics,
  };
}

// ====================================================
// 内部ヘルパー
// ====================================================

interface PendingOrder {
  ticker: string;
  limitPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  quantity: number;
  rank: "S" | "A" | "B" | "C";
  score: number;
}

interface EntryCandidate {
  ticker: string;
  score: LogicScore;
  entry: {
    limitPrice: number;
    takeProfitPrice: number;
    stopLossPrice: number;
    quantity: number;
  };
}

/**
 * 全銘柄のスコアリング・エントリー評価
 */
function evaluateTickers(
  config: BacktestConfig,
  allData: Map<string, OHLCVData[]>,
  today: string,
  cash: number,
  openPositions: SimulatedPosition[],
): EntryCandidate[] {
  const candidates: EntryCandidate[] = [];

  for (const [ticker, bars] of allData) {
    // 同一銘柄のオープンポジションがある場合はスキップ
    if (openPositions.some((p) => p.ticker === ticker)) continue;

    const todayIdx = bars.findIndex((b) => b.date === today);
    if (todayIdx < 0) continue;

    // ウィンドウスライス: today までの直近 MIN_WINDOW_BARS 本
    const windowEnd = todayIdx + 1;
    const windowStart = Math.max(0, windowEnd - MIN_WINDOW_BARS);
    const window = bars.slice(windowStart, windowEnd);

    if (window.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) continue;

    // テクニカル分析（newest-first を期待）
    const newestFirst = [...window].reverse();
    const summary = analyzeTechnicals(newestFirst);

    // チャートパターン（oldest-first を期待）
    const chartPatterns = detectChartPatterns(
      window.map((d) => ({
        date: d.date,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
      })),
    );

    // ローソク足パターン（最新の1本）
    const latest = window[window.length - 1];
    const candlestickPattern = analyzeSingleCandle({
      date: latest.date,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
    });

    // 週次ボラティリティ算出
    const weeklyVolatility = computeWeeklyVolatility(window);

    // スコアリング
    let score = scoreTechnicals({
      summary,
      chartPatterns,
      candlestickPattern,
      historicalData: newestFirst,
      latestPrice: latest.close,
      latestVolume: latest.volume,
      weeklyVolatility,
    });

    // 即死ルール判定（価格上限は config.maxPrice で上書き）
    if (
      score.isDisqualified &&
      score.disqualifyReason === "price_too_high" &&
      latest.close <= config.maxPrice
    ) {
      // maxPrice 以内 → latestPrice を即死回避値にして再スコアリング
      score = scoreTechnicals({
        summary,
        chartPatterns,
        candlestickPattern,
        historicalData: newestFirst,
        latestPrice: SCORING.DISQUALIFY.MAX_PRICE,
        latestVolume: latest.volume,
        weeklyVolatility,
      });
    }
    if (score.isDisqualified) continue;
    if (score.totalScore < config.scoreThreshold) continue;

    // エントリー条件算出
    const maxPositionPct = 100;
    const entry = calculateEntryCondition(
      latest.close,
      summary,
      score,
      config.strategy,
      cash,
      maxPositionPct,
    );

    if (entry.quantity <= 0) continue;

    // config の TP/SL パラメータで上書き
    let takeProfitPrice = Math.round(entry.limitPrice * config.takeProfitRatio);
    let stopLossPrice: number;

    if (summary.atr14 != null) {
      stopLossPrice = Math.round(
        entry.limitPrice - summary.atr14 * config.atrMultiplier,
      );
    } else {
      stopLossPrice = Math.round(entry.limitPrice * config.stopLossRatio);
    }

    // SL が指値を超えないように保護
    if (stopLossPrice >= entry.limitPrice) {
      stopLossPrice = Math.round(entry.limitPrice * config.stopLossRatio);
    }
    // TP が指値以下にならないように保護
    if (takeProfitPrice <= entry.limitPrice) {
      takeProfitPrice = Math.round(entry.limitPrice * config.takeProfitRatio);
    }

    candidates.push({
      ticker,
      score,
      entry: {
        limitPrice: entry.limitPrice,
        takeProfitPrice,
        stopLossPrice,
        quantity: entry.quantity,
      },
    });
  }

  // スコア降順でソート
  candidates.sort((a, b) => b.score.totalScore - a.score.totalScore);

  return candidates;
}

/**
 * 直近5日の日次リターンから週次ボラティリティ（%）を算出
 */
function computeWeeklyVolatility(bars: OHLCVData[]): number | null {
  if (bars.length < 6) return null;
  const recent = bars.slice(-6);
  const returns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1].close > 0) {
      returns.push(
        (recent[i].close - recent[i - 1].close) / recent[i - 1].close,
      );
    }
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(5) * 100;
}
