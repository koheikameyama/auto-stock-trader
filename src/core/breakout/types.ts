/**
 * ブレイクアウト戦略の型定義
 */

/** ウォッチリストエントリ（候補銘柄） */
export interface WatchlistEntry {
  /** ティッカーシンボル */
  ticker: string;
  /** 25日平均体積 */
  avgVolume25: number;
  /** 20日高値 */
  high20: number;
  /** 14日ATR */
  atr14: number;
  /** 最新終値 */
  latestClose: number;
}

/** ホットリストエントリ（体積サージ中の銘柄） */
export interface HotListEntry {
  /** ティッカーシンボル */
  ticker: string;
  /** ホットリストに昇格した日時 */
  promotedAt: Date;
  /** クールダウンカウント（0-2） */
  coolDownCount: number;
}

/** スキャナーの状態管理 */
export interface ScannerState {
  /** ウォッチリスト（候補銘柄） */
  watchlist: WatchlistEntry[];
  /** ホットセット（体積サージ中の銘柄） */
  hotSet: Map<string, HotListEntry>;
  /** 本日トリガー済み銘柄 */
  triggeredToday: Set<string>;
  /** 最後のコールドスキャン時刻（ティッカー単位のキャッシュ） */
  lastColdScanTime: Map<string, number>;
  /** 直近スキャン時の出来高サージ比率（ティッカー → 比率） */
  lastSurgeRatios: Map<string, number>;
}

/** ウォッチリスト構築のフィルター統計 */
export interface WatchlistFilterStats {
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
  /** high20欠損 */
  skipHigh20: number;
  /** ATR欠損 */
  skipAtr: number;
  /** 出来高欠損 */
  skipAvgVolume: number;
  /** 処理エラー */
  skipError: number;
  /** 通過銘柄数 */
  passed: number;
}

/** ウォッチリスト構築結果 */
export interface WatchlistBuildResult {
  entries: WatchlistEntry[];
  stats: WatchlistFilterStats;
}

/** ブレイクアウトトリガーイベント */
export interface BreakoutTrigger {
  /** ティッカーシンボル */
  ticker: string;
  /** トリガー時点の現在値 */
  currentPrice: number;
  /** 累積体積（ポーリング期間中） */
  cumulativeVolume: number;
  /** 体積サージ比率（平均体積比） */
  volumeSurgeRatio: number;
  /** 20日高値 */
  high20: number;
  /** 14日ATR */
  atr14: number;
  /** トリガー発生日時（JST） */
  triggeredAt: Date;
}
