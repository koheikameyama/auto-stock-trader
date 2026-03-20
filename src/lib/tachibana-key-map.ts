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

  // 注文レスポンス
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
