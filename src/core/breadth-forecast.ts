/**
 * Breadth 予測
 *
 * SMA25 の roll効果 + 価格シナリオから、今後 N営業日の breadth 推移を予測する。
 * scripts/forecast-breadth.ts と morning-analysis 両方から利用される共通ロジック。
 *
 * 注意:
 *   - 全銘柄が一律 X%/日 で動く前提（保守的近似、個別ボラは無視）
 *   - SMA25 roll は数学的に正確
 *   - VIX急騰やキルスイッチ等のフィルターは考慮しない
 */

import { prisma } from "../lib/prisma";
import dayjs from "dayjs";

const SMA_PERIOD = 25;

export interface BreadthScenario {
  label: string;
  dailyChangePct: number;
}

export const DEFAULT_SCENARIOS: BreadthScenario[] = [
  { label: "bear -0.8%/日", dailyChangePct: -0.008 },
  { label: "weak -0.3%/日", dailyChangePct: -0.003 },
  { label: "flat 0.0%/日", dailyChangePct: 0.0 },
  { label: "rebound +0.5%/日", dailyChangePct: 0.005 },
  { label: "strong +1.0%/日", dailyChangePct: 0.01 },
];

export interface ForecastDay {
  day: number;
  breadth: number;
  above: number;
  total: number;
}

export interface ScenarioForecast {
  scenario: BreadthScenario;
  forecast: ForecastDay[];
  /** target に到達した最初の day (= 営業日数)。到達しなければ null。 */
  daysToTarget: number | null;
}

interface TickerHistory {
  ticker: string;
  closes: number[]; // 古い順、長さ ≥ SMA_PERIOD
}

/**
 * 全 JP 銘柄の直近 25バー close を取得（最新営業日基準）
 */
export async function fetchBreadthHistories(): Promise<{ histories: TickerHistory[]; asOfDate: Date }> {
  const latest = await prisma.stockDailyBar.findFirst({
    where: { market: "JP" },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  if (!latest) throw new Error("No JP StockDailyBar data");
  const asOfDate = latest.date;

  const fromDate = dayjs(asOfDate).subtract(60, "day").toDate();
  const bars = await prisma.stockDailyBar.findMany({
    where: { market: "JP", date: { gte: fromDate, lte: asOfDate } },
    orderBy: [{ tickerCode: "asc" }, { date: "asc" }],
    select: { tickerCode: true, close: true },
  });

  const grouped = new Map<string, number[]>();
  for (const b of bars) {
    const arr = grouped.get(b.tickerCode) ?? [];
    arr.push(Number(b.close));
    grouped.set(b.tickerCode, arr);
  }

  const histories: TickerHistory[] = [];
  for (const [ticker, closes] of grouped) {
    if (closes.length < SMA_PERIOD) continue;
    histories.push({ ticker, closes: closes.slice(-SMA_PERIOD) });
  }

  return { histories, asOfDate };
}

/**
 * 単一シナリオで N営業日後までの breadth を投影する
 */
export function computeBreadthForecast(
  histories: TickerHistory[],
  dailyChangePct: number,
  days: number,
): ForecastDay[] {
  const sims = histories.map((h) => ({
    closes: [...h.closes],
    lastClose: h.closes[h.closes.length - 1],
  }));

  const result: ForecastDay[] = [];

  for (let day = 0; day <= days; day++) {
    let above = 0;
    let total = 0;
    for (const s of sims) {
      const window = s.closes.slice(-SMA_PERIOD);
      const sma = window.reduce((a, b) => a + b, 0) / window.length;
      const currentClose = s.closes[s.closes.length - 1];
      if (currentClose > sma) above++;
      total++;
    }
    result.push({ day, breadth: above / total, above, total });

    if (day < days) {
      for (const s of sims) {
        const newClose = s.lastClose * Math.pow(1 + dailyChangePct, day + 1);
        s.closes.push(newClose);
      }
    }
  }

  return result;
}

/**
 * 全シナリオで予測を実行し、各シナリオの target到達日を集計する
 */
export async function forecastBreadthAll(opts: {
  days?: number;
  target: number;
  scenarios?: BreadthScenario[];
}): Promise<{
  asOfDate: Date;
  totalTickers: number;
  currentBreadth: number;
  results: ScenarioForecast[];
}> {
  const days = opts.days ?? 20;
  const scenarios = opts.scenarios ?? DEFAULT_SCENARIOS;

  const { histories, asOfDate } = await fetchBreadthHistories();

  const results: ScenarioForecast[] = [];
  let currentBreadth = 0;
  for (const sc of scenarios) {
    const forecast = computeBreadthForecast(histories, sc.dailyChangePct, days);
    const crossDay = forecast.find((f) => f.breadth >= opts.target)?.day ?? null;
    results.push({ scenario: sc, forecast, daysToTarget: crossDay });
    if (currentBreadth === 0) currentBreadth = forecast[0].breadth;
  }

  return { asOfDate, totalTickers: histories.length, currentBreadth, results };
}

/**
 * Slack/ログ用の短いサマリー文字列を生成
 *
 * 例: "breadth予測: rebound+0.5%/日なら 4営業日後復活 / 横ばいは未達 / 弱気は未達"
 */
export function summarizeForecast(
  result: { results: ScenarioForecast[] },
  target: number,
): string {
  const rebound = result.results.find((r) => r.scenario.label.startsWith("rebound"));
  const flat = result.results.find((r) => r.scenario.label.startsWith("flat"));
  const weak = result.results.find((r) => r.scenario.label.startsWith("weak"));

  const parts: string[] = [];
  if (rebound) {
    parts.push(
      rebound.daysToTarget !== null
        ? `反発+0.5%なら ${rebound.daysToTarget}営業日後復活`
        : "反発でも未達",
    );
  }
  if (flat) {
    parts.push(flat.daysToTarget !== null ? `横ばいで ${flat.daysToTarget}日後` : "横ばいは未達");
  }
  if (weak) {
    parts.push(weak.daysToTarget !== null ? `弱気-0.3%で ${weak.daysToTarget}日後` : "弱気は未達");
  }

  return `breadth予測（下限${(target * 100).toFixed(1)}%到達）: ${parts.join(" / ")}`;
}
