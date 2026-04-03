/**
 * 指定銘柄の注文・現在値・保有状況をブローカーAPIで確認するデバッグスクリプト
 * Usage: npx tsx scripts/check-order-status.ts 1963
 */

import "dotenv/config";
import { getTachibanaClient } from "../src/core/broker-client";
import { TACHIBANA_CLMID } from "../src/lib/constants/broker";
import { tickerToBrokerCode } from "../src/lib/ticker-utils";

const ticker = process.argv[2] ?? "1963";
const brokerCode = tickerToBrokerCode(`${ticker}.T`);

async function main() {
  console.log(`=== 銘柄チェック: ${ticker}.T (ブローカーコード: ${brokerCode}) ===\n`);

  const client = getTachibanaClient();
  await client.login();
  console.log("ログイン成功\n");

  // 1. 現在値
  console.log("--- 現在値 ---");
  const priceRes = await client.requestPrice({
    sCLMID: TACHIBANA_CLMID.MARKET_PRICE,
    sTargetIssueCode: brokerCode,
    sTargetSizyouC: "00",
    sTargetColumn: "pDPP,pDOP,pDHP,pDLP,pPRP,pDV,pDYWP,pDYRP,pQAP,pQBP",
  });
  if (priceRes.sResultCode === "0") {
    // mapNumericKeys により数値キーはすでに変換済み
    const list = (priceRes.aMarketPriceList as Record<string, unknown>[]) ?? [];
    if (list.length > 0) {
      const p = list[0];
      console.log(`  現在値:    ¥${p.pCurrentPrice ?? "-"}`);
      console.log(`  前日終値:  ¥${p.pPreviousClose ?? "-"}`);
      console.log(`  始値:      ¥${p.pOpenPrice ?? "-"}`);
      console.log(`  高値:      ¥${p.pHighPrice ?? "-"}`);
      console.log(`  安値:      ¥${p.pLowPrice ?? "-"}`);
      console.log(`  出来高:    ${p.pVolume ?? "-"}株`);
      console.log(`  前日比:    ${p.pChange ?? "-"}円 (${p.pChangePercent ?? "-"}%)`);
      console.log(`  売気配:    ¥${p.pAskPrice ?? "-"}`);
      console.log(`  買気配:    ¥${p.pBidPrice ?? "-"}`);
    } else {
      console.log("  データなし");
    }
  } else {
    console.log(`  エラー: [${priceRes.sResultCode}] ${priceRes.sResultText}`);
  }

  // 2. 注文一覧（全ステータス）
  // 注意: CLMOrderList の配列はキー"94"で返るがマップ未登録のため生キーで参照
  console.log("\n--- 注文一覧（当日全ステータス） ---");
  const orderRes = await client.request({
    sCLMID: TACHIBANA_CLMID.ORDER_LIST,
    sIssueCode: brokerCode,
    sOrderSyoukaiStatus: "",
  });
  if (orderRes.sResultCode === "0") {
    // aOrderList がマップされていない場合は生キー"94"にフォールバック
    const orders = ((orderRes.aOrderList ?? orderRes["94"]) as Record<string, unknown>[]) ?? [];
    if (!orders.length) {
      console.log("  注文なし");
    } else {
      for (const o of orders) {
        // 各フィールドの実測キー名でフォールバック付きで参照
        const orderNum = o.sOrderOrderNumber ?? o["378"] ?? o.sOrderNumber ?? "-";
        const sikkouDay = o.sOrderSikkouDay ?? o["653"] ?? o.sEigyouDay ?? "-";
        const side = o.sBaibaiKubun ?? o["621"] ?? "-";
        const statusText = o.sOrderStatus ?? o["656"] ?? "-";
        const statusCode = o.sOrderStatusCode ?? o["657"] ?? "-";
        const orderPrice = o.sOrderPrice ?? o["647"] ?? "-";
        const qty = o.sOrderSuryou ?? o["649"] ?? "-";
        const filledQty = o.sOrderYakuzyouSuryou ?? o["633"] ?? "-";
        const reverseTrigger = o.sOrderGyakusasiZyouken ?? o["634"] ?? "-";
        const expiry = o["645"] ?? "-";

        const sideLabel = side === "1" ? "売" : side === "3" ? "買" : side;
        console.log(`  注文番号:     ${orderNum}`);
        console.log(`  営業日:       ${sikkouDay}`);
        console.log(`  売買:         ${sideLabel}`);
        console.log(`  状態:         [${statusCode}] ${statusText}`);
        console.log(`  注文/逆指値:  ¥${orderPrice} / トリガー¥${reverseTrigger}`);
        console.log(`  注文株数:     ${qty}株  約定済: ${filledQty}株`);
        console.log(`  期限:         ${expiry}`);
        console.log("  ---");
      }
    }
  } else {
    console.log(`  エラー: [${orderRes.sResultCode}] ${orderRes.sResultText}`);
  }

  // 3. 保有状況
  // 注意: CLMGenbutuKabuList の配列はキー"88"で返るがマップ未登録のため生キーで参照
  console.log("\n--- 現物保有 ---");
  const holdingsRes = await client.request({
    sCLMID: TACHIBANA_CLMID.HOLDINGS,
    sIssueCode: brokerCode,
  });
  if (holdingsRes.sResultCode === "0") {
    const holdings = ((holdingsRes.aGenbutuKabuList ?? holdingsRes["88"]) as Record<string, unknown>[]) ?? [];
    if (!holdings.length) {
      console.log("  保有なし");
    } else {
      for (const h of holdings) {
        console.log(`  銘柄コード:   ${h.sUriOrderIssueCode ?? "-"}`);
        console.log(`  残高株数:     ${h.sUriOrderZanKabuSuryou ?? "-"}株`);
        console.log(`  売付可能株数: ${h.sUriOrderUritukeKanouSuryou ?? "-"}株`);
        console.log(`  簿価単価:     ¥${h.sUriOrderGaisanBokaTanka ?? "-"}`);
        console.log(`  評価単価:     ¥${h.sUriOrderHyoukaTanka ?? "-"}`);
        console.log(`  評価損益:     ¥${h.sUriOrderGaisanHyoukaSoneki ?? "-"}`);
      }
    }
  } else {
    console.log(`  エラー: [${holdingsRes.sResultCode}] ${holdingsRes.sResultText}`);
  }

  await client.logout();
}

main().catch((e) => {
  console.error("エラー:", e);
  process.exit(1);
});
