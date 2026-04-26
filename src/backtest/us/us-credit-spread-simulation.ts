/**
 * SPY/QQQ Credit Spread バックテスト
 *
 * Bull Put Credit Spread サイクル:
 *   1. ショートput売り + ロングput買い → クレジット受領（cash増）
 *   2. 日次で残スプレッド価格を BS で評価
 *   3. 早期決済 (50%利益)、ストップロス、満期消滅、満期最大損失で クローズ
 *
 * 原資産: ^GSPC ÷ 10 = SPY 換算（実SPYと数%以内の誤差）
 * IV: VIX / 100 × ivScaleFactor
 */

import dayjs from "dayjs";
import { bsPutPrice, findStrikeForTargetDelta } from "../../core/options-pricing";
import { calculateMetrics } from "../metrics";
import type { USCreditSpreadBacktestConfig, USCreditSpreadBacktestResult, SimulatedSpread, CreditSpreadPerformanceMetrics } from "./us-credit-spread-types";
import type { SimulatedPosition, DailyEquity } from "../types";

const CONTRACT_SIZE = 100;

function daysToYears(days: number): number {
  return Math.max(days / 365, 0);
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function findExpirationDate(entryDate: string, dte: number, tradingDays: string[]): string {
  const target = dayjs(entryDate).add(dte, "day").format("YYYY-MM-DD");
  for (const d of tradingDays) {
    if (d >= target) return d;
  }
  return tradingDays[tradingDays.length - 1];
}

/** スプレッドの現在価格（売値ベース、close時に支払う） */
function priceSpread(
  spotSpy: number,
  shortStrike: number,
  longStrike: number,
  tte: number,
  riskFreeRate: number,
  iv: number,
): number {
  const shortPx = bsPutPrice(spotSpy, shortStrike, tte, riskFreeRate, iv);
  const longPx = bsPutPrice(spotSpy, longStrike, tte, riskFreeRate, iv);
  return Math.max(shortPx - longPx, 0);
}

export async function runUSCreditSpreadBacktest(
  config: USCreditSpreadBacktestConfig,
  gspcData: Map<string, number>,
  vixData: Map<string, number>,
): Promise<USCreditSpreadBacktestResult> {
  // tradingDays: ^GSPC のある日付セット
  const tradingDays = [...gspcData.keys()]
    .filter((d) => d >= config.startDate && d <= config.endDate)
    .sort();

  // SMAウォームアップ用に過去データも保持（lookback前から計算可能）
  const allGspcDays = [...gspcData.keys()].sort();
  const gspcSmaCache = new Map<string, number>();
  if (config.indexTrendFilter) {
    for (let i = config.indexTrendSmaPeriod - 1; i < allGspcDays.length; i++) {
      let sum = 0;
      for (let j = 0; j < config.indexTrendSmaPeriod; j++) {
        sum += gspcData.get(allGspcDays[i - j])!;
      }
      gspcSmaCache.set(allGspcDays[i], sum / config.indexTrendSmaPeriod);
    }
  }

  let cash = config.initialBudget;
  const openSpreads: SimulatedSpread[] = [];
  const closedSpreads: SimulatedSpread[] = [];
  const equityCurve: DailyEquity[] = [];

  for (const today of tradingDays) {
    const gspc = gspcData.get(today);
    const vix = vixData.get(today);
    if (gspc == null || vix == null) continue;

    const spotSpy = gspc / 10;
    const iv = (vix / 100) * config.ivScaleFactor;

    // ── 1. 既存スプレッドを評価・クローズ判定 ──
    const stillOpen: SimulatedSpread[] = [];
    for (const sp of openSpreads) {
      const tte = daysToYears(daysBetween(today, sp.expirationDate));

      // 満期当日: 内在価値で settlement
      if (today >= sp.expirationDate) {
        // 満期: max(shortStrike - spot, 0) - max(longStrike - spot, 0) per share
        const shortIntrinsic = Math.max(sp.shortStrike - spotSpy, 0);
        const longIntrinsic = Math.max(sp.longStrike - spotSpy, 0);
        const finalSpreadValue = Math.max(shortIntrinsic - longIntrinsic, 0);

        // P&L: 受領クレジット - 支払い終値スプレッド (per share)
        const pnlPerShare = sp.creditReceived - finalSpreadValue;
        const exitCommission = config.optionsCommission * 2 * sp.contracts; // short close + long close
        // 満期消滅の場合は手数料発生せず（OCCの自動消滅）
        const isWorthless = finalSpreadValue < 0.01;
        const commissionsThisLeg = isWorthless ? 0 : exitCommission;
        const pnl = pnlPerShare * CONTRACT_SIZE * sp.contracts - commissionsThisLeg;

        cash += sp.creditReceived * CONTRACT_SIZE * sp.contracts; // クレジットは entry 時に既に増えてるので戻す...
        // → 違う。entry時に creditReceived * 100 * contracts を cash に加算済み、collateral も差し引き済み。
        //    満期では (max loss = spreadWidth × 100 × contracts) のロックを解放、
        //    支払い分 = finalSpreadValue × 100 × contracts を cash から引く

        // 修正: entry時にロックした collateral を解放
        cash += config.spreadWidth * CONTRACT_SIZE * sp.contracts; // collateral 解放
        cash -= finalSpreadValue * CONTRACT_SIZE * sp.contracts; // 終値支払い
        cash -= commissionsThisLeg;

        sp.state = "CLOSED";
        sp.closeDate = today;
        sp.closeSpreadPrice = finalSpreadValue;
        sp.totalCommissions += commissionsThisLeg;
        sp.netPnl = pnl;

        if (finalSpreadValue < 0.01) sp.closeReason = "expired_worthless";
        else if (finalSpreadValue >= config.spreadWidth - 0.01) sp.closeReason = "expired_max_loss";
        else sp.closeReason = "expired_partial";

        closedSpreads.push(sp);
        continue;
      }

      // 通常日: 現在のスプレッド価格を計算
      const currentSpreadPrice = priceSpread(
        spotSpy,
        sp.shortStrike,
        sp.longStrike,
        tte,
        config.riskFreeRate,
        iv,
      );

      // 利益目標: 現在価値が credit × (1 - profitTarget) 以下になれば 利益確定
      const profitTargetPrice = sp.creditReceived * (1 - config.profitTarget);
      // ストップロス: 現在価値が credit × (1 + stopLossMultiplier) 以上で撤退
      const stopLossPrice = config.stopLossMultiplier > 0
        ? sp.creditReceived * (1 + config.stopLossMultiplier)
        : Number.POSITIVE_INFINITY;

      let shouldClose: "profit_target" | "stop_loss" | null = null;
      if (currentSpreadPrice <= profitTargetPrice) shouldClose = "profit_target";
      else if (currentSpreadPrice >= stopLossPrice) shouldClose = "stop_loss";

      if (shouldClose) {
        const exitCommission = config.optionsCommission * 2 * sp.contracts;
        const pnlPerShare = sp.creditReceived - currentSpreadPrice;
        const pnl = pnlPerShare * CONTRACT_SIZE * sp.contracts - exitCommission;

        cash += config.spreadWidth * CONTRACT_SIZE * sp.contracts; // collateral 解放
        cash -= currentSpreadPrice * CONTRACT_SIZE * sp.contracts; // 買い戻し
        cash -= exitCommission;

        sp.state = "CLOSED";
        sp.closeDate = today;
        sp.closeReason = shouldClose;
        sp.closeSpreadPrice = currentSpreadPrice;
        sp.totalCommissions += exitCommission;
        sp.netPnl = pnl;

        closedSpreads.push(sp);
      } else {
        stillOpen.push(sp);
      }
    }
    openSpreads.length = 0;
    openSpreads.push(...stillOpen);

    // ── 2. 新規エントリー判定 ──
    if (openSpreads.length < config.maxPositions) {
      // VIX cap
      if (vix > config.vixCap) {
        // skip
      } else if (config.indexTrendFilter) {
        const sma = gspcSmaCache.get(today);
        if (sma == null || gspc < sma) {
          // skip
        } else {
          tryOpenSpread();
        }
      } else {
        tryOpenSpread();
      }

      function tryOpenSpread() {
        const dte = config.dte;
        const expirationDate = findExpirationDate(today, dte, tradingDays);
        const tte = daysToYears(daysBetween(today, expirationDate));
        if (tte <= 0) return;

        // ショート put strike を delta で決定
        const shortInfo = findStrikeForTargetDelta({
          spotPrice: spotSpy,
          targetDelta: -Math.abs(config.shortPutDelta),
          tte,
          riskFreeRate: config.riskFreeRate,
          iv,
          optionType: "put",
          strikeStep: 1,
        });
        const shortStrike = shortInfo.strike;
        const longStrike = shortStrike - config.spreadWidth;
        if (longStrike <= 0) return;

        const shortPremium = shortInfo.premium;
        const longPremium = bsPutPrice(spotSpy, longStrike, tte, config.riskFreeRate, iv);
        const credit = shortPremium - longPremium;
        if (credit <= 0.05) return; // クレジット少なすぎはスキップ

        const collateralRequired = config.spreadWidth * CONTRACT_SIZE * config.contractsPerSpread;
        if (cash < collateralRequired + 50) return; // 余裕を確保

        const entryCommission = config.optionsCommission * 2 * config.contractsPerSpread;
        cash -= collateralRequired;
        cash += credit * CONTRACT_SIZE * config.contractsPerSpread;
        cash -= entryCommission;

        const spread: SimulatedSpread = {
          underlyingSymbol: config.underlyingSymbol,
          entryDate: today,
          expirationDate,
          entrySpotPrice: spotSpy,
          entryIV: iv,
          shortStrike,
          longStrike,
          shortDeltaAtEntry: shortInfo.delta,
          creditReceived: credit,
          contracts: config.contractsPerSpread,
          state: "OPEN",
          totalCommissions: entryCommission,
        };
        openSpreads.push(spread);
      }
    }

    // ── 3. equity curve 計算 ──
    let unrealizedSpreadValue = 0;
    for (const sp of openSpreads) {
      const tte = daysToYears(daysBetween(today, sp.expirationDate));
      const currentValue = priceSpread(
        spotSpy,
        sp.shortStrike,
        sp.longStrike,
        tte,
        config.riskFreeRate,
        iv,
      );
      // ロック中の collateral - 現在の負債 (= 買い戻しコスト)
      // unrealized = collateral - currentValue × CONTRACT_SIZE × contracts
      unrealizedSpreadValue +=
        config.spreadWidth * CONTRACT_SIZE * sp.contracts -
        currentValue * CONTRACT_SIZE * sp.contracts;
    }
    const totalEquity = cash + unrealizedSpreadValue;
    equityCurve.push({
      date: today,
      cash,
      positionsValue: unrealizedSpreadValue,
      totalEquity,
      openPositionCount: openSpreads.length,
    });
  }

  // ── 4. メトリクス計算 ──
  const allSpreads = [...closedSpreads, ...openSpreads];

  // metrics.ts は SimulatedPosition の特定 exitReason のみカウントするため、
  // クレジットスプレッドのクローズ理由を以下の通りマッピング:
  //   profit_target / expired_worthless → "take_profit"
  //   stop_loss / expired_max_loss → "stop_loss"
  //   expired_partial → "time_stop"（PnLは計上、勝敗判定は pnl の正負で）
  const mapExitReason = (
    r: SimulatedSpread["closeReason"],
  ): SimulatedPosition["exitReason"] => {
    if (r === "profit_target" || r === "expired_worthless") return "take_profit";
    if (r === "stop_loss" || r === "expired_max_loss") return "stop_loss";
    if (r === "expired_partial") return "time_stop";
    return "still_open";
  };

  const tradeShape: SimulatedPosition[] = closedSpreads.map((sp) => {
    const grossPnl = (sp.creditReceived - (sp.closeSpreadPrice ?? 0)) * CONTRACT_SIZE * sp.contracts;
    const netPnl = sp.netPnl ?? 0;
    const holdingDays = sp.closeDate ? daysBetween(sp.entryDate, sp.closeDate) : 0;
    const maxLossDollar = config.spreadWidth * CONTRACT_SIZE * sp.contracts;
    return {
      ticker: sp.underlyingSymbol,
      entryDate: sp.entryDate,
      entryPrice: sp.entrySpotPrice,
      takeProfitPrice: 0,
      stopLossPrice: 0,
      quantity: sp.contracts,
      volumeSurgeRatio: 0,
      regime: null,
      maxHighDuringHold: sp.entrySpotPrice,
      minLowDuringHold: sp.entrySpotPrice,
      trailingStopPrice: null,
      entryAtr: null,
      exitDate: sp.closeDate ?? null,
      exitPrice: sp.entrySpotPrice,
      exitReason: mapExitReason(sp.closeReason),
      pnl: netPnl,
      pnlPct: (netPnl / maxLossDollar) * 100,
      holdingDays,
      limitLockDays: 0,
      entryCommission: config.optionsCommission * 2 * sp.contracts,
      exitCommission: sp.totalCommissions - config.optionsCommission * 2 * sp.contracts,
      totalCost: sp.totalCommissions,
      tax: 0,
      grossPnl,
      netPnl,
    };
  });

  const baseMetrics = calculateMetrics(tradeShape, equityCurve, config.initialBudget);

  const totalCredit = closedSpreads.reduce((s, sp) => s + sp.creditReceived * CONTRACT_SIZE * sp.contracts, 0);
  const expiredWorthless = closedSpreads.filter((sp) => sp.closeReason === "expired_worthless").length;
  const maxLossCount = closedSpreads.filter((sp) => sp.closeReason === "expired_max_loss").length;
  const profitTargetHits = closedSpreads.filter((sp) => sp.closeReason === "profit_target").length;
  const stopLossHits = closedSpreads.filter((sp) => sp.closeReason === "stop_loss").length;
  const avgCreditRatio = closedSpreads.length > 0
    ? closedSpreads.reduce((s, sp) => s + sp.creditReceived / config.spreadWidth, 0) / closedSpreads.length
    : 0;
  const avgHolding = closedSpreads.length > 0
    ? closedSpreads.reduce((s, sp) => s + (sp.closeDate ? daysBetween(sp.entryDate, sp.closeDate) : 0), 0) /
      closedSpreads.length
    : 0;

  const metrics: CreditSpreadPerformanceMetrics = {
    ...baseMetrics,
    totalSpreads: closedSpreads.length,
    expiredWorthless,
    maxLossCount,
    profitTargetHits,
    stopLossHits,
    totalCreditReceived: totalCredit,
    avgCreditRatio,
    avgHoldingDays: avgHolding,
  };

  return { config, spreads: allSpreads, equityCurve, metrics };
}
