/**
 * 立花証券 API レスポンスの数値キー → 名前付きキー変換
 *
 * APIレスポンスはデフォルトで数値キー（"287", "872" 等）を使用する。
 * このモジュールで名前付きキーに変換する。
 */

/** 数値キー → 名前付きキーのマッピング */
const NUMERIC_KEY_MAP: Record<string, string> = {
  // 共通
  // v4r10 でキーが全面シフト（2026-09-29 本番実測、KOH-未採番）。旧値はコメントに残す。
  "311": "sResultCode",  // v4r9: 287
  "310": "sResultText",  // v4r9: 286
  "357": "sCLMID",       // v4r9: 334

  // ログインレスポンス（仮想URL5本）
  // v4r10 実測・確定（2026-09-29）: broker-client.ts の login() が復号後にパスセグメント
  // （/request/, /master/, /price/, /event/, wss://）を検証してこの割り当てが正しいことを
  // 本番で確認済み（assertVirtualUrlShape が例外を投げずに通過し、Virtual URLs ログで実URLを確認）。
  "892": "sUrlEvent",          // v4r9: 869
  "893": "sUrlEventWebSocket", // v4r9: 870
  "894": "sUrlMaster",         // v4r9: 871
  "895": "sUrlPrice",          // v4r9: 872
  "896": "sUrlRequest",        // v4r9: 873

  // 買余力 (CLMZanKaiKanougaku)
  // v4r10 実測・確定（2026-09-29）: ログイン後の初回呼び出しで "766":"508228"（本番の実際の
  // 買付余力と一致する額）、"770":"202609291605"（呼び出し時刻と一致するYYYYMMDDHHMM形式）を確認。
  "766": "sSummaryGenkabuKaituke", // v4r9: 743, v4r8: 744
  "770": "sSummaryUpdate",         // v4r9: 747

  // v4r10 で以下のキーは未検証。実測するまで意図的に未マップのまま
  // （mapNumericKeys は未知キーをそのまま数値キーで残すため、誤って旧v4r9のキーを
  //   適用して不正確な値を読むより安全）。
  //   旧マップ: 549=sLastLoginDate / 552=sKinsyouhouMidokuFlg / 745=sSummaryNseityouTousiKanougaku
  // 保守予定日通知（v4r10 実測・確定, 2026-09-30）
  // "872":"20260927"（= v4r9 廃止日そのもの、確度の高い一致）/ "873":"20261001"（明日）を
  // アルファベット順（sUpdateInformAPISpecFunction < sUpdateInformWebDocument）で対応付け。
  // checkMaintenanceNotices() は通知のみで実害がないため、この確度で登録して問題ない。
  // ⚠️ 873=交付書面更新予定日が2026-10-01（明日）: 交付書面更新後は Web で確認するまで
  // ログインがブロックされる可能性がある（sKinsyouhouMidokuFlg、現状未マップ）。
  "872": "sUpdateInformAPISpecFunction", // v4r9: 未確認
  "873": "sUpdateInformWebDocument",     // v4r9: 未確認

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

  // 買余力 (v4r9 で -1 シフト、本番実測。v4r10は745/747とも未検証)
  "745": "sSummaryNseityouTousiKanougaku", // v4r8: 746。v4r10実測ログで"768"が同位置(NISA=0)の可能性高いが値"0"のみでは確証薄く未反映
  "747": "sSummaryUpdate",                  // 新規
  // sHusokukinHasseiFlg は v4r9 では名前付きキーで返る

  // 時価情報 (CLMMfdsGetMarketPrice)
  // v4r10 実測・確定（2026-09-30, KOH-未採番）: 全キーが v4r9 から一律 +24 シフト。
  // リクエスト列(TACHIBANA_QUOTE_COLUMNS)12個の実測レスポンスで、レンジ整合性
  // （low≦open,current≦high / prevClose+change=current 等）を満たす唯一の割当として確定。
  // aMarketPriceList(71→81)・sTargetIssueCode(473→496)は+23（sCLMID等と同系列の別シフト量）。
  "81": "aMarketPriceList",   // v4r9: 71
  "496": "sTargetIssueCode",  // v4r9: 473
  "139": "pCurrentPrice",     // pDPP - 現在値（v4r9: 115）
  "136": "pOpenPrice",        // pDOP - 始値（v4r9: 112）
  "130": "pHighPrice",        // pDHP - 高値（v4r9: 106）
  "134": "pLowPrice",         // pDLP - 安値（v4r9: 110）
  "205": "pPreviousClose",    // pPRP - 前日終値（v4r9: 181）
  "141": "pVolume",           // pDV  - 出来高（v4r9: 117）
  "144": "pChange",           // pDYWP - 前日比（v4r9: 120）
  "143": "pChangePercent",    // pDYRP - 前日比率(%)（v4r9: 119）
  "206": "pAskPrice",         // pQAP - 売気配値（v4r9: 182）
  "208": "pBidPrice",         // pQBP - 買気配値（v4r9: 184）
  "207": "pAskSize",          // pQAS - 売気配数量（v4r9: 183）
  "209": "pBidSize",          // pQBS - 買気配数量（v4r9: 185）
  // 以下は未リクエスト列（TACHIBANA_QUOTE_COLUMNSに含まれず今回の実測で確認できていない）。
  // +24シフトの推定値のまま。実際に使用する箇所があれば実測してから使うこと。
  "132": "pTradingValue",     // pDJ  - 売買代金（v4r9: 108）※推定
  "237": "pVWAP",             // pVWAP（v4r9: 213）※推定
  "962": "tPriceTime",        // tDPP:T - 約定時刻（v4r9: 938）※推定
  "129": "pHighFlag",         // pDHF（v4r9: 105）※推定
  "133": "pLowFlag",          // pDLF（v4r9: 109）※推定
  "138": "pPriceFlag",        // pDPG（v4r9: 114）※推定
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
