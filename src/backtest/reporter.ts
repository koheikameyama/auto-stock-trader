/**
 * バックテスト結果の出力フォーマット
 */

import { writeFileSync } from "node:fs";
import type { BacktestResult, SensitivityResult } from "./types";

export function printBacktestReport(result: BacktestResult): void {
  const { config, metrics } = result;

  console.log("");
  console.log("=".repeat(50));
  console.log("  バックテスト結果");
  console.log("=".repeat(50));
  console.log(`  期間: ${config.startDate} ~ ${config.endDate}`);
  console.log(`  銘柄数: ${config.tickers.length}`);
  console.log(`  初期資金: ¥${config.initialBudget.toLocaleString()}`);
  console.log(`  戦略: ${config.strategy}`);
  console.log(`  スコア閾値: ${config.scoreThreshold}`);
  console.log(`  TP: ${((config.takeProfitRatio - 1) * 100).toFixed(1)}%`);
  console.log(`  SL: ${((1 - config.stopLossRatio) * 100).toFixed(1)}%`);
  console.log(`  ATR倍率: ${config.atrMultiplier}`);
  console.log(`  価格上限: ¥${config.maxPrice.toLocaleString()}`);
  console.log("");

  console.log("-".repeat(50));
  console.log("  パフォーマンス");
  console.log("-".repeat(50));
  console.log(`  トレード数: ${metrics.totalTrades} (勝: ${metrics.wins}, 負: ${metrics.losses})`);
  if (metrics.stillOpen > 0) {
    console.log(`  未決済: ${metrics.stillOpen}`);
  }
  console.log(`  勝率: ${metrics.winRate}%`);
  console.log(`  平均利益: +${metrics.avgWinPct}%`);
  console.log(`  平均損失: ${metrics.avgLossPct}%`);
  console.log(`  PF: ${metrics.profitFactor === Infinity ? "∞" : metrics.profitFactor}`);
  console.log(`  最大DD: -${metrics.maxDrawdown}%`);
  if (metrics.maxDrawdownPeriod) {
    console.log(`    (${metrics.maxDrawdownPeriod.start} ~ ${metrics.maxDrawdownPeriod.end})`);
  }
  if (metrics.sharpeRatio != null) {
    console.log(`  シャープレシオ: ${metrics.sharpeRatio}`);
  }
  console.log(`  平均保有日数: ${metrics.avgHoldingDays}日`);

  const sign = metrics.totalPnl >= 0 ? "+" : "";
  console.log(`  累計損益: ${sign}¥${metrics.totalPnl.toLocaleString()} (${sign}${metrics.totalReturnPct}%)`);
  console.log("");

  // ランク別
  const rankOrder = ["S", "A", "B", "C"];
  const rankEntries = rankOrder
    .filter((r) => metrics.byRank[r])
    .map((r) => ({ rank: r, ...metrics.byRank[r] }));

  if (rankEntries.length > 0) {
    console.log("-".repeat(50));
    console.log("  ランク別");
    console.log("-".repeat(50));
    console.log("  ランク  取引数  勝率     平均損益");
    for (const r of rankEntries) {
      const pnlSign = r.avgPnlPct >= 0 ? "+" : "";
      console.log(
        `  ${r.rank.padEnd(6)} ${String(r.totalTrades).padStart(4)}   ${String(r.winRate + "%").padStart(6)}   ${pnlSign}${r.avgPnlPct}%`,
      );
    }
    console.log("");
  }

  // トレード一覧（最大20件）
  const closedTrades = result.trades.filter(
    (t) => t.exitReason === "take_profit" || t.exitReason === "stop_loss",
  );
  if (closedTrades.length > 0) {
    console.log("-".repeat(50));
    console.log(`  トレード一覧 (${closedTrades.length > 20 ? "直近20件" : `${closedTrades.length}件`})`);
    console.log("-".repeat(50));
    const display = closedTrades.slice(-20);
    for (const t of display) {
      const pnlSign = (t.pnl ?? 0) >= 0 ? "+" : "";
      const reason = t.exitReason === "take_profit" ? "TP" : "SL";
      console.log(
        `  ${t.entryDate} ${t.ticker.padEnd(8)} ${reason} ¥${t.entryPrice}→¥${t.exitPrice} ${pnlSign}¥${t.pnl} (${pnlSign}${t.pnlPct}%) ${t.holdingDays}日`,
      );
    }
    console.log("");
  }
}

export function printSensitivityReport(results: SensitivityResult[]): void {
  console.log("=".repeat(50));
  console.log("  パラメータ感度分析");
  console.log("=".repeat(50));

  // パラメータ別にグループ化
  const groups = new Map<string, SensitivityResult[]>();
  for (const r of results) {
    const existing = groups.get(r.parameter) ?? [];
    existing.push(r);
    groups.set(r.parameter, existing);
  }

  for (const [param, items] of groups) {
    console.log("");
    console.log(`--- ${param} ---`);
    console.log("  値       勝率     PF      取引数  DD      リターン");
    for (const item of items) {
      const m = item.metrics;
      const pf = m.profitFactor === Infinity ? "∞" : String(m.profitFactor);
      const ret = `${m.totalReturnPct >= 0 ? "+" : ""}${m.totalReturnPct}%`;
      console.log(
        `  ${String(item.value).padEnd(8)} ${String(m.winRate + "%").padStart(6)}  ${pf.padStart(6)}  ${String(m.totalTrades).padStart(5)}  -${String(m.maxDrawdown + "%").padStart(5)}  ${ret}`,
      );
    }
  }
  console.log("");
}

export function writeJsonReport(
  result: BacktestResult,
  sensitivityResults: SensitivityResult[] | null,
  outputPath: string,
): void {
  const report = {
    backtest: result,
    sensitivity: sensitivityResults,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`[backtest] JSON出力: ${outputPath}`);
}
