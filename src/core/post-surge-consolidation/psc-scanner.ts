/**
 * 高騰後押し目（Post-Surge Consolidation）スキャナー
 *
 * GapUpScanner と同じパターン。
 * ウォッチリスト銘柄の当日OHLCVと直近20日の履歴バーから PSC シグナルを検出する。
 */

import { isPostSurgeConsolidationSignal } from "./entry-conditions";
import { POST_SURGE_CONSOLIDATION } from "../../lib/constants/post-surge-consolidation";
import type { WatchlistEntry } from "../breakout/types";

/** psc-monitor が StockDailyBar から取得する銘柄ごとの事前計算データ */
export interface PSCHistoricalData {
  /** 20営業日前の終値 */
  close20DaysAgo: number;
  /** 直近20営業日の最高終値 */
  high20: number;
}

/** PSCトリガーイベント */
export interface PostSurgeConsolidationTrigger {
  ticker: string;
  currentPrice: number;
  volume: number;
  volumeSurgeRatio: number;
  momentumReturn: number;
  atr14: number;
  triggeredAt: Date;
  /** 板情報（立花APIから取得できた場合のみ） */
  askPrice?: number;
  bidPrice?: number;
  askSize?: number;
  bidSize?: number;
}

export class PostSurgeConsolidationScanner {
  private watchlistMap: Map<string, WatchlistEntry>;

  constructor(watchlist: WatchlistEntry[]) {
    this.watchlistMap = new Map(watchlist.map((e) => [e.ticker, e]));
  }

  /**
   * PSCスキャンを実行
   *
   * @param quotes 当日OHLCVデータ（立花APIから取得）
   * @param historicalMap 銘柄ごとの直近履歴データ（PSC判定用）
   * @param holdingTickers 保有中のティッカーセット（除外用）
   * @returns triggers = 発注候補（momentumReturn × volumeSurgeRatio 降順）/
   *          skipped = シグナルは満たしたが holdingTickers で除外した銘柄（弾き分析用）
   *
   * ⚠️ 除外判定はシグナル判定の**後**に行う（GapUpScanner と同じ理由）。
   */
  scan(
    quotes: Array<{ ticker: string; open: number; price: number; volume: number }>,
    historicalMap: Map<string, PSCHistoricalData>,
    holdingTickers: Set<string>,
  ): {
    triggers: PostSurgeConsolidationTrigger[];
    skipped: { ticker: string; currentPrice: number }[];
  } {
    const triggers: PostSurgeConsolidationTrigger[] = [];
    const skipped: { ticker: string; currentPrice: number }[] = [];

    for (const quote of quotes) {
      const entry = this.watchlistMap.get(quote.ticker);
      if (!entry) continue;

      const hist = historicalMap.get(quote.ticker);
      if (!hist) continue;

      const isSignal = isPostSurgeConsolidationSignal({
        open: quote.open,
        close: quote.price,
        close20DaysAgo: hist.close20DaysAgo,
        high20: hist.high20,
        volume: quote.volume,
        avgVolume25: entry.avgVolume25,
        momentumMinReturn: POST_SURGE_CONSOLIDATION.ENTRY.MOMENTUM_MIN_RETURN,
        maxHighDistancePct: POST_SURGE_CONSOLIDATION.ENTRY.MAX_HIGH_DISTANCE_PCT,
        volSurgeRatio: POST_SURGE_CONSOLIDATION.ENTRY.VOL_SURGE_RATIO,
      });

      if (!isSignal) continue;

      // 保有中・当日発注済み・決済後cooldown はここで除外（シグナルは満たしている）
      if (holdingTickers.has(quote.ticker)) {
        skipped.push({ ticker: quote.ticker, currentPrice: quote.price });
        continue;
      }

      const volumeSurgeRatio = entry.avgVolume25 > 0 ? quote.volume / entry.avgVolume25 : 0;
      const momentumReturn = hist.close20DaysAgo > 0 ? quote.price / hist.close20DaysAgo - 1 : 0;

      triggers.push({
        ticker: quote.ticker,
        currentPrice: quote.price,
        volume: quote.volume,
        volumeSurgeRatio,
        momentumReturn,
        atr14: entry.atr14,
        triggeredAt: new Date(),
      });
    }

    // 優先順位ソート: momentumReturn × volumeSurgeRatio 降順
    triggers.sort((a, b) => b.momentumReturn * b.volumeSurgeRatio - a.momentumReturn * a.volumeSurgeRatio);

    return { triggers, skipped };
  }
}
