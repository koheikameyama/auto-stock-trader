/**
 * アプリケーション全体で使用する定数
 */

// 銘柄管理の制限
export const MAX_PORTFOLIO_STOCKS = 100;
export const MAX_WATCHLIST_STOCKS = 100;
export const MAX_TRACKED_STOCKS = 100;

// データ取得の制限
export const MAX_PASSED_STOCKS_RETRIEVE = 20;

// ダッシュボード「注目の高評価銘柄」表示件数
export const MAX_TOP_STOCKS_DISPLAY = 10;

// 株価取得のバッチサイズ（1リクエストあたりの銘柄数）
export const STOCK_PRICE_BATCH_SIZE = 10;

// 単元株数（日本株の最小取引単位）
export const UNIT_SHARES = 100;

// 株価取得失敗の警告閾値（データ取得不可の可能性）
export const FETCH_FAIL_WARNING_THRESHOLD = 3;

// 株価データの鮮度チェック（日数）: これより古いデータは無視
export const STALE_DATA_DAYS = 14;

// チャートデータに必要な最小データポイント数
// この数未満のデータしかない銘柄はチャート表示・分析・おすすめから除外
export const MIN_CHART_DATA_POINTS = 20;

// デフォルト値
export const DEFAULT_INVESTMENT_BUDGET = 100000;

// ユーザーアクティビティ
export const USER_ACTIVITY = {
  /** バッチ処理の非アクティブ除外閾値（日数）
   * → Python: INACTIVE_THRESHOLD_DAYS */
  INACTIVE_THRESHOLD_DAYS: 7,
  /** DB更新のスロットル間隔（時間） - これより新しい場合は更新しない */
  UPDATE_THROTTLE_HOURS: 1,
} as const;

// 投資スタイル（投資戦略）
export const INVESTMENT_STYLES = {
  CONSERVATIVE: "CONSERVATIVE", // 安定配当型
  BALANCED: "BALANCED", // 成長投資型
  AGGRESSIVE: "AGGRESSIVE", // アクティブ型
} as const;

export type InvestmentStyle =
  (typeof INVESTMENT_STYLES)[keyof typeof INVESTMENT_STYLES];

// 投資スタイル別の係数（利確・損切り価格計算用）
export const INVESTMENT_STYLE_COEFFICIENTS = {
  // 損切り幅の係数（ボラティリティに乗算）
  STOP_LOSS: {
    CONSERVATIVE: 1.5, // 極めてタイト
    BALANCED: 2.5, // 標準的
    AGGRESSIVE: 4.0, // ワイド（深い）
  },
  // 利確目標の係数
  TAKE_PROFIT: {
    CONSERVATIVE: 1.0, // 早めに確定
    BALANCED: 1.5, // 標準的（リスク・リワード 1:2）
    AGGRESSIVE: 2.0, // 野心的
  },
} as const;

// ATRベース出口戦略
export const ATR_EXIT_STRATEGY = {
  // ATRが利用できない場合のフォールバック損切り率（%）
  FALLBACK_STOP_LOSS: {
    CONSERVATIVE: 5,
    BALANCED: 8,
    AGGRESSIVE: 12,
  },
  // 利確マイルストーン（%）: この利益率に達したら通知
  PROFIT_MILESTONES: [10, 20, 30],
  // 最低リスクリワード比（売却目標率 >= 撤退ライン率 × この値）
  MIN_RISK_REWARD_RATIO: 3,
  // 撤退ライン率の上限（超えたらbuy→stayに降格）
  MAX_EXIT_RATE_FOR_BUY: {
    CONSERVATIVE: 0.10,
    BALANCED: 0.15,
    AGGRESSIVE: 0.20,
  },
} as const;

// 投資スタイル別の表示設定（他の設定と形式を統一）
export const INVESTMENT_STYLE_CONFIG: Record<
  string,
  {
    text: string;
    icon: string;
    short: string;
    description: string;
    color: string;
    bg: string;
  }
> = {
  CONSERVATIVE: {
    text: "安定配当型",
    icon: "🛡️",
    short: "配当と安定性を重視",
    description:
      "高配当・割安な優良企業を中心に、安定したリターンを目指します。",
    color: "text-blue-800",
    bg: "bg-blue-100",
  },
  BALANCED: {
    text: "成長投資型",
    icon: "📈",
    short: "成長性と割安さのバランス",
    description:
      "業績が伸びている成長企業を、割安なタイミングで狙います。",
    color: "text-green-800",
    bg: "bg-green-100",
  },
  AGGRESSIVE: {
    text: "アクティブ型",
    icon: "⚡",
    short: "勢いとチャンスを重視",
    description:
      "モメンタム（勢い）のある銘柄に乗り、短期で利益を狙います。",
    color: "text-red-800",
    bg: "bg-red-100",
  },
};

// バランスシート・配当分析の閾値
export const DEBT_EQUITY_THRESHOLDS = {
  HEALTHY: 0.5, // 非常に健全
  NORMAL: 1.0, // 健全
  ELEVATED: 2.0, // やや借入多め（これ以上は注意）
} as const;

export const CURRENT_RATIO_THRESHOLDS = {
  EXCELLENT: 2.0, // 非常に良好
  GOOD: 1.5, // 良好
  MINIMUM: 1.0, // 最低限（これ以下は注意）
} as const;

export const PAYOUT_RATIO_THRESHOLDS = {
  LOW: 30, // 余裕あり
  NORMAL: 50, // 適正
  HIGH: 80, // やや高め（これ以上は減配リスク注意）
} as const;

// おすすめ候補の買い候補フィルター閾値
export const BUY_CANDIDATE_FILTER = {
  // チャート分析: 過熱判定の閾値（MA乖離率 %、安全ルールの20%より厳しめ）
  CHART_OVERHEAT_THRESHOLD: 15,
  // チャート分析: ポジティブシグナルの閾値
  POSITIVE_MOMENTUM_THRESHOLD: 0, // weekChangeRate > 0% で陽転
  OVERSOLD_THRESHOLD: -5, // maDeviationRate < -5% で押し目買い候補
  VOLUME_INTEREST_THRESHOLD: 1.5, // volumeRatio > 1.5 で注目度高
} as const;

// 投資観点別のスコアボーナス（スコアリングで使用）
export const PERSPECTIVE_BONUS = {
  // 安定配当型: 配当 + バリュー + ディフェンシブ + 財務安全性
  CONSERVATIVE: {
    HIGH_DIVIDEND: 15, // dividendYield >= 4%
    NORMAL_DIVIDEND: 8, // dividendYield >= 2%
    NO_DIVIDEND: -10, // dividendYield === 0 or null
    LOW_PBR: 12, // PBR < 1
    FAIR_PBR: 5, // PBR < 1.5
    HIGH_PBR: -8, // PBR > 3
    LOW_PER: 8, // PER < 15（割安）
    PROFITABLE: 8, // 黒字企業ボーナス
    LOW_DEBT: 8, // debtEquityRatio < 0.5（財務健全）
    HIGH_DEBT: -8, // debtEquityRatio >= 2.0（借入過多）
    HEALTHY_PAYOUT: 5, // payoutRatio < 50%（配当余力あり）
    HIGH_PAYOUT: -5, // payoutRatio >= 80%（減配リスク）
    DIVIDEND_GROWTH: 5, // dividendGrowthRate > 0（増配実績）
  },
  // 成長投資型: グロース + バリュー
  BALANCED: {
    HIGH_GROWTH: 15, // revenueGrowth >= 20%
    MODERATE_GROWTH: 8, // revenueGrowth >= 10%
    HIGH_ROE: 10, // ROE >= 15%
    GOOD_ROE: 5, // ROE >= 10%
    LOW_PBR: 8, // PBR < 1（割安成長株）
    GROWTH_PER: 5, // PER 15-30（成長企業の適正範囲）
    NEGATIVE_GROWTH: -10, // revenueGrowth < 0%
  },
  // アクティブ型: モメンタム + グロース
  AGGRESSIVE: {
    HIGH_GROWTH: 10, // revenueGrowth >= 20%
    MODERATE_GROWTH: 5, // revenueGrowth >= 10%
  },
} as const;

/**
 * 投資スタイルに応じた基本ラベル ("安定配当型" 等) を取得します。
 */
export function getStyleLabel(style: string | null): string {
  return (
    INVESTMENT_STYLE_CONFIG[style as keyof typeof INVESTMENT_STYLE_CONFIG]
      ?.text || "成長投資型"
  );
}

/**
 * 投資スタイルに応じたリッチラベル ("🛡️ 安定配当型" 等) を取得します。
 */
export function getRichStyleLabel(style: string | null): string {
  const config =
    INVESTMENT_STYLE_CONFIG[style as keyof typeof INVESTMENT_STYLE_CONFIG] ||
    INVESTMENT_STYLE_CONFIG.BALANCED;
  return `${config.icon} ${config.text}`;
}

/**
 * 投資スタイルに応じたプロンプト用ラベル ("安定配当型 - 配当と安定性を重視" 等) を取得します。
 */
export function getPromptStyleLabel(style: string | null): string {
  const config =
    INVESTMENT_STYLE_CONFIG[style as keyof typeof INVESTMENT_STYLE_CONFIG] ||
    INVESTMENT_STYLE_CONFIG.BALANCED;
  return `${config.text} - ${config.short}`;
}

// テクニカル指標の閾値
export const RSI_THRESHOLDS = {
  OVERBOUGHT: 70,
  SLIGHTLY_OVERBOUGHT: 60,
  OVERSOLD: 30,
  SLIGHTLY_OVERSOLD: 40,
} as const;

export const MACD_THRESHOLDS = {
  STRONG_UPTREND: 1,
  UPTREND: 0,
  STRONG_DOWNTREND: -1,
} as const;

// 財務指標の閾値
export const MARKET_CAP_THRESHOLDS = {
  LARGE: 10000, // 10兆円以上
  MEDIUM: 1000, // 1000億円以上
} as const;

export const DIVIDEND_THRESHOLDS = {
  HIGH: 4, // 4%以上
  NORMAL: 2, // 2%以上
} as const;

export const PBR_THRESHOLDS = {
  FAIR_VALUE: 1, // 1未満 = 割安
  SLIGHTLY_HIGH: 1.5, // 1.5未満 = 適正
} as const;

// ポートフォリオ分析の閾値
export const PORTFOLIO_ANALYSIS = {
  // 購入直後の猶予期間（日数）: この期間中は売り推奨を抑制
  RECENT_PURCHASE_DAYS: 3,
  // 猶予期間中でも警告する含み損の閾値（%）
  FORCE_SELL_LOSS_THRESHOLD: -15,
} as const;

// OpenAI設定
export const OPENAI_CONFIG = {
  MODEL: "gpt-4o-mini",
  TEMPERATURE: 0.7,
  MAX_TOKENS_ANALYSIS: 600,
  MAX_TOKENS_RECOMMENDATION: 500,
} as const;

// Daily Market Navigator 設定
export const DAILY_MARKET_NAVIGATOR = {
  // 分析に必要な最小銘柄数（ポートフォリオ＋ウォッチリスト合計）
  MIN_STOCKS: 0,
  OPENAI_MODEL: "gpt-4o-mini",
  OPENAI_TEMPERATURE: 0.3,
  // 夜セッション開始時間（JST）: この時間以降は evening セッション
  EVENING_SESSION_START_HOUR: 15,
  // AIプロンプトに含めるセクタートレンドの最大数
  MAX_SECTOR_TRENDS_FOR_AI: 10,
} as const;

// チャットAI設定
export const CHAT_CONFIG = {
  MAX_STEPS: 5, // ツール呼び出しの最大ステップ数
  MODEL: "gpt-4o-mini",
  TEMPERATURE: 0.7,
  MAX_TOKENS: 3000,
} as const;

// 購入判断の表示モード判定用
// 取引時間中（09:30-15:30）は actionable、それ以外は informational
export const PURCHASE_RECOMMENDATION_SESSION = {
  ACTIONABLE_START_HOUR: 9,
  ACTIONABLE_START_MINUTE: 30,
  ACTIONABLE_END_HOUR: 15,
  ACTIONABLE_END_MINUTE: 30,
} as const;

// AI分析の更新スケジュール（平日のみ、session-batch.yml で一括実行）
export const UPDATE_SCHEDULES = {
  // あなたへのおすすめ（session-personal-recommendations.yml）
  PERSONAL_RECOMMENDATIONS: "9:30 / 13:00 / 15:40",
  // ポートフォリオ分析・購入レコメンド（session-batch.yml）
  STOCK_ANALYSIS: "9:30 / 10:30 / 13:00 / 14:00 / 15:40",
} as const;

// キャッシュTTL（ミリ秒）
export const CACHE_TTL = {
  USER_STOCKS: 5 * 60 * 1000, // 5分
  TRACKED_STOCKS: 5 * 60 * 1000, // 5分
  SOLD_STOCKS: 5 * 60 * 1000, // 5分
  STOCK_PRICES: 30 * 1000, // 30秒
  PORTFOLIO_SUMMARY: 2 * 60 * 1000, // 2分
} as const;

// 市場指標の閾値
export const MARKET_INDEX = {
  CRASH_THRESHOLD: -5, // 急落判定（週間変化率%）
  UP_TREND_THRESHOLD: 3, // 上昇トレンド判定（週間変化率%）
  DOWN_TREND_THRESHOLD: -3, // 下落トレンド判定（週間変化率%）
  PANIC_THRESHOLD: -7, // パニック閾値（週間-7%以下で防御モード発動）
} as const;

// 市場パニック時の防御モード
// 日経平均の週間変化率がPANIC_THRESHOLDを下回った場合、
// 全スタイルの閾値を引き締めて慎重な判断に切り替える
export const MARKET_DEFENSIVE_MODE = {
  SURGE_TIGHTENING_FACTOR: 0.7, // 急騰閾値を70%に引き締め
  DECLINE_LOOSENING_FACTOR: 0.7, // 下落閾値を70%に引き締め（絶対値）
  CONFIDENCE_REDUCTION: 0.1, // 全体confidence低下
  OVERHEAT_TIGHTENING_FACTOR: 0.75, // 過熱閾値を75%に引き締め
  GAP_UP_TIGHTENING_FACTOR: 0.7, // ギャップアップ閾値を70%に引き締め
  SCORE_PENALTY: -10, // おすすめスコアリングの一律ペナルティ
} as const;

// バッジ表示設定
// 各種ステータスの英語キーから表示テキスト・色を一元管理

// ポートフォリオ個別銘柄ステータス
// ポートフォリオ推奨アクション表示設定（recommendationベース）
export const PORTFOLIO_RECOMMENDATION_CONFIG: Record<
  string,
  {
    text: string;
    color: string;
    bg: string;
  }
> = {
  buy: { text: "買い推奨", color: "text-green-700", bg: "bg-green-50" },
  hold: { text: "ホールド", color: "text-blue-700", bg: "bg-blue-50" },
  sell: { text: "売却検討", color: "text-red-700", bg: "bg-red-50" },
};

// ウォッチリスト購入判断
export const PURCHASE_JUDGMENT_CONFIG: Record<
  string,
  {
    text: string;
    color: string;
    bg: string;
  }
> = {
  buy: { text: "買い推奨", color: "text-green-700", bg: "bg-green-50" },
  stay: { text: "様子見", color: "text-blue-700", bg: "bg-blue-50" },
  avoid: { text: "見送り推奨", color: "text-red-700", bg: "bg-red-50" },
};


// 指標評価バッジ
export const EVALUATION_BADGE_CONFIG: Record<
  string,
  {
    color: string;
    bg: string;
  }
> = {
  good: { color: "text-green-700", bg: "bg-green-100" },
  neutral: { color: "text-gray-700", bg: "bg-gray-100" },
  warning: { color: "text-yellow-700", bg: "bg-yellow-100" },
};

// 投資テーマバッジ（おすすめの根拠）
export const INVESTMENT_THEME_CONFIG: Record<
  string,
  {
    text: string;
    color: string;
    bg: string;
    icon: string;
  }
> = {
  短期成長: {
    text: "短期成長",
    color: "text-orange-700",
    bg: "bg-orange-50",
    icon: "🚀",
  },
  中長期安定成長: {
    text: "中長期安定成長",
    color: "text-blue-700",
    bg: "bg-blue-50",
    icon: "📈",
  },
  高配当: {
    text: "高配当",
    color: "text-emerald-700",
    bg: "bg-emerald-50",
    icon: "💰",
  },
  割安反発: {
    text: "割安反発",
    color: "text-purple-700",
    bg: "bg-purple-50",
    icon: "💎",
  },
  テクニカル好転: {
    text: "テクニカル好転",
    color: "text-cyan-700",
    bg: "bg-cyan-50",
    icon: "📊",
  },
  安定ディフェンシブ: {
    text: "安定ディフェンシブ",
    color: "text-teal-700",
    bg: "bg-teal-50",
    icon: "🛡️",
  },
};

// 投資テーマのenumリスト（AI生成用）
export const INVESTMENT_THEMES = Object.keys(INVESTMENT_THEME_CONFIG);

// 市場シグナルバッジ
export const MARKET_SIGNAL_CONFIG: Record<
  string,
  {
    text: string;
    color: string;
    bg: string;
    icon: string;
  }
> = {
  bullish: {
    text: "上昇優勢",
    color: "text-green-700",
    bg: "bg-green-100",
    icon: "↑",
  },
  neutral: {
    text: "横ばい",
    color: "text-gray-600",
    bg: "bg-gray-100",
    icon: "→",
  },
  bearish: {
    text: "下落優勢",
    color: "text-red-700",
    bg: "bg-red-100",
    icon: "↓",
  },
};

// トレンドライン検出の閾値
export const TRENDLINE = {
  MIN_DATA_POINTS: 15, // 検出に必要な最小データ点数
  WINDOW_SIZE: 3, // ローカル極値検出のウィンドウサイズ
  TOUCH_TOLERANCE: 0.02, // トレンドラインへの「接触」許容幅（2%）
  MAX_VIOLATION_RATIO: 0.15, // 許容する逸脱点の比率（15%以下）
  MIN_TOUCHES: 2, // 有効なトレンドラインの最小接触回数
  SIGNIFICANT_SLOPE: 0.001, // 上昇/下降判定の傾き閾値
  MIN_SPAN_RATIO: 0.3, // トレンドラインの最小スパン比率（全データの30%以上）
} as const;

// 移動平均乖離率の閾値
export const MA_DEVIATION = {
  PERIOD: 25, // 短期移動平均の期間（日）
  LONG_PERIOD: 75, // 長期移動平均の期間（日）
  FETCH_PERIOD: "3m" as const, // SMA25計算に必要な取得期間
  FETCH_SLICE: 60, // 取得データから使用する件数
  UPPER_THRESHOLD: 20, // 上方乖離の閾値（%）
  LOWER_THRESHOLD: -20, // 下方乖離の閾値（%）
  CONFIDENCE_PENALTY: -0.15, // 上方乖離時のconfidenceペナルティ
  CONFIDENCE_BONUS: 0.1, // 下方乖離時のconfidenceボーナス
  SCORE_PENALTY: -20, // 日次おすすめのスコアペナルティ
  SCORE_BONUS: 10, // 日次おすすめのスコアボーナス
  LOW_VOLATILITY_THRESHOLD: 30, // 低ボラティリティの閾値（%）
  DIP_BUY_THRESHOLD: 5, // 乖離率(%)がこれを超えたら押し目買い推奨
  RSI_OVERBOUGHT_THRESHOLD: 70, // RSIがこれを超えたら押し目買い推奨
  EXTREME_UPPER_THRESHOLD: 50, // skipSafetyRulesでもブロックする極端な上方乖離（%）
  DIP_ATR_MULTIPLIER: 1.0, // 押し目買い目安: currentPrice - ATR14 × この倍率
  // ATRがない場合のフォールバック: volatility / 2 をベースに、上下限でクランプ
  DIP_PRICE_VOLATILITY_FACTOR: 0.5, // ボラティリティに掛ける係数（volatility * factor / 100 = 下落率）
  DIP_PRICE_MIN_RATE: 0.02, // 最小フォールバック率（2%）
  DIP_PRICE_MAX_RATE: 0.15, // 最大フォールバック率（15%）
  DIP_PRICE_DEFAULT_RATE: 0.05, // ボラティリティ不明時のデフォルト率（5%）
} as const;

// トレンドねじれ（Divergence）検出の閾値
export const TREND_DIVERGENCE = {
  // パターン1: 上昇中の下落予測（スピード調整）
  SPEED_CORRECTION_RSI: 65, // RSI > 65 で過熱判定
  SPEED_CORRECTION_DEVIATION: 5, // 乖離率 > +5% で過熱判定
  // パターン2: 下落中の上昇予測（リバウンド警戒）
  REBOUND_WARNING_RSI: 35, // RSI < 35 で売られすぎ判定
} as const;

// モメンタム（トレンドフォロー）の閾値
export const MOMENTUM = {
  // 下落トレンド検出（週間変化率 %）: これ以下で buy → stay
  // 投資スタイル別の閾値
  CONSERVATIVE_DECLINE_THRESHOLD: -10, // 安定配当型: -10% で下落判定（タイト）
  BALANCED_DECLINE_THRESHOLD: -15, // バランス: -15% で下落判定（標準）
  AGGRESSIVE_DECLINE_THRESHOLD: -20, // アクティブ型: -20% で下落判定（寛容）
  DEFAULT_DECLINE_THRESHOLD: -15, // 投資スタイル未設定時のデフォルト
  DECLINE_CONFIDENCE_PENALTY: -0.1, // 下落トレンド時のconfidenceペナルティ
  // 急騰銘柄ルールの投資スタイル別閾値（週間変化率 %）: これ以上で buy → stay
  CONSERVATIVE_SURGE_THRESHOLD: 20, // 安定配当型: +20% 以上でブロック（タイト）
  BALANCED_SURGE_THRESHOLD: 25, // バランス: +25% 以上でブロック（標準）
  AGGRESSIVE_SURGE_THRESHOLD: 50, // アクティブ型: +50% 以上でブロック
  DEFAULT_SURGE_THRESHOLD: 25, // 投資スタイル未設定時のデフォルト
  // 赤字×急騰銘柄の閾値（週間変化率 %）: 赤字銘柄がこれ以上急騰で buy → stay
  UNPROFITABLE_SURGE_THRESHOLD: 20, // 赤字企業の急騰は+20%からブロック
  // 過熱圏ルール: アクティブ型は無効化
  AGGRESSIVE_SKIP_OVERHEAT: true, // アクティブ型: 過熱圏ルールをスキップ
  EXTREME_SURGE_THRESHOLD: 50, // skipSafetyRulesでもブロックする極端な急騰（%）
  // おすすめスコアリング用ペナルティ
  DECLINE_SCORE_PENALTY: -15, // 下落銘柄のスコアペナルティ
  STRONG_DECLINE_SCORE_PENALTY: -25, // 強い下落銘柄のスコアペナルティ
} as const;

// 利益確定促進ルール（含み益 + 短期下落予兆 → 利確を促す）
export const PROFIT_TAKING_PROMOTION = {
  // 利確促進の最低含み益率（%）: これ以上で短期下落予兆がある場合に利確を促す
  CONSERVATIVE_MIN_PROFIT: 5, // 安定配当型: +5%以上で利確検討
  BALANCED_MIN_PROFIT: 8, // 成長投資型: +8%以上で利確検討
  AGGRESSIVE_MIN_PROFIT: 15, // アクティブ型: +15%以上で一部利確検討（大きな利益を守る）
  // 推奨売却割合
  CONSERVATIVE_SELL_PERCENT: 75 as 25 | 50 | 75 | 100,
  BALANCED_SELL_PERCENT: 50 as 25 | 50 | 75 | 100,
  AGGRESSIVE_SELL_PERCENT: 25 as 25 | 50 | 75 | 100, // 残りで上値追い継続
} as const;

// 売りタイミング判断の閾値
export const SELL_TIMING = {
  DEVIATION_LOWER_THRESHOLD: -5, // 乖離率がこれ未満で戻り売り推奨
  RSI_OVERSOLD_THRESHOLD: 30, // RSIがこれ未満で戻り売り推奨
  // パニック売り防止閾値（スタイル別）
  // null = 無効化（損切り優先）、数値 = 乖離率がこれ以下でsell→hold強制補正
  PANIC_SELL_THRESHOLD: {
    CONSERVATIVE: null, // 安定配当型: 無効化（損切り優先）
    BALANCED: -25, // 成長投資型: やや深めに設定
    AGGRESSIVE: -20, // アクティブ型: 現状維持（リバウンド狙い）
  } as Record<string, number | null>,
  PROFIT_TAKING_THRESHOLD: 10, // 利益率(%)がこれ以上で利確優先
  STOP_LOSS_THRESHOLD: -15, // 損失率(%)がこれ以下で損切り優先
  NEAR_AVERAGE_PRICE_THRESHOLD: 5, // 平均購入価格から+5%以内は「平均価格に近い」とみなす（指値提案）
  TREND_OVERRIDE_LOSS_THRESHOLD: -15, // 中長期トレンド保護を無視する損失閾値(%)
  SELL_PRICE_PROXIMITY_THRESHOLD: 0.02, // 売却目標近接の閾値（比率）
  REBOUND_ATR_MULTIPLIER: 1.0, // 戻り売り目安: currentPrice + ATR14 × この倍率
} as const;

// avoid判定のconfidence閾値（投資スタイル別）
// AIが avoid を出した場合、confidence がこの閾値未満なら stay に逆補正される
export const AVOID_CONFIDENCE_THRESHOLD: Record<string, number> = {
  CONSERVATIVE: 0.6, // 安全重視 → avoid が出やすい
  BALANCED: 0.65,
  AGGRESSIVE: 0.75, // リスク許容 → avoid が出にくい
};

// stay → avoid 強制補正の閾値（投資スタイル別）
export const AVOID_ESCALATION = {
  // 条件1: 赤字 + 減益トレンド + 週間変化率が閾値以下
  UNPROFITABLE_DECLINE: {
    CONSERVATIVE: -3,
    BALANCED: -5,
    AGGRESSIVE: -10,
  } as Record<string, number>,
  // 条件2: テクニカル売りシグナル強度が閾値以上 + 中期予測down
  TECHNICAL_FULL_NEGATIVE: {
    CONSERVATIVE: 60,
    BALANCED: 70,
    AGGRESSIVE: 85,
  } as Record<string, number>,
  // 条件3: MA乖離率が閾値以下 + 週間変化率マイナス（反発の兆候なし）
  PROLONGED_DECLINE_DEVIATION: {
    CONSERVATIVE: -8,
    BALANCED: -12,
    AGGRESSIVE: -18,
  } as Record<string, number>,
} as const;

// スタイル間合意度によるconfidence補正
export const CROSS_STYLE_CONSENSUS = {
  // 買い推奨スタイル数に応じたconfidenceペナルティ
  SOLO_BUY_PENALTY: -0.15, // 1/3のみbuy（根拠が弱い）
  PARTIAL_BUY_PENALTY: -0.05, // 2/3がbuy（やや弱い）
  // ペナルティ適用後のconfidence閾値（これ未満でbuy→stay）
  MIN_BUY_CONFIDENCE: 0.6,
} as const;

// 出来高分析の閾値（下落日 vs 上昇日の出来高比較）
export const VOLUME_ANALYSIS = {
  ANALYSIS_DAYS: 10, // 分析対象の直近日数
  // 下落日出来高 / 上昇日出来高 の比率
  DISTRIBUTION_THRESHOLD: 1.5, // これ以上 → 分配売り（構造的な下落シグナル）
  ACCUMULATION_THRESHOLD: 0.7, // これ以下 → 出来高を伴わない調整（一時的な下落シグナル）
} as const;

// タイミング補助指標の閾値
export const TIMING_INDICATORS = {
  // ギャップアップ率の閾値（投資スタイル別）
  GAP_UP_SURGE_THRESHOLD: 10, // デフォルト（後方互換性のため残す）
  GAP_UP_SURGE_CONSERVATIVE: 10, // 安定配当型: 10%以上でブロック
  GAP_UP_SURGE_BALANCED: 15, // 成長投資型: 15%以上でブロック
  GAP_UP_SURGE_AGGRESSIVE: 20, // アクティブ型: 20%以上でブロック
  GAP_UP_WARNING_THRESHOLD: 5, // これ以上でAIに警告指示
  // 出来高急増率の閾値
  VOLUME_SPIKE_EXTREME_THRESHOLD: 5.0, // 異常な出来高（仕手株リスク判定用）
  VOLUME_SPIKE_HIGH_THRESHOLD: 2.0, // AIに材料確認を指示する閾値
  VOLUME_SPIKE_NOTABLE_THRESHOLD: 1.5, // 注目度上昇の目安
  // 売買代金フォーマット
  TURNOVER_OKU_THRESHOLD: 100_000_000, // 1億円（億円単位表示の閾値）
} as const;

// アクティブ型リバウンド狙いロジック
// 安定配当型・成長投資型がstayでも、引けにかけて強い/出来高が伴う銘柄は
// アクティブ型のみ短期リバウンド狙いでbuyに昇格する
export const AGGRESSIVE_REBOUND = {
  // 引けにかけて強い判定の閾値（ローソク足分析の強度%）
  CLOSING_STRENGTH_THRESHOLD: 55,
  // 出来高を伴う判定の閾値（20日平均比の倍率）
  VOLUME_SPIKE_THRESHOLD: 1.5,
  // リバウンド判定時のconfidence
  REBOUND_CONFIDENCE: 0.60,
  // 出来高+引け強い両方が揃った場合のconfidence
  REBOUND_CONFIDENCE_WITH_VOLUME: 0.65,
  // 既にbuyのアクティブ型に対する引け強い/出来高ありのconfidenceブースト
  CONFIDENCE_BOOST: 0.05,
} as const;

// ギャップアップモメンタムシグナル（アクティブ型向け）
// 小幅ギャップアップ + 引け強い + 出来高 → 正のモメンタムシグナル
export const GAP_UP_MOMENTUM = {
  MIN_GAP_UP: 2, // 正シグナルの最小ギャップ率(%)
  MAX_GAP_UP: 5, // 正シグナルの最大ギャップ率(%)
  CLOSING_STRENGTH_THRESHOLD: 70, // 引け強い判定(%) - (close-low)/(high-low)*100
  VOLUME_CONFIRMATION_THRESHOLD: 1.3, // 出来高確認閾値(倍)
  CONFIDENCE_BOOST: 0.08, // 3条件揃った時のconfidenceブースト
} as const;

// テクニカルブレーキの閾値（投資スタイル別）
// combinedTechnical.strength がこの値以上で buy → stay
export const TECHNICAL_BRAKE = {
  CONSERVATIVE: 70, // 安定配当型: 70%以上の売りシグナルでブロック
  BALANCED: 75, // 成長投資型: 75%以上でブロック
  AGGRESSIVE: 85, // アクティブ型: 85%以上でブロック（逆張り許容）
} as const;

// 相対強度分析の閾値（銘柄 vs 市場/セクター）
export const RELATIVE_STRENGTH = {
  // 銘柄変化率 - 市場変化率（%）: これ以上でアウトパフォーム
  OUTPERFORM_THRESHOLD: 3,
  // 銘柄変化率 - 市場変化率（%）: これ以下でアンダーパフォーム
  UNDERPERFORM_THRESHOLD: -3,
  // 下落局面でアウトパフォームしている場合、sellをholdに戻す閾値
  OUTPERFORM_SELL_PROTECTION: 5,
} as const;

// セクタートレンド分析の閾値・重み
export const SECTOR_TREND = {
  UP_THRESHOLD: 20, // compositeScore >= 20 → "up"
  DOWN_THRESHOLD: -20, // compositeScore <= -20 → "down"
  US_INFLUENCE_WEIGHT: 0.7, // US→JPの影響度係数
  // 総合スコアの重み配分
  NEWS_WEIGHT: 0.4, // ニューススコアの重み
  PRICE_WEIGHT: 0.4, // 株価モメンタムの重み
  VOLUME_WEIGHT: 0.2, // 出来高スコアの重み
  // スケーリング用キャップ
  PRICE_CLAMP: 10, // weekChangeRate のキャップ（±%）
  VOLUME_CLAMP: 1, // volumeRatio - 1.0 のキャップ（±）
  // 強弱閾値
  STRONG_UP_THRESHOLD: 40, // 強い追い風の閾値
  STRONG_DOWN_THRESHOLD: -40, // 強い逆風の閾値
  // おすすめスコアリングへの連続ボーナス（閾値ベース → 連続関数）
  SCORE_CONTINUOUS_FACTOR: 0.25, // compositeScore × factor = 連続ボーナス
  SCORE_CONTINUOUS_CLAMP: 50, // compositeScore を ±50 にクランプ
  // セクター順位ボーナス（compositeScore 降順: 1位→11位）
  RANK_BONUSES: [6, 4, 2, 0, 0, 0, 0, 0, -2, -4, -6] as readonly number[],
} as const;

// 決算発表日バッジの閾値（日数）
export const EARNINGS_DATE_BADGE = {
  URGENT_DAYS: 3, // 3日以内: 赤
  WARNING_DAYS: 7, // 7日以内: 黄
  INFO_DAYS: 14, // 14日以内: グレー（14日超は非表示）
} as const;

// 決算・配当権利落ちのセーフティルール
export const EARNINGS_SAFETY = {
  PRE_EARNINGS_BLOCK_DAYS: 3, // 決算3日前から買いブロック
  EARNINGS_NEAR_WARNING_DAYS: 7, // 7日前から警告
  EARNINGS_NEAR_CONFIDENCE_PENALTY: -0.1, // 決算近接時のconfidenceペナルティ
  POST_EX_DIVIDEND_DAYS: 3, // 権利落ち後3日間は配当落ち保護
} as const;

/**
 * セクターマスタ
 * - key: セクターグループ名（UIフィルター、ニュース分類、セクタートレンドで使用）
 * - value: 対応する東証業種分類の配列（Stock.sectorとのマッチングに使用）
 */
export const SECTOR_MASTER: Record<string, readonly string[]> = {
  "半導体・電子部品": ["電気機器", "精密機器"],
  "自動車": ["輸送用機器"],
  "金融": ["銀行業", "証券、商品先物取引業", "保険業", "卸売業"],
  "医薬品": ["医薬品"],
  "IT・サービス": ["情報・通信業", "サービス業"],
  "エネルギー": ["電気・ガス業", "鉱業", "石油・石炭製品"],
  "小売": ["小売業", "食料品"],
  "不動産": ["不動産業", "建設業"],
  "素材": ["化学", "鉄鋼", "非鉄金属", "金属製品", "ガラス・土石製品", "繊維製品"],
  "運輸": ["陸運業", "海運業", "空運業"],
  "その他": ["その他製品"],
};

// UIフィルター用のセクターリスト（マスタから自動生成）
export const SECTORS = Object.keys(SECTOR_MASTER);

// TSE業種 → セクターグループの逆引きマップ
export const TSE_TO_SECTOR: Record<string, string> = Object.entries(SECTOR_MASTER).reduce(
  (acc, [group, industries]) => {
    for (const industry of industries) {
      acc[industry] = group;
    }
    return acc;
  },
  {} as Record<string, string>,
);

/** Stock.sector（東証業種分類）からセクターグループ名を取得 */
export function getSectorGroup(tseSector: string | null): string | null {
  if (!tseSector) return null;
  return TSE_TO_SECTOR[tseSector] ?? null;
}

/** セクターグループ名から東証業種分類の配列を取得 */
export function getTseIndustries(sectorGroup: string): string[] {
  return [...(SECTOR_MASTER[sectorGroup] ?? [])];
}

// ベンチマーク比較指標の閾値
export const BENCHMARK_METRICS = {
  // 計算に必要な最小スナップショット日数
  MIN_DATA_POINTS: 30,
  // 無リスク金利（年率%）: 日本10年国債利回り近似
  RISK_FREE_RATE_ANNUAL: 0.5,
  // 超過リターンの評価
  EXCESS_RETURN_GOOD: 3, // +3%以上で良好
  EXCESS_RETURN_BAD: -3, // -3%以下で注意
  // ベータ値の評価
  BETA_STABLE: 0.5, // 安定型
  BETA_BALANCED: 1.0, // 成長投資型
  BETA_AGGRESSIVE: 1.5, // 積極型
  // シャープレシオの評価
  SHARPE_EXCELLENT: 1.0, // 優秀
  SHARPE_FAIR: 0.5, // 普通
} as const;

// ギャップ予測（寄り付きギャップ推定）
export const GAP_PREDICTION = {
  // 市場全体ギャップ推定の重み
  NIKKEI_FUTURES_WEIGHT: 0.50,
  SP500_WEIGHT: 0.25,
  NASDAQ_WEIGHT: 0.15,
  USDJPY_WEIGHT: 0.10,
  // 為替影響係数（1%の円安→約0.3%プラス影響）
  USDJPY_IMPACT_FACTOR: 0.3,
  // ベータ近似のクランプ
  BETA_MIN: 0.3,
  BETA_MAX: 3.0,
  // severity判定閾値（|gapRate| %）
  HIGH_SEVERITY_THRESHOLD: 2.0,
  MEDIUM_SEVERITY_THRESHOLD: 0.8,
  // セクター別NASDAQ重み上乗せ（セクターグループ名で定義）
  SECTOR_NASDAQ_BONUS: {
    "半導体・電子部品": 0.15,
    "IT・サービス": 0.10,
    "自動車": 0.05,
    "不動産": -0.05,
  } as Record<string, number>,
  // セクター別為替感応度（セクターグループ名で定義）
  SECTOR_FX_SENSITIVITY: {
    "半導体・電子部品": 1.5,
    "自動車": 1.5,
    "IT・サービス": 1.0,
    "素材": 1.2,
    "医薬品": 1.0,
    "エネルギー": 1.0,
    "金融": 0.5,
    "小売": 0.3,
    "不動産": 0.3,
  } as Record<string, number>,
} as const;

// ギャップ予測の表示設定（マイ株ページ）
export const GAP_PREDICTION_DISPLAY = {
  START_HOUR: 7,   // 表示開始（JST）
  END_HOUR: 15,    // 表示終了（JST）
  MARKET_OPEN_HOUR: 9,  // 寄り付き判定
} as const;

// CME日経先物の取引時間（JST基準）
// CME Nikkei futures: 月曜07:00 JST ～ 土曜06:00 JST（ほぼ24時間）
// 日次休憩: 毎日06:00～07:00 JST
export const CME_TRADING_HOURS = {
  DAILY_BREAK_START_HOUR_JST: 6,
  DAILY_BREAK_END_HOUR_JST: 7,
  WEEK_START_DAY: 1, // 月曜日
  WEEK_END_DAY: 6,   // 土曜日
  WEEK_END_HOUR_JST: 6,
} as const;

// 先物と現物の乖離率シグナル
export const FUTURES_DIVERGENCE = {
  // 乖離率の閾値（パーセントポイント）
  BULLISH_THRESHOLD: 0.3,
  BEARISH_THRESHOLD: -0.3,
  STRONG_BULLISH_THRESHOLD: 1.0,
  STRONG_BEARISH_THRESHOLD: -1.0,
} as const;

// 地政学リスク指標の閾値
export const GEOPOLITICAL_RISK = {
  // VIX（恐怖指数）の閾値
  VIX_HIGH: 30,
  VIX_ELEVATED: 25,
  VIX_NORMAL: 20,

  // VIXの急変動閾値（前日比%）
  VIX_SPIKE_THRESHOLD: 20,

  // WTI原油の急変動閾値（前日比%）
  WTI_SPIKE_THRESHOLD: 5,
  WTI_CRASH_THRESHOLD: -5,
} as const;
