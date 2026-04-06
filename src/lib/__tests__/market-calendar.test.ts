import { describe, it, expect } from "vitest";
import { countNonTradingDaysAhead, adjustToTradingDay } from "../market-calendar";

// テスト用ヘルパー: YYYY-MM-DD → Date（JST基準）
function jstDate(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00+09:00");
}

describe("countNonTradingDaysAhead", () => {
  it("月曜日（翌日が火曜=営業日）→ 0", () => {
    // 2026-03-16 = 月曜日
    expect(countNonTradingDaysAhead(jstDate("2026-03-16"))).toBe(0);
  });

  it("水曜日（翌日が木曜=営業日）→ 0", () => {
    // 2026-03-18 = 水曜日
    expect(countNonTradingDaysAhead(jstDate("2026-03-18"))).toBe(0);
  });

  it("金曜日（土日を挟む）→ 2", () => {
    // 2026-03-20 = 金曜日、翌営業日は3/23月曜
    expect(countNonTradingDaysAhead(jstDate("2026-03-20"))).toBe(2);
  });

  it("金曜 + 月曜祝日（3連休）→ 3", () => {
    // 2026-07-17 = 金曜、7/20 = 海の日（月曜祝日）
    // → 土日月で3日、翌営業日は7/21火曜
    expect(countNonTradingDaysAhead(jstDate("2026-07-17"))).toBe(3);
  });

  it("年末（12/30水 → 1/4月）→ 4", () => {
    // 2026-12-30 = 水曜
    // 12/31(木)=TSE休場, 1/1(金)=祝日, 1/2(土)=週末, 1/3(日)=週末
    // → 4日、翌営業日は1/4(月)
    expect(countNonTradingDaysAhead(jstDate("2026-12-30"))).toBe(4);
  });

  it("GW前（複数祝日が連続）→ 正しい日数", () => {
    // 2026-04-28 = 火曜
    // 4/29(水)=昭和の日, 4/30(木)=平日, → 翌営業日は4/30
    // → 1日
    expect(countNonTradingDaysAhead(jstDate("2026-04-28"))).toBe(1);
  });

  it("引数なしで現在日付を使用（エラーにならない）", () => {
    const result = countNonTradingDaysAhead();
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(30);
  });
});

describe("adjustToTradingDay", () => {
  it("営業日（月曜）はそのまま返す", () => {
    // 2026-04-06 = 月曜日
    const result = adjustToTradingDay(jstDate("2026-04-06"));
    expect(result.getUTCDate()).toBe(6);
  });

  it("土曜日 → 直後の月曜日に調整", () => {
    // 2026-04-11 = 土曜日 → 2026-04-13 = 月曜日
    const result = adjustToTradingDay(jstDate("2026-04-11"));
    expect(result.getUTCMonth()).toBe(3); // April (0-indexed)
    expect(result.getUTCDate()).toBe(13);
  });

  it("日曜日 → 直後の月曜日に調整", () => {
    // 2026-04-12 = 日曜日 → 2026-04-13 = 月曜日
    const result = adjustToTradingDay(jstDate("2026-04-12"));
    expect(result.getUTCDate()).toBe(13);
  });

  it("祝日 → 直後の営業日に調整", () => {
    // 2026-04-29 = 昭和の日（水曜祝日） → 2026-04-30 = 木曜
    const result = adjustToTradingDay(jstDate("2026-04-29"));
    expect(result.getUTCDate()).toBe(30);
  });
});
