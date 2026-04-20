/**
 * 自動売買システム定数
 */

// 単元株数（日本株の最小取引単位）
export const UNIT_SHARES = 100;

// ========================================
// 取引設定のデフォルト値
// ========================================

export const TRADING_DEFAULTS = {
  TOTAL_BUDGET: 500_000, // 50万円
  MAX_POSITIONS: 3, // 最大同時保有数（戦略別・独立）
  MAX_POSITIONS_BO: 3, // ブレイクアウト戦略の最大ポジション数
  MAX_POSITIONS_GU: 3, // ギャップアップ戦略の最大ポジション数（資金稼働率向上）
  MAX_POSITIONS_WB: 2, // 週足レンジブレイク戦略の最大ポジション数
  MAX_POSITIONS_PSC: 1, // 高騰後押し目戦略の最大ポジション数（スモールスタート）
  MAX_POSITION_PCT: 40, // 1銘柄集中リスク防止（50万円規模: 最大20万/銘柄）
  MAX_DAILY_LOSS_PCT: 3, // 日次最大損失率(%)
} as const;


// ========================================
// テクニカル指標の閾値
// ========================================

export const RSI_THRESHOLDS = {
  OVERBOUGHT: 70,
  OVERSOLD: 30,
} as const;

// トレンドライン検出の閾値
export const TRENDLINE = {
  MIN_DATA_POINTS: 15,
  WINDOW_SIZE: 3,
  TOUCH_TOLERANCE: 0.02,
  MAX_VIOLATION_RATIO: 0.15,
  MIN_TOUCHES: 2,
  SIGNIFICANT_SLOPE: 0.001,
  MIN_SPAN_RATIO: 0.3,
} as const;

// ========================================
// 市場指標
// ========================================

export const MARKET_INDEX = {
  CRASH_THRESHOLD: -5, // 急落判定（週間変化率%）
  PANIC_THRESHOLD: -7, // パニック閾値
  NIKKEI_CRISIS_THRESHOLD: -3, // 日経平均キルスイッチ（前日比%で全取引停止）
} as const;

/** 市場breadthフィルター（全戦略共通） */
export const MARKET_BREADTH = {
  /** breadth閾値（全銘柄のSMA25上回り比率）— この値未満の日はエントリーをスキップ */
  THRESHOLD: 0.55,
} as const;

// CME日経先物の取引時間（JST基準）
export const CME_TRADING_HOURS = {
  DAILY_BREAK_START_HOUR_JST: 6,
  DAILY_BREAK_END_HOUR_JST: 7,
  WEEK_START_DAY: 1,
  WEEK_END_DAY: 6,
  WEEK_END_HOUR_JST: 6,
} as const;

// 先物と現物の乖離率シグナル
export const FUTURES_DIVERGENCE = {
  BULLISH_THRESHOLD: 0.3,
  BEARISH_THRESHOLD: -0.3,
  STRONG_BULLISH_THRESHOLD: 1.0,
  STRONG_BEARISH_THRESHOLD: -1.0,
} as const;

// VIX閾値（プライマリ恐怖指標）
export const VIX_THRESHOLDS = {
  HIGH: 30, // Crisis: > 30（取引停止）
  ELEVATED: 25, // High: 25-30（最大1ポジション、Sランクのみ）
  NORMAL: 20, // Elevated: 20-25（最大2ポジション、S/Aランク）
} as const;

// 指数SMAヒステリシスフィルター（本番用定数）
export const INDEX_TREND_HYSTERESIS = {
  /** SMA期間 */
  SMA_PERIOD: 50,
  /** OFFバッファ（%）: SMA*(1-this)以下でフィルターOFF。0=バッファなし */
  OFF_BUFFER_PCT: 0,
  /** ONバッファ（%）: SMA*(1+this)以上でフィルターON。0=バッファなし */
  ON_BUFFER_PCT: 0,
  /** ヒステリシス状態ウォームアップ日数 */
  WARMUP_DAYS: 30,
} as const;

// 日経225トレンドフィルター（SMAベース）
export const NIKKEI_TREND_FILTER = {
  /** SMA期間（25日 ≈ 5週間） */
  SMA_PERIOD: 25,
  /** SMA下でのmaxPositions */
  MAX_POSITIONS_BELOW_SMA: 1,
  /** SMA下でのminScore（旧Sランク相当: 75点以上） */
  MIN_SCORE_BELOW_SMA: 75,
} as const;

// 米国市場オーバーナイト指標
// 前日の米国市場終値を翌朝の日本株判断に使用する
export const US_OVERNIGHT = {
  // 米国市場が全面安と判断する閾値（3指数すべてがこの値以下）
  BROAD_SELLOFF_THRESHOLD: -1.5,
  // SOX半導体指数の急落閾値（日本の半導体セクターに直接波及）
  SOX_CRASH_THRESHOLD: -3.0,
  // NASDAQ急落閾値（テック・グロース系に波及）
  NASDAQ_CRASH_THRESHOLD: -3.0,
} as const;

// 米国セクター → 日本セクターグループ の相関マッピング
// 米国セクターの前日動向を日本の対応セクターの追加シグナルとして使用
export const US_JP_SECTOR_CORRELATION = {
  // SOX半導体指数 → 半導体・電子部品（最重要: 東京エレクトロン、アドバンテスト等に直結）
  sox: ["半導体・電子部品"] as readonly string[],
  // NASDAQ → IT・グロース系
  nasdaq: ["IT・サービス", "半導体・電子部品"] as readonly string[],
} as const;

// CMEナイトセッション乖離率閾値
export const CME_NIGHT_DIVERGENCE = {
  CRITICAL: -3.0, // crisis（取引停止、前場でギャップダウン必至）
  WARNING: -1.5, // elevated以上に引き上げ（警戒モード）
} as const;

// ========================================
// 取引スケジュール（JST）
// ========================================

export const TRADING_SCHEDULE = {
  MARKET_OPEN: { hour: 9, minute: 0 },
  MORNING_CLOSE: { hour: 11, minute: 30 },
  AFTERNOON_OPEN: { hour: 12, minute: 30 },
  MARKET_CLOSE: { hour: 15, minute: 30 },
} as const;

// ========================================
// エントリー時間帯フィルタ
// ========================================

export const TIME_WINDOW = {
  // 寄付き直後（9:00-9:30）
  OPENING_VOLATILITY: {
    start: { hour: 9, minute: 0 },
    end: { hour: 9, minute: 30 },
  },
  // デイトレ新規エントリー締切（15:00）
  DAY_TRADE_ENTRY_CUTOFF: { hour: 15, minute: 0 },
} as const;

// ========================================
// 流動性フィルタ（板情報チェック）
// ========================================

export const LIQUIDITY_FILTER = {
  // スプレッド上限（%）: best ask - best bid が株価に対してこの比率を超えたらスキップ
  // 日経225銘柄は通常0.1-0.3%。0.5%超は流動性不足と判断
  MAX_SPREAD_PCT: 0.5,

  // 最良気配の最小板厚（株数）: 自分の注文数量以上の板厚がなければスキップ
  // 注文数量との比較で判定するため、固定値ではなく倍率で管理
  MIN_BOARD_DEPTH_RATIO: 1.0, // askSize >= 注文数量 × この倍率

  // 売り超過の警戒閾値: askSize / bidSize がこの値以上なら「売り圧力大」としてリスクフラグ
  SELL_PRESSURE_THRESHOLD: 3.0,
} as const;

/** @deprecated LIQUIDITY_FILTER.MAX_SPREAD_PCT を使用してください */
export const SPREAD_FILTER = {
  MAX_SPREAD_PCT: LIQUIDITY_FILTER.MAX_SPREAD_PCT,
} as const;

// ========================================
// yahoo-finance2 設定
// ========================================

export const YAHOO_FINANCE = {
  HISTORICAL_DAYS: 200, // データポイント数（週足トレンド分析対応）
  BATCH_SIZE: 50, // バッチクォート取得サイズ（1リクエストで複数銘柄）
  RATE_LIMIT_DELAY_MS: 2000, // レート制限用ディレイ
} as const;

// ========================================
// セクターマスタ
// ========================================

export const SECTOR_MASTER: Record<string, readonly string[]> = {
  "半導体・電子部品": ["電気機器", "精密機器", "機械"],
  自動車: ["輸送用機器"],
  金融: ["銀行業", "証券、商品先物取引業", "保険業", "卸売業", "その他金融業"],
  医薬品: ["医薬品"],
  "IT・サービス": ["情報・通信業", "サービス業"],
  エネルギー: ["電気・ガス業", "鉱業", "石油・石炭製品"],
  小売: ["小売業", "食料品", "水産・農林業"],
  不動産: ["不動産業", "建設業"],
  素材: [
    "化学",
    "鉄鋼",
    "非鉄金属",
    "金属製品",
    "ガラス・土石製品",
    "繊維製品",
    "ゴム製品",
    "パルプ・紙",
  ],
  運輸: ["陸運業", "海運業", "空運業", "倉庫・運輸関連業"],
  その他: ["その他製品"],
};

// セクターグループ名リスト（AI構造化出力のenum等で使用）
export const SECTOR_GROUP_NAMES = Object.keys(SECTOR_MASTER);

// TSE業種 → セクターグループの逆引き
export const TSE_TO_SECTOR: Record<string, string> = Object.entries(
  SECTOR_MASTER,
).reduce(
  (acc, [group, industries]) => {
    for (const industry of industries) {
      acc[industry] = group;
    }
    return acc;
  },
  {} as Record<string, string>,
);

export function getSectorGroup(tseSector: string | null): string | null {
  if (!tseSector) return null;
  return TSE_TO_SECTOR[tseSector] ?? null;
}

// ========================================
// マクロファクターマスタ
// ========================================

// マクロファクター → セクターグループ[] のマッピング
// 同一マクロファクターのセクターは同一のマクロ経済変数（USD/JPY・金利等）で連動して動く
export const MACRO_FACTOR_MASTER: Record<string, readonly string[]> = {
  "為替連動（輸出）": ["自動車", "半導体・電子部品"],
  金利連動: ["金融", "不動産"],
  "内需・景気敏感": ["小売", "素材", "運輸"],
  ディフェンシブ: ["医薬品"],
  "IT・グロース": ["IT・サービス"],
  エネルギー: ["エネルギー"],
  その他: ["その他"],
} as const;

// セクターグループ → マクロファクターの逆引きマップ
export const SECTOR_TO_MACRO_FACTOR: Record<string, string> = Object.entries(
  MACRO_FACTOR_MASTER,
).reduce(
  (acc, [factor, sectors]) => {
    for (const sector of sectors) {
      acc[sector] = factor;
    }
    return acc;
  },
  {} as Record<string, string>,
);

/**
 * セクターグループからマクロファクターを取得する
 */
export function getMacroFactor(sectorGroup: string | null): string | null {
  if (!sectorGroup) return null;
  return SECTOR_TO_MACRO_FACTOR[sectorGroup] ?? null;
}

// ========================================
// セクターリスク管理
// ========================================

export const SECTOR_RISK = {
  MAX_SAME_SECTOR_POSITIONS: 1, // 同一セクター最大保有数
  MAX_SAME_MACRO_POSITIONS: 2, // 同一マクロファクター最大保有数
  WEAK_SECTOR_THRESHOLD: -2.0, // 弱セクター判定（日経比 相対パフォーマンス%）
  NEWS_SENTIMENT_DAYS: 3, // ニュースセンチメント集約日数
} as const;

// ========================================
// ドローダウン管理
// ========================================

export const DRAWDOWN = {
  WEEKLY_HALT_PCT: 5, // 週次5%で取引停��
  MONTHLY_HALT_PCT: 10, // 月���10%で取��停止
} as const;

// ========================================
// 連敗クールダウン
// ========================================

export const LOSING_STREAK = {
  /** リスク%縮小の開始トリガー（連敗数） */
  SCALE_TRIGGER: 3,
  /** リスク%のスケールファクター（50%に縮小） */
  SCALE_FACTOR: 0.5,
  /** クールダウン中の最大同時保有数 */
  MAX_POSITIONS_COOLDOWN: 1,
  /** 取引停止の連敗数 */
  HALT_TRIGGER: 5,
} as const;

// ========================================
// マーケットレジーム（VIXベース）
// ========================================

export const MARKET_REGIME = {
  CRISIS: {
    // VIX > 30
    maxPositions: 1, // 1ポジション制限（暴落時にブレイクアウトする銘柄は本物の強さ）
    minScore: 75, // 旧Sランク相当
  },
  HIGH: {
    // VIX 25-30
    maxPositions: 1,
    minScore: 75, // 旧Sランク相当
  },
  ELEVATED: {
    // VIX 20-25
    maxPositions: 2,
    minScore: 60, // 旧Aランク相当
  },
  NORMAL: {
    // VIX < 20
    maxPositions: 3, // 制限なし（TradingConfig準拠）
    minScore: 0, // 制限なし
  },
} as const;

// ========================================
// VIX高騰時のポジション強制決済
// ========================================

export const STRATEGY_SWITCHING = {
  // VIXがこの値以上 → 既存breakout/gapupポジションも強制決済（危機水準）
  // ギャップダウンでSLが機能しないリスクを回避
  VIX_FORCE_CLOSE_THRESHOLD: VIX_THRESHOLDS.HIGH,
} as const;

// ========================================
// 銘柄スクリーニング対象
// ========================================

// 日経225構成銘柄 + 主要中小型株から取引対象を選定
// 初期は日経225のティッカーコードリストを外部から読み込む想定
export const SCREENING = {
  // スクリーニング対象の最低条件
  MIN_MARKET_CAP: 100, // 最低時価総額（億円）
  MIN_DAILY_VOLUME: 100_000, // 最低出来高（株）
  MIN_PRICE: 100, // 最低株価（円）— 低位株の板薄リスク排除（出来高フィルターと併用）
  MIN_TURNOVER: 100_000_000, // 最低売買代金（円）— 金額ベースの流動性確保（株価×出来高）
} as const;

// ========================================
// 週末・連休リスク管理
// ========================================

export const WEEKEND_RISK = {
  SIZE_REDUCTION_THRESHOLD: 3,       // 非営業日N日以上でポジションサイズ縮小（3連休以上で発動）
  POSITION_SIZE_MULTIPLIER: 0.7,     // ポジションサイズ70%（30%縮小）

  TRAILING_TIGHTEN_THRESHOLD: 3,     // 非営業日N日以上でトレーリングストップ引き締め
  TRAILING_TIGHTEN_MULTIPLIER: 0.7,  // ATR倍率を70%に縮小（例: 2.0 → 1.4）
} as const;

// ========================================
// 上場廃止リスク管理
// ========================================

export const DELISTING_RISK = {
  TS_TIGHTEN_MULTIPLIER: 0.5,       // 廃止予定銘柄のATR倍率を50%に引き締め
  FORCE_CLOSE_DAYS_BEFORE: 5,       // 廃止日の5営業日前で強制クローズ
} as const;
