/**
 * 立花証券 e支店 API (v4r8) 定数
 */

// ========================================
// ブローカーモード
// ========================================

export type BrokerMode = "simulation" | "dry_run" | "live";

export const DEFAULT_BROKER_MODE: BrokerMode = "simulation";

// ========================================
// 立花証券 API 環境設定
// ========================================

export type TachibanaEnv = "demo" | "production";

export const TACHIBANA_API_URLS = {
  demo: "https://demo-kabuka.e-shiten.jp/e_api_v4r8/",
  production: "https://kabuka.e-shiten.jp/e_api_v4r8/",
} as const;

// ========================================
// セッション設定
// ========================================

export const TACHIBANA_SESSION = {
  /** 自動再ログイン間隔（ミリ秒） - 30分 */
  AUTO_REFRESH_INTERVAL_MS: 30 * 60 * 1000,
  /** リクエストタイムアウト（ミリ秒） */
  REQUEST_TIMEOUT_MS: 30_000,
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
