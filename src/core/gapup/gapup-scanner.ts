/**
 * ギャップアップスキャナー
 *
 * 14:50に1回実行し、ウォッチリスト全銘柄の当日OHLCVからギャップアップシグナルを検出する。
 * isGapUpSignal()（既存の共通モジュール）でシグナル判定。
 */

import { isGapUpSignal } from "./entry-conditions";
import { GAPUP } from "../../lib/constants/gapup";
import type { WatchlistEntry } from "../breakout/types";

/** 立花APIから取得する当日のOHLCVデータ */
export interface GapUpQuoteData {
  ticker: string;
  open: number;
  price: number; // 現在値（15:20時点 ≈ 終値の代替）
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
  /** 板情報（スキャン時のスナップショット。立花APIから取得できた場合のみ） */
  askPrice?: number;
  bidPrice?: number;
  askSize?: number;
  bidSize?: number;
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
   * @returns GapUpTrigger[]（gapPct × volumeSurgeRatio 降順）
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

      // isGapUpSignal で判定（15:20時点のpriceをcloseとして使用）
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

    // 優先順位ソート: gapPct × volumeSurgeRatio 降順（WF検証済み: PF 2.89 > RR順 2.57）
    triggers.sort((a, b) => {
      const aGapPct = (a.currentPrice - a.prevClose) / a.prevClose;
      const bGapPct = (b.currentPrice - b.prevClose) / b.prevClose;
      return (bGapPct * b.volumeSurgeRatio) - (aGapPct * a.volumeSurgeRatio);
    });

    return triggers;
  }
}
