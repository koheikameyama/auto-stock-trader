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
    maxPrice: 5_000,
    maxPositions: 3,
  },

  /** パラメータ条件（1ベースライン + 4軸×3値 + フィルター3 = 16条件） */
  PARAMETER_CONDITIONS: [
    // ベースライン（本番ロジック）
    { key: "baseline", label: "ベースライン" },

    // TS起動ATR倍率（ベースライン=3.0）
    { key: "ts_act_2.0", label: "TS起動2.0", param: "trailingActivationMultiplier", value: 2.0 },
    { key: "ts_act_2.5", label: "TS起動2.5", param: "trailingActivationMultiplier", value: 2.5 },
    { key: "ts_act_3.5", label: "TS起動3.5", param: "trailingActivationMultiplier", value: 3.5 },

    // スコア閾値（ベースライン=70）
    { key: "score_60", label: "スコア60", param: "scoreThreshold", value: 60 },
    { key: "score_65", label: "スコア65", param: "scoreThreshold", value: 65 },
    { key: "score_75", label: "スコア75", param: "scoreThreshold", value: 75 },

    // ATR倍率（損切幅）— overrideTpSl=true 必須（SL計算に影響）
    { key: "atr_0.8", label: "ATR0.8", param: "atrMultiplier", value: 0.8, overrideTpSl: true },
    { key: "atr_1.0", label: "ATR1.0", param: "atrMultiplier", value: 1.0, overrideTpSl: true },
    { key: "atr_1.5", label: "ATR1.5", param: "atrMultiplier", value: 1.5, overrideTpSl: true },

    // トレール幅ATR倍率（ベースライン=2.0）
    { key: "trail_1.0", label: "トレール1.0", param: "trailMultiplier", value: 1.0 },
    { key: "trail_1.2", label: "トレール1.2", param: "trailMultiplier", value: 1.2 },
    { key: "trail_2.0", label: "トレール2.0", param: "trailMultiplier", value: 2.0 },

    // トレンド＆プルバックフィルター（ベースライン=トレンドON）
    { key: "trend_off", label: "トレンドOFF", overrides: { trendFilterEnabled: false } },
    { key: "pullback_on", label: "+プルバック", overrides: { pullbackFilterEnabled: true } },
    { key: "trend_off_pb", label: "トレンドOFF+PB", overrides: { trendFilterEnabled: false, pullbackFilterEnabled: true } },

    // ボラティリティ＆RSフィルター（ベースライン=ボラON）
    { key: "vol_off", label: "ボラOFF", overrides: { volatilityFilterEnabled: false } },
    { key: "rs_filter", label: "RSフィルタ", overrides: { rsFilterEnabled: true } },
    { key: "vol_off_rs", label: "ボラOFF+RS", overrides: { volatilityFilterEnabled: false, rsFilterEnabled: true } },

    // タイムストップ延長
    { key: "hold_15", label: "保有15日", overrides: { maxHoldingDays: 15 } },
    { key: "hold_20", label: "保有20日", overrides: { maxHoldingDays: 20 } },

    // 複合: RS+保有15日
    { key: "rs_hold15", label: "RS+15日", overrides: { rsFilterEnabled: true, maxHoldingDays: 15 } },
  ] satisfies ParameterCondition[],

  /** シミュレーション期間（ローリング） */
  LOOKBACK_MONTHS: 12,

  /** ScoringRecord蓄積がこの月数未満ならフォールバックモードを使用 */
  MIN_SCORING_RECORD_MONTHS: 3,

  /** ScoringRecordからのティッカー選定 */
  TICKER_SELECTION: {
    LOOKBACK_DAYS: 30,
    MIN_TICKERS: 5,
    TARGET_RANKS: ["S", "A"],
    FALLBACK_RANKS: ["S", "A", "B"],
  },

  /** デフォルトシミュレーションパラメータ */
  DEFAULT_PARAMS: {
    scoreThreshold: 70,
    takeProfitRatio: 1.50,    // overrideTpSl=true 時のみ使用
    stopLossRatio: 0.98,      // overrideTpSl=true 時のみ使用
    atrMultiplier: 1.0,       // overrideTpSl=true 時のみ使用
    trailingActivationMultiplier: 3.0,  // TS発動閾値（ATR×N上昇で発動）— PF 1.97実績
    trailMultiplier: 2.0,               // トレール幅（最高値 - ATR×N、発動時=ブレイクイーブン）
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
