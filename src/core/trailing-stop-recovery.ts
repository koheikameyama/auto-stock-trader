import { calculateTrailingStop } from "./trailing-stop";
import type { TradingStrategy } from "./market-regime";

export interface PositionForRecovery {
  entryPrice: number;
  maxHighDuringHold: number;
  currentTrailingStop: number | null;
  stopLossPrice: number;
  entryAtr: number | null;
  strategy: TradingStrategy;
}

export interface RecoveryResult {
  newMaxHigh: number;
  newStopPrice: number;
  improved: boolean;
}

/**
 * サーバーダウン中に取り逃がしたトレーリングストップの追従を回復する純粋関数。
 * DB操作は行わない。
 *
 * @param position ポジション情報
 * @param barHighs StockDailyBar の高値配列（入場日以降）
 */
export function computeRecoveredStop(
  position: PositionForRecovery,
  barHighs: number[],
): RecoveryResult {
  const newMaxHigh =
    barHighs.length > 0
      ? Math.max(position.maxHighDuringHold, ...barHighs)
      : position.maxHighDuringHold;

  const tsResult = calculateTrailingStop({
    entryPrice: position.entryPrice,
    maxHighDuringHold: newMaxHigh,
    currentTrailingStop: position.currentTrailingStop,
    originalStopLoss: position.stopLossPrice,
    originalTakeProfit: Infinity,
    entryAtr: position.entryAtr,
    strategy: position.strategy,
  });

  const currentStop =
    position.currentTrailingStop ?? position.stopLossPrice;
  const newStopPrice =
    tsResult.trailingStopPrice ?? position.currentTrailingStop ?? position.stopLossPrice;

  return {
    newMaxHigh,
    newStopPrice,
    improved: newStopPrice > currentStop,
  };
}
