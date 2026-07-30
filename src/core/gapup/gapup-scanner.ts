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
  price: number; // 現在値（15:24時点 ≈ 終値の代替）
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
   * @returns triggers = 発注候補（gapPct × volumeSurgeRatio 降順）/
   *          skipped = シグナルは満たしたが holdingTickers で除外した銘柄（弾き分析用）
   *
   * ⚠️ 除外判定はシグナル判定の**後**に行う。順序を入れ替えると
   * 「シグナルが満たしていたが保有中/cooldownで発注しなかった」候補を数えられなくなる
   * （triggers の内容は順序に依存しない = 除外銘柄は必ず triggers から外れる）。
   */
  scan(
    quotes: GapUpQuoteData[],
    holdingTickers: Set<string>,
  ): { triggers: GapUpTrigger[]; skipped: { ticker: string; currentPrice: number }[] } {
    const triggers: GapUpTrigger[] = [];
    const skipped: { ticker: string; currentPrice: number }[] = [];

    for (const quote of quotes) {
      const entry = this.watchlistMap.get(quote.ticker);
      if (!entry) continue;

      // prevClose = ウォッチリストのlatestClose（前日終値）
      const prevClose = entry.latestClose;

      // isGapUpSignal で判定（15:24時点のpriceをcloseとして使用）
      const isSignal = isGapUpSignal({
        open: quote.open,
        close: quote.price,
        prevClose,
        volume: quote.volume,
        avgVolume25: entry.avgVolume25,
        gapMinPct: GAPUP.ENTRY.GAP_MIN_PCT,
        volSurgeRatio: GAPUP.ENTRY.VOL_SURGE_RATIO,
        gapRelaxVolThreshold: GAPUP.ENTRY.GAP_RELAX_VOL_THRESHOLD,
        gapMinPctRelaxed: GAPUP.ENTRY.GAP_MIN_PCT_RELAXED,
      });

      if (!isSignal) continue;

      // 保有中・当日発注済み・決済後cooldown はここで除外（シグナルは満たしている）
      if (holdingTickers.has(quote.ticker)) {
        skipped.push({ ticker: quote.ticker, currentPrice: quote.price });
        continue;
      }

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

    return { triggers, skipped };
  }
}
