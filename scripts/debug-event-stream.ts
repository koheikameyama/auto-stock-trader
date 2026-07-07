/**
 * EVENT I/F の ST/SS/US メッセージ調査用スクリプト
 *
 * デモ環境に接続して、受信したメッセージをすべてログ出力する。
 * Usage: npx tsx scripts/debug-event-stream.ts
 */

import "@dotenvx/dotenvx/config";
import { getTachibanaClient } from "../src/core/broker-client";
import { getBrokerEventStream } from "../src/core/broker-event-stream";

async function main() {
  console.log("=== EVENT I/F デバッグ ===");
  console.log(`TACHIBANA_ENV: ${process.env.TACHIBANA_ENV ?? "demo"}`);

  // ログイン
  const client = getTachibanaClient();
  const session = await client.login();
  console.log(`ログイン成功: wsUrl=${session.urlEventWebSocket}`);

  // WebSocket接続
  const stream = getBrokerEventStream();

  stream.on("connected", () => {
    console.log("\n✅ WebSocket 接続成功 — メッセージ待機中...\n");
  });

  stream.on("keepalive", () => {
    process.stdout.write(".");
  });

  stream.on("status", (data: { type: string; fields: Record<string, string> }) => {
    console.log(`\n📨 [${data.type}] ${JSON.stringify(data.fields, null, 2)}`);
  });

  stream.on("execution", (data: unknown) => {
    console.log(`\n📨 [EC] ${JSON.stringify(data, null, 2)}`);
  });

  stream.on("error", (err: Error) => {
    console.error(`\n❌ Error: ${err.message}`);
  });

  stream.on("disconnected", (code: number) => {
    console.log(`\n🔌 Disconnected (code=${code})`);
  });

  stream.connect(session.urlEventWebSocket);

  // 60秒後に切断
  const WAIT_SEC = 60;
  console.log(`${WAIT_SEC}秒間メッセージを受信します...`);

  await new Promise((resolve) => setTimeout(resolve, WAIT_SEC * 1000));

  stream.disconnect();
  await client.logout();
  console.log("\n\n=== 完了 ===");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
