import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { BREAKOUT } from "../../lib/constants/breakout";
import { TIMEZONE } from "../../lib/constants";

dayjs.extend(utc);
dayjs.extend(timezone);
import { calculateVolumeSurgeRatio } from "./volume-surge";
import type {
  WatchlistEntry,
  HotListEntry,
  ScannerState,
  BreakoutTrigger,
} from "./types";

export interface QuoteData {
  ticker: string;
  price: number;
  /** 累積出来高（Tachibana API の pDV） */
  volume: number;
}

export class BreakoutScanner {
  private state: ScannerState;
  private watchlistMap: Map<string, WatchlistEntry>;

  constructor(watchlist: WatchlistEntry[]) {
    this.state = {
      watchlist: [...watchlist],
      hotSet: new Map<string, HotListEntry>(),
      triggeredToday: new Set<string>(),
      lastColdScanTime: new Map<string, number>(),
      lastSurgeRatios: new Map<string, number>(),
    };
    this.watchlistMap = new Map(watchlist.map((e) => [e.ticker, e]));
  }

  /**
   * 1分間隔で呼ばれるメインスキャンループ
   *
   * @param quotes       ティッカーごとのリアルタイム気配値
   * @param now          現在時刻（JST）
   * @param dailyEntryCount  本日のエントリー済み件数
   * @param holdingTickers   現在保有中のティッカーセット
   * @returns 発火したブレイクアウトトリガーのリスト
   */
  scan(
    quotes: QuoteData[],
    now: Date,
    dailyEntryCount: number,
    holdingTickers: Set<string>,
  ): BreakoutTrigger[] {
    const jst = dayjs(now).tz(TIMEZONE);
    const hour = jst.hour();
    const minute = jst.minute();
    const nowMs = now.getTime();

    // Guard: 9:05 より前はスキャンしない
    if (!this.isAfterEarliestEntry(hour, minute)) {
      return [];
    }

    // quotes を Map にして O(1) 検索
    const quoteMap = new Map<string, QuoteData>(
      quotes.map((q) => [q.ticker, q]),
    );

    const triggers: BreakoutTrigger[] = [];

    // --- Hot scan (毎分) ---
    for (const [ticker, hotEntry] of this.state.hotSet) {
      const watchEntry = this.findWatchlistEntry(ticker);
      if (!watchEntry) continue;

      const quote = quoteMap.get(ticker);
      if (!quote) continue;

      const surgeRatio = calculateVolumeSurgeRatio(
        quote.volume,
        watchEntry.avgVolume25,
        hour,
        minute,
      );
      this.state.lastSurgeRatios.set(ticker, surgeRatio);

      // 高値追いチェック: high20からATR×MAX_CHASE_ATR以上乖離していたらスキップ
      const chaseAmount = quote.price - watchEntry.high20;
      const maxChase = watchEntry.atr14 * BREAKOUT.PRICE.MAX_CHASE_ATR;

      if (
        surgeRatio >= BREAKOUT.VOLUME_SURGE.TRIGGER_THRESHOLD &&
        quote.price > watchEntry.high20 &&
        chaseAmount <= maxChase &&
        this.canFireTrigger(ticker, hour, minute, dailyEntryCount, holdingTickers)
      ) {
        // Trigger 発火
        this.state.triggeredToday.add(ticker);
        triggers.push({
          ticker,
          currentPrice: quote.price,
          cumulativeVolume: quote.volume,
          volumeSurgeRatio: surgeRatio,
          high20: watchEntry.high20,
          atr14: watchEntry.atr14,
          triggeredAt: now,
        });
      } else if (surgeRatio < BREAKOUT.VOLUME_SURGE.COOL_DOWN_THRESHOLD) {
        // クールダウン
        hotEntry.coolDownCount += 1;
        if (hotEntry.coolDownCount >= BREAKOUT.VOLUME_SURGE.COOL_DOWN_COUNT) {
          // Hot → Cold 降格
          this.state.hotSet.delete(ticker);
        }
      } else {
        // サージが維持されている → クールダウンカウントをリセット
        hotEntry.coolDownCount = 0;
      }
    }

    // --- Cold scan (5分間隔ごと) ---
    for (const watchEntry of this.state.watchlist) {
      const { ticker } = watchEntry;

      // すでに Hot または Triggered → スキップ
      if (this.state.hotSet.has(ticker)) continue;
      if (this.state.triggeredToday.has(ticker)) continue;
      if (holdingTickers.has(ticker)) continue;

      // 5分間隔チェック
      const lastScan = this.state.lastColdScanTime.get(ticker) ?? 0;
      if (nowMs - lastScan < BREAKOUT.POLLING.COLD_INTERVAL_MS) continue;

      const quote = quoteMap.get(ticker);
      if (!quote) {
        // quote が取れない場合でも lastColdScanTime は更新しない（再試行のため）
        continue;
      }

      this.state.lastColdScanTime.set(ticker, nowMs);

      const surgeRatio = calculateVolumeSurgeRatio(
        quote.volume,
        watchEntry.avgVolume25,
        hour,
        minute,
      );
      this.state.lastSurgeRatios.set(ticker, surgeRatio);

      if (surgeRatio >= BREAKOUT.VOLUME_SURGE.HOT_THRESHOLD) {
        // Cold → Hot 昇格
        this.state.hotSet.set(ticker, {
          ticker,
          promotedAt: now,
          coolDownCount: 0,
        });
      }
    }

    triggers.sort((a, b) => b.volumeSurgeRatio - a.volumeSurgeRatio);
    return triggers;
  }

  /**
   * 1日の開始時にステートをリセットし、ウォッチリストを更新する
   */
  resetDaily(newWatchlist: WatchlistEntry[]): void {
    this.state = {
      watchlist: [...newWatchlist],
      hotSet: new Map<string, HotListEntry>(),
      triggeredToday: new Set<string>(),
      lastColdScanTime: new Map<string, number>(),
      lastSurgeRatios: new Map<string, number>(),
    };
    this.watchlistMap = new Map(newWatchlist.map((e) => [e.ticker, e]));
  }

  getState(): Readonly<ScannerState> {
    return this.state;
  }

  /**
   * 再トリガーを許可するために triggeredToday から銘柄を削除する
   * （一時的な理由で却下された場合に使用）
   */
  removeFromTriggeredToday(ticker: string): void {
    this.state.triggeredToday.delete(ticker);
  }

  // ----------------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------------

  private findWatchlistEntry(ticker: string): WatchlistEntry | undefined {
    return this.watchlistMap.get(ticker);
  }

  /**
   * 9:05 以降かどうか判定
   */
  private isAfterEarliestEntry(hour: number, minute: number): boolean {
    const [eh, em] = BREAKOUT.GUARD.EARLIEST_ENTRY_TIME.split(":").map(Number);
    return hour * 60 + minute >= eh * 60 + em;
  }

  /**
   * 14:30 以前かどうか判定（トリガー発火の上限時刻）
   */
  private isBeforeLatestEntry(hour: number, minute: number): boolean {
    const [lh, lm] = BREAKOUT.GUARD.LATEST_ENTRY_TIME.split(":").map(Number);
    return hour * 60 + minute <= lh * 60 + lm;
  }

  /**
   * トリガーを発火してよいかすべてのガード条件を確認する
   */
  private canFireTrigger(
    ticker: string,
    hour: number,
    minute: number,
    dailyEntryCount: number,
    holdingTickers: Set<string>,
  ): boolean {
    if (!this.isBeforeLatestEntry(hour, minute)) return false;
    if (dailyEntryCount >= BREAKOUT.GUARD.MAX_DAILY_ENTRIES) return false;
    if (this.state.triggeredToday.has(ticker)) return false;
    if (holdingTickers.has(ticker)) return false;
    return true;
  }
}
