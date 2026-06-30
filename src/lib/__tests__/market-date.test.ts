import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  jstDateAsUTC,
  getTodayForDB,
  getDaysAgoForDB,
  toJSTDateForDB,
  getStartOfDayJST,
  getEndOfDayJST,
  countNonTradingDaysAhead,
  countTradingDaysBetween,
  adjustToTradingDay,
} from "../market-date";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { TIMEZONE } from "../constants";

dayjs.extend(utc);
dayjs.extend(timezone);

// テスト用ヘルパー: YYYY-MM-DD → Date（JST基準）
function jstDate(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00+09:00");
}

// ─── 日付変換ユーティリティ ───

describe("jstDateAsUTC", () => {
  it("JST日付をUTC 00:00のDateオブジェクトとして返す", () => {
    const d = dayjs.tz("2026-03-20 10:30", TIMEZONE);
    const result = jstDateAsUTC(d);
    expect(result.toISOString()).toBe("2026-03-20T00:00:00.000Z");
  });

  it("JST 1月1日を正しく変換", () => {
    const d = dayjs.tz("2026-01-01 00:00", TIMEZONE);
    const result = jstDateAsUTC(d);
    expect(result.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("getTodayForDB", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("JST昼間 → その日の日付", () => {
    // JST 2026-03-20 10:00 = UTC 2026-03-20 01:00
    vi.setSystemTime(new Date("2026-03-20T01:00:00.000Z"));
    const result = getTodayForDB();
    expect(result.toISOString()).toBe("2026-03-20T00:00:00.000Z");
  });

  it("JST深夜23:59 → その日の日付", () => {
    // JST 2026-03-20 23:59 = UTC 2026-03-20 14:59
    vi.setSystemTime(new Date("2026-03-20T14:59:00.000Z"));
    const result = getTodayForDB();
    expect(result.toISOString()).toBe("2026-03-20T00:00:00.000Z");
  });

  it("UTC 16:00（= JST翌日01:00）→ 翌日の日付", () => {
    // UTC 2026-03-20 16:00 = JST 2026-03-21 01:00
    vi.setSystemTime(new Date("2026-03-20T16:00:00.000Z"));
    const result = getTodayForDB();
    expect(result.toISOString()).toBe("2026-03-21T00:00:00.000Z");
  });
});

describe("getDaysAgoForDB", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("7日前の日付", () => {
    vi.setSystemTime(new Date("2026-03-20T01:00:00.000Z"));
    const result = getDaysAgoForDB(7);
    expect(result.toISOString()).toBe("2026-03-13T00:00:00.000Z");
  });

  it("0日前 = 今日", () => {
    vi.setSystemTime(new Date("2026-03-20T01:00:00.000Z"));
    const result = getDaysAgoForDB(0);
    expect(result.toISOString()).toBe("2026-03-20T00:00:00.000Z");
  });
});

describe("toJSTDateForDB", () => {
  it("ISO文字列を変換（UTC 15:00 = JST翌日00:00）", () => {
    const result = toJSTDateForDB("2026-03-20T15:00:00.000Z");
    expect(result.toISOString()).toBe("2026-03-21T00:00:00.000Z");
  });

  it("Dateオブジェクトを変換", () => {
    const result = toJSTDateForDB(new Date("2026-03-20T01:00:00.000Z"));
    // UTC 01:00 = JST 10:00 → JST 3/20
    expect(result.toISOString()).toBe("2026-03-20T00:00:00.000Z");
  });

  it("UTC 00:00 = JST 09:00 → その日の日付", () => {
    const result = toJSTDateForDB("2026-03-20T00:00:00.000Z");
    expect(result.toISOString()).toBe("2026-03-20T00:00:00.000Z");
  });
});

describe("getStartOfDayJST", () => {
  it("指定日のJST開始時刻（UTC表現）", () => {
    // JST 2026-03-20 00:00:00 = UTC 2026-03-19 15:00:00
    const result = getStartOfDayJST(new Date("2026-03-20T01:00:00.000Z"));
    expect(result.toISOString()).toBe("2026-03-19T15:00:00.000Z");
  });
});

describe("getEndOfDayJST", () => {
  it("指定日のJST終了時刻（UTC表現）", () => {
    // JST 2026-03-20 23:59:59.999 = UTC 2026-03-20 14:59:59.999
    const result = getEndOfDayJST(new Date("2026-03-20T01:00:00.000Z"));
    expect(result.toISOString()).toBe("2026-03-20T14:59:59.999Z");
  });
});

// ─── 東証営業日判定 ───

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
});

describe("countTradingDaysBetween（BTパリティ: 保有営業日数）", () => {
  it("エントリー当日（from==to）→ 0", () => {
    expect(countTradingDaysBetween(jstDate("2026-03-16"), jstDate("2026-03-16"))).toBe(0);
  });

  it("月→水（連続2営業日）→ 2", () => {
    // 2026-03-16 月 → 3/17火・3/18水 の2営業日
    expect(countTradingDaysBetween(jstDate("2026-03-16"), jstDate("2026-03-18"))).toBe(2);
  });

  it("金→翌月曜（土日を挟む）→ 1", () => {
    // 2026-03-20 金 → 3/21土・3/22日は数えず、3/23月のみ
    expect(countTradingDaysBetween(jstDate("2026-03-20"), jstDate("2026-03-23"))).toBe(1);
  });

  it("祝日跨ぎ（金エントリー→翌火、月曜が海の日）→ 1（祝日は数えない）", () => {
    // 2026-07-17 金 → 7/18土・7/19日・7/20海の日(月) は除外、7/21火のみ = 1
    // 旧実装（月〜金を一律カウント）なら 7/20 を1日と数えて 2 になっていた = time-stop 早発火の原因
    expect(countTradingDaysBetween(jstDate("2026-07-17"), jstDate("2026-07-21"))).toBe(1);
  });

  it("年末年始跨ぎ（12/30水→1/4月）→ 1（12/31・1/1〜1/3は除外）", () => {
    expect(countTradingDaysBetween(jstDate("2026-12-30"), jstDate("2027-01-04"))).toBe(1);
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
