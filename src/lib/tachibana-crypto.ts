/**
 * 立花証券 e支店 API (v4r9) 公開鍵暗号ユーティリティ
 *
 * v4r9 のログイン応答で返る仮想URLは、利用設定画面で登録した公開鍵で
 * RSA-OAEP(SHA-256) 暗号化 + Base64 エンコードされている。
 * ペアとなる秘密鍵で復号して利用する。
 *
 * openssl 等価コマンド:
 *   cat val.txt | base64 -d | openssl pkeyutl -decrypt -inkey pr.pem \
 *     -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:SHA256
 */

import crypto from "crypto";

/**
 * 環境変数 TACHIBANA_PRIVATE_KEY から秘密鍵(PEM)を読み込む。
 *
 * 以下いずれの形式も受け付ける:
 *   - 生のPEM（実際の改行、またはリテラル "\n" を含む1行表現）
 *   - PEM全体をBase64エンコードした文字列（.env で改行を扱わないための推奨形式）
 */
export function loadTachibanaPrivateKey(): string {
  const raw = process.env.TACHIBANA_PRIVATE_KEY;
  if (!raw) {
    throw new Error(
      "TACHIBANA_PRIVATE_KEY is required in environment variables",
    );
  }

  if (raw.includes("-----BEGIN")) {
    // リテラル \n を実改行に戻す（.env に1行で書いた場合への対応）
    return raw.replace(/\\n/g, "\n");
  }

  // PEM ではない → Base64 エンコードされた PEM とみなしてデコード
  return Buffer.from(raw, "base64").toString("utf-8");
}

/**
 * 公開鍵で暗号化された仮想URL値（Base64）を秘密鍵で復号する。
 */
export function decryptVirtualUrl(
  encryptedBase64: string,
  privateKeyPem: string,
): string {
  const buffer = Buffer.from(encryptedBase64, "base64");
  const decrypted = crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    buffer,
  );
  return decrypted.toString("utf-8");
}
