import { describe, it, expect } from "vitest";
import {
  normalizeTickerCode,
  removeTickerSuffix,
  normalizeTickerCodes,
  prepareTickerForYahoo,
  prepareTickerForDB,
} from "../ticker-utils";

describe("normalizeTickerCode", () => {
  it("空文字 → エラー", () => {
    expect(() => normalizeTickerCode("")).toThrow("tickerCode is required");
  });

  it("サフィックス付き → そのまま", () => {
    expect(normalizeTickerCode("7203.T")).toBe("7203.T");
  });

  it("インデックス（^始まり）→ そのまま", () => {
    expect(normalizeTickerCode("^N225")).toBe("^N225");
  });

  it("数字のみ → .T を追加", () => {
    expect(normalizeTickerCode("7203")).toBe("7203.T");
    expect(normalizeTickerCode("9432")).toBe("9432.T");
  });

  it("数字+英字1文字（JPX新コード形式）→ .T を追加", () => {
    expect(normalizeTickerCode("123A")).toBe("123A.T");
    expect(normalizeTickerCode("456B")).toBe("456B.T");
  });

  it("小文字の英字 → .T を追加", () => {
    expect(normalizeTickerCode("123a")).toBe("123a.T");
  });

  it("英字のみ（米国株）→ そのまま", () => {
    expect(normalizeTickerCode("AAPL")).toBe("AAPL");
    expect(normalizeTickerCode("MSFT")).toBe("MSFT");
  });

  it("英数字混合（数字+英字パターン以外）→ そのまま", () => {
    expect(normalizeTickerCode("ABC123")).toBe("ABC123");
  });
});

describe("removeTickerSuffix", () => {
  it("空文字 → エラー", () => {
    expect(() => removeTickerSuffix("")).toThrow("tickerCode is required");
  });

  it("サフィックス付き → 除去", () => {
    expect(removeTickerSuffix("7203.T")).toBe("7203");
  });

  it("ドットなし → そのまま", () => {
    expect(removeTickerSuffix("AAPL")).toBe("AAPL");
  });

  it("複数ドット → 最初のドット以前を返す", () => {
    expect(removeTickerSuffix("7203.T.extra")).toBe("7203");
  });
});

describe("normalizeTickerCodes", () => {
  it("混合配列を正規化", () => {
    expect(normalizeTickerCodes(["7203", "9432.T", "AAPL"])).toEqual([
      "7203.T",
      "9432.T",
      "AAPL",
    ]);
  });

  it("空配列 → 空配列", () => {
    expect(normalizeTickerCodes([])).toEqual([]);
  });
});

describe("prepareTickerForYahoo", () => {
  it("normalizeTickerCode と同じ結果", () => {
    expect(prepareTickerForYahoo("7203")).toBe("7203.T");
    expect(prepareTickerForYahoo("AAPL")).toBe("AAPL");
  });
});

describe("prepareTickerForDB", () => {
  it("normalizeTickerCode と同じ結果", () => {
    expect(prepareTickerForDB("7203")).toBe("7203.T");
    expect(prepareTickerForDB("AAPL")).toBe("AAPL");
  });
});
