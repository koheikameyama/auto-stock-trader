import { describe, it, expect } from "vitest";
import { mapNumericKeys, getNumericKey } from "../tachibana-key-map";

describe("mapNumericKeys", () => {
  it("数値キーを名前付きキーに変換する", () => {
    const input = {
      "311": "0",
      "310": "",
      "357": "CLMAuthLoginAck",
      "896": "https://example.com/request",
    };

    const result = mapNumericKeys(input);
    expect(result.sResultCode).toBe("0");
    expect(result.sResultText).toBe("");
    expect(result.sCLMID).toBe("CLMAuthLoginAck");
    expect(result.sUrlRequest).toBe("https://example.com/request");
  });

  it("マッピングにないキーはそのまま保持する", () => {
    const input = { "999": "unknown", customKey: "value" };
    const result = mapNumericKeys(input);
    expect(result["999"]).toBe("unknown");
    expect(result.customKey).toBe("value");
  });

  it("ネストしたオブジェクトも再帰的に変換する", () => {
    const input = {
      "357": "CLMOrderList",
      nested: { "311": "0", "542": "1" },
    };

    const result = mapNumericKeys(input);
    expect(result.sCLMID).toBe("CLMOrderList");
    const nested = result.nested as Record<string, unknown>;
    expect(nested.sResultCode).toBe("0");
    expect(nested.sOrderStatus).toBe("1");
  });

  it("配列内のオブジェクトも変換する", () => {
    const input = {
      aGenbutuKabuList: [
        { "859": "6501", "863": "100" },
        { "859": "9984", "863": "200" },
      ],
    };

    const result = mapNumericKeys(input);
    const list = result.aGenbutuKabuList as Record<string, unknown>[];
    expect(list).toHaveLength(2);
    expect(list[0].sUriOrderIssueCode).toBe("6501");
    expect(list[0].sUriOrderZanKabuSuryou).toBe("100");
    expect(list[1].sUriOrderIssueCode).toBe("9984");
  });

  it("空オブジェクトを処理できる", () => {
    expect(mapNumericKeys({})).toEqual({});
  });

  it("v4r10本番実測の時価レスポンス(CLMMfdsGetMarketPrice, 1545)を正しく変換する", () => {
    // 2026-09-30 15:24 本番ログから採取した生レスポンス（Railway MCP get-logs で確認）。
    // 数値キーが+24シフトしていることの実データ検証。
    const input = {
      "81": [
        {
          "130": "242.0",
          "134": "239.3",
          "136": "241.8",
          "139": "240.1",
          "141": "2241090",
          "143": "0.08",
          "144": "0.2",
          "205": "239.9",
          "206": "240.1",
          "207": "0101",
          "208": "240.0",
          "209": "0101",
          "496": "1545",
        },
      ],
      "310": "",
      "311": "0",
      "357": "CLMMfdsGetMarketPrice",
    };

    const result = mapNumericKeys(input);
    expect(result.sResultCode).toBe("0");
    expect(result.sCLMID).toBe("CLMMfdsGetMarketPrice");

    const list = result.aMarketPriceList as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    const item = list[0];
    expect(item.sTargetIssueCode).toBe("1545");
    expect(item.pHighPrice).toBe("242.0");
    expect(item.pLowPrice).toBe("239.3");
    expect(item.pOpenPrice).toBe("241.8");
    expect(item.pCurrentPrice).toBe("240.1");
    expect(item.pVolume).toBe("2241090");
    expect(item.pChangePercent).toBe("0.08");
    expect(item.pChange).toBe("0.2");
    expect(item.pPreviousClose).toBe("239.9");
    expect(item.pAskPrice).toBe("240.1");
    expect(item.pBidPrice).toBe("240.0");
    // レンジ整合性: low <= open,current <= high
    expect(Number(item.pLowPrice)).toBeLessThanOrEqual(Number(item.pOpenPrice));
    expect(Number(item.pLowPrice)).toBeLessThanOrEqual(Number(item.pCurrentPrice));
    expect(Number(item.pHighPrice)).toBeGreaterThanOrEqual(Number(item.pOpenPrice));
    expect(Number(item.pHighPrice)).toBeGreaterThanOrEqual(Number(item.pCurrentPrice));
    // 前日比の算術整合性: prevClose + change = current
    expect(Number(item.pPreviousClose) + Number(item.pChange)).toBeCloseTo(
      Number(item.pCurrentPrice),
      5,
    );
  });
});

describe("getNumericKey", () => {
  it("名前付きキーから数値キーを逆引きする", () => {
    expect(getNumericKey("sResultCode")).toBe("311");
    expect(getNumericKey("sUrlRequest")).toBe("896");
    expect(getNumericKey("sOrderNumber")).toBe("532");
  });

  it("存在しないキーはundefinedを返す", () => {
    expect(getNumericKey("nonExistentKey")).toBeUndefined();
  });
});
