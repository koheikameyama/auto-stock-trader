/**
 * パラメータ感度分析
 *
 * 各パラメータを1つずつ変化させ、勝率・PF等への影響を測定する。
 * データ取得は不要（事前取得済みのデータを再利用）。
 */

import type { OHLCVData } from "../core/technical-analysis";
import type { BacktestConfig, SensitivityResult } from "./types";
import { runBacktest } from "./simulation-engine";

const SENSITIVITY_PARAMS: Record<string, number[]> = {
  scoreThreshold: [60, 65, 70, 75, 80],
  takeProfitRatio: [1.03, 1.05, 1.10, 1.20, 1.50],
  stopLossRatio: [0.975, 0.98, 0.985, 0.99],
  atrMultiplier: [0.5, 0.8, 1.0, 1.2, 1.5],
  trailingActivationMultiplier: [1.0, 1.2, 1.5, 2.0, 2.5],
};

// TP/SL関連パラメータ（変化時に overrideTpSl=true を自動セット）
const TP_SL_PARAMS = new Set(["takeProfitRatio", "stopLossRatio", "atrMultiplier"]);

const PARAM_LABELS: Record<string, string> = {
  scoreThreshold: "スコア閾値",
  takeProfitRatio: "利確比率",
  stopLossRatio: "損切比率",
  atrMultiplier: "ATR倍率",
  trailingActivationMultiplier: "TS起動ATR倍率",
};

export function runSensitivityAnalysis(
  baseConfig: BacktestConfig,
  allData: Map<string, OHLCVData[]>,
  nikkeiViData?: Map<string, number>,
): SensitivityResult[] {
  const results: SensitivityResult[] = [];
  const totalRuns = Object.values(SENSITIVITY_PARAMS).reduce((s, v) => s + v.length, 0);
  let current = 0;

  for (const [param, values] of Object.entries(SENSITIVITY_PARAMS)) {
    for (const value of values) {
      current++;
      const label = PARAM_LABELS[param] ?? param;
      console.log(`  [${current}/${totalRuns}] ${label}=${value}`);

      // TP/SL系パラメータは overrideTpSl=true で上書きモード有効化
      const overrideTpSl = TP_SL_PARAMS.has(param) ? true : baseConfig.overrideTpSl;
      const config = { ...baseConfig, [param]: value, overrideTpSl, verbose: false };
      const result = runBacktest(config, allData, nikkeiViData);

      results.push({
        parameter: label,
        value,
        metrics: result.metrics,
      });
    }
  }

  return results;
}
