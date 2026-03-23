/**
 * ジョブ設定
 */

// ポジションのデフォルト利確/損切り
export const POSITION_DEFAULTS = {
  TAKE_PROFIT_RATIO: 1.03, // 3%利確
  STOP_LOSS_RATIO: 0.98, // 2%損切り
} as const;

// 注文有効期限
export const ORDER_EXPIRY = {
  SWING_DAYS: 5, // スイングトレード注文の有効日数
} as const;

// 株価取得関連
export const STOCK_FETCH = {
  FAIL_THRESHOLD: 5, // 上場廃止判定の失敗回数
  WEEKLY_CHANGE_MIN_DAYS: 5, // 週間変化率計算の最低日数
  QUOTE_FAILURE_THRESHOLD: 0.8, // この割合以上のクォート失敗はサイドカー障害とみなしてジョブをエラー終了
} as const;

// ジョブの同時実行数
export const JOB_CONCURRENCY = {
  MARKET_SCANNER: 5,
  ORDER_MANAGER: 3, // OpenAI API レート制限考慮
} as const;

// ブレイクイーブンストップ（トレーリングストップ発動前の建値撤退）
// エントリー + ATR × N 以上の含み益が出たらSLをエントリー価格に引き上げ
// トレーリングストップ発動までの空白期間で「最悪でもトントン」を確保
export const BREAK_EVEN_STOP = {
  ACTIVATION_ATR_MULTIPLIER: {
    day_trade: 0.8,  // ATR×0.8の含み益でBE発動（トレーリング発動=1.2より手前）
    swing: 1.5,      // ATR×1.5の含み益でBE発動（トレーリング発動=2.5より手前）
  },
  // ATR不明時のフォールバック（%ベース）
  ACTIVATION_PCT: { day_trade: 0.01, swing: 0.03 },
} as const;

// トレーリングストップ
// 制約: ACTIVATION_ATR_MULTIPLIER >= TRAIL_ATR_MULTIPLIER（発動時にストップがエントリー以上）
export const TRAILING_STOP = {
  // アクティベーション閾値（エントリー価格からATR×N上昇で発動）
  ACTIVATION_ATR_MULTIPLIER: {
    day_trade: 1.2,  // trail=0.8より大きく設定しBE保証不要に
    swing: 2.5,      // ATR×2.5上昇で発動（BE=1.5との連携でPF改善）
  },
  // トレール幅（最高値 - ATR×N がストップライン）
  TRAIL_ATR_MULTIPLIER: {
    day_trade: 0.8,  // activation=1.2に対して十分小さく
    swing: 1.5,      // activation=2.5に対してtrail=1.5→発動時ATR×1.0の含み益確保
  },
  // ATR不明時のフォールバック（%ベース）— 同じ制約: ACTIVATION >= TRAIL
  ACTIVATION_PCT: { day_trade: 0.015, swing: 0.04 },
  TRAIL_PCT: { day_trade: 0.01, swing: 0.04 },
} as const;

// ディフェンシブモード（市場環境悪化時のポジション防衛）
export const DEFENSIVE_MODE = {
  ENABLED_SENTIMENTS: ["bearish", "crisis"] as readonly string[],
  // 微益撤退の最低利益率（%）— 損小利大を維持するため手数料以上の利益を確保
  MIN_PROFIT_PCT_FOR_RETREAT: 1.0,
  // bearish時の含み損損切り閾値（%）— ギャップダウンリスクを回避するため引き締め
  BEARISH_LOSS_CUT_PCT: 1.5,
} as const;

// cautiousモード（市場環境が徐々に悪化している場合のリスク制限）
// neutral → bearish の中間段階。day_tradeに強制切替して保有期間を短縮
// day_tradeは15:10に強制決済されるため、オーバーナイトリスクを回避
export const CAUTIOUS_MODE = {
  // day_tradeに強制切替する（既存swingもday_tradeに変換）
  FORCE_DAY_TRADE: true,
} as const;

// 昼休み再評価
export const MIDDAY_REASSESSMENT = {
  SCHEDULED_HOUR: 12,
  SCHEDULED_MINUTE: 15,
} as const;

// 週次レビュー
export const WEEKLY_REVIEW = {
  LOOKBACK_DAYS: 7,
} as const;

// タイムストップ
export const TIME_STOP = {
  MAX_HOLDING_DAYS: 5,           // 10 → 5（保有日数短縮でアルファを明確化）
  MAX_EXTENDED_HOLDING_DAYS: 10, // 15 → 10（含み益ハードキャップも比率維持）
} as const;
