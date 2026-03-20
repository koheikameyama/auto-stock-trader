import { describe, it, expect, vi, beforeEach } from "vitest";
import { tachibanaFetchQuote, tachibanaFetchQuotesBatch } from "../tachibana-price-client";

// broker-client モック
const mockRequestPrice = vi.fn();
vi.mock("../../core/broker-client", () => ({
  getTachibanaClient: vi.fn().mockReturnValue({
    isLoggedIn: vi.fn().mockReturnValue(true),
    requestPrice: (...args: unknown[]) => mockRequestPrice(...args),
  }),
}));

function createPriceResponse(
  issueCode: string,
  overrides: Record<string, string> = {},
) {
  return {
    sResultCode: "0",
    sResultText: "",
    sCLMID: "CLMMfdsGetMarketPrice",
    aMarketPriceList: [
      {
        pCurrentPrice: "2500",
        pOpenPrice: "2480",
        pHighPrice: "2520",
        pLowPrice: "2470",
        pPreviousClose: "2490",
        pVolume: "1000000",
        pChange: "10",
        pChangePercent: "0.40",
        sTargetIssueCode: issueCode,
        ...overrides,
      },
    ],
  };
}

describe("tachibanaFetchQuote", () => {
  beforeEach(() => {
    mockRequestPrice.mockReset();
  });

  it("正常にクォートを取得できる", async () => {
    mockRequestPrice.mockResolvedValueOnce(createPriceResponse("7203"));

    const result = await tachibanaFetchQuote("7203.T");

    expect(result.tickerCode).toBe("7203.T");
    expect(result.price).toBe(2500);
    expect(result.open).toBe(2480);
    expect(result.high).toBe(2520);
    expect(result.low).toBe(2470);
    expect(result.previousClose).toBe(2490);
    expect(result.volume).toBe(1000000);
    expect(result.change).toBe(10);
    expect(result.changePercent).toBe(0.40);
  });

  it("ファンダメンタルズはnullで返す", async () => {
    mockRequestPrice.mockResolvedValueOnce(createPriceResponse("7203"));

    const result = await tachibanaFetchQuote("7203.T");

    expect(result.per).toBeNull();
    expect(result.pbr).toBeNull();
    expect(result.eps).toBeNull();
    expect(result.marketCap).toBeNull();
  });

  it("APIエラー時にthrowする", async () => {
    mockRequestPrice.mockResolvedValueOnce({
      sResultCode: "-1",
      sResultText: "銘柄コードエラー",
      sCLMID: "CLMMfdsGetMarketPrice",
    });

    await expect(tachibanaFetchQuote("9999.T")).rejects.toThrow(
      "[-1] 銘柄コードエラー",
    );
  });

  it("空のレスポンスでthrowする", async () => {
    mockRequestPrice.mockResolvedValueOnce({
      sResultCode: "0",
      sCLMID: "CLMMfdsGetMarketPrice",
      aMarketPriceList: [],
    });

    await expect(tachibanaFetchQuote("7203.T")).rejects.toThrow("No data");
  });

  it("ティッカーの.Tサフィックスを除去してリクエストする", async () => {
    mockRequestPrice.mockResolvedValueOnce(createPriceResponse("7203"));

    await tachibanaFetchQuote("7203.T");

    expect(mockRequestPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        sTargetIssueCode: "7203",
      }),
    );
  });

  it("空文字の値は0に変換する", async () => {
    mockRequestPrice.mockResolvedValueOnce(
      createPriceResponse("7203", {
        pCurrentPrice: "",
        pVolume: "",
      }),
    );

    const result = await tachibanaFetchQuote("7203.T");
    expect(result.price).toBe(0);
    expect(result.volume).toBe(0);
  });
});

describe("tachibanaFetchQuotesBatch", () => {
  beforeEach(() => {
    mockRequestPrice.mockReset();
  });

  it("複数銘柄のクォートをバッチ取得できる", async () => {
    mockRequestPrice
      .mockResolvedValueOnce(createPriceResponse("7203"))
      .mockResolvedValueOnce(createPriceResponse("6501"));

    const results = await tachibanaFetchQuotesBatch(["7203.T", "6501.T"]);

    expect(results).toHaveLength(2);
    expect(results[0]?.tickerCode).toBe("7203.T");
    expect(results[1]?.tickerCode).toBe("6501.T");
  });

  it("個別の失敗はnullで返す", async () => {
    mockRequestPrice
      .mockResolvedValueOnce(createPriceResponse("7203"))
      .mockResolvedValueOnce({
        sResultCode: "-1",
        sResultText: "エラー",
        sCLMID: "CLMMfdsGetMarketPrice",
      });

    const results = await tachibanaFetchQuotesBatch(["7203.T", "9999.T"]);

    expect(results).toHaveLength(2);
    expect(results[0]?.tickerCode).toBe("7203.T");
    expect(results[1]).toBeNull();
  });
});
