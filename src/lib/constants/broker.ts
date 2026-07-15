/**
 * 立花証券 e支店 API (v4r9) 定数
 */

// ========================================
// 立花証券 API 環境設定
// ========================================

export type TachibanaEnv = "demo" | "production";

export const isTachibanaProduction =
  process.env.TACHIBANA_ENV === "production";

export const TACHIBANA_API_URLS = {
  demo: "https://demo-kabuka.e-shiten.jp/e_api_v4r9/",
  production: "https://kabuka.e-shiten.jp/e_api_v4r9/",
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
  /** システム混雑エラー(sResultCode=-2)時の最大リトライ回数。
   * 立花は8:00〜15:30が高負荷帯で「ただいまシステムが大変混み合っております」を
   * 返すことがある。一時的な負荷なので指数バックオフでリトライする。 */
  BUSY_RETRY_MAX: 3,
  /** システム混雑リトライのベース待機（ミリ秒）。指数バックオフ（500/1000/2000ms） */
  BUSY_RETRY_BASE_MS: 500,
} as const;

/** システム混雑（一時的なサーバー高負荷）を示す sResultCode */
export const TACHIBANA_BUSY_RESULT_CODE = "-2";

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
    /**
     * `sOrderExpireDay` に指定できる最大営業日数（立花の仕様上限）。
     * これを超える期日は指定できないため、20営業日保有する固定SL戦略の逆指値は
     * 期限内に必ず更新が入る（`.claude/rules/tachibana-api.md` / KOH-555）。
     */
    MAX_BUSINESS_DAYS: 10,
  },
  /** 譲渡益課税区分 */
  TAX_TYPE: {
    SPECIFIC: "1",
    GENERAL: "3",
    NISA: "5",
    NISA_GROWTH: "6",
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

export const BROKER_FILL_LOOKUP = {
  /** 成行注文を出してから約定確定を読むまでの試行回数。
   * 立会中の成行は即約定するため通常1回で取れる。立花の負荷ガイドライン
   * （8:00-15:30 はポーリング回避）に従い、決済1件あたりの上限をここで縛る。 */
  MAX_ATTEMPTS: 3,
  /** 試行間隔（ms）。約定反映の僅かなラグを吸収する分だけ待つ */
  RETRY_DELAY_MS: 700,
} as const;

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

// ========================================
// 発注結果サブコード（sOrderResultCode）
// ========================================

/** 発注応答のサブコード（sResultCode=0 でも sOrderResultCode にエラーが入る） */
export const TACHIBANA_ORDER_RESULT = {
  /** 只今の時間帯は受付できません（後場立会終了〜翌日注文受付開始前の受付停止窓）。
   * 引け成行約定直後の即時SL発注は必ずこの窓に入る。ensure-broker-sl が後で発注するため良性。 */
  OUTSIDE_ACCEPTANCE_HOURS: "11102",
} as const;

// ========================================
// 注文受付停止窓（大引け後〜翌日注文受付開始前）
// ========================================

/** 立花が新規注文（逆指値SL含む）を受け付けない「大引け後〜翌日注文受付開始前」の窓（JST）。
 * 後場立会終了(15:30) 〜 翌日注文受付開始(17:00) は 11102「只今の時間帯は受付できません」を返す。
 * 引け成行約定(15:30)直後の即時SL発注はこの窓に必ず入るため、ensure-broker-sl(17:00〜)に委譲する。 */
export const BROKER_ORDER_BLACKOUT = {
  START_MINUTE_JST: 15 * 60 + 30, // 15:30 後場立会終了
  END_MINUTE_JST: 17 * 60, // 17:00 翌日注文受付開始
} as const;
