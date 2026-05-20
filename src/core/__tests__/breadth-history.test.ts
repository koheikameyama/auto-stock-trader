import { describe, it, expect } from "vitest";
import {
  computeLinearForecast,
  computeSimilarCases,
  formatEnrichment,
  type BreadthHistoryPoint,
  type BreadthEnrichment,
} from "../breadth-history";

function point(daysAgo: number, breadth: number): BreadthHistoryPoint {
  const d = new Date(2026, 4, 20); // 2026-05-20
  d.setDate(d.getDate() - daysAgo);
  return { date: d, breadth };
}

describe("computeLinearForecast", () => {
  it("履歴が3点未満なら null", () => {
    const fc = computeLinearForecast([point(1, 0.3), point(0, 0.32)], 0.54);
    expect(fc.daysToTarget).toBe(null);
    expect(fc.expectedDate).toBe(null);
  });

  it("上昇トレンドから target 到達日を推定する", () => {
    // 5日で 0.28 → 0.32 (+0.01/日) → target 0.54 まで 22日
    const history: BreadthHistoryPoint[] = [
      point(4, 0.28),
      point(3, 0.29),
      point(2, 0.30),
      point(1, 0.31),
      point(0, 0.32),
    ];
    const fc = computeLinearForecast(history, 0.54);
    expect(fc.driftPerDay).toBeCloseTo(0.01, 3);
    expect(fc.daysToTarget).toBe(22);
    expect(fc.expectedDate).not.toBe(null);
  });

  it("下降トレンドなら未達 (null)", () => {
    const history: BreadthHistoryPoint[] = [
      point(4, 0.35),
      point(3, 0.34),
      point(2, 0.33),
      point(1, 0.32),
      point(0, 0.31),
    ];
    const fc = computeLinearForecast(history, 0.54);
    expect(fc.daysToTarget).toBe(null);
    expect(fc.driftPerDay).toBeLessThan(0);
  });

  it("既に target 以上なら null", () => {
    const history: BreadthHistoryPoint[] = [
      point(2, 0.55),
      point(1, 0.56),
      point(0, 0.58),
    ];
    const fc = computeLinearForecast(history, 0.54);
    expect(fc.daysToTarget).toBe(null);
  });
});

describe("computeSimilarCases", () => {
  it("複数の低迷期から復帰日数を集計する", () => {
    // 過去履歴: 高 → 低（現値レベル）→ 復帰 を 3回
    // 各エピソードで現値 0.32 付近に達してから target 0.54 復帰までの日数
    const history: BreadthHistoryPoint[] = [];
    let idx = 0;
    const push = (breadth: number) => {
      history.push(point(100 - idx, breadth));
      idx++;
    };

    // Episode 1: 0.6 → 0.32 → 0.55 (target 復帰までから 5日)
    push(0.6); push(0.5); push(0.4); push(0.32); push(0.35); push(0.4); push(0.45); push(0.5); push(0.55);
    // Episode 2: 0.6 → 0.30 → 0.55 (target 復帰までから 10日)
    push(0.5); push(0.4); push(0.30); push(0.32); push(0.35); push(0.38); push(0.42); push(0.45); push(0.48); push(0.50); push(0.52); push(0.54); push(0.56);
    // Episode 3: 0.6 → 0.34 → 0.55 (target 復帰までから 3日)
    push(0.5); push(0.34); push(0.4); push(0.48); push(0.56);

    const stats = computeSimilarCases(history, 0.32, 0.54, { tolerance: 0.03 });
    expect(stats.count).toBe(3);
    expect(stats.medianDays).not.toBe(null);
    expect(stats.minDays).not.toBe(null);
    expect(stats.maxDays).not.toBe(null);
    expect(stats.minDays!).toBeLessThanOrEqual(stats.medianDays!);
    expect(stats.maxDays!).toBeGreaterThanOrEqual(stats.medianDays!);
    expect(stats.rangeLower).toBeCloseTo(0.29, 2);
    expect(stats.rangeUpper).toBeCloseTo(0.35, 2);
  });

  it("マッチなしなら count=0", () => {
    const history: BreadthHistoryPoint[] = [point(2, 0.6), point(1, 0.7), point(0, 0.8)];
    const stats = computeSimilarCases(history, 0.32, 0.54);
    expect(stats.count).toBe(0);
    expect(stats.medianDays).toBe(null);
    expect(stats.minDays).toBe(null);
    expect(stats.maxDays).toBe(null);
  });

  it("同じ低迷期は1件としてカウント (連続マッチを重複させない)", () => {
    // 30日連続で 0.32 → 0.55 復帰
    const history: BreadthHistoryPoint[] = [];
    history.push(point(50, 0.6));
    for (let i = 49; i >= 20; i--) {
      history.push(point(i, 0.32));
    }
    history.push(point(19, 0.55));

    const stats = computeSimilarCases(history, 0.32, 0.54);
    expect(stats.count).toBe(1);
  });
});

describe("formatEnrichment", () => {
  it("3パートすべて揃ったときに 3行のサマリーを返す", () => {
    const enrichment: BreadthEnrichment = {
      recentSeries: [28.1, 29.6, 31.2, 32.0, 32.8],
      recentAvgChangePct: 1.175,
      forecast: {
        driftPerDay: 0.01175,
        daysToTarget: 9,
        expectedDate: new Date(2026, 5, 2),
      },
      similar: {
        count: 12,
        medianDays: 8,
        minDays: 4,
        maxDays: 22,
        rangeLower: 0.29,
        rangeUpper: 0.35,
      },
    };
    const text = formatEnrichment(enrichment, 0.54);
    const lines = text.split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("28.1→29.6→31.2→32.0→32.8");
    expect(lines[0]).toContain("↗");
    expect(lines[1]).toContain("≈9営業日後");
    expect(lines[2]).toContain("N=12");
    expect(lines[2]).toContain("4〜22営業日");
    expect(lines[2]).toContain("中央値8");
  });

  it("点推定が null（横ばい/下降）のときは文言を切り替える", () => {
    const enrichment: BreadthEnrichment = {
      recentSeries: [33.0, 32.5, 32.0],
      recentAvgChangePct: -0.5,
      forecast: { driftPerDay: -0.005, daysToTarget: null, expectedDate: null },
      similar: { count: 0, medianDays: null, minDays: null, maxDays: null, rangeLower: 0.29, rangeUpper: 0.35 },
    };
    const text = formatEnrichment(enrichment, 0.54);
    expect(text).toContain("横ばい〜下降");
    expect(text).not.toContain("過去類似");
  });
});
