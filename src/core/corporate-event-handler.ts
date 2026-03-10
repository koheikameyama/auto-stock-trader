/**
 * コーポレートイベントハンドラ
 *
 * 配当落ち日・株式分割時のポジション自動調整を行う。
 * 全て純粋関数（I/Oなし）。DB更新は呼び出し側が行う。
 */

// ========================================
// 配当落ち調整
// ========================================

export interface DividendAdjustmentResult {
  adjusted: boolean;
  oldStopLoss: number;
  newStopLoss: number;
  oldTrailingStop: number | null;
  newTrailingStop: number | null;
  dividendAmount: number;
}

/**
 * 配当落ち日にポジションの損切り・トレーリングストップを調整する。
 *
 * 配当落ち日には株価が配当額分だけ下落するのが正常なので、
 * 損切りラインをその分引き下げないと誤発動する。
 */
export function adjustForExDividend(
  stopLossPrice: number,
  trailingStopPrice: number | null,
  dividendPerShare: number,
): DividendAdjustmentResult {
  if (dividendPerShare <= 0) {
    return {
      adjusted: false,
      oldStopLoss: stopLossPrice,
      newStopLoss: stopLossPrice,
      oldTrailingStop: trailingStopPrice,
      newTrailingStop: trailingStopPrice,
      dividendAmount: dividendPerShare,
    };
  }

  const newStopLoss =
    Math.round((stopLossPrice - dividendPerShare) * 100) / 100;
  const newTrailingStop =
    trailingStopPrice != null
      ? Math.round((trailingStopPrice - dividendPerShare) * 100) / 100
      : null;

  return {
    adjusted: true,
    oldStopLoss: stopLossPrice,
    newStopLoss,
    oldTrailingStop: trailingStopPrice,
    newTrailingStop,
    dividendAmount: dividendPerShare,
  };
}

// ========================================
// 株式分割調整
// ========================================

export interface SplitAdjustmentResult {
  adjusted: boolean;
  splitRatio: number; // e.g., 2.0 for 1:2 split
  adjustments: {
    entryPrice: { old: number; new: number };
    quantity: { old: number; new: number };
    stopLossPrice: { old: number; new: number };
    takeProfitPrice: { old: number | null; new: number | null };
    trailingStopPrice: { old: number | null; new: number | null };
    entryAtr: { old: number | null; new: number | null };
  };
}

/**
 * 株式分割時にポジション情報を調整する。
 *
 * 例: 1:2 分割 → 株価は半分、株数は2倍
 * numerator=2, denominator=1 → splitRatio=2
 */
export function adjustForSplit(
  entryPrice: number,
  quantity: number,
  stopLossPrice: number,
  takeProfitPrice: number | null,
  trailingStopPrice: number | null,
  entryAtr: number | null,
  numerator: number,
  denominator: number,
): SplitAdjustmentResult {
  const splitRatio = numerator / denominator;

  if (splitRatio <= 0 || splitRatio === 1) {
    return {
      adjusted: false,
      splitRatio,
      adjustments: {
        entryPrice: { old: entryPrice, new: entryPrice },
        quantity: { old: quantity, new: quantity },
        stopLossPrice: { old: stopLossPrice, new: stopLossPrice },
        takeProfitPrice: { old: takeProfitPrice, new: takeProfitPrice },
        trailingStopPrice: { old: trailingStopPrice, new: trailingStopPrice },
        entryAtr: { old: entryAtr, new: entryAtr },
      },
    };
  }

  const adjustPrice = (price: number) =>
    Math.round((price / splitRatio) * 100) / 100;
  const adjustNullable = (price: number | null) =>
    price != null ? adjustPrice(price) : null;

  return {
    adjusted: true,
    splitRatio,
    adjustments: {
      entryPrice: { old: entryPrice, new: adjustPrice(entryPrice) },
      quantity: { old: quantity, new: Math.round(quantity * splitRatio) },
      stopLossPrice: { old: stopLossPrice, new: adjustPrice(stopLossPrice) },
      takeProfitPrice: {
        old: takeProfitPrice,
        new: adjustNullable(takeProfitPrice),
      },
      trailingStopPrice: {
        old: trailingStopPrice,
        new: adjustNullable(trailingStopPrice),
      },
      entryAtr: { old: entryAtr, new: adjustNullable(entryAtr) },
    },
  };
}

/**
 * 分割比率文字列をパースする
 * "1:2" → { numerator: 2, denominator: 1 }
 */
export function parseSplitFactor(
  splitFactor: string,
): { numerator: number; denominator: number } | null {
  const match = splitFactor.match(/^(\d+):(\d+)$/);
  if (!match) return null;
  const denominator = parseInt(match[1], 10);
  const numerator = parseInt(match[2], 10);
  if (denominator <= 0 || numerator <= 0) return null;
  return { numerator, denominator };
}
