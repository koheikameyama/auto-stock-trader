import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "crypto";
import {
  decryptVirtualUrl,
  loadTachibanaPrivateKey,
} from "../tachibana-crypto";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function encrypt(plaintext: string): string {
  return crypto
    .publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(plaintext, "utf-8"),
    )
    .toString("base64");
}

describe("tachibana-crypto", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("decryptVirtualUrl", () => {
    it("公開鍵で暗号化した値を秘密鍵で復号できる", () => {
      const url = "https://kabuka.e-shiten.jp/e_api_v4r9/request/TOKEN==/";
      const decrypted = decryptVirtualUrl(encrypt(url), privateKey);
      expect(decrypted).toBe(url);
    });

    it("対応しない秘密鍵では復号に失敗する", () => {
      const other = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      expect(() =>
        decryptVirtualUrl(encrypt("https://x/"), other.privateKey),
      ).toThrow();
    });
  });

  describe("loadTachibanaPrivateKey", () => {
    it("生のPEMをそのまま返す", () => {
      vi.stubEnv("TACHIBANA_PRIVATE_KEY", privateKey);
      expect(loadTachibanaPrivateKey()).toBe(privateKey);
    });

    it("リテラル \\n を含む1行PEMを実改行に戻す", () => {
      const oneLine = privateKey.replace(/\n/g, "\\n");
      vi.stubEnv("TACHIBANA_PRIVATE_KEY", oneLine);
      expect(loadTachibanaPrivateKey()).toBe(privateKey);
    });

    it("Base64エンコードされたPEMをデコードする", () => {
      const b64 = Buffer.from(privateKey, "utf-8").toString("base64");
      vi.stubEnv("TACHIBANA_PRIVATE_KEY", b64);
      expect(loadTachibanaPrivateKey()).toBe(privateKey);
    });

    it("Base64経由で読み込んだ鍵でも復号できる", () => {
      const b64 = Buffer.from(privateKey, "utf-8").toString("base64");
      vi.stubEnv("TACHIBANA_PRIVATE_KEY", b64);
      const loaded = loadTachibanaPrivateKey();
      const url = "wss://kabuka.e-shiten.jp/e_api_v4r9/event/ws/";
      expect(decryptVirtualUrl(encrypt(url), loaded)).toBe(url);
    });

    it("環境変数がない場合はエラーをスローする", () => {
      vi.stubEnv("TACHIBANA_PRIVATE_KEY", "");
      expect(() => loadTachibanaPrivateKey()).toThrow(
        "TACHIBANA_PRIVATE_KEY is required",
      );
    });
  });
});
