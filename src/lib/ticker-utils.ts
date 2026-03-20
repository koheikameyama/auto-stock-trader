/**
 * ティッカーコードのユーティリティ関数
 *
 * 東京証券取引所の銘柄には `.T` サフィックスが必要
 * このモジュールで一貫した処理を提供
 */

/**
 * ティッカーコードを正規化（日本株の可能性が高い場合に .T サフィックスを補完）
 * すでにサフィックスがある場合や、英字のみ（米国株）の場合はそのまま
 *
 * @param tickerCode - 元のティッカーコード（例: "7203", "123A", "AAPL"）
 * @returns 正規化されたティッカーコード
 */
export function normalizeTickerCode(tickerCode: string): string {
  if (!tickerCode) {
    throw new Error("tickerCode is required");
  }

  // すでにサフィックス（ドット）が含まれている場合はそのまま返す
  if (tickerCode.includes(".")) {
    return tickerCode;
  }

  // インデックス（^で始まる）はそのまま返す
  if (tickerCode.startsWith("^")) {
    return tickerCode;
  }

  // 数字のみ、または数字+英字1文字（JPX新コード形式 123Aなど）の場合は .T を付与
  if (/^\d+$/.test(tickerCode) || /^\d+[A-Z]$/i.test(tickerCode)) {
    return `${tickerCode}.T`;
  }

  // それ以外（英字のみの米国株など）はそのまま返す
  return tickerCode;
}

/**
 * ティッカーコードからサフィックス（.Tなど）を削除
 *
 * @param tickerCode - ティッカーコード（例: "7203.T", "AAPL"）
 * @returns サフィックスなしのコード（例: "7203", "AAPL"）
 */
export function removeTickerSuffix(tickerCode: string): string {
  if (!tickerCode) {
    throw new Error("tickerCode is required");
  }

  // 最初のドット以前を抽出
  return tickerCode.split(".")[0];
}

/**
 * ティッカーコード配列を正規化
 *
 * @param tickerCodes - ティッカーコード配列
 * @returns 正規化されたティッカーコード配列
 *
 * @example
 * normalizeTickerCodes(["7203", "9432.T"]) // ["7203.T", "9432.T"]
 */
export function normalizeTickerCodes(tickerCodes: string[]): string[] {
  return tickerCodes.map(normalizeTickerCode);
}

/**
 * Yahoo Finance用にティッカーコードを準備
 * 市場が特定できない場合にデフォルトで .T を付与
 *
 * @param tickerCode - DB保存用のサフィックスなしコード、または入力をそのまま
 * @returns Yahoo Finance用のティッカーコード（例: "7203.T"）
 */
export function prepareTickerForYahoo(tickerCode: string): string {
  return normalizeTickerCode(tickerCode);
}

/**
 * データベース保存用にティッカーコードを準備
 * サフィックスがない場合、デフォルトで .T を補完して保存する
 * (正確な市場判別が必要な場合は登録フローで fetchStockPrices を使用すること)
 *
 * @param tickerCode - 入力されたティッカーコード
 * @returns サフィックス付きのティッカーコード（例: "7203" -> "7203.T"）
 */
export function prepareTickerForDB(tickerCode: string): string {
  return normalizeTickerCode(tickerCode);
}

/**
 * DB/内部形式 → ブローカー用コードに変換
 * 立花証券APIは4桁数字のみ（".T" サフィックスなし）
 *
 * @param ticker - DB保存形式（例: "7203.T"）
 * @returns ブローカー用コード（例: "7203"）
 */
export function tickerToBrokerCode(ticker: string): string {
  return removeTickerSuffix(ticker);
}

/**
 * ブローカー用コード → DB/内部形式に変換
 *
 * @param brokerCode - ブローカー用コード（例: "7203"）
 * @returns DB保存形式（例: "7203.T"）
 */
export function brokerCodeToTicker(brokerCode: string): string {
  return normalizeTickerCode(brokerCode);
}
