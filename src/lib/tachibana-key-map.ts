/**
 * 立花証券 API レスポンスの数値キー → 名前付きキー変換
 *
 * APIレスポンスはデフォルトで数値キー（"287", "872" 等）を使用する。
 * このモジュールで名前付きキーに変換する。
 */

/** 数値キー → 名前付きキーのマッピング */
const NUMERIC_KEY_MAP: Record<string, string> = {
  // 共通
  "287": "sResultCode",
  "286": "sResultText",
  "334": "sCLMID",

  // ログインレスポンス
  "872": "sUrlRequest",
  "870": "sUrlMaster",
  "871": "sUrlPrice",
  "868": "sUrlEvent",
  "869": "sUrlEventWebSocket",
  "744": "sSummaryGenkabuKaituke",
  "549": "sLastLoginDate",
  "552": "sKinsyouhouMidokuFlg",

  // 注文レスポンス（共通）
  "688": "sOrderResultCode",   // サブ結果コード（"0"以外はエラー）
  "689": "sOrderResultText",   // サブ結果テキスト

  // 注文レスポンス（CLMKabuNewOrder - 実測キー）
  "643": "sOrderNumber",        // 新規注文レスポンスで確認済み
  "370": "sEigyouDay",          // 新規注文レスポンスで確認済み
  "660": "sOrderTesuryou",      // 新規注文レスポンスで確認済み
  "669": "sOrderSyouhizei",     // 新規注文レスポンスで確認済み

  // 注文レスポンス（注文一覧・詳細 - APIドキュメント記載キー、実測未確認）
  "532": "sOrderNumber",
  "405": "sEigyouDay",
  "540": "sOrderSuryou",
  "537": "sOrderPrice",
  "543": "sOrderTesuryou",
  "544": "sOrderSyouhizei",
  "542": "sOrderStatus",
  "531": "sOrderIssueCode",
  "534": "sOrderCondition",
  "533": "sOrderBaibaiKubun",
  "541": "sOrderSizyouC",

  // 注文一覧・詳細 - 実測キー (CLMOrderList / CLMOrderListDetail)
  "378": "sOrderOrderNumber",    // 注文番号
  "656": "sOrderStatus",         // 注文状態テキスト（"全部約定" 等）※"542" はドキュメント記載
  "657": "sOrderStatusCode",     // 注文状態コード（"10" = FULLY_FILLED）
  "96":  "aYakuzyouSikkouList",  // 約定執行リスト
  "878": "sYakuzyouPrice",       // 約定価格（実測: デモAPI 9984で878=¥4626, 879=100を確認）
  "879": "sYakuzyouSuryou",      // 約定株数（実測: 同上。95a39a6fで逆にされていたが誤りだった）

  // 現物保有銘柄
  "859": "sUriOrderIssueCode",
  "863": "sUriOrderZanKabuSuryou",
  "860": "sUriOrderUritukeKanouSuryou",
  "854": "sUriOrderGaisanBokaTanka",
  "858": "sUriOrderHyoukaTanka",
  "857": "sUriOrderGaisanHyoukagaku",
  "855": "sUriOrderGaisanHyoukaSoneki",

  // 買余力
  "746": "sSummaryNseityouTousiKanougaku",
  "451": "sHusokukinHasseiFlg",

  // 時価情報 (CLMMfdsGetMarketPrice)
  "71": "aMarketPriceList",
  "473": "sTargetIssueCode",
  "115": "pCurrentPrice",     // pDPP - 現在値
  "112": "pOpenPrice",        // pDOP - 始値
  "106": "pHighPrice",        // pDHP - 高値
  "110": "pLowPrice",         // pDLP - 安値
  "181": "pPreviousClose",    // pPRP - 前日終値
  "117": "pVolume",           // pDV  - 出来高
  "108": "pTradingValue",     // pDJ  - 売買代金
  "120": "pChange",           // pDYWP - 前日比
  "119": "pChangePercent",    // pDYRP - 前日比率(%)
  "182": "pAskPrice",         // pQAP - 売気配値
  "184": "pBidPrice",         // pQBP - 買気配値
  "183": "pAskSize",          // pQAS - 売気配数量
  "185": "pBidSize",          // pQBS - 買気配数量
  "213": "pVWAP",             // pVWAP
  "938": "tPriceTime",        // tDPP:T - 約定時刻
  "105": "pHighFlag",         // pDHF
  "109": "pLowFlag",          // pDLF
  "114": "pPriceFlag",        // pDPG
};

/** 配列キーのマッピング */
const ARRAY_KEY_MAP: Record<string, string> = {
  aGenbutuKabuList: "aGenbutuKabuList",
  aOrderList: "aOrderList",
  aYakuzyouSikkouList: "aYakuzyouSikkouList",
};

/**
 * APIレスポンスオブジェクトの数値キーを名前付きキーに変換
 *
 * @param data - APIレスポンスオブジェクト（数値キー）
 * @returns 名前付きキーに変換されたオブジェクト
 */
export function mapNumericKeys(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const mappedKey = NUMERIC_KEY_MAP[key] ?? ARRAY_KEY_MAP[key] ?? key;

    if (Array.isArray(value)) {
      result[mappedKey] = value.map((item) =>
        typeof item === "object" && item !== null
          ? mapNumericKeys(item as Record<string, unknown>)
          : item,
      );
    } else if (typeof value === "object" && value !== null) {
      result[mappedKey] = mapNumericKeys(value as Record<string, unknown>);
    } else {
      result[mappedKey] = value;
    }
  }

  return result;
}

/**
 * 名前付きキーから数値キーを逆引き
 */
export function getNumericKey(namedKey: string): string | undefined {
  for (const [numKey, name] of Object.entries(NUMERIC_KEY_MAP)) {
    if (name === namedKey) return numKey;
  }
  return undefined;
}
