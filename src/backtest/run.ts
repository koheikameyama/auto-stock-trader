/**
 * バックテスト CLI エントリポイント
 *
 * Usage:
 *   npm run backtest -- --tickers 7203,9432 --start-date 2025-09-01
 *   npm run backtest -- --tickers 7203 --sensitivity
 *   npm run backtest -- --tickers 7203 --output results.json
 */

import { parseArgs } from "node:util";
import dayjs from "dayjs";
import { fetchMultipleBacktestData, fetchVixData } from "./data-fetcher";
import { runBacktest } from "./simulation-engine";
import { runSensitivityAnalysis } from "./sensitivity";
import {
  printBacktestReport,
  printSensitivityReport,
  writeJsonReport,
} from "./reporter";
import type { BacktestConfig } from "./types";

const { values } = parseArgs({
  options: {
    tickers: { type: "string", default: "" },
    "start-date": { type: "string" },
    "end-date": { type: "string" },
    budget: { type: "string", default: "100000" },
    "max-positions": { type: "string", default: "3" },
    "score-threshold": { type: "string", default: "65" },
    "tp-ratio": { type: "string", default: "1.50" },
    "sl-ratio": { type: "string", default: "0.98" },
    "atr-multiplier": { type: "string", default: "1.0" },
    "trailing-activation": { type: "string", default: "1.5" },
    "trail-multiplier": { type: "string" },
    "cooldown-days": { type: "string", default: "5" },
    "max-price": { type: "string", default: "1000" },
    strategy: { type: "string", default: "swing" },
    "no-costs": { type: "boolean", default: false },
    "price-limits": { type: "boolean", default: false },
    "no-gap-risk": { type: "boolean", default: false },
    "override-tp-sl": { type: "boolean", default: false },
    "trend-filter": { type: "boolean", default: false },
    "pullback-filter": { type: "boolean", default: false },
    sensitivity: { type: "boolean", default: false },
    output: { type: "string" },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

function printHelp(): void {
  console.log(`
バックテスト CLI

使い方:
  npm run backtest -- [オプション]

オプション:
  --tickers <codes>       銘柄コード（カンマ区切り）  例: 7203,9432
  --start-date <date>     開始日（YYYY-MM-DD）       デフォルト: 6ヶ月前
  --end-date <date>       終了日（YYYY-MM-DD）       デフォルト: 今日
  --budget <yen>          初期資金                   デフォルト: 100000
  --max-positions <n>     最大同時保有数             デフォルト: 3
  --score-threshold <n>   スコア閾値                 デフォルト: 65
  --tp-ratio <n>          利確比率（TS有効時は高く設定）デフォルト: 1.50
  --sl-ratio <n>          損切比率                   デフォルト: 0.98
  --atr-multiplier <n>    ATR倍率（損切り）           デフォルト: 1.0
  --trailing-activation <n> TS起動ATR倍率            デフォルト: 1.5
  --trail-multiplier <n>  トレール幅ATR倍率          デフォルト: 定数値
  --cooldown-days <n>     SL後の同一銘柄再エントリー禁止日数 デフォルト: 5
  --max-price <yen>       即死ルール価格上限         デフォルト: 1000
  --strategy <type>       day_trade | swing          デフォルト: swing
  --no-costs              取引コストモデルを無効化
  --price-limits          値幅制限シミュレーションを有効化
  --no-gap-risk           ギャップリスク考慮を無効化
  --override-tp-sl        TP/SLを固定比率で上書き（感度分析用、デフォルトは本番ロジック）
  --sensitivity           パラメータ感度分析を実行
  --output <path>         JSON結果を出力
  --verbose               詳細ログ
  --help                  ヘルプ表示
  `);
}

async function main(): Promise<void> {
  if (values.help) {
    printHelp();
    return;
  }

  if (!values.tickers) {
    console.error("エラー: --tickers を指定してください（例: --tickers 7203,9432）");
    process.exit(1);
  }

  const tickers = values.tickers.split(",").map((t) => t.trim()).filter(Boolean);
  const endDate = values["end-date"] ?? dayjs().format("YYYY-MM-DD");
  const startDate =
    values["start-date"] ?? dayjs(endDate).subtract(6, "month").format("YYYY-MM-DD");

  const config: BacktestConfig = {
    tickers,
    startDate,
    endDate,
    initialBudget: Number(values.budget),
    maxPositions: Number(values["max-positions"]),
    scoreThreshold: Number(values["score-threshold"]),
    takeProfitRatio: Number(values["tp-ratio"]),
    stopLossRatio: Number(values["sl-ratio"]),
    atrMultiplier: Number(values["atr-multiplier"]),
    trailingActivationMultiplier: Number(values["trailing-activation"]),
    maxPrice: Number(values["max-price"]),
    strategy: values.strategy === "day_trade" ? "day_trade" : "swing",
    costModelEnabled: !values["no-costs"],
    priceLimitEnabled: values["price-limits"] ?? false,
    gapRiskEnabled: !(values["no-gap-risk"] ?? false),
    cooldownDays: Number(values["cooldown-days"]),
    overrideTpSl: values["override-tp-sl"] ?? false,
    trendFilterEnabled: values["trend-filter"] ?? false,
    pullbackFilterEnabled: values["pullback-filter"] ?? false,
    trailMultiplier: values["trail-multiplier"]
      ? Number(values["trail-multiplier"])
      : undefined,
    outputFile: values.output,
    verbose: values.verbose ?? false,
  };

  console.log("[backtest] 開始");
  const startTime = Date.now();

  // 1. データ取得（VIXを並行取得）
  const [allData, vixData] = await Promise.all([
    fetchMultipleBacktestData(tickers, config.startDate, config.endDate),
    fetchVixData(config.startDate, config.endDate).catch((err) => {
      console.warn("[backtest] VIXデータ取得失敗（crisis halt なし）:", err);
      return new Map<string, number>();
    }),
  ]);

  if (allData.size === 0) {
    console.error("エラー: データを取得できませんでした");
    process.exit(1);
  }

  // 2. バックテスト実行
  console.log("[backtest] シミュレーション実行中...");
  const result = runBacktest(config, allData, vixData);

  // 3. 結果表示
  printBacktestReport(result);

  // 4. 感度分析（オプション）
  let sensitivityResults = null;
  if (values.sensitivity) {
    console.log("[backtest] パラメータ感度分析...");
    sensitivityResults = runSensitivityAnalysis(config, allData, vixData);
    printSensitivityReport(sensitivityResults);
  }

  // 5. JSON出力（オプション）
  if (values.output) {
    writeJsonReport(result, sensitivityResults, values.output);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[backtest] 完了 (${elapsed}秒)`);
}

main().catch((err) => {
  console.error("バックテスト実行エラー:", err);
  process.exit(1);
});
