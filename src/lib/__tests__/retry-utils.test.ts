import { describe, it, expect, vi } from "vitest";
import { isTransientDbError, withDbRetry } from "../retry-utils";

describe("isTransientDbError", () => {
  it("P1017（サーバ切断）を一時障害として判定する", () => {
    expect(isTransientDbError({ code: "P1017" })).toBe(true);
    expect(
      isTransientDbError(new Error("Server has closed the connection.")),
    ).toBe(true);
  });

  it("その他の接続系エラーも判定する", () => {
    expect(isTransientDbError({ code: "P1001" })).toBe(true);
    expect(isTransientDbError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isTransientDbError(new Error("Connection terminated"))).toBe(true);
  });

  it("一時障害でないエラーは false", () => {
    expect(isTransientDbError(new Error("Unique constraint failed"))).toBe(
      false,
    );
    expect(isTransientDbError({ code: "P2002" })).toBe(false);
  });
});

describe("withDbRetry", () => {
  it("P1017 後に再試行して成功する", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ code: "P1017" })
      .mockResolvedValueOnce("ok");
    const result = await withDbRetry(fn, "test", { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("一時障害でないエラーは即座に再送出し、再試行しない", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Unique constraint failed"));
    await expect(withDbRetry(fn, "test", { baseDelayMs: 1 })).rejects.toThrow(
      "Unique constraint failed",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("maxAttempts を超えたら最後のエラーを送出する", async () => {
    const fn = vi.fn().mockRejectedValue({ code: "P1017" });
    await expect(
      withDbRetry(fn, "test", { maxAttempts: 3, baseDelayMs: 1 }),
    ).rejects.toMatchObject({ code: "P1017" });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
