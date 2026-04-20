/**
 * 立花証券 e支店 API (v4r8) 定数
 */

// ========================================
// 立花証券 API 環境設定
// ========================================

export type TachibanaEnv = "demo" | "production";

export const isTachibanaProduction =
  process.env.TACHIBANA_ENV === "production";

export const TACHIBANA_API_URLS = {
  demo: "https://demo-kabuka.e-shiten.jp/e_api_v4r8/",
  production: "https://kabuka.e-shiten.jp/e_api_v4r8/",
} as const;

// ========================================
// セッション設定
// ========================================

export const TACHIBANA_SESSION = {
  /** 自動再ログイン間隔（ミリ秒） - 6時間
   * Tachibanaの公式セッション有効期限は未確認。30分で再ログインすると電話番号認証が
   * 要求されることが判明したため、セッション切れ(sResultCode=2)検出時のreLoginOnce()に
   * 任せる方針に変更。本タイマーはあくまで保険。
   */
  AUTO_REFRESH_INTERVAL_MS: 6 * 60 * 60 * 1000,
  /** リクエストタイムアウト（ミリ秒） */
  REQUEST_TIMEOUT_MS: 30_000,
  /** ログイン承認の有効期限（ミリ秒） - 10分
   * 利用者がダッシュボードの「ログイン承認」ボタンを押してから、
   * この時間内にlogin()が実行されればそのまま通る。
   * 超過した場合は再度ボタン押下が必要。
   */
  LOGIN_ARM_TTL_MS: 10 * 60 * 1000,
} as const;

// ========================================
// API 機能ID (sCLMID)
// ========================================

export const TACHIBANA_CLMID = {
  // 認証
  LOGIN: "CLMAuthLoginRequest",
  LOGIN_ACK: "CLMAuthLoginAck",
  LOGOUT: "CLMAuthLogoutRequest",

  // 注文
  NEW_ORDER: "CLMKabuNewOrder",
  CORRECT_ORDER: "CLMKabuCorrectOrder",
  CANCEL_ORDER: "CLMKabuCancelOrder",
  CANCEL_ALL: "CLMKabuCancelOrderAll",

  // 口座・ポジション
  HOLDINGS: "CLMGenbutuKabuList",
  BUYING_POWER: "CLMZanKaiKanougaku",
  ORDER_LIST: "CLMOrderList",
  ORDER_DETAIL: "CLMOrderListDetail",
  SELL_QUANTITY: "CLMZanUriKanousuu",

  // マスタ
  EVENT_DOWNLOAD: "CLMEventDownload",

  // 時価
  MARKET_PRICE: "CLMMfdsGetMarketPrice",
  MARKET_PRICE_HISTORY: "CLMMfdsGetMarketPriceHistory",
} as const;

// ========================================
// 時価取得用カラムコード
// ========================================

/** CLMMfdsGetMarketPrice の sTargetColumn に指定するカラムコード */
export const TACHIBANA_PRICE_COLUMNS = {
  CURRENT_PRICE: "pDPP",
  OPEN: "pDOP",
  HIGH: "pDHP",
  LOW: "pDLP",
  PREVIOUS_CLOSE: "pPRP",
  VOLUME: "pDV",
  TRADING_VALUE: "pDJ",
  CHANGE: "pDYWP",
  CHANGE_PERCENT: "pDYRP",
  ASK_PRICE: "pQAP",
  BID_PRICE: "pQBP",
  ASK_SIZE: "pQAS",
  BID_SIZE: "pQBS",
  VWAP: "pVWAP",
  PRICE_TIME: "tDPP:T",
} as const;

/** クォート取得に必要なカラムの一括指定文字列 */
export const TACHIBANA_QUOTE_COLUMNS = [
  TACHIBANA_PRICE_COLUMNS.CURRENT_PRICE,
  TACHIBANA_PRICE_COLUMNS.OPEN,
  TACHIBANA_PRICE_COLUMNS.HIGH,
  TACHIBANA_PRICE_COLUMNS.LOW,
  TACHIBANA_PRICE_COLUMNS.PREVIOUS_CLOSE,
  TACHIBANA_PRICE_COLUMNS.VOLUME,
  TACHIBANA_PRICE_COLUMNS.CHANGE,
  TACHIBANA_PRICE_COLUMNS.CHANGE_PERCENT,
  TACHIBANA_PRICE_COLUMNS.ASK_PRICE,
  TACHIBANA_PRICE_COLUMNS.BID_PRICE,
  TACHIBANA_PRICE_COLUMNS.ASK_SIZE,
  TACHIBANA_PRICE_COLUMNS.BID_SIZE,
].join(",");

// ========================================
// 注文パラメータ値
// ========================================

export const TACHIBANA_ORDER = {
  /** 売買区分 */
  SIDE: {
    SELL: "1",
    BUY: "3",
  },
  /** 現金信用区分 */
  MARGIN_TYPE: {
    CASH: "0",
    MARGIN_NEW: "2",
    MARGIN_CLOSE: "4",
  },
  /** 市場コード */
  EXCHANGE: {
    TSE: "00",
  },
  /** 執行条件 */
  CONDITION: {
    NONE: "0",
    OPEN: "2",
    CLOSE: "4",
    FUNARI: "6",
  },
  /** 逆指値注文種別 */
  REVERSE_ORDER_TYPE: {
    NORMAL: "0",
    REVERSE_ONLY: "1",
    NORMAL_AND_REVERSE: "2",
  },
  /** 注文期日 */
  EXPIRE: {
    TODAY: "0",
  },
  /** 譲渡益課税区分 */
  TAX_TYPE: {
    SPECIFIC: "1",
    GENERAL: "3",
    NISA: "5",
  },
  /** 成行注文価格 */
  MARKET_PRICE: "0",
} as const;

// ========================================
// 注文ステータスコード
// ========================================

export const TACHIBANA_ORDER_STATUS = {
  NOT_RECEIVED: "0",
  UNFILLED: "1",
  PARTIAL_FILLED: "9",
  FULLY_FILLED: "10",
  CANCELLED: "7",
  EXPIRED: "12",
  WAITING_REVERSE: "13",
  SWITCHING: "15",
  SWITCHED_UNFILLED: "16",
  SUBMITTING: "50",
} as const;

// ========================================
// 注文照会フィルタ
// ========================================

export const TACHIBANA_ORDER_QUERY = {
  UNFILLED: "1",
  FULLY_FILLED: "2",
  CORRECTABLE: "4",
  UNFILLED_AND_PARTIAL: "5",
} as const;

// ========================================
// ブローカー照合（reconciliation）
// ========================================

export const BROKER_RECONCILIATION = {
  /** SL約定価格の正常範囲下限（エントリー価格に対する比率）
   * SL最大損失3%なので、-10%超の乖離はデータ異常と判定する */
  MIN_FILL_PRICE_RATIO: 0.9,
  /** 保有照合（Phase 3）を開始するJST時刻（分）
   * 9:00丁度は立花APIの保有データが未反映の可能性があるため、
   * 9:05以降から照合を開始する */
  HOLDINGS_CHECK_START_MINUTE_JST: 9 * 60 + 5, // 09:05 JST
} as const;

// ========================================
// WebSocket 接続時間帯
// ========================================

/** WebSocket接続を許可する時間帯（JST） */
export const BROKER_WS_HOURS = {
  START_HOUR: 7, // 07:00 JST（注文受付開始前の余裕）
  END_HOUR: 18, // 18:00 JST（閉局後の余裕）
} as const;
