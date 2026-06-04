import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
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
    brokerSession: {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

// v4r9: ログイン応答の仮想URLは公開鍵で暗号化されて返るため、
// テスト用のRSA鍵ペアを生成し、公開鍵で暗号化・秘密鍵で復号を検証する。
const { publicKey: testPublicKey, privateKey: testPrivateKey } =
  crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

/** 仮想URL値を立花サーバ同様に公開鍵で RSA-OAEP(SHA-256) 暗号化 + Base64 */
function encUrl(plaintext: string): string {
  return crypto
    .publicEncrypt(
      {
        key: testPublicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(plaintext, "utf-8"),
    )
    .toString("base64");
}

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

/** ログイン成功レスポンス（仮想URLは暗号化済み） */
function loginSuccessResponse() {
  return createMockResponse({
    "287": "0",
    "334": "CLMAuthLoginAck",
    "872": encUrl("https://vurl/request/"),
    "870": encUrl("https://vurl/master/"),
    "871": encUrl("https://vurl/price/"),
    "868": encUrl("https://vurl/event/"),
    "869": encUrl("wss://vurl/ws/"),
    "552": "0",
  });
}

describe("TachibanaClient", () => {
  let client: TachibanaClient;

  beforeEach(() => {
    resetTachibanaClient();
    client = new TachibanaClient("demo");
    vi.stubEnv("TACHIBANA_AUTH_ID", "testauthid");
    vi.stubEnv("TACHIBANA_PRIVATE_KEY", testPrivateKey);
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
    it("ログイン成功時に復号した仮想URLをセッションに保持する", async () => {
      mockFetch.mockResolvedValueOnce(loginSuccessResponse());

      const session = await client.login();
      expect(session.urlRequest).toBe("https://vurl/request/");
      expect(session.urlMaster).toBe("https://vurl/master/");
      expect(session.urlPrice).toBe("https://vurl/price/");
      expect(session.urlEvent).toBe("https://vurl/event/");
      expect(session.urlEventWebSocket).toBe("wss://vurl/ws/");
      expect(client.isLoggedIn()).toBe(true);
    });

    it("秘密鍵が公開鍵と対応しない場合は復号エラーをスローする", async () => {
      // 別の鍵ペアを生成し、対応しない秘密鍵を環境変数に設定
      const other = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      vi.stubEnv("TACHIBANA_PRIVATE_KEY", other.privateKey);

      mockFetch.mockResolvedValueOnce(loginSuccessResponse());

      await expect(client.login()).rejects.toThrow("Failed to decrypt");
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
          "552": "1",
        }),
      );

      await expect(client.login()).rejects.toThrow("金商法のお知らせが未読");
    });

    it("認証IDがない場合にエラーをスローする", async () => {
      vi.stubEnv("TACHIBANA_AUTH_ID", "");

      await expect(client.login()).rejects.toThrow(
        "TACHIBANA_AUTH_ID is required",
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
      const mockConfig = { id: "config-1" };
      mockTradingConfigFindFirst
        .mockResolvedValueOnce(null)       // ロックチェック
        .mockResolvedValueOnce(mockConfig); // 1回のupdate用

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "287": "0",
          "334": "CLMAuthLoginAck",
          "688": "10033",
          "689": "account locked by server",
        }),
      );

      await expect(client.login()).rejects.toThrow("Tachibana login blocked (アカウントロック)");

      // 1回のupdateでisActive停止 + ロック理由 + 発生日時をまとめて書き込み
      expect(mockTradingConfigUpdate).toHaveBeenCalledWith({
        where: { id: "config-1" },
        data: expect.objectContaining({
          isActive: false,
          loginLockedUntil: expect.any(Date),
          loginLockReason: "アカウントロック",
          loginLockOccurredAt: expect.any(Date),
        }),
      });
    });

    it("電話番号認証要求(10089)検出時にDBにログインロック状態を書き込む", async () => {
      // ロックチェック: nullなのでスルー
      const mockConfig = { id: "config-1" };
      mockTradingConfigFindFirst
        .mockResolvedValueOnce(null)       // ロックチェック
        .mockResolvedValueOnce(mockConfig); // 1回のupdate用

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "287": "0",
          "334": "CLMAuthLoginAck",
          "688": "10089",
          "689": "phone auth required",
        }),
      );

      await expect(client.login()).rejects.toThrow("Tachibana login blocked (電話番号認証が必要)");

      // 1回のupdateでisActive停止 + ロック理由 + 発生日時をまとめて書き込み
      expect(mockTradingConfigUpdate).toHaveBeenCalledWith({
        where: { id: "config-1" },
        data: expect.objectContaining({
          isActive: false,
          loginLockedUntil: expect.any(Date),
          loginLockReason: "電話番号認証が必要",
          loginLockOccurredAt: expect.any(Date),
        }),
      });
    });

    it("正常ログイン成功時にDBのロック状態をクリアする", async () => {
      const mockConfig = { id: "config-1" };
      mockTradingConfigFindFirst
        .mockResolvedValueOnce(null)        // ロックチェック
        .mockResolvedValueOnce(mockConfig); // 成功後クリア用

      mockFetch.mockResolvedValueOnce(loginSuccessResponse());

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
      mockFetch.mockResolvedValueOnce(loginSuccessResponse());
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
      mockFetch.mockResolvedValueOnce(loginSuccessResponse());
      await client.login();

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("https://demo-kabuka.e-shiten.jp/e_api_v4r9/auth/?");
      // URLエンコードされたJSONが含まれる
      expect(calledUrl).toContain("%7B");
    });
  });

  describe("logout", () => {
    it("ログアウト後はisLoggedInがfalseになる", async () => {
      // ログイン
      mockFetch.mockResolvedValueOnce(loginSuccessResponse());
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
