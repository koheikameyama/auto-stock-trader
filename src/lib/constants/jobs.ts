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
  ORDER_MANAGER: 1, // 立花証券APIはp_no受信順を強制するため直列化
} as const;

// ブレイクイーブンストップ（トレーリングストップ発動前の建値撤退）
// エントリー + ATR × N 以上の含み益が出たらSLをエントリー価格に引き上げ
// トレーリングストップ発動までの空白期間で「最悪でもトントン」を確保
export const BREAK_EVEN_STOP = {
  ACTIVATION_ATR_MULTIPLIER: {
    breakout: 1.0,   // ATR×1.0で早めに建値ロック（ブレイクアウト初動の利益を守る）
    gapup: 0.3,      // ATR×0.3の含み益でBE発動（WF最適値: be=0.3・trail=0.3が全ウィンドウで安定）
    momentum: 1.0,
    "earnings-gap": 0.3,
    "weekly-break": 0.8,
    "squeeze-breakout": 0.5,
  },
  // ATR不明時のフォールバック（%ベース）
  ACTIVATION_PCT: { breakout: 0.02, gapup: 0.005, momentum: 0.02, "earnings-gap": 0.005, "weekly-break": 0.015, "squeeze-breakout": 0.01 },
} as const;

// トレーリングストップ
export const TRAILING_STOP = {
  // トレール幅（最高値 - ATR×N がストップライン）
  TRAIL_ATR_MULTIPLIER: {
    breakout: 1.5,   // ATR×1.0ではノイズ（通常リトレースメント）で狩られるため1.5に拡大
    gapup: 0.3,      // BE発動(ATR×0.3)後にATR×0.3のタイトなトレール（WF最適値）
    momentum: 1.0,
    "earnings-gap": 0.3,
    "weekly-break": 1.0,
    "squeeze-breakout": 0.5,
  },
  // ATR不明時のフォールバック（%ベース）
  ACTIVATION_PCT: { breakout: 0.03, gapup: 0.008, momentum: 0.02, "earnings-gap": 0.008, "weekly-break": 0.015, "squeeze-breakout": 0.02 },
  TRAIL_PCT: { breakout: 0.02, gapup: 0.005, momentum: 0.02, "earnings-gap": 0.005, "weekly-break": 0.015, "squeeze-breakout": 0.01 },
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

// 出口判定の猶予期間（ポジションOpen直後は日足OHLCに買い前の高値/安値が含まれるため）
export const EXIT_GRACE_PERIOD_MS = 1 * 60 * 1000; // 1分

// タイムストップ
export const TIME_STOP = {
  MAX_HOLDING_DAYS: 5,           // 10 → 5（保有日数短縮でアルファを明確化）
  MAX_EXTENDED_HOLDING_DAYS: 10, // 15 → 10（含み益ハードキャップも比率維持）
  /** gapup戦略のタイムストップ */
  GAPUP_MAX_HOLDING_DAYS: 3,
  GAPUP_MAX_EXTENDED_HOLDING_DAYS: 5,
} as const;
