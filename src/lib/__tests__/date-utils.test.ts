import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  jstDateAsUTC,
  getTodayForDB,
  getDaysAgoForDB,
  toJSTDateForDB,
  getStartOfDayJST,
  getEndOfDayJST,
} from "../date-utils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

describe("jstDateAsUTC", () => {
  it("JST日付をUTC 00:00のDateオブジェクトとして返す", () => {
    const d = dayjs.tz("2026-03-20 10:30", "Asia/Tokyo");
    const result = jstDateAsUTC(d);
    expect(result.toISOString()).toBe("2026-03-20T00:00:00.000Z");
  });

  it("JST 1月1日を正しく変換", () => {
    const d = dayjs.tz("2026-01-01 00:00", "Asia/Tokyo");
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
