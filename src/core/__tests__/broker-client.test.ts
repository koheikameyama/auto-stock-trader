import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import iconv from "iconv-lite";
import { TachibanaClient, resetTachibanaClient } from "../broker-client";

const {
  mockTradingConfigFindFirst,
  mockTradingConfigUpdate,
  mockBrokerSessionUpsert,
  mockBrokerSessionFindUnique,
} = vi.hoisted(() => ({
  mockTradingConfigFindFirst: vi.fn(),
  mockTradingConfigUpdate: vi.fn(),
  mockBrokerSessionUpsert: vi.fn(),
  mockBrokerSessionFindUnique: vi.fn(),
}));

const { mockNotifySlack } = vi.hoisted(() => ({ mockNotifySlack: vi.fn() }));

vi.mock("../../lib/slack", () => ({
  notifySlack: mockNotifySlack,
  notifyBrokerError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingConfig: {
      findFirst: mockTradingConfigFindFirst,
      update: mockTradingConfigUpdate,
    },
    brokerSession: {
      upsert: mockBrokerSessionUpsert,
      findUnique: mockBrokerSessionFindUnique,
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

/** Shift_JISエンコードのレスポンス（日本語エラーテキストが fetchWithDecode で正しく復号されるように） */
function createMockResponseSjis(data: Record<string, string>) {
  const buffer = iconv.encode(JSON.stringify(data), "shift_jis");
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: () => Promise.resolve(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
  };
}

/** ログイン成功レスポンス（仮想URLは暗号化済み） */
function loginSuccessResponse() {
  return createMockResponse({
    "311": "0",
    "357": "CLMAuthLoginAck",
    "896": encUrl("https://vurl/request/"),
    "894": encUrl("https://vurl/master/"),
    "895": encUrl("https://vurl/price/"),
    "892": encUrl("https://vurl/event/"),
    "893": encUrl("wss://vurl/ws/"),
    "542": "0",
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
    mockBrokerSessionUpsert.mockReset();
    mockBrokerSessionUpsert.mockResolvedValue({});
    mockBrokerSessionFindUnique.mockReset();
    mockBrokerSessionFindUnique.mockResolvedValue(null);
    mockNotifySlack.mockReset();
    mockNotifySlack.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
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

    it("仮想URLの数値キー割り当てがズレている場合はエラーをスローし、セッションをDBに保存しない", async () => {
      // 892(request)と896(event)を入れ替え、キー対応が壊れているケースを再現する。
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "311": "0",
          "357": "CLMAuthLoginAck",
          "896": encUrl("https://vurl/event/"),
          "894": encUrl("https://vurl/master/"),
          "895": encUrl("https://vurl/price/"),
          "892": encUrl("https://vurl/request/"),
          "893": encUrl("wss://vurl/ws/"),
          "542": "0",
        }),
      );

      await expect(client.login()).rejects.toThrow(
        "numeric key mapping is likely wrong",
      );
      expect(mockBrokerSessionUpsert).not.toHaveBeenCalled();
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
          "311": "1",
          "310": "Authentication failed",
          "357": "CLMAuthLoginAck",
        }),
      );

      await expect(client.login()).rejects.toThrow("Tachibana login failed");
    });

    it("金商法お知らせ未読時にエラーをスローする", async () => {
      // sKinsyouhouMidokuFlg の数値キーは v4r10 で未確定のため、名前付きキーで
      // 直接送るケース（checkMaintenanceNotices と同様のフォールバック経路）をテストする。
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "311": "0",
          "357": "CLMAuthLoginAck",
          sKinsyouhouMidokuFlg: "1",
          "896": encUrl("https://vurl/request/"),
          "894": encUrl("https://vurl/master/"),
          "895": encUrl("https://vurl/price/"),
        }),
      );

      await expect(client.login()).rejects.toThrow("金商法のお知らせ（交付書面等）が未読");
    });

    it("v4r10 のログイン応答で 542=1（未読フラグ）ならブロックとして Slack に通知する", async () => {
      // 2026-10-01 本番実測: 交付書面の確認前は "542":"1" で仮想URLが空、確認後は "0"
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "311": "0",
          "357": "CLMAuthLoginAck",
          "542": "1",
          "873": "20261001",
          "896": "",
        }),
      );

      await expect(client.login()).rejects.toThrow("金商法のお知らせ（交付書面等）が未読");
      expect(mockNotifySlack).toHaveBeenCalledWith(
        expect.objectContaining({ color: "danger" }),
      );
    });

    it("交付書面更新日を過ぎて仮想URLが空のときは書面未確認と明示し Slack に通知する", async () => {
      // 2026-10-01 本番実測: 書面未確認だと sResultCode=0 のまま仮想URLが空で返る
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "311": "0",
          "357": "CLMAuthLoginAck",
          "873": "20000101",
          "892": "",
          "893": "",
          "894": "",
          "895": "",
          "896": "",
        }),
      );

      await expect(client.login()).rejects.toThrow("交付書面（更新日 20000101）が未確認");
      expect(mockNotifySlack).toHaveBeenCalledWith(
        expect.objectContaining({ color: "danger" }),
      );
    });

    it("交付書面更新日が未来なら仮想URL欠落は従来どおりのエラーにする", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "311": "0",
          "357": "CLMAuthLoginAck",
          "873": "29991231",
          "896": "",
        }),
      );

      await expect(client.login()).rejects.toThrow("virtual URLs are missing");
      expect(mockNotifySlack).not.toHaveBeenCalledWith(
        expect.objectContaining({ color: "danger" }),
      );
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
          "311": "0",
          "357": "CLMAuthLoginAck",
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
          "311": "0",
          "357": "CLMAuthLoginAck",
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

  describe("保守通知", () => {
    function loginWithWebDoc(webDoc: string) {
      return createMockResponse({
        "311": "0",
        "357": "CLMAuthLoginAck",
        "542": "0",
        "873": webDoc,
        "896": encUrl("https://vurl/request/"),
        "894": encUrl("https://vurl/master/"),
        "895": encUrl("https://vurl/price/"),
      });
    }
    const warningCall = expect.objectContaining({ color: "warning" });

    it("交付書面更新日が未来なら通知し、通知内容を DB に記録する", async () => {
      mockTradingConfigFindFirst.mockResolvedValue({ id: "cfg1", maintenanceNoticeKey: null });
      mockFetch.mockResolvedValueOnce(loginWithWebDoc("29991231"));

      await client.login();

      expect(mockNotifySlack).toHaveBeenCalledWith(warningCall);
      expect(mockTradingConfigUpdate).toHaveBeenCalledWith({
        where: { id: "cfg1" },
        data: { maintenanceNoticeKey: "交付書面更新予定日: 29991231" },
      });
    });

    it("別プロセスで通知済み（DB のキーが一致）なら再通知しない", async () => {
      mockTradingConfigFindFirst.mockResolvedValue({
        id: "cfg1",
        maintenanceNoticeKey: "交付書面更新予定日: 29991231",
      });
      mockFetch.mockResolvedValueOnce(loginWithWebDoc("29991231"));

      await client.login();

      expect(mockNotifySlack).not.toHaveBeenCalledWith(warningCall);
    });

    it("交付書面更新日の当日以降は通知しない（未確認なら未読フラグ検知が 🚨 を出す）", async () => {
      const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" })
        .format(new Date())
        .replaceAll("-", "");
      mockFetch.mockResolvedValueOnce(loginWithWebDoc(today));

      await client.login();

      expect(mockNotifySlack).not.toHaveBeenCalled();
    });
  });

  describe("request", () => {
    it("セッションがない場合は自動ログインを試みる（失敗時はエラー）", async () => {
      // fetchモックが設定されていないので自動ログインが失敗する
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          "311": "1",
          "310": "login failed",
          "357": "CLMAuthLoginAck",
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
          "311": "0",
          "357": "CLMOrderList",
          "688": "0",
        }),
      );

      const res = await client.request({ sCLMID: "CLMOrderList" });
      expect(res.sResultCode).toBe("0");
      expect(res.sOrderResultCode).toBe("0");
    });

    it("p_no順序エラー時はサーバ最終p_no+余裕まで先行してリトライ成功する", async () => {
      // ログイン
      mockFetch.mockResolvedValueOnce(loginSuccessResponse());
      await client.login();

      // 1回目: p_no順序エラー（サーバ最終p_no=5000）→ 2回目: 成功
      // 日本語エラーテキストは fetchWithDecode が shift_jis で復号するため SJIS で返す。
      mockFetch
        .mockResolvedValueOnce(
          createMockResponseSjis({
            "311": "6",
            "310": "引数（p_no:[2] <= 前要求.p_no:[5000]）エラー。",
            "357": "CLMOrderList",
          }),
        )
        .mockResolvedValueOnce(
          createMockResponse({ "311": "0", "357": "CLMOrderList" }),
        );

      const res = await client.request({ sCLMID: "CLMOrderList" });
      expect(res.sResultCode).toBe("0");

      // リトライ送信のp_noが「サーバ最終5000 + 余裕1000 + インクリメント1 = 6001」であること。
      // +1しか先行しないと並行プロセスに即追い抜かれるため、余裕分の先行が回帰しないよう固定する。
      const retryUrl = mockFetch.mock.calls.at(-1)![0] as string;
      const retryParams = JSON.parse(
        decodeURIComponent(retryUrl.split("?")[1]),
      );
      expect(retryParams.p_no).toBe("6001");
    });
  });

  describe("ログイン頻度の抑制（2026-10-02 立花の高負荷警告）", () => {
    /** 認証エンドポイント（/auth/）への fetch 回数 */
    const authCalls = () =>
      mockFetch.mock.calls.filter(([url]) => String(url).includes("/auth/")).length;

    const savedSession = (loginAt: Date, prefix = "https://saved") => ({
      env: "demo",
      urlRequest: `${prefix}/request/`,
      urlMaster: `${prefix}/master/`,
      urlPrice: `${prefix}/price/`,
      urlEvent: `${prefix}/event/`,
      urlEventWebSocket: "wss://saved/ws/",
      loginAt,
    });

    it("同時に呼ばれた login() は1本のログインに束ねる", async () => {
      mockFetch.mockResolvedValueOnce(loginSuccessResponse());

      const [a, b, c] = await Promise.all([client.login(), client.login(), client.login()]);

      expect(authCalls()).toBe(1);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it("交付書面ブロックを検知したら DB にクールダウンを書いて全プロセスのログインを止める", async () => {
      mockTradingConfigFindFirst.mockResolvedValue({ id: "cfg1", loginLockedUntil: null });
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ "311": "0", "357": "CLMAuthLoginAck", "542": "1", "873": "20261001", "896": "" }),
      );

      await expect(client.login()).rejects.toThrow("未読");

      const lockWrite = mockTradingConfigUpdate.mock.calls.find(
        ([arg]) => arg.data.loginLockReason === "交付書面未確認",
      );
      expect(lockWrite).toBeDefined();
      const lockedUntil = lockWrite![0].data.loginLockedUntil as Date;
      expect(lockedUntil.getTime() - Date.now()).toBeGreaterThan(55 * 60 * 1000);
      // ブロック検知後にロックを消してしまわない（旧実装は未読チェック前にクリアしていた）
      expect(
        mockTradingConfigUpdate.mock.calls.some(
          ([arg]) => arg.data.loginLockedUntil === null,
        ),
      ).toBe(false);
    });

    it("セッション切れ時、別プロセスがDBに保存した新しいセッションがあればログインせず採用する", async () => {
      mockFetch.mockResolvedValueOnce(loginSuccessResponse());
      await client.login();
      const newer = savedSession(new Date(Date.now() + 60_000));
      mockBrokerSessionFindUnique.mockResolvedValue(newer);

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ "311": "2", "357": "CLMOrderList" }))
        .mockResolvedValueOnce(createMockResponse({ "311": "0", "357": "CLMOrderList" }));

      const res = await client.request({ sCLMID: "CLMOrderList" });

      expect(res.sResultCode).toBe("0");
      expect(authCalls()).toBe(1); // 最初のログインのみ
      expect(String(mockFetch.mock.calls.at(-1)![0])).toContain("https://saved/request/");
    });

    it("直近ログインから間もなくセッションが切れた場合は再ログインしない", async () => {
      mockFetch.mockResolvedValueOnce(loginSuccessResponse());
      const session = await client.login();
      mockBrokerSessionFindUnique.mockResolvedValue(savedSession(session.loginAt));

      mockFetch.mockResolvedValue(createMockResponse({ "311": "2", "357": "CLMOrderList" }));

      await expect(client.request({ sCLMID: "CLMOrderList" })).rejects.toThrow("re-login throttled");
      expect(authCalls()).toBe(1);
    });

    it("別プロセスがDB上で直近にログインしたばかりなら、自プロセスの初回でも再ログインしない", async () => {
      // 自プロセスはDBから古い（同じ）セッションを復元済み、DBのloginAtは5分前
      const recent = savedSession(new Date(Date.now() - 5 * 60_000));
      mockBrokerSessionFindUnique.mockResolvedValue(recent);
      await client.restoreFromDB();

      mockFetch.mockResolvedValue(createMockResponse({ "311": "2", "357": "CLMOrderList" }));

      await expect(client.request({ sCLMID: "CLMOrderList" })).rejects.toThrow("re-login throttled");
      expect(authCalls()).toBe(0);
    });

    it("最小間隔を過ぎていれば再ログインする", async () => {
      const old = savedSession(new Date(Date.now() - 3 * 60 * 60_000));
      mockBrokerSessionFindUnique.mockResolvedValue(old);
      await client.restoreFromDB();

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ "311": "2", "357": "CLMOrderList" }))
        .mockResolvedValueOnce(loginSuccessResponse())
        .mockResolvedValueOnce(createMockResponse({ "311": "0", "357": "CLMOrderList" }));

      const res = await client.request({ sCLMID: "CLMOrderList" });
      expect(res.sResultCode).toBe("0");
      expect(authCalls()).toBe(1);
    });

    describe("ensureDailySession", () => {
      it("当日（06:00 JST以降）のセッションがDBにあればログインせず採用する", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-05T07:00:00+09:00"));
        mockBrokerSessionFindUnique.mockResolvedValue(
          savedSession(new Date("2026-10-05T06:30:00+09:00")),
        );

        await client.ensureDailySession();

        expect(authCalls()).toBe(0);
        expect(client.getSession()?.urlRequest).toBe("https://saved/request/");
      });

      it("前日のセッションしか無ければログインする", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-05T07:00:00+09:00"));
        mockBrokerSessionFindUnique.mockResolvedValue(
          savedSession(new Date("2026-10-04T23:00:00+09:00")),
        );
        mockFetch.mockResolvedValueOnce(loginSuccessResponse());

        await client.ensureDailySession();

        expect(authCalls()).toBe(1);
      });
    });
  });

  describe("encodeParams", () => {
    it("URLにJSON文字列をエンコードして送信する", async () => {
      mockFetch.mockResolvedValueOnce(loginSuccessResponse());
      await client.login();

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("https://demo-kabuka.e-shiten.jp/e_api_v4r10/auth/?");
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
        createMockResponse({ "311": "0" }),
      );
      await client.logout();
      expect(client.isLoggedIn()).toBe(false);
    });
  });
});
