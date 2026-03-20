import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TachibanaClient, resetTachibanaClient } from "../broker-client";

// fetchをモック
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createMockResponse(data: Record<string, string>) {
  const json = JSON.stringify(data);
  // Shift_JISエンコードをシミュレート（ASCII範囲はそのまま）
  const encoder = new TextEncoder();
  const buffer = encoder.encode(json);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: () => Promise.resolve(buffer.buffer),
  };
}

describe("TachibanaClient", () => {
  let client: TachibanaClient;

  beforeEach(() => {
    resetTachibanaClient();
    client = new TachibanaClient("demo");
    vi.stubEnv("TACHIBANA_USER_ID", "testuser");
    vi.stubEnv("TACHIBANA_PASSWORD", "testpass");
    mockFetch.mockReset();
  });

  afterEach(() => {
    client.stopAutoRefresh();
    vi.unstubAllEnvs();
  });

  describe("login", () => {
    it("ログイン成功時にセッション情報を保持する", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "287": "0",
          "334": "CLMAuthLoginAck",
          "872": "https://vurl/request/",
          "870": "https://vurl/master/",
          "871": "https://vurl/price/",
          "868": "https://vurl/event/",
          "869": "wss://vurl/ws/",
          "552": "0",
        }),
      );

      const session = await client.login();
      expect(session.urlRequest).toBe("https://vurl/request/");
      expect(session.urlMaster).toBe("https://vurl/master/");
      expect(session.urlPrice).toBe("https://vurl/price/");
      expect(client.isLoggedIn()).toBe(true);
    });

    it("ログイン失敗時にエラーをスローする", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "287": "1",
          "286": "Authentication failed",
          "334": "CLMAuthLoginAck",
        }),
      );

      await expect(client.login()).rejects.toThrow("Tachibana login failed");
    });

    it("金商法お知らせ未読時にエラーをスローする", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "287": "0",
          "334": "CLMAuthLoginAck",
          "872": "https://vurl/request/",
          "870": "https://vurl/master/",
          "871": "https://vurl/price/",
          "868": "https://vurl/event/",
          "869": "wss://vurl/ws/",
          "552": "1",
        }),
      );

      await expect(client.login()).rejects.toThrow("金商法のお知らせが未読");
    });

    it("環境変数がない場合にエラーをスローする", async () => {
      vi.stubEnv("TACHIBANA_USER_ID", "");
      vi.stubEnv("TACHIBANA_PASSWORD", "");

      await expect(client.login()).rejects.toThrow(
        "TACHIBANA_USER_ID and TACHIBANA_PASSWORD are required",
      );
    });
  });

  describe("request", () => {
    it("ログインしていない場合にエラーをスローする", async () => {
      await expect(
        client.request({ sCLMID: "CLMOrderList" }),
      ).rejects.toThrow("not logged in");
    });

    it("ログイン後にリクエストを送信できる", async () => {
      // ログイン
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "287": "0",
          "334": "CLMAuthLoginAck",
          "872": "https://vurl/request/",
          "870": "https://vurl/master/",
          "871": "https://vurl/price/",
          "868": "https://vurl/event/",
          "869": "wss://vurl/ws/",
          "552": "0",
        }),
      );
      await client.login();

      // リクエスト
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "287": "0",
          "334": "CLMOrderList",
          "744": "20000000",
        }),
      );

      const res = await client.request({ sCLMID: "CLMOrderList" });
      expect(res.sResultCode).toBe("0");
      expect(res.sSummaryGenkabuKaituke).toBe("20000000");
    });
  });

  describe("encodeParams", () => {
    it("URLにJSON文字列をエンコードして送信する", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "287": "0",
          "334": "CLMAuthLoginAck",
          "872": "https://vurl/request/",
          "870": "https://vurl/master/",
          "871": "https://vurl/price/",
          "868": "https://vurl/event/",
          "869": "wss://vurl/ws/",
          "552": "0",
        }),
      );
      await client.login();

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("https://demo-kabuka.e-shiten.jp/e_api_v4r8/auth/?");
      // URLエンコードされたJSONが含まれる
      expect(calledUrl).toContain("%7B");
    });
  });

  describe("logout", () => {
    it("ログアウト後はisLoggedInがfalseになる", async () => {
      // ログイン
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "287": "0",
          "334": "CLMAuthLoginAck",
          "872": "https://vurl/request/",
          "870": "https://vurl/master/",
          "871": "https://vurl/price/",
          "868": "https://vurl/event/",
          "869": "wss://vurl/ws/",
          "552": "0",
        }),
      );
      await client.login();
      expect(client.isLoggedIn()).toBe(true);

      // ログアウト
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ "287": "0" }),
      );
      await client.logout();
      expect(client.isLoggedIn()).toBe(false);
    });
  });
});
