/**
 * ギャップアップスキャナー
 *
 * 14:50に1回実行し、ウォッチリスト全銘柄の当日OHLCVからギャップアップシグナルを検出する。
 * isGapUpSignal()（既存の共通モジュール）でシグナル判定。
 */

import { isGapUpSignal } from "./entry-conditions";
import { GAPUP } from "../../lib/constants/gapup";
import { STOP_LOSS } from "../../lib/constants";
import type { WatchlistEntry } from "../breakout/types";

/** 立花APIから取得する当日のOHLCVデータ */
export interface GapUpQuoteData {
  ticker: string;
  open: number;
  price: number; // 現在値（14:50時点 ≈ 終値の代替）
  high: number;
  low: number;
  volume: number;
}

/** ギャップアップトリガーイベント */
export interface GapUpTrigger {
  ticker: string;
  currentPrice: number;
  volume: number;
  volumeSurgeRatio: number;
  atr14: number;
  prevClose: number;
  triggeredAt: Date;
}

export class GapUpScanner {
  private watchlistMap: Map<string, WatchlistEntry>;

  constructor(watchlist: WatchlistEntry[]) {
    this.watchlistMap = new Map(watchlist.map((e) => [e.ticker, e]));
  }

  /**
   * ギャップアップスキャンを実行
   *
   * @param quotes 当日OHLCVデータ（立花APIから取得）
   * @param holdingTickers 保有中のティッカーセット（除外用）
   * @returns GapUpTrigger[]（RR降順 → SL%昇順 → volumeSurgeRatio降順）
   */
  scan(quotes: GapUpQuoteData[], holdingTickers: Set<string>): GapUpTrigger[] {
    const triggers: GapUpTrigger[] = [];

    for (const quote of quotes) {
      const entry = this.watchlistMap.get(quote.ticker);
      if (!entry) continue;

      // 保有中銘柄はスキップ
      if (holdingTickers.has(quote.ticker)) continue;

      // prevClose = ウォッチリストのlatestClose（前日終値）
      const prevClose = entry.latestClose;

      // isGapUpSignal で判定（14:50時点のpriceをcloseとして使用）
      const isSignal = isGapUpSignal({
        open: quote.open,
        close: quote.price,
        prevClose,
        volume: quote.volume,
        avgVolume25: entry.avgVolume25,
        gapMinPct: GAPUP.ENTRY.GAP_MIN_PCT,
        volSurgeRatio: GAPUP.ENTRY.VOL_SURGE_RATIO,
      });

      if (!isSignal) continue;

      const volumeSurgeRatio =
        entry.avgVolume25 > 0 ? quote.volume / entry.avgVolume25 : 0;

      triggers.push({
        ticker: quote.ticker,
        currentPrice: quote.price,
        volume: quote.volume,
        volumeSurgeRatio,
        atr14: entry.atr14,
        prevClose,
        triggeredAt: new Date(),
      });
    }

    // 優先順位ソート: RR降順 → SL%昇順 → 出来高サージ降順
    const slAtrMul = GAPUP.STOP_LOSS.ATR_MULTIPLIER;
    triggers.sort((a, b) => {
      const aRawSL = a.currentPrice - a.atr14 * slAtrMul;
      const aMaxSL = a.currentPrice * (1 - STOP_LOSS.MAX_LOSS_PCT);
      const aRisk = a.currentPrice - Math.max(aRawSL, aMaxSL);
      const aRR = aRisk > 0 ? (a.atr14 * 5.0) / aRisk : 0;
      const aSlPct = aRisk / a.currentPrice;

      const bRawSL = b.currentPrice - b.atr14 * slAtrMul;
      const bMaxSL = b.currentPrice * (1 - STOP_LOSS.MAX_LOSS_PCT);
      const bRisk = b.currentPrice - Math.max(bRawSL, bMaxSL);
      const bRR = bRisk > 0 ? (b.atr14 * 5.0) / bRisk : 0;
      const bSlPct = bRisk / b.currentPrice;

      if (Math.abs(bRR - aRR) >= 0.1) return bRR - aRR;
      if (Math.abs(aSlPct - bSlPct) >= 0.001) return aSlPct - bSlPct;
      return b.volumeSurgeRatio - a.volumeSurgeRatio;
    });

    return triggers;
  }
}
