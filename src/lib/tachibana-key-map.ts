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
  // v4r9 で URL の数値キーが +1 シフト（本番DBの session URL 実態から判明）
  "873": "sUrlRequest",       // v4r8: 872
  "871": "sUrlMaster",        // v4r8: 870
  "872": "sUrlPrice",         // v4r8: 871
  "869": "sUrlEvent",         // v4r8: 868
  "870": "sUrlEventWebSocket", // v4r8: 869
  "743": "sSummaryGenkabuKaituke", // v4r8: 744 (v4r9 で -1 シフト、本番実測)
  "549": "sLastLoginDate",
  "552": "sKinsyouhouMidokuFlg",
  // v4r9 保守通知フィールド: 数値キー未確認。名前付きキーで返るケースは
  // broker-client.ts の checkMaintenanceNotices() でフォールバック処理する。
  // 数値キーが判明したらここに追加: "???": "sUpdateInformWebDocument",
  //                                "???": "sUpdateInformAPISpecFunction",

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
  "94":  "aOrderList",           // CLMOrderList の注文配列（未マップだと syncBrokerOrderStatuses が空になり注文同期が全て no-op になっていた）
  // CLMOrderList 要素の実測キー（2026-07-02 本番 4812.T で確認。従来の "378" 等は要素キーと不一致で
  // 注文番号/営業日/売買が読めず、businessDay バックフィル・約定リカバリ・孤立検出が全て機能していなかった）
  "646": "sOrderOrderNumber",    // 注文番号（例: "2016584"）
  "653": "sOrderSikkouDay",      // 執行(営業)日（例: "20260702"）
  "618": "sBaibaiKubun",         // 売買区分（"1"売/"3"買）
  "638": "sOrderIssueCode",      // 銘柄コード
  "378": "sOrderOrderNumber",    // 注文番号
  "656": "sOrderStatus",         // 注文状態テキスト（"全部約定" 等）※"542" はドキュメント記載
  "657": "sOrderStatusCode",     // 注文状態コード（"10" = FULLY_FILLED）
  "96":  "aYakuzyouSikkouList",  // 約定執行リスト
  // v4r9 実測（2026-07-02 本番 4812.T）: 878=約定日時, 879=約定価格, 880=約定数量 で1つズレる。
  // 旧 878=価格/879=数量 は demo(v4r8) 実測値で、本番 v4r9 の約定価格に日時が入り overflow していた。
  "878": "sYakuzyouDay",         // 約定日時 YYYYMMDDHHMMSS（旧マップは sYakuzyouPrice=誤り）
  "879": "sYakuzyouPrice",       // 約定価格
  "880": "sYakuzyouSuryou",      // 約定数量

  // 現物保有銘柄
  "859": "sUriOrderIssueCode",
  "863": "sUriOrderZanKabuSuryou",
  "860": "sUriOrderUritukeKanouSuryou",
  "854": "sUriOrderGaisanBokaTanka",
  "858": "sUriOrderHyoukaTanka",
  "857": "sUriOrderGaisanHyoukagaku",
  "855": "sUriOrderGaisanHyoukaSoneki",

  // 買余力 (v4r9 で -1 シフト、本番実測)
  "745": "sSummaryNseityouTousiKanougaku", // v4r8: 746
  "747": "sSummaryUpdate",                  // 新規
  // sHusokukinHasseiFlg は v4r9 では名前付きキーで返る

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
