import { SCORING } from "../../lib/constants/scoring";
import type { ScoringGateResult } from "./types";

export interface GateInput {
  latestPrice: number;
  avgVolume25: number | null;
  atrPct: number | null;
  nextEarningsDate: Date | null;
  exDividendDate: Date | null;
  today: Date;
}

export function checkGates(input: GateInput): ScoringGateResult {
  const { GATES } = SCORING;

  // 流動性
  if (input.avgVolume25 != null && input.avgVolume25 < GATES.MIN_AVG_VOLUME_25) {
    return { passed: false, failedGate: "liquidity" };
  }

  // 株価
  if (input.latestPrice > GATES.MAX_PRICE) {
    return { passed: false, failedGate: "spread" };
  }

  // 最低ボラ
  if (input.atrPct != null && input.atrPct < GATES.MIN_ATR_PCT) {
    return { passed: false, failedGate: "volatility" };
  }

  // 決算接近
  if (input.nextEarningsDate) {
    const diffDays = Math.floor(
      (input.nextEarningsDate.getTime() - input.today.getTime()) / 86_400_000,
    );
    if (diffDays >= 0 && diffDays <= GATES.EARNINGS_DAYS_BEFORE) {
      return { passed: false, failedGate: "earnings" };
    }
  }

  // 配当
  if (input.exDividendDate) {
    const diffDays = Math.floor(
      (input.exDividendDate.getTime() - input.today.getTime()) / 86_400_000,
    );
    if (diffDays >= 0 && diffDays <= GATES.EX_DIVIDEND_DAYS_BEFORE) {
      return { passed: false, failedGate: "dividend" };
    }
  }

  return { passed: true, failedGate: null };
}
