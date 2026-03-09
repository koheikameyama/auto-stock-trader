/**
 * パラメータ感度分析
 *
 * 各パラメータを1つずつ変化させ、勝率・PF等への影響を測定する。
 * データ取得は不要（事前取得済みのデータを再利用）。
 */

import type { OHLCVData } from "../core/technical-analysis";
import type { BacktestConfig, SensitivityResult } from "./types";
import { runBacktest } from "./simulation-engine";

const SENSITIVITY_PARAMS: Record<
  keyof Pick<BacktestConfig, "scoreThreshold" | "takeProfitRatio" | "stopLossRatio" | "atrMultiplier">,
  number[]
> = {
  scoreThreshold: [60, 65, 70, 75, 80],
  takeProfitRatio: [1.015, 1.02, 1.025, 1.03, 1.04, 1.05],
  stopLossRatio: [0.975, 0.98, 0.985, 0.99],
  atrMultiplier: [0.5, 0.8, 1.0, 1.2, 1.5],
};

const PARAM_LABELS: Record<string, string> = {
  scoreThreshold: "スコア閾値",
  takeProfitRatio: "利確比率",
  stopLossRatio: "損切比率",
  atrMultiplier: "ATR倍率",
};

export function runSensitivityAnalysis(
  baseConfig: BacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData?: Map<string, number>,
): SensitivityResult[] {
  const results: SensitivityResult[] = [];
  const totalRuns = Object.values(SENSITIVITY_PARAMS).reduce((s, v) => s + v.length, 0);
  let current = 0;

  for (const [param, values] of Object.entries(SENSITIVITY_PARAMS)) {
    for (const value of values) {
      current++;
      const label = PARAM_LABELS[param] ?? param;
      console.log(`  [${current}/${totalRuns}] ${label}=${value}`);

      const config = { ...baseConfig, [param]: value, verbose: false };
      const result = runBacktest(config, allData, vixData);

      results.push({
        parameter: label,
        value,
        metrics: result.metrics,
      });
    }
  }

  return results;
}
