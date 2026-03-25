/**
 * ウォッチリストビルダー
 *
 * 8:00AMに実行し、場中のブレイクアウトスキャナーが監視する候補銘柄リストを生成する。
 * スコアリングやAIレビューは行わない。
 *
 * フロー:
 *   1. DB全銘柄 + OHLCVデータ一括取得
 *   2. checkGates() でゲート判定
 *   3. weeklyClose < weeklySma13 の銘柄を除外（落ちるナイフ回避）
 *   4. high20 / avgVolume25 / atr14 を算出
 *   5. WatchlistEntry[] を返す
 */

import { prisma } from "../../lib/prisma";
import { TECHNICAL_MIN_DATA } from "../../lib/constants";
import { STOP_LOSS, POSITION_SIZING, UNIT_SHARES } from "../../lib/constants";
import { readHistoricalFromDB } from "../market-data";
import { analyzeTechnicals } from "../technical-analysis";
import { checkGates, computeScoringIntermediates } from "./filters";
import { getEffectiveCapital } from "../position-manager";
import { BREAKOUT } from "../../lib/constants/breakout";
import type { WatchlistEntry, WatchlistBuildResult } from "./types";

/**
 * 直近 N 営業日の日足 high の最大値を計算する
 * @param data OHLCVデータ（newest-first）
 * @param days 遡る日数
 */
function computeHigh(data: { high: number }[], days: number): number | null {
  const slice = data.slice(0, days);
  if (slice.length === 0) return null;
  return Math.max(...slice.map((d) => d.high));
}

/**
 * 直近 N 日の平均出来高を計算する
 * @param data OHLCVデータ（newest-first）
 * @param days 平均を取る日数
 */
function computeAvgVolume(data: { volume: number }[], days: number): number | null {
  const slice = data.slice(0, days);
  if (slice.length === 0) return null;
  return slice.reduce((sum, d) => sum + d.volume, 0) / slice.length;
}

/**
 * 余力フィルター: entry-executor と同じロジックでポジションサイズを計算し、
 * 実効資金で購入可能かチェックする
 */
function canAffordEntry(
  latestPrice: number,
  atr14: number,
  effectiveCapital: number,
): boolean {
  // SL計算（entry-executorと同じ）
  const rawStopLoss = latestPrice - atr14 * BREAKOUT.STOP_LOSS.ATR_MULTIPLIER;
  const maxStopLoss = latestPrice * (1 - STOP_LOSS.MAX_LOSS_PCT);
  const stopLossPrice = Math.max(rawStopLoss, maxStopLoss);
  const riskPerShare = latestPrice - stopLossPrice;

  if (riskPerShare <= 0) return false;

  // ポジションサイズ計算
  const riskAmount = effectiveCapital * (POSITION_SIZING.RISK_PER_TRADE_PCT / 100);
  const rawQuantity = Math.floor(riskAmount / riskPerShare);
  const quantity = Math.floor(rawQuantity / UNIT_SHARES) * UNIT_SHARES;

  if (quantity === 0) return false;

  const requiredAmount = latestPrice * quantity;
  return effectiveCapital >= requiredAmount;
}

/**
 * ウォッチリストを構築する
 *
 * 基本フィルター（ゲート）と週足下降トレンドチェックを通過した銘柄を返す。
 */
export async function buildWatchlist(): Promise<WatchlistBuildResult> {
  // 1. DB全銘柄取得（廃止・制限なし）
  const stocks = await prisma.stock.findMany({
    where: {
      isDelisted: false,
      isActive: true,
      isRestricted: false,
      tradingHaltFlag: false,
      delistingDate: null,
    },
    select: {
      tickerCode: true,
      latestPrice: true,
      latestVolume: true,
      nextEarningsDate: true,
      exDividendDate: true,
    },
  });

  console.log(`[watchlist-builder] DB銘柄数: ${stocks.length}`);
  if (stocks.length === 0) {
    return {
      entries: [],
      stats: {
        totalStocks: 0,
        historicalLoaded: 0,
        skipInsufficientData: 0,
        skipGate: 0,
        skipAffordability: 0,
        skipWeeklyTrend: 0,
        skipHigh20: 0,
        skipAtr: 0,
        skipAvgVolume: 0,
        skipError: 0,
        passed: 0,
      },
    };
  }

  const allTickerCodes = stocks.map((s) => s.tickerCode);

  // 2. 実効資金を取得（余力フィルター用、1回だけ）
  const effectiveCapital = await getEffectiveCapital();
  console.log(`[watchlist-builder] 実効資金: ¥${effectiveCapital.toLocaleString()}`);

  // 3. OHLCVデータを一括取得（DBから）
  const historicalMap = await readHistoricalFromDB(allTickerCodes);
  console.log(`[watchlist-builder] OHLCVデータ取得済: ${historicalMap.size}銘柄`);

  const today = new Date();
  const entries: WatchlistEntry[] = [];

  // フィルター別カウンター
  let skipInsufficientData = 0;
  let skipGate = 0;
  let skipAffordability = 0;
  let skipWeeklyTrend = 0;
  let skipHigh20 = 0;
  let skipAtr = 0;
  let skipAvgVolume = 0;
  let skipError = 0;

  for (const stock of stocks) {
    try {
      const historical = historicalMap.get(stock.tickerCode);
      if (!historical || historical.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) {
        skipInsufficientData++;
        continue;
      }

      // 3. テクニカル分析（ATR・avgVolume計算に必要）
      const summary = analyzeTechnicals(historical);

      // avgVolume25 は直近25日の出来高平均
      const avgVolume25 = computeAvgVolume(historical, 25);

      // ATR%（ゲートチェック用）
      const latestPrice = stock.latestPrice != null ? Number(stock.latestPrice) : summary.currentPrice;
      const atrPct =
        summary.atr14 != null && latestPrice > 0
          ? (summary.atr14 / latestPrice) * 100
          : null;

      // 4. checkGates() でゲート判定
      const gate = checkGates({
        latestPrice,
        avgVolume25,
        atrPct,
        nextEarningsDate: stock.nextEarningsDate ?? null,
        exDividendDate: stock.exDividendDate ?? null,
        today,
      });

      if (!gate.passed) {
        skipGate++;
        continue;
      }

      // 5. 余力フィルター（ATRが計算可能な場合のみ）
      if (summary.atr14 != null && !canAffordEntry(latestPrice, summary.atr14, effectiveCapital)) {
        skipAffordability++;
        continue;
      }

      // 6. 週足下降トレンドチェック（checkGates には含まれていないため個別チェック）
      const intermediates = computeScoringIntermediates(historical);
      const { weeklyClose, weeklySma13 } = intermediates;

      if (weeklySma13 != null && weeklyClose != null && weeklyClose < weeklySma13) {
        skipWeeklyTrend++;
        continue;
      }

      // 6. high20 = 直近 HIGH_LOOKBACK_DAYS 日の high の最大値
      const high20 = computeHigh(historical, BREAKOUT.PRICE.HIGH_LOOKBACK_DAYS);
      if (high20 == null) {
        skipHigh20++;
        continue;
      }

      // atr14 が null の場合はスキップ
      if (summary.atr14 == null) {
        skipAtr++;
        continue;
      }

      // avgVolume25 が null の場合はスキップ
      if (avgVolume25 == null) {
        skipAvgVolume++;
        continue;
      }

      entries.push({
        ticker: stock.tickerCode,
        avgVolume25,
        high20,
        atr14: summary.atr14,
        latestClose: summary.currentPrice,
      });
    } catch (error) {
      skipError++;
      console.error(`[watchlist-builder] 処理エラー: ${stock.tickerCode}`, error);
    }
  }

  const stats = {
    totalStocks: stocks.length,
    historicalLoaded: historicalMap.size,
    skipInsufficientData,
    skipGate,
    skipAffordability,
    skipWeeklyTrend,
    skipHigh20,
    skipAtr,
    skipAvgVolume,
    skipError,
    passed: entries.length,
  };

  console.log(
    `[watchlist-builder] フィルター結果: ` +
      `データ不足=${skipInsufficientData}, ゲート落ち=${skipGate}, ` +
      `余力不足=${skipAffordability}, 週足下降=${skipWeeklyTrend}, ` +
      `high20欠損=${skipHigh20}, ATR欠損=${skipAtr}, 出来高欠損=${skipAvgVolume}, ` +
      `エラー=${skipError} → 通過=${entries.length}銘柄`
  );

  return { entries, stats };
}
