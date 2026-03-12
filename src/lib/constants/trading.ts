/**
 * 自動売買システム定数
 */

// 単元株数（日本株の最小取引単位）
export const UNIT_SHARES = 100;

// ========================================
// 取引設定のデフォルト値
// ========================================

export const TRADING_DEFAULTS = {
  TOTAL_BUDGET: 300_000, // 30万円
  MAX_POSITIONS: 3, // 最大同時保有数
  MAX_POSITION_PCT: 50, // 1銘柄あたり最大比率(%) - 2〜3ポジション分散
  MAX_DAILY_LOSS_PCT: 3, // 日次最大損失率(%)
} as const;

// ========================================
// OpenAI設定
// ========================================

export const OPENAI_CONFIG = {
  MODEL: "gpt-4o",
  TEMPERATURE: 0.3, // 取引判断は低めの温度で安定性重視
  MAX_TOKENS: 2000,
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
  MARKET_CLOSE: { hour: 15, minute: 0 },
  // デイトレの強制決済時刻（Yahoo Finance約20分遅延を考慮し+20分）
  DAY_TRADE_FORCE_EXIT: { hour: 14, minute: 50 },
} as const;

// ========================================
// エントリー時間帯フィルタ
// ========================================

export const TIME_WINDOW = {
  // 寄付き直後（板が薄い・スプレッド拡大）
  OPENING_VOLATILITY: {
    start: { hour: 9, minute: 0 },
    end: { hour: 9, minute: 30 },
  },
  // デイトレ新規エントリー締切（残り30分では期待値マイナス）
  DAY_TRADE_ENTRY_CUTOFF: { hour: 14, minute: 30 },
} as const;

// ========================================
// yahoo-finance2 設定
// ========================================

export const YAHOO_FINANCE = {
  HISTORICAL_PERIOD: "10mo", // テクニカル分析用データ期間（週足SMA26に200日必要）
  HISTORICAL_DAYS: 200, // データポイント数（週足トレンド分析対応）
  BATCH_SIZE: 50, // バッチクォート取得サイズ（1リクエストで複数銘柄）
  HISTORICAL_BATCH_SIZE: 10, // ヒストリカルデータ取得の並列数
  RATE_LIMIT_DELAY_MS: 2000, // レート制限用ディレイ
  RETRY_MAX_ATTEMPTS: 3, // リトライ最大回数
  RETRY_BASE_DELAY_MS: 3000, // リトライ初回待機（指数バックオフ: 3s,6s,12s）
  // スロットルキュー設定（429回避）
  THROTTLE_CONCURRENCY: 1, // 同時実行数（1 = 直列実行）
  THROTTLE_MIN_DELAY_MS: 1000, // リクエスト間最小ディレイ（ms）
  THROTTLE_MAX_DELAY_MS: 2000, // リクエスト間最大ディレイ（ms）
} as const;

// ========================================
// セクターマスタ
// ========================================

export const SECTOR_MASTER: Record<string, readonly string[]> = {
  "半導体・電子部品": ["電気機器", "精密機器"],
  自動車: ["輸送用機器"],
  金融: ["銀行業", "証券、商品先物取引業", "保険業", "卸売業"],
  医薬品: ["医薬品"],
  "IT・サービス": ["情報・通信業", "サービス業"],
  エネルギー: ["電気・ガス業", "鉱業", "石油・石炭製品"],
  小売: ["小売業", "食料品"],
  不動産: ["不動産業", "建設業"],
  素材: [
    "化学",
    "鉄鋼",
    "非鉄金属",
    "金属製品",
    "ガラス・土石製品",
    "繊維製品",
  ],
  運輸: ["陸運業", "海運業", "空運業"],
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
// セクターリスク管理
// ========================================

export const SECTOR_RISK = {
  MAX_SAME_SECTOR_POSITIONS: 1, // 同一セクター最大保有数
  WEAK_SECTOR_THRESHOLD: -2.0, // 弱セクター判定（日経比 相対パフォーマンス%）
  NEWS_SENTIMENT_DAYS: 3, // ニュースセンチメント集約日数
} as const;

// ========================================
// ドローダウン管理
// ========================================

export const DRAWDOWN = {
  WEEKLY_HALT_PCT: 5, // 週次5%で取引停止
  MONTHLY_HALT_PCT: 10, // 月次10%で取引停止
  COOLDOWN_TRIGGER: 3, // 3連敗でクールダウン発動
  COOLDOWN_HALT_TRIGGER: 5, // 5連敗で取引停止
  COOLDOWN_MAX_POSITIONS: 1, // クールダウン中の最大ポジション数
} as const;

// ========================================
// マーケットレジーム（VIXベース）
// ========================================

export const MARKET_REGIME = {
  CRISIS: {
    // VIX > 30
    maxPositions: 0, // 取引停止
    minRank: null as null, // N/A
  },
  HIGH: {
    // VIX 25-30
    maxPositions: 1,
    minRank: "S" as const, // Sランクのみ
  },
  ELEVATED: {
    // VIX 20-25
    maxPositions: 2,
    minRank: "A" as const, // S/Aランク
  },
  NORMAL: {
    // VIX < 20
    maxPositions: 3, // 制限なし（TradingConfig準拠）
    minRank: "B" as const, // S/A/Bランク（通常通り）
  },
} as const;

// ========================================
// 戦略切り替え（市場環境ベース）
// ========================================

// VIX・CME乖離率に基づいてday_trade/swingを日単位で決定する
// オーバーナイトリスクが高い環境ではデイトレに切り替え、持ち越しを回避
export const STRATEGY_SWITCHING = {
  // VIXがこの値以上 → day_trade（オーバーナイトリスク回避）
  VIX_DAY_TRADE_THRESHOLD: 25,
  // CME先物乖離率がこの値以下 → day_trade（翌朝ギャップリスク回避）
  CME_DIVERGENCE_DAY_TRADE_THRESHOLD: -1.5,
  // デフォルト戦略（上記条件に該当しない場合）
  DEFAULT_STRATEGY: "swing" as const,
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
  MIN_PRICE: 100, // 最低株価（円）
} as const;
