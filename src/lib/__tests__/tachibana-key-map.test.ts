import { describe, it, expect } from "vitest";
import { mapNumericKeys, getNumericKey } from "../tachibana-key-map";

describe("mapNumericKeys", () => {
  it("数値キーを名前付きキーに変換する", () => {
    const input = {
      "287": "0",
      "286": "",
      "334": "CLMAuthLoginAck",
      "872": "https://example.com/request",
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
      "334": "CLMOrderList",
      nested: { "287": "0", "542": "1" },
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
});

describe("getNumericKey", () => {
  it("名前付きキーから数値キーを逆引きする", () => {
    expect(getNumericKey("sResultCode")).toBe("287");
    expect(getNumericKey("sUrlRequest")).toBe("872");
    expect(getNumericKey("sOrderNumber")).toBe("532");
  });

  it("存在しないキーはundefinedを返す", () => {
    expect(getNumericKey("nonExistentKey")).toBeUndefined();
  });
});
