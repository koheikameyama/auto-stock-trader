import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TachibanaClient, resetTachibanaClient } from "../broker-client";

const { mockTradingConfigFindFirst, mockTradingConfigUpdate } = vi.hoisted(() => ({
  mockTradingConfigFindFirst: vi.fn(),
  mockTradingConfigUpdate: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingConfig: {
      findFirst: mockTradingConfigFindFirst,
      update: mockTradingConfigUpdate,
    },
  },
}));

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
    mockTradingConfigFindFirst.mockReset();
    mockTradingConfigFindFirst.mockResolvedValue(null);
    mockTradingConfigUpdate.mockReset();
    mockTradingConfigUpdate.mockResolvedValue({});
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

    it("DBにログインロックがある場合はAPIを呼ばずにエラーをスローする", async () => {
      const lockedUntil = new Date(Date.now() + 30 * 60 * 1000); // 30分後
      mockTradingConfigFindFirst.mockResolvedValueOnce({ loginLockedUntil: lockedUntil });

      await expect(client.login()).rejects.toThrow("Tachibana login is locked until");

      // fetchが呼ばれていないことを確認
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("アカウントロック検出時にDBにログインロック状態を書き込む", async () => {
      // ロックチェック: nullなのでスルー
      // isActive=false 書き込み用 + ロック詳細書き込み用（2回）
      const mockConfig = { id: "config-1" };
      mockTradingConfigFindFirst
        .mockResolvedValueOnce(null)       // ロックチェック
        .mockResolvedValueOnce(mockConfig) // isActive=false 書き込み用
        .mockResolvedValueOnce(mockConfig); // ロック詳細書き込み用

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "287": "0",
          "334": "CLMAuthLoginAck",
          "688": "10033",
          "689": "account locked by server",
        }),
      );

      await expect(client.login()).rejects.toThrow("Tachibana login blocked (アカウントロック)");

      // 1回目: isActive=false のみ（マイグレーション未適用でも確実に停止）
      expect(mockTradingConfigUpdate).toHaveBeenNthCalledWith(1, {
        where: { id: "config-1" },
        data: { isActive: false },
      });
      // 2回目: ロック詳細
      expect(mockTradingConfigUpdate).toHaveBeenNthCalledWith(2, {
        where: { id: "config-1" },
        data: expect.objectContaining({
          loginLockedUntil: expect.any(Date),
          loginLockReason: "アカウントロック",
        }),
      });
    });

    it("電話番号認証要求(10089)検出時にDBにログインロック状態を書き込む", async () => {
      // ロックチェック: nullなのでスルー
      // isActive=false 書き込み用 + ロック詳細書き込み用（2回）
      const mockConfig = { id: "config-1" };
      mockTradingConfigFindFirst
        .mockResolvedValueOnce(null)       // ロックチェック
        .mockResolvedValueOnce(mockConfig) // isActive=false 書き込み用
        .mockResolvedValueOnce(mockConfig); // ロック詳細書き込み用

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "287": "0",
          "334": "CLMAuthLoginAck",
          "688": "10089",
          "689": "phone auth required",
        }),
      );

      await expect(client.login()).rejects.toThrow("Tachibana login blocked (電話番号認証が必要)");

      // 1回目: isActive=false のみ（マイグレーション未適用でも確実に停止）
      expect(mockTradingConfigUpdate).toHaveBeenNthCalledWith(1, {
        where: { id: "config-1" },
        data: { isActive: false },
      });
      // 2回目: ロック詳細
      expect(mockTradingConfigUpdate).toHaveBeenNthCalledWith(2, {
        where: { id: "config-1" },
        data: expect.objectContaining({
          loginLockedUntil: expect.any(Date),
          loginLockReason: "電話番号認証が必要",
        }),
      });
    });

    it("正常ログイン成功時にDBのロック状態をクリアする", async () => {
      const mockConfig = { id: "config-1" };
      mockTradingConfigFindFirst
        .mockResolvedValueOnce(null)        // ロックチェック
        .mockResolvedValueOnce(mockConfig); // 成功後クリア用

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

      expect(mockTradingConfigUpdate).toHaveBeenCalledWith({
        where: { id: "config-1" },
        data: { loginLockedUntil: null, loginLockReason: null },
      });
    });
  });

  describe("request", () => {
    it("セッションがない場合は自動ログインを試みる（失敗時はエラー）", async () => {
      // fetchモックが設定されていないので自動ログインが失敗する
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "287": "1",
          "286": "login failed",
          "334": "CLMAuthLoginAck",
        }),
      );
      await expect(
        client.request({ sCLMID: "CLMOrderList" }),
      ).rejects.toThrow("Tachibana login failed");
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
