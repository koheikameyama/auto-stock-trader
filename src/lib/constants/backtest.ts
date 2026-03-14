/**
 * 日次バックテスト定数
 */

/** パラメータ条件の型 */
interface BaseCondition {
  key: string;
  label: string;
}

interface ParameterOverrideCondition extends BaseCondition {
  param: string;
  value: number;
  overrideTpSl?: boolean;
}

interface MultiOverrideCondition extends BaseCondition {
  overrides: Record<string, number | boolean | undefined>;
}

export type ParameterCondition =
  | BaseCondition
  | ParameterOverrideCondition
  | MultiOverrideCondition;

/** パラメータオーバーライドを持つ条件かどうか */
export function hasParamOverride(
  c: ParameterCondition,
): c is ParameterOverrideCondition {
  return "param" in c;
}

/** 複数パラメータオーバーライドを持つ条件かどうか */
export function hasMultiOverride(
  c: ParameterCondition,
): c is MultiOverrideCondition {
  return "overrides" in c;
}

export const DAILY_BACKTEST = {
  /** 固定予算（30万ティア） */
  FIXED_BUDGET: {
    budget: 300_000,
    maxPrice: 3_000,
    maxPositions: 3,
  },

  /** パラメータ条件（1ベースライン + 4軸×3値 + フィルター3 = 16条件） */
  PARAMETER_CONDITIONS: [
    // ベースライン（本番ロジック）
    { key: "baseline", label: "ベースライン" },

    // TS起動ATR倍率
    { key: "ts_act_1.5", label: "TS起動1.5", param: "trailingActivationMultiplier", value: 1.5 },
    { key: "ts_act_2.0", label: "TS起動2.0", param: "trailingActivationMultiplier", value: 2.0 },
    { key: "ts_act_2.5", label: "TS起動2.5", param: "trailingActivationMultiplier", value: 2.5 },

    // スコア閾値
    { key: "score_60", label: "スコア60", param: "scoreThreshold", value: 60 },
    { key: "score_65", label: "スコア65", param: "scoreThreshold", value: 65 },
    { key: "score_70", label: "スコア70", param: "scoreThreshold", value: 70 },

    // ATR倍率（損切幅）— overrideTpSl=true 必須（SL計算に影響）
    { key: "atr_0.8", label: "ATR0.8", param: "atrMultiplier", value: 0.8, overrideTpSl: true },
    { key: "atr_1.0", label: "ATR1.0", param: "atrMultiplier", value: 1.0, overrideTpSl: true },
    { key: "atr_1.5", label: "ATR1.5", param: "atrMultiplier", value: 1.5, overrideTpSl: true },

    // トレール幅ATR倍率
    { key: "trail_0.8", label: "トレール0.8", param: "trailMultiplier", value: 0.8 },
    { key: "trail_1.0", label: "トレール1.0", param: "trailMultiplier", value: 1.0 },
    { key: "trail_1.5", label: "トレール1.5", param: "trailMultiplier", value: 1.5 },

    // トレンド＆プルバックフィルター
    { key: "trend_on", label: "トレンドF", overrides: { trendFilterEnabled: true } },
    { key: "pullback_on", label: "プルバックF", overrides: { pullbackFilterEnabled: true } },
    { key: "trend_pullback", label: "トレンド+PB", overrides: { trendFilterEnabled: true, pullbackFilterEnabled: true } },

    // ボラティリティ＆RSフィルター
    { key: "vol_filter", label: "ボラF", overrides: { volatilityFilterEnabled: true } },
    { key: "rs_filter", label: "RSフィルタ", overrides: { rsFilterEnabled: true } },
    { key: "vol_rs", label: "ボラ+RS", overrides: { volatilityFilterEnabled: true, rsFilterEnabled: true } },

    // タイムストップ延長
    { key: "hold_15", label: "保有15日", overrides: { maxHoldingDays: 15 } },
    { key: "hold_20", label: "保有20日", overrides: { maxHoldingDays: 20 } },

    // 複合: ボラ+RS+保有15日
    { key: "vol_rs_hold15", label: "ボラRS15日", overrides: { volatilityFilterEnabled: true, rsFilterEnabled: true, maxHoldingDays: 15 } },
  ] satisfies ParameterCondition[],

  /** シミュレーション期間（ローリング） */
  LOOKBACK_MONTHS: 12,

  /** ScoringRecord蓄積がこの月数未満ならフォールバックモードを使用 */
  MIN_SCORING_RECORD_MONTHS: 3,

  /** ScoringRecordからのティッカー選定 */
  TICKER_SELECTION: {
    LOOKBACK_DAYS: 30,
    MIN_TICKERS: 5,
    TARGET_RANKS: ["S"],
    FALLBACK_RANKS: ["S", "A"],
  },

  /** デフォルトシミュレーションパラメータ */
  DEFAULT_PARAMS: {
    scoreThreshold: 65,
    takeProfitRatio: 1.50,    // overrideTpSl=true 時のみ使用
    stopLossRatio: 0.98,      // overrideTpSl=true 時のみ使用
    atrMultiplier: 1.0,       // overrideTpSl=true 時のみ使用
    trailingActivationMultiplier: 2.0,  // TRAILING_STOP.ACTIVATION_ATR_MULTIPLIER.swing と同期
    strategy: "swing" as const,
    overrideTpSl: false,      // false = 本番ロジック（calculateEntryCondition の値をそのまま使用）
    cooldownDays: 5,          // ストップアウト後の同一銘柄再エントリー禁止日数
  },

  /** ボラティリティ＆RSフィルターの閾値 */
  UNIVERSE_FILTER: {
    /** ATR(14)/終値 × 100 がこの%以上の銘柄のみ（低ボラメガキャップ除外） */
    MIN_ATR_PCT: 1.5,
    /** RS(0-15)がこの値以上の銘柄のみ（セクター上位のみ） */
    MIN_RS_SCORE: 3.0,
  },

  /** トレンド＆プルバックフィルターの閾値 */
  TREND_FILTER: {
    /** プルバックエントリー: RSI上限 */
    MAX_RSI_FOR_ENTRY: 60,
    /** プルバックエントリー: SMA25からの最大乖離率(%) */
    MAX_DEVIATION_FROM_SMA25: 2.0,
  },

  /** トレンド表示の日数 */
  TREND_DAYS: 30,

  /** オンザフライスコアリングモード設定 */
  ON_THE_FLY: {
    /** スコアリング用のOHLCVルックバック（カレンダー日数） */
    LOOKBACK_CALENDAR_DAYS: 200,
  },
} as const;
