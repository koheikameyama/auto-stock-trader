/**
 * バックテスト・シミュレーションエンジン
 *
 * 日次ループでスコアリング→エントリー→TP/SL判定をシミュレーションする。
 * 既存のコアモジュールをそのまま再利用し、AIコールは行わない。
 */

import type { OHLCVData } from "../core/technical-analysis";
import { analyzeTechnicals } from "../core/technical-analysis";
import { scoreStock } from "../core/scoring";
import type { NewLogicScore } from "../core/scoring";
import { calculateEntryCondition } from "../core/entry-calculator";
import { TECHNICAL_MIN_DATA, DEFENSIVE_MODE, DAILY_BACKTEST, WEEKEND_RISK, TRAILING_STOP } from "../lib/constants";
import { countNonTradingDaysAhead } from "../lib/market-calendar";
import { checkPositionExit } from "../core/exit-checker";
import { checkBuyLimitFill } from "../core/order-executor";
import { determineMarketRegime } from "../core/market-regime";
import { calculateCommission, calculateTax } from "../core/trading-costs";
import { getLimitDownPrice } from "../lib/constants/price-limits";
import { calculateMetrics } from "./metrics";
import type {
  BacktestConfig,
  BacktestResult,
  SimulatedPosition,
  ScoreBreakdown,
  DailyEquity,
  RegimeLevel,
} from "./types";

const MIN_WINDOW_BARS = 80;

/**
 * バックテストを実行する
 */
export function runBacktest(
  config: BacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData?: Map<string, number>,
  candidateMap?: Map<string, string[]> | null,
  sectorMap?: Map<string, string>,
): BacktestResult {
  const openPositions: SimulatedPosition[] = [];
  const closedTrades: SimulatedPosition[] = [];
  const equityCurve: DailyEquity[] = [];
  // ストップアウト後のクールダウン: ticker → 最終決済日のdayIdx
  const lastExitDayIdx = new Map<string, number>();
  let cash = config.initialBudget;
  let ordersPlaced = 0;
  let ordersFilled = 0;

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

    // 0. VIXレジーム判定（フィル判定・新規エントリーの両方で使用）
    const todayVix = vixData?.get(today);
    const todayRegime: RegimeLevel =
      todayVix != null ? determineMarketRegime(todayVix).level : "normal";
    const regime = todayVix != null ? determineMarketRegime(todayVix) : null;
    const regimeMaxPositions = regime ? regime.maxPositions : config.maxPositions;

    // 1. ペンディング注文のフィル判定（前日に出した注文）
    const filledOrders: FilledOrder[] = [];
    const remainingOrders: PendingOrder[] = [];

    for (const order of pendingOrders) {
      const bars = allData.get(order.ticker);
      const todayBar = bars?.find((b) => b.date === today);

      if (!todayBar) {
        remainingOrders.push(order);
        continue;
      }

      // 本番 order-executor.ts の checkBuyLimitFill を直接呼出
      const fillPrice = checkBuyLimitFill(order.limitPrice, todayBar.low, todayBar.open);
      if (fillPrice !== null) {
        if (openPositions.length < regimeMaxPositions && cash >= fillPrice * order.quantity) {
          const hasExisting = openPositions.some((p) => p.ticker === order.ticker);
          if (!hasExisting) {
            filledOrders.push({ ...order, fillPrice });
            ordersFilled++;
          }
        }
      }
    }
    pendingOrders = [];

    for (const filled of filledOrders) {
      const fillPrice = filled.fillPrice;
      const tradeValue = fillPrice * filled.quantity;
      const entryCommission = config.costModelEnabled
        ? calculateCommission(tradeValue)
        : 0;
      cash -= tradeValue + entryCommission;

      const position: SimulatedPosition = {
        ticker: filled.ticker,
        entryDate: today,
        entryPrice: fillPrice,
        takeProfitPrice: filled.takeProfitPrice,
        stopLossPrice: filled.stopLossPrice,
        quantity: filled.quantity,
        rank: filled.rank,
        score: filled.score,
        scoreBreakdown: filled.scoreBreakdown,
        regime: filled.regime,
        maxHighDuringHold: fillPrice,
        trailingStopPrice: null,
        entryAtr: filled.entryAtr,
        exitDate: null,
        exitPrice: null,
        exitReason: null,
        pnl: null,
        pnlPct: null,
        holdingDays: null,
        entryCommission,
        exitCommission: null,
        totalCost: null,
        tax: null,
        grossPnl: null,
        netPnl: null,
        limitLockDays: 0,
      };

      openPositions.push(position);

      if (config.verbose) {
        const gapNote = fillPrice < filled.limitPrice ? ` (GD寄¥${fillPrice})` : "";
        console.log(
          `  [${today}] ${filled.ticker} 約定: ¥${fillPrice} x${filled.quantity} (${filled.rank}:${filled.score}pt)${gapNote}`,
        );
      }
    }

    // 2. オープンポジションの TP/SL 判定（本番 position-monitor.ts と同一の checkPositionExit を使用）
    const toClose: number[] = [];
    for (let i = 0; i < openPositions.length; i++) {
      const pos = openPositions[i];
      const bars = allData.get(pos.ticker);
      const todayBar = bars?.find((b) => b.date === today);
      if (!todayBar) continue;

      // 保有営業日数を算出
      const entryDayIdx = tradingDays.indexOf(pos.entryDate);
      const holdingDays = entryDayIdx >= 0 ? dayIdx - entryDayIdx : 0;

      // スイング: エントリー日はSL判定をスキップ（日中ノイズで刈られるのを防止）
      if (config.strategy === "swing" && holdingDays === 0) {
        // 高値更新のみ記録（トレーリングストップ用）
        pos.maxHighDuringHold = Math.max(pos.maxHighDuringHold, todayBar.high);
        continue;
      }

      // 連休前リスク管理: 感度分析の固定値がなければ週末リスクで引き締め
      const posSimDate = new Date(tradingDays[dayIdx] + "T00:00:00+09:00");
      const posNonTradingDays = countNonTradingDaysAhead(posSimDate);
      const isPreLongHoliday = posNonTradingDays >= WEEKEND_RISK.TRAILING_TIGHTEN_THRESHOLD;

      let trailOverride = config.trailMultiplier;
      if (trailOverride == null && isPreLongHoliday && config.strategy === "swing") {
        trailOverride = TRAILING_STOP.TRAIL_ATR_MULTIPLIER.swing * WEEKEND_RISK.TRAILING_TIGHTEN_MULTIPLIER;
      }

      // 共通出口判定（本番 position-monitor.ts と同一ロジック）
      const exitResult = checkPositionExit(
        {
          entryPrice: pos.entryPrice,
          takeProfitPrice: pos.takeProfitPrice,
          stopLossPrice: pos.stopLossPrice,
          entryAtr: pos.entryAtr,
          maxHighDuringHold: pos.maxHighDuringHold,
          currentTrailingStop: pos.trailingStopPrice,
          strategy: config.strategy,
          holdingBusinessDays: holdingDays,
          activationMultiplierOverride: config.trailingActivationMultiplier,
          trailMultiplierOverride: trailOverride,
          maxHoldingDaysOverride: config.maxHoldingDays,
        },
        { open: todayBar.open, high: todayBar.high, low: todayBar.low, close: todayBar.close },
      );

      // ポジション状態を更新
      pos.maxHighDuringHold = exitResult.newMaxHigh;
      pos.trailingStopPrice = exitResult.trailingStopPrice;

      let exitPrice = exitResult.exitPrice;
      let exitReason: SimulatedPosition["exitReason"] = exitResult.exitReason;

      // 値幅制限シミュレーション: ストップ安で損切り不可能な状況を再現
      if (config.priceLimitEnabled && exitPrice != null && exitReason === "stop_loss") {
        const prevBar = dayIdx > 0
          ? bars?.find((b) => b.date === tradingDays[dayIdx - 1])
          : null;

        if (prevBar) {
          const limitDown = getLimitDownPrice(prevBar.close);

          // ストップ安張り付き（始値 == 安値 == 制限値幅下限）→ 約定不可
          if (
            todayBar.open <= limitDown &&
            todayBar.low <= limitDown &&
            todayBar.close <= limitDown
          ) {
            exitPrice = null;
            exitReason = null;
            pos.limitLockDays++;
            if (config.verbose) {
              console.log(
                `  [${today}] ${pos.ticker}: ストップ安張り付き（約定不可、${pos.limitLockDays}日目）`,
              );
            }
          } else if (exitPrice < limitDown) {
            // 損切り価格がストップ安以下 → ストップ安価格で約定（スリッページ）
            exitPrice = limitDown;
            if (config.verbose) {
              console.log(
                `  [${today}] ${pos.ticker}: ストップ安スリッページ（SL ¥${pos.stopLossPrice} → 約定 ¥${limitDown}）`,
              );
            }
          }
        }
      }

      // デイトレ: 当日中にTP/SLヒットしなければ引けで決済
      if (!exitPrice && config.strategy === "day_trade") {
        exitPrice = todayBar.close;
        exitReason =
          todayBar.close >= pos.entryPrice ? "take_profit" : "stop_loss";
      }

      if (exitPrice != null && exitReason != null) {
        const grossPnl = (exitPrice - pos.entryPrice) * pos.quantity;
        const pnlPct = pos.entryPrice > 0
          ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
          : 0;
        const entryDayIdx = tradingDays.indexOf(pos.entryDate);
        const holdingDays = entryDayIdx >= 0 ? dayIdx - entryDayIdx : 1;

        // コスト計算
        const exitTradeValue = exitPrice * pos.quantity;
        const exitCommission = config.costModelEnabled
          ? calculateCommission(exitTradeValue)
          : 0;
        const totalCost = (pos.entryCommission ?? 0) + exitCommission;
        const tax = config.costModelEnabled
          ? calculateTax(grossPnl, totalCost)
          : 0;
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

        cash += exitTradeValue - exitCommission - tax;
        toClose.push(i);

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
    }

    // クローズ済みを移動 + クールダウン記録
    for (let i = toClose.length - 1; i >= 0; i--) {
      const closedPos = openPositions[toClose[i]];
      closedTrades.push(closedPos);
      lastExitDayIdx.set(closedPos.ticker, dayIdx);
      openPositions.splice(toClose[i], 1);
    }

    // 2.5. ディフェンシブモード（本番の position-monitor と同等）
    //   crisis → 全ポジション即時決済
    //   high   → 含み益ポジション微益撤退

    if (
      (todayRegime === "crisis" || todayRegime === "high") &&
      openPositions.length > 0
    ) {
      const defensiveToClose: number[] = [];

      for (let i = 0; i < openPositions.length; i++) {
        const pos = openPositions[i];
        const bars = allData.get(pos.ticker);
        const todayBar = bars?.find((b) => b.date === today);
        if (!todayBar) continue;

        const currentProfitPct =
          ((todayBar.close - pos.entryPrice) / pos.entryPrice) * 100;

        let shouldClose = false;
        if (todayRegime === "crisis") {
          // crisis: 全ポジション即時決済
          shouldClose = true;
        } else if (
          currentProfitPct >= DEFENSIVE_MODE.MIN_PROFIT_PCT_FOR_RETREAT
        ) {
          // high: 含み益ポジションのみ微益撤退
          shouldClose = true;
        }

        if (shouldClose) {
          const exitPrice = todayBar.close;
          const grossPnl = (exitPrice - pos.entryPrice) * pos.quantity;
          const pnlPct =
            ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
          const entryDayIdx = tradingDays.indexOf(pos.entryDate);
          const holdingDays = entryDayIdx >= 0 ? dayIdx - entryDayIdx : 1;

          const exitTradeValue = exitPrice * pos.quantity;
          const exitCommission = config.costModelEnabled
            ? calculateCommission(exitTradeValue)
            : 0;
          const totalCost = (pos.entryCommission ?? 0) + exitCommission;
          const tax = config.costModelEnabled
            ? calculateTax(grossPnl, totalCost)
            : 0;
          const netPnl = grossPnl - totalCost - tax;

          pos.exitDate = today;
          pos.exitPrice = exitPrice;
          pos.exitReason = "defensive_exit";
          pos.pnl = Math.round(grossPnl);
          pos.pnlPct = Math.round(pnlPct * 100) / 100;
          pos.holdingDays = holdingDays;
          pos.exitCommission = exitCommission;
          pos.totalCost = Math.round(totalCost);
          pos.tax = Math.round(tax);
          pos.grossPnl = Math.round(grossPnl);
          pos.netPnl = Math.round(netPnl);

          cash += exitTradeValue - exitCommission - tax;
          defensiveToClose.push(i);

          if (config.verbose) {
            const sign = grossPnl >= 0 ? "+" : "";
            const mode = todayRegime === "crisis" ? "crisis全決済" : "high微益撤退";
            console.log(
              `  [${today}] ${pos.ticker} ${mode}: ¥${exitPrice} ${sign}¥${Math.round(grossPnl)} (${sign}${pos.pnlPct}%)`,
            );
          }
        }
      }

      for (let i = defensiveToClose.length - 1; i >= 0; i--) {
        const closedPos = openPositions[defensiveToClose[i]];
        closedTrades.push(closedPos);
        lastExitDayIdx.set(closedPos.ticker, dayIdx);
        openPositions.splice(defensiveToClose[i], 1);
      }
    }

    // 3. 新規エントリー評価
    // crisis時またはshouldTrade=false日は新規エントリーをスキップ
    const isMarketHalt = config.shouldTradeSkipDates?.has(today) ?? false;
    if (todayRegime === "crisis" || isMarketHalt) {
      if (config.verbose) {
        const reason = todayRegime === "crisis"
          ? `VIX=${todayVix?.toFixed(1)} → crisis`
          : "shouldTrade=false";
        console.log(`  [${today}] ${reason}: 新規エントリースキップ`);
      }
    } else if (openPositions.length < regimeMaxPositions && cash > 0) {
      // candidateMapがある場合、当日の候補銘柄のみ評価（生存者バイアス除去）
      const todayCandidates = candidateMap?.get(today);
      const minRank = regime?.minRank ?? null;
      const candidates = evaluateTickers(
        config,
        allData,
        today,
        cash,
        openPositions,
        todayCandidates,
        lastExitDayIdx,
        dayIdx,
        minRank,
        sectorMap,
      );

      // スコア上位から注文を作成
      for (const candidate of candidates) {
        if (openPositions.length + pendingOrders.length >= regimeMaxPositions) break;
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
          scoreBreakdown: {
            trendQuality: candidate.score.trendQuality,
            entryTiming: candidate.score.entryTiming,
            riskQuality: candidate.score.riskQuality,
            sectorMomentum: candidate.score.sectorMomentumScore,
          },
          entryAtr: candidate.entryAtr,
          regime: todayRegime,
        });
        ordersPlaced++;
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

  const metrics = calculateMetrics(allTrades, equityCurve, config.initialBudget, ordersPlaced, ordersFilled);

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
  rank: "S" | "A" | "B" | "C" | "D";
  score: number;
  scoreBreakdown: ScoreBreakdown | null;
  entryAtr: number | null;
  regime: RegimeLevel;
}

interface FilledOrder extends PendingOrder {
  fillPrice: number;
}

interface EntryCandidate {
  ticker: string;
  score: NewLogicScore;
  entry: {
    limitPrice: number;
    takeProfitPrice: number;
    stopLossPrice: number;
    quantity: number;
  };
  entryAtr: number | null;
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
  candidateTickers?: string[],
  lastExitDayIdxMap?: Map<string, number>,
  currentDayIdx?: number,
  minRank?: "S" | "A" | "B" | null,
  _sectorMap?: Map<string, string>,
): EntryCandidate[] {
  const candidates: EntryCandidate[] = [];

  // candidateTickersが指定されている場合はその銘柄のみ評価
  const tickersToEvaluate: Iterable<[string, OHLCVData[]]> = candidateTickers
    ? candidateTickers
        .filter((t) => allData.has(t))
        .map((t) => [t, allData.get(t)!] as [string, OHLCVData[]])
    : allData;

  for (const [ticker, bars] of tickersToEvaluate) {
    // 同一銘柄のオープンポジションがある場合はスキップ
    if (openPositions.some((p) => p.ticker === ticker)) continue;

    // クールダウン: 直近N営業日以内にクローズした銘柄はスキップ
    if (config.cooldownDays > 0 && lastExitDayIdxMap && currentDayIdx != null) {
      const lastExit = lastExitDayIdxMap.get(ticker);
      if (lastExit != null && currentDayIdx - lastExit < config.cooldownDays) {
        continue;
      }
    }

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
    const latest = window[window.length - 1];

    // トレンドプレフィルター: 上昇トレンドでない株をスキップ
    if (config.trendFilterEnabled) {
      if (
        summary.sma25 == null ||
        summary.sma75 == null ||
        latest.close <= summary.sma25 ||
        summary.sma25 <= summary.sma75
      ) {
        continue;
      }
    }

    // プルバックエントリー: 高値掴み防止（RSI < 60 OR SMA25乖離 <= 2%）
    if (config.pullbackFilterEnabled) {
      const { MAX_RSI_FOR_ENTRY, MAX_DEVIATION_FROM_SMA25 } =
        DAILY_BACKTEST.TREND_FILTER;
      const rsiOk =
        summary.rsi != null && summary.rsi < MAX_RSI_FOR_ENTRY;
      const nearSma25 =
        summary.sma25 != null &&
        Math.abs((latest.close - summary.sma25) / summary.sma25) * 100 <=
          MAX_DEVIATION_FROM_SMA25;
      if (!rsiOk && !nearSma25) continue;
    }

    // ボラティリティフィルター: ATR%が低すぎる銘柄をスキップ（低ボラメガキャップ除外）
    if (config.volatilityFilterEnabled) {
      const { MIN_ATR_PCT } = DAILY_BACKTEST.UNIVERSE_FILTER;
      if (
        summary.atr14 == null ||
        latest.close <= 0 ||
        (summary.atr14 / latest.close) * 100 < MIN_ATR_PCT
      ) {
        continue;
      }
    }

    // 週次ボラティリティ算出
    const weeklyVolatility = computeWeeklyVolatility(window);

    // 新スコアリング（3カテゴリ）
    const score = scoreStock({
      historicalData: newestFirst,
      latestPrice: latest.close,
      latestVolume: latest.volume,
      weeklyVolatility,
      summary,
      avgVolume25: summary.volumeAnalysis.avgVolume20,
    });

    // 即死ルール判定（価格上限は config.maxPrice で上書き）
    if (
      score.isDisqualified &&
      score.gate.failedGate === "spread" &&
      latest.close <= config.maxPrice
    ) {
      // maxPrice 以内 → ゲートの価格制限を回避して再スコアリング
      const retryScore = scoreStock({
        historicalData: newestFirst,
        latestPrice: config.maxPrice,
        latestVolume: latest.volume,
        weeklyVolatility,
        summary,
        avgVolume25: summary.volumeAnalysis.avgVolume20,
      });
      if (!retryScore.isDisqualified) {
        // 再スコアリング成功 → そのまま続行
        Object.assign(score, retryScore);
      }
    }
    if (score.isDisqualified) continue;
    if (score.totalScore < config.scoreThreshold) continue;

    // レジームによるランク制限（本番 market-scanner.ts と同等）
    if (minRank) {
      const rankOrder: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 4 };
      if ((rankOrder[score.rank] ?? 4) > rankOrder[minRank]) continue;
    }

    // 週末リスク: 金曜/連休前はポジションサイズを縮小
    const simDate = new Date(today + "T00:00:00+09:00");
    const simNonTradingDays = countNonTradingDaysAhead(simDate);
    const budgetForSizing = simNonTradingDays >= WEEKEND_RISK.SIZE_REDUCTION_THRESHOLD
      ? cash * WEEKEND_RISK.POSITION_SIZE_MULTIPLIER
      : cash;

    // エントリー条件算出
    const maxPositionPct = 100;
    const entry = calculateEntryCondition(
      latest.close,
      summary,
      score as any,
      config.strategy,
      budgetForSizing,
      maxPositionPct,
      config.gapRiskEnabled ? newestFirst : undefined,
      config.collarPct,
    );

    if (entry.quantity <= 0) continue;

    // TP/SL: デフォルトは calculateEntryCondition の算出値をそのまま使用（本番互換）
    // --override-tp-sl 指定時のみ config の固定比率で上書き（感度分析用）
    let takeProfitPrice: number;
    let stopLossPrice: number;

    if (config.overrideTpSl) {
      takeProfitPrice = Math.round(entry.limitPrice * config.takeProfitRatio);
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
    } else {
      takeProfitPrice = entry.takeProfitPrice;
      stopLossPrice = entry.stopLossPrice;
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
      entryAtr: summary.atr14,
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
