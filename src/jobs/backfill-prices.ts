/**
 * 株価データ初期取得 / バックフィル
 *
 * 1. 日経225主要銘柄をStockテーブルに登録
 * 2. 各銘柄の最新株価・出来高を更新
 * 3. TradingConfig の初期設定（存在しない場合）
 */

import { prisma } from "../lib/prisma";
import { TRADING_DEFAULTS, YAHOO_FINANCE, SCREENING } from "../lib/constants";
import { fetchStockQuote, fetchHistoricalData } from "../core/market-data";
import { analyzeTechnicals } from "../core/technical-analysis";
import { normalizeTickerCode } from "../lib/ticker-utils";
import pLimit from "p-limit";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 日経225主要銘柄（代表的な銘柄を選定）
const NIKKEI_TICKERS = [
  // 半導体・電子部品
  { ticker: "6857", name: "アドバンテスト", market: "東証プライム", sector: "電気機器" },
  { ticker: "6920", name: "レーザーテック", market: "東証プライム", sector: "電気機器" },
  { ticker: "8035", name: "東京エレクトロン", market: "東証プライム", sector: "電気機器" },
  { ticker: "6723", name: "ルネサスエレクトロニクス", market: "東証プライム", sector: "電気機器" },
  { ticker: "6146", name: "ディスコ", market: "東証プライム", sector: "機械" },
  // 自動車
  { ticker: "7203", name: "トヨタ自動車", market: "東証プライム", sector: "輸送用機器" },
  { ticker: "7267", name: "本田技研工業", market: "東証プライム", sector: "輸送用機器" },
  { ticker: "7269", name: "スズキ", market: "東証プライム", sector: "輸送用機器" },
  // 金融
  { ticker: "8306", name: "三菱UFJフィナンシャル・グループ", market: "東証プライム", sector: "銀行業" },
  { ticker: "8316", name: "三井住友フィナンシャルグループ", market: "東証プライム", sector: "銀行業" },
  { ticker: "8411", name: "みずほフィナンシャルグループ", market: "東証プライム", sector: "銀行業" },
  { ticker: "8766", name: "東京海上ホールディングス", market: "東証プライム", sector: "保険業" },
  // 商社
  { ticker: "8001", name: "伊藤忠商事", market: "東証プライム", sector: "卸売業" },
  { ticker: "8058", name: "三菱商事", market: "東証プライム", sector: "卸売業" },
  { ticker: "8031", name: "三井物産", market: "東証プライム", sector: "卸売業" },
  // IT・通信
  { ticker: "9984", name: "ソフトバンクグループ", market: "東証プライム", sector: "情報・通信業" },
  { ticker: "9433", name: "KDDI", market: "東証プライム", sector: "情報・通信業" },
  { ticker: "4755", name: "楽天グループ", market: "東証プライム", sector: "サービス業" },
  { ticker: "4689", name: "LINEヤフー", market: "東証プライム", sector: "情報・通信業" },
  // 医薬品
  { ticker: "4502", name: "武田薬品工業", market: "東証プライム", sector: "医薬品" },
  { ticker: "4519", name: "中外製薬", market: "東証プライム", sector: "医薬品" },
  { ticker: "4568", name: "第一三共", market: "東証プライム", sector: "医薬品" },
  // 小売・食品
  { ticker: "9983", name: "ファーストリテイリング", market: "東証プライム", sector: "小売業" },
  { ticker: "7974", name: "任天堂", market: "東証プライム", sector: "その他製品" },
  { ticker: "2801", name: "キッコーマン", market: "東証プライム", sector: "食料品" },
  // 電機・機械
  { ticker: "6758", name: "ソニーグループ", market: "東証プライム", sector: "電気機器" },
  { ticker: "6501", name: "日立製作所", market: "東証プライム", sector: "電気機器" },
  { ticker: "6702", name: "富士通", market: "東証プライム", sector: "電気機器" },
  { ticker: "6861", name: "キーエンス", market: "東証プライム", sector: "電気機器" },
  { ticker: "6367", name: "ダイキン工業", market: "東証プライム", sector: "機械" },
  // 不動産・建設
  { ticker: "8830", name: "住友不動産", market: "東証プライム", sector: "不動産業" },
  { ticker: "1925", name: "大和ハウス工業", market: "東証プライム", sector: "建設業" },
  // 素材
  { ticker: "5401", name: "日本製鉄", market: "東証プライム", sector: "鉄鋼" },
  { ticker: "4063", name: "信越化学工業", market: "東証プライム", sector: "化学" },
  // 運輸
  { ticker: "9020", name: "東日本旅客鉄道", market: "東証プライム", sector: "陸運業" },
  { ticker: "9022", name: "東海旅客鉄道", market: "東証プライム", sector: "陸運業" },
];

export async function main() {
  console.log("=== Backfill Prices 開始 ===");

  // 1. 銘柄マスタ登録
  console.log(`[1/3] 銘柄マスタ登録... (${NIKKEI_TICKERS.length}銘柄)`);

  for (const stock of NIKKEI_TICKERS) {
    const tickerCode = normalizeTickerCode(stock.ticker);

    await prisma.stock.upsert({
      where: { tickerCode },
      create: {
        tickerCode,
        name: stock.name,
        market: stock.market,
        sector: stock.sector,
      },
      update: {
        name: stock.name,
        market: stock.market,
        sector: stock.sector,
      },
    });
  }
  console.log("  銘柄マスタ登録完了");

  // 2. 株価データ更新
  console.log("[2/3] 株価データ更新中...");
  const allStocks = await prisma.stock.findMany({ where: { isDelisted: false } });
  const limit = pLimit(5);
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < allStocks.length; i += YAHOO_FINANCE.BATCH_SIZE) {
    const batch = allStocks.slice(i, i + YAHOO_FINANCE.BATCH_SIZE);

    await Promise.all(
      batch.map((stock) =>
        limit(async () => {
          try {
            const quote = await fetchStockQuote(stock.tickerCode);
            if (!quote) {
              failed++;
              // 失敗カウント更新
              await prisma.stock.update({
                where: { id: stock.id },
                data: {
                  fetchFailCount: stock.fetchFailCount + 1,
                  isDelisted: stock.fetchFailCount + 1 >= 5,
                },
              });
              return;
            }

            // ヒストリカルデータからATRを計算
            let atr14: number | null = null;
            let weekChange: number | null = null;
            let volatility: number | null = null;

            const historical = await fetchHistoricalData(stock.tickerCode);
            if (historical && historical.length >= 15) {
              const summary = analyzeTechnicals(historical);
              atr14 = summary.atr14;

              // 週間変化率
              if (historical.length >= 5) {
                const current = historical[0].close;
                const weekAgo = historical[4].close;
                weekChange =
                  Math.round(((current - weekAgo) / weekAgo) * 10000) / 100;
              }

              // ボラティリティ（ATR / 株価 %）
              if (atr14 && quote.price > 0) {
                volatility =
                  Math.round((atr14 / quote.price) * 10000) / 100;
              }
            }

            await prisma.stock.update({
              where: { id: stock.id },
              data: {
                latestPrice: quote.price,
                latestVolume: BigInt(quote.volume),
                dailyChangeRate: quote.changePercent,
                weekChangeRate: weekChange,
                volatility,
                atr14,
                latestPriceDate: new Date(),
                priceUpdatedAt: new Date(),
                fetchFailCount: 0,
              },
            });

            updated++;
            console.log(
              `  ✓ ${stock.tickerCode} ${stock.name}: ¥${quote.price.toLocaleString()}`,
            );
          } catch (error) {
            failed++;
            console.error(`  ✗ ${stock.tickerCode}: ${error}`);
          }
        }),
      ),
    );

    if (i + YAHOO_FINANCE.BATCH_SIZE < allStocks.length) {
      await sleep(YAHOO_FINANCE.RATE_LIMIT_DELAY_MS);
    }
  }

  console.log(`  更新: ${updated}件, 失敗: ${failed}件`);

  // 3. TradingConfig 初期設定
  console.log("[3/3] TradingConfig 確認...");
  const config = await prisma.tradingConfig.findFirst();

  if (!config) {
    await prisma.tradingConfig.create({
      data: {
        totalBudget: TRADING_DEFAULTS.TOTAL_BUDGET,
        maxPositions: TRADING_DEFAULTS.MAX_POSITIONS,
        maxPositionPct: TRADING_DEFAULTS.MAX_POSITION_PCT,
        maxDailyLossPct: TRADING_DEFAULTS.MAX_DAILY_LOSS_PCT,
        isActive: true,
      },
    });
    console.log(
      `  TradingConfig作成: 予算¥${TRADING_DEFAULTS.TOTAL_BUDGET.toLocaleString()}`,
    );
  } else {
    console.log(
      `  TradingConfig存在: 予算¥${Number(config.totalBudget).toLocaleString()}`,
    );
  }

  console.log("=== Backfill Prices 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("backfill-prices");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Backfill Prices エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
