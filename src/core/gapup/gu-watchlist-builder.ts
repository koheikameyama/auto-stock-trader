/**
 * GU/WB共用ウォッチリストビルダー
 *
 * `breakout/watchlist-builder.ts` をベースに以下の変更を加えたビルダー:
 * - high20フィルターを削除（GUはブレイクアウト条件を必要としない）
 * - 直近5日モメンタムフィルターを追加（momentum5d > 0 の銘柄のみ）
 *
 * フロー:
 *   1. DB全銘柄 + OHLCVデータ一括取得
 *   2. checkGates() でゲート判定
 *   3. weeklyClose < weeklySma13 の銘柄を除外（落ちるナイフ回避）
 *   4. momentum5d = (latestClose - close5dAgo) / close5dAgo を計算
 *   5. momentum5d <= 0 の銘柄を除外
 *   6. avgVolume25 / atr14 を算出
 *   7. GuWatchlistEntry[] を返す
 */

import { prisma } from "../../lib/prisma";
import { TECHNICAL_MIN_DATA } from "../../lib/constants";
import { STOP_LOSS, POSITION_SIZING, UNIT_SHARES } from "../../lib/constants";
import { readHistoricalFromDB } from "../market-data";
import { analyzeTechnicals } from "../technical-analysis";
import { checkGates, computeScoringIntermediates } from "../breakout/filters";
import { getEffectiveCapital } from "../position-manager";
import { getMaxBuyablePrice } from "../risk-manager";
import { BREAKOUT } from "../../lib/constants/breakout";
import type { WatchlistEntry } from "../breakout/types";

/** GUウォッチリストエントリ（候補銘柄） */
export interface GuWatchlistEntry extends WatchlistEntry {
  /** 直近5日モメンタム（(latestClose - close5dAgo) / close5dAgo） */
  momentum5d: number;
}

/** GUウォッチリスト構築のフィルター統計 */
export interface GuWatchlistFilterStats {
  /** DB全銘柄数 */
  totalStocks: number;
  /** OHLCVデータ取得済み銘柄数 */
  historicalLoaded: number;
  /** データ不足でスキップ */
  skipInsufficientData: number;
  /** ゲート落ち */
  skipGate: number;
  /** 週足下降トレンドで除外 */
  skipWeeklyTrend: number;
  /** モメンタム不足（直近5日リターン <= 0）で除外 */
  skipMomentum: number;
  /** ATR欠損 */
  skipAtr: number;
  /** 出来高欠損 */
  skipAvgVolume: number;
  /** 余力不足 */
  skipAffordability: number;
  /** 処理エラー */
  skipError: number;
  /** 通過銘柄数 */
  passed: number;
}

/** GUウォッチリスト構築結果 */
export interface GuWatchlistBuildResult {
  entries: GuWatchlistEntry[];
  stats: GuWatchlistFilterStats;
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
  if (rawStopLoss < maxStopLoss) return false;

  const stopLossPrice = rawStopLoss;
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
 * GU/WB共用ウォッチリストを構築する
 *
 * 基本フィルター（ゲート）、週足下降トレンドチェック、
 * および直近5日モメンタムフィルターを通過した銘柄を返す。
 */
export async function buildGuWatchlist(): Promise<GuWatchlistBuildResult> {
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

  console.log(`[gu-watchlist-builder] DB銘柄数: ${stocks.length}`);
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
        skipMomentum: 0,
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
  const maxPrice = getMaxBuyablePrice(effectiveCapital);
  console.log(`[gu-watchlist-builder] 実効資金: ¥${effectiveCapital.toLocaleString()}, 最大株価: ¥${maxPrice.toLocaleString()}`);

  // 3. OHLCVデータを一括取得（DBから）
  const historicalMap = await readHistoricalFromDB(allTickerCodes);
  console.log(`[gu-watchlist-builder] OHLCVデータ取得済: ${historicalMap.size}銘柄`);

  const today = new Date();
  const entries: GuWatchlistEntry[] = [];

  // フィルター別カウンター
  let skipInsufficientData = 0;
  let skipGate = 0;
  let skipAffordability = 0;
  let skipWeeklyTrend = 0;
  let skipMomentum = 0;
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

      // テクニカル分析（ATR・avgVolume計算に必要）
      const summary = analyzeTechnicals(historical);

      // avgVolume25 は直近25日の出来高平均
      const avgVolume25 = computeAvgVolume(historical, 25);

      // ATR%（ゲートチェック用）
      const latestPrice = stock.latestPrice != null ? Number(stock.latestPrice) : summary.currentPrice;
      const atrPct =
        summary.atr14 != null && latestPrice > 0
          ? (summary.atr14 / latestPrice) * 100
          : null;

      // checkGates() でゲート判定
      const gate = checkGates({
        latestPrice,
        avgVolume25,
        atrPct,
        nextEarningsDate: stock.nextEarningsDate ?? null,
        exDividendDate: stock.exDividendDate ?? null,
        today,
        maxPrice,
      });

      if (!gate.passed) {
        skipGate++;
        continue;
      }

      // 余力フィルター（ATRが計算可能な場合のみ）
      if (summary.atr14 != null && !canAffordEntry(latestPrice, summary.atr14, effectiveCapital)) {
        skipAffordability++;
        continue;
      }

      // 週足下降トレンドチェック
      const intermediates = computeScoringIntermediates(historical);
      const { weeklyClose, weeklySma13 } = intermediates;

      if (weeklySma13 != null && weeklyClose != null && weeklyClose < weeklySma13) {
        skipWeeklyTrend++;
        continue;
      }

      // 直近5日モメンタム計算（データ取得）
      // データはnewest-first: index0が最新、index4が5営業日前
      const latestClose = historical[0]?.close;
      const close5dAgo = historical[4]?.close;

      if (latestClose == null || close5dAgo == null || close5dAgo === 0) {
        skipMomentum++;
        continue;
      }

      const momentum5d = (latestClose - close5dAgo) / close5dAgo;
      // momentum5d フィルターはここでは行わない。
      // GU候補は getGuWatchlist() の取得時に momentum5d > 0 でフィルタリングする。
      // PSC候補はフィルターなしで全エントリーを使う。

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
        high20: 0, // GUでは使用しないためダミー値
        atr14: summary.atr14,
        latestClose: summary.currentPrice,
        weeklyHigh13: intermediates.weeklyHigh13 ?? undefined,
        momentum5d,
      });
    } catch (error) {
      skipError++;
      console.error(`[gu-watchlist-builder] 処理エラー: ${stock.tickerCode}`, error);
    }
  }

  const stats = {
    totalStocks: stocks.length,
    historicalLoaded: historicalMap.size,
    skipInsufficientData,
    skipGate,
    skipAffordability,
    skipWeeklyTrend,
    skipMomentum,
    skipAtr,
    skipAvgVolume,
    skipError,
    passed: entries.length,
  };

  console.log(
    `[gu-watchlist-builder] フィルター結果: ` +
      `データ不足=${skipInsufficientData}, ゲート落ち=${skipGate}, ` +
      `余力不足=${skipAffordability}, 週足下降=${skipWeeklyTrend}, ` +
      `モメンタム不足=${skipMomentum}, ATR欠損=${skipAtr}, 出来高欠損=${skipAvgVolume}, ` +
      `エラー=${skipError} → 通過=${entries.length}銘柄`
  );

  return { entries, stats };
}
