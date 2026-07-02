/**
 * スリッページ集計（実約定 vs 基準価格）
 *
 * per-trade のスリッページは約定時に broker-fill-handler / position-manager が
 * TradingOrder.referencePrice / slippageBps に記録済み。本モジュールはその生データを
 * 集計し「資金（ポジション金額）が増えるとスリッページが悪化するか（= キャパシティ）」を
 * 可視化する純粋関数群。DB アクセスはしない（slippage-report.ts が供給）。
 *
 * 符号の統一（costBps, 正 = 執行で損した分）:
 *   - 買い(エントリー): filled > reference で不利 → costBps = +slippageBps
 *   - 売り(エグジット): filled < reference で不利 → costBps = -slippageBps
 *   → costBps が正なら「基準価格より不利に約定＝執行コスト」。両サイド共通の損得指標。
 */

export interface SlippageRecord {
  side: "buy" | "sell";
  strategy: string;
  /** 約定時に記録された slippageBps（(filled-reference)/reference × 10000, 生値） */
  slippageBps: number;
  /** 約定金額 = filledPrice × quantity（円）。キャパシティ分析の説明変数 */
  notional: number;
  /** 約定日時（月次集計用） */
  filledAt: Date;
}

export interface SlippageStat {
  n: number;
  /** 執行コスト平均（bps, 正=不利） */
  avgCostBps: number;
  medianCostBps: number;
  /** 上位10%の悪いコスト（bps）。テール（大きく滑った時） */
  p90CostBps: number;
  avgNotional: number;
}

/** 買い=+slippage, 売り=-slippage を「執行コスト(正=損)」に統一 */
export function toCostBps(r: SlippageRecord): number {
  return r.side === "buy" ? r.slippageBps : -r.slippageBps;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function computeStat(records: SlippageRecord[]): SlippageStat {
  if (records.length === 0) {
    return { n: 0, avgCostBps: NaN, medianCostBps: NaN, p90CostBps: NaN, avgNotional: NaN };
  }
  const costs = records.map(toCostBps).sort((a, b) => a - b);
  const avgCost = costs.reduce((s, v) => s + v, 0) / costs.length;
  const avgNotional =
    records.reduce((s, r) => s + r.notional, 0) / records.length;
  return {
    n: records.length,
    avgCostBps: avgCost,
    medianCostBps: median(costs),
    p90CostBps: percentile(costs, 0.9),
    avgNotional,
  };
}

/** 約定金額の帯（キャパシティ曲線用）。円 */
export const NOTIONAL_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "<¥100k", min: 0, max: 100_000 },
  { label: "¥100-300k", min: 100_000, max: 300_000 },
  { label: "¥300k-1M", min: 300_000, max: 1_000_000 },
  { label: "¥1M-3M", min: 1_000_000, max: 3_000_000 },
  { label: "¥3M+", min: 3_000_000, max: Infinity },
];

export interface SlippageSummary {
  overall: SlippageStat;
  byBuySell: { buy: SlippageStat; sell: SlippageStat };
  byStrategy: { key: string; stat: SlippageStat }[];
  /** 買い(エントリー)のみ、約定金額帯別 = 「資金が増えるとコストが増えるか」の核心 */
  buyByNotional: { label: string; stat: SlippageStat }[];
  byMonth: { month: string; buy: SlippageStat }[];
}

export function summarizeSlippage(records: SlippageRecord[]): SlippageSummary {
  const buys = records.filter((r) => r.side === "buy");
  const sells = records.filter((r) => r.side === "sell");

  const strategyKeys = [...new Set(records.map((r) => r.strategy))].sort();
  const byStrategy = strategyKeys.map((key) => ({
    key,
    stat: computeStat(records.filter((r) => r.strategy === key)),
  }));

  const buyByNotional = NOTIONAL_BUCKETS.map((b) => ({
    label: b.label,
    stat: computeStat(buys.filter((r) => r.notional >= b.min && r.notional < b.max)),
  }));

  const monthKeys = [
    ...new Set(
      buys.map((r) => {
        const d = r.filledAt;
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      }),
    ),
  ].sort();
  const byMonth = monthKeys.map((month) => ({
    month,
    buy: computeStat(
      buys.filter((r) => {
        const d = r.filledAt;
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` === month;
      }),
    ),
  }));

  return {
    overall: computeStat(records),
    byBuySell: { buy: computeStat(buys), sell: computeStat(sells) },
    byStrategy,
    buyByNotional,
    byMonth,
  };
}
