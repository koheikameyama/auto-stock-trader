import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// THREADS_USER_TOKEN はモジュール読み込み時に評価されるため、import より先に注入する
vi.hoisted(() => {
  process.env.THREADS_USER_TOKEN = "test-token";
  process.env.THREADS_USER_ID = "me";
});

import { postToThreads } from "../threads";

/** Graph API の成功応答 */
function ok(id: string) {
  return { ok: true, status: 200, json: async () => ({ id }) };
}

/** Graph API のエラー応答 */
function apiError(code: number, message: string, type = "OAuthException") {
  return {
    ok: false,
    status: 400,
    json: async () => ({ error: { code, message, type } }),
  };
}

const fetchMock = vi.fn();

/**
 * postToThreads は待機を挟むのでフェイクタイマーを進めながら解決させる。
 * 実時間で待つと1テスト 5〜30 秒かかる。
 *
 * タイマーを進める前に rejection ハンドラを繋いでおく。そうしないと待機中に
 * reject したときへ誰も掴んでおらず unhandled rejection になる。
 */
async function runPost(text = "テスト投稿"): Promise<void> {
  const settled = postToThreads(text).then(
    () => ({ failed: false }) as const,
    (e: unknown) => ({ failed: true, e }) as const,
  );
  await vi.runAllTimersAsync();
  const result = await settled;
  if (result.failed) throw result.e;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("postToThreads", () => {
  it("コンテナ作成 → publish の2段階を叩いて投稿する", async () => {
    fetchMock
      .mockResolvedValueOnce(ok("container-1"))
      .mockResolvedValueOnce(ok("post-1"));

    await runPost();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("/me/threads");
    expect(fetchMock.mock.calls[1][0]).toContain("/me/threads_publish");
    // publish には作成した container の id が渡る
    expect(String(fetchMock.mock.calls[1][1].body)).toContain(
      "creation_id=container-1",
    );
  });

  // KOH-562: コンテナ作成の間欠失敗。KOH-546 の修正は publish にしか掛かっておらず、
  // ここが一発勝負のまま残っていて 2026-07-16 の投稿が落ちた
  it("コンテナ作成が unknown error で落ちてもリトライして成功する", async () => {
    fetchMock
      .mockResolvedValueOnce(apiError(1, "An unknown error occurred"))
      .mockResolvedValueOnce(ok("container-1"))
      .mockResolvedValueOnce(ok("post-1"));

    await runPost();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toContain("/me/threads");
  });

  // KOH-546 の回帰。container のメディア処理完了前に publish すると返る
  it("publish が does not exist で落ちてもリトライして成功する", async () => {
    fetchMock
      .mockResolvedValueOnce(ok("container-1"))
      .mockResolvedValueOnce(
        apiError(24, "The requested resource does not exist"),
      )
      .mockResolvedValueOnce(ok("post-1"));

    await runPost();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("トークン失効（code 190）はリトライせず即座に諦める", async () => {
    fetchMock.mockResolvedValue(apiError(190, "Session has expired"));

    await expect(runPost()).rejects.toThrow("Session has expired");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("不正パラメータ（code 100）はリトライしない", async () => {
    fetchMock.mockResolvedValue(apiError(100, "Invalid parameter"));

    await expect(runPost()).rejects.toThrow("Invalid parameter");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("一時エラーが続く場合は上限まで試して諦める", async () => {
    fetchMock.mockResolvedValue(apiError(1, "An unknown error occurred"));

    await expect(runPost()).rejects.toThrow("An unknown error occurred");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("エラーには Meta の code / type を含めて原因を切り分けられるようにする", async () => {
    fetchMock.mockResolvedValue(
      apiError(1, "An unknown error occurred", "OAuthException"),
    );

    await expect(runPost()).rejects.toThrow("[code 1/OAuthException]");
  });

  it("500文字を超える本文は切り詰めて送る", async () => {
    fetchMock
      .mockResolvedValueOnce(ok("container-1"))
      .mockResolvedValueOnce(ok("post-1"));

    await runPost("あ".repeat(600));

    const body = new URLSearchParams(String(fetchMock.mock.calls[0][1].body));
    expect([...body.get("text")!]).toHaveLength(500);
    expect(body.get("text")!.endsWith("…")).toBe(true);
  });
});
