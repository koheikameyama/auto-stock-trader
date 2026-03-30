import { describe, it, expect, beforeEach } from "vitest";
import { BreakoutScanner, QuoteData } from "../breakout-scanner";
import type { WatchlistEntry } from "../types";

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function makeWatchlistEntry(
  ticker: string,
  overrides: Partial<WatchlistEntry> = {},
): WatchlistEntry {
  return {
    ticker,
    avgVolume25: 100_000,
    high20: 1000,
    atr14: 20,
    latestClose: 980,
    ...overrides,
  };
}

/**
 * 9:30 JST の Date を返す（デフォルト）
 */
function makeTime(hour: number, minute: number): Date {
  // Use a fixed date; only hour/minute matter for the scanner logic
  const d = new Date(Date.UTC(2026, 2, 24)); // 2026-03-24 00:00 UTC
  // Set JST hour/minute: JST = UTC + 9, so UTC = JST - 9
  d.setUTCHours(hour - 9, minute, 0, 0);
  return d;
}

/**
 * calculateVolumeSurgeRatio をシミュレートして必要な累積出来高を逆算する。
 *
 * ratio = cumulativeVolume / (avgVolume25 * elapsedFraction)
 * → cumulativeVolume = ratio * avgVolume25 * elapsedFraction
 *
 * 9:30 の elapsedFraction = 30/300 = 0.1
 */
function volumeForRatio(ratio: number, avgVolume25: number, hour: number, minute: number): number {
  // elapsedFraction of 9:30 = 30/300 = 0.1
  // We need to import getElapsedFraction but it's easier to inline for tests.
  // For morning session: elapsedMinutes = (hour*60+minute) - 9*60
  const morningStart = 9 * 60;
  const morningEnd = 11 * 60 + 30;
  const afternoonStart = 12 * 60 + 30;
  const morningMinutes = 150;
  const totalMinutes = 300;

  const t = hour * 60 + minute;
  let elapsed: number;
  if (t < morningStart) {
    elapsed = 0;
  } else if (t <= morningEnd) {
    elapsed = t - morningStart;
  } else if (t < afternoonStart) {
    elapsed = morningMinutes;
  } else {
    elapsed = morningMinutes + Math.min(t - afternoonStart, morningMinutes);
  }

  const fraction = elapsed / totalMinutes;
  return ratio * avgVolume25 * fraction;
}

// ----------------------------------------------------------------
// Default test fixtures
// ----------------------------------------------------------------

const DEFAULT_TICKER = "1234";
const DEFAULT_WATCHLIST: WatchlistEntry[] = [makeWatchlistEntry(DEFAULT_TICKER)];
const SCAN_TIME = makeTime(9, 30); // 9:30 JST — well within trading window
const NO_HOLDINGS = new Set<string>();

function makeQuote(ticker: string, ratio: number, hour = 9, minute = 30, price = 1001): QuoteData {
  const entry = DEFAULT_WATCHLIST.find((e) => e.ticker === ticker) ??
    makeWatchlistEntry(ticker);
  return {
    ticker,
    price,
    volume: Math.ceil(volumeForRatio(ratio, entry.avgVolume25, hour, minute)),
  };
}

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe("BreakoutScanner", () => {
  let scanner: BreakoutScanner;

  beforeEach(() => {
    scanner = new BreakoutScanner(DEFAULT_WATCHLIST);
  });

  // 1. Initial state: empty hot set, no triggers
  it("1. 初期状態: hotSet が空でトリガーが発火しない", () => {
    const state = scanner.getState();
    expect(state.hotSet.size).toBe(0);
    expect(state.triggeredToday.size).toBe(0);
    expect(state.watchlist).toHaveLength(1);

    // Quote でサージなし（ratio 1.0）→ Cold スキャンでもホット昇格しない
    const quote: QuoteData = makeQuote(DEFAULT_TICKER, 1.0);
    const triggers = scanner.scan([quote], SCAN_TIME, NO_HOLDINGS);

    expect(triggers).toHaveLength(0);
    expect(scanner.getState().hotSet.size).toBe(0);
  });

  // 2. volumeSurgeRatio >= 1.5 → Cold → Hot promotion
  it("2. surgeRatio >= 1.5 → Cold から Hot に昇格する", () => {
    // First cold scan: lastColdScanTime = 0, so 5 min interval passes (epoch vs now)
    const quote = makeQuote(DEFAULT_TICKER, 1.5);
    const triggers = scanner.scan([quote], SCAN_TIME, NO_HOLDINGS);

    expect(triggers).toHaveLength(0); // 昇格のみ、トリガーはまだ
    expect(scanner.getState().hotSet.has(DEFAULT_TICKER)).toBe(true);
    expect(scanner.getState().hotSet.get(DEFAULT_TICKER)!.coolDownCount).toBe(0);
  });

  // 3. volumeSurgeRatio < 1.2 twice consecutively → Hot → Cold demotion
  it("3. surgeRatio < 1.2 が2回連続 → Hot から Cold に降格する", () => {
    // Promote to hot first
    scanner.scan([makeQuote(DEFAULT_TICKER, 1.5)], SCAN_TIME, NO_HOLDINGS);
    expect(scanner.getState().hotSet.has(DEFAULT_TICKER)).toBe(true);

    // 1st low surge (ratio 1.0 < 1.2) → coolDownCount = 1
    const time2 = makeTime(9, 31);
    scanner.scan([makeQuote(DEFAULT_TICKER, 1.0, 9, 31)], time2, NO_HOLDINGS);
    const hotEntry = scanner.getState().hotSet.get(DEFAULT_TICKER);
    expect(hotEntry).toBeDefined();
    expect(hotEntry!.coolDownCount).toBe(1);

    // 2nd low surge → coolDownCount reaches 2 → demote
    const time3 = makeTime(9, 32);
    scanner.scan([makeQuote(DEFAULT_TICKER, 1.0, 9, 32)], time3, NO_HOLDINGS);
    expect(scanner.getState().hotSet.has(DEFAULT_TICKER)).toBe(false);
  });

  // 4. volumeSurgeRatio < 1.2 once, then >= 1.2 → coolDownCount resets
  it("4. surgeRatio < 1.2 の1回後に >= 1.2 → coolDownCount がリセットされる", () => {
    // Promote to hot
    scanner.scan([makeQuote(DEFAULT_TICKER, 1.5)], SCAN_TIME, NO_HOLDINGS);

    // 1st low surge → coolDownCount = 1
    const time2 = makeTime(9, 31);
    scanner.scan([makeQuote(DEFAULT_TICKER, 1.0, 9, 31)], time2, NO_HOLDINGS);
    expect(scanner.getState().hotSet.get(DEFAULT_TICKER)!.coolDownCount).toBe(1);

    // Recover → coolDownCount = 0
    const time3 = makeTime(9, 32);
    scanner.scan([makeQuote(DEFAULT_TICKER, 1.3, 9, 32)], time3, NO_HOLDINGS);
    expect(scanner.getState().hotSet.has(DEFAULT_TICKER)).toBe(true);
    expect(scanner.getState().hotSet.get(DEFAULT_TICKER)!.coolDownCount).toBe(0);
  });

  // 5. volumeSurgeRatio >= 2.0 AND price > high20 → trigger fires
  it("5. surgeRatio >= 2.0 かつ price > high20 → トリガーが発火する", () => {
    // Promote to hot
    scanner.scan([makeQuote(DEFAULT_TICKER, 1.5)], SCAN_TIME, NO_HOLDINGS);

    // Trigger condition: ratio >= 2.0, price > high20 (1000)
    const time2 = makeTime(9, 31);
    const triggerQuote: QuoteData = {
      ticker: DEFAULT_TICKER,
      price: 1010, // > high20 (1000)
      volume: Math.ceil(volumeForRatio(2.0, 100_000, 9, 31)),
    };
    const triggers = scanner.scan([triggerQuote], time2, NO_HOLDINGS);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].ticker).toBe(DEFAULT_TICKER);
    expect(triggers[0].volumeSurgeRatio).toBeGreaterThanOrEqual(2.0);
    expect(triggers[0].currentPrice).toBe(1010);
    expect(triggers[0].high20).toBe(1000);
    expect(scanner.getState().triggeredToday.has(DEFAULT_TICKER)).toBe(true);
  });

  // 6. Same ticker 2nd trigger → blocked (triggeredToday)
  it("6. 同一ティッカーの2回目トリガー → triggeredToday でブロックされる", () => {
    // Promote to hot then trigger
    scanner.scan([makeQuote(DEFAULT_TICKER, 1.5)], SCAN_TIME, NO_HOLDINGS);
    const time2 = makeTime(9, 31);
    const triggerQuote: QuoteData = {
      ticker: DEFAULT_TICKER,
      price: 1010,
      volume: Math.ceil(volumeForRatio(2.0, 100_000, 9, 31)),
    };
    const firstTriggers = scanner.scan([triggerQuote], time2, NO_HOLDINGS);
    expect(firstTriggers).toHaveLength(1);

    // Re-promote (simulate another cold→hot cycle for same ticker)
    // Manually inject back into hotSet to simulate re-entry attempt
    const state = scanner.getState() as unknown as {
      hotSet: Map<string, { ticker: string; promotedAt: Date; coolDownCount: number }>;
    };
    state.hotSet.set(DEFAULT_TICKER, {
      ticker: DEFAULT_TICKER,
      promotedAt: time2,
      coolDownCount: 0,
    });

    // Attempt 2nd trigger
    const time3 = makeTime(9, 35);
    const secondTriggers = scanner.scan([triggerQuote], time3, NO_HOLDINGS);
    expect(secondTriggers).toHaveLength(0);
  });

  // 7. Before 9:05 → no scanning
  it("7. 9:05 より前 → スキャンを行わない（Cold 昇格もトリガーもなし）", () => {
    const earlyTime = makeTime(9, 4);
    const quote = makeQuote(DEFAULT_TICKER, 2.0, 9, 4, 1010);
    const triggers = scanner.scan([quote], earlyTime, NO_HOLDINGS);

    expect(triggers).toHaveLength(0);
    expect(scanner.getState().hotSet.size).toBe(0);
  });

  // 8. After 15:25 → no trigger firing
  it("8. 15:25 より後 → トリガーが発火しない（Hot 昇格は可能）", () => {
    // First promote to hot at 9:30
    scanner.scan([makeQuote(DEFAULT_TICKER, 1.5)], SCAN_TIME, NO_HOLDINGS);
    expect(scanner.getState().hotSet.has(DEFAULT_TICKER)).toBe(true);

    // After 15:25, attempt to trigger
    const lateTime = makeTime(15, 26);
    const triggerQuote: QuoteData = {
      ticker: DEFAULT_TICKER,
      price: 1010,
      volume: Math.ceil(volumeForRatio(2.5, 100_000, 15, 1)),
    };
    const triggers = scanner.scan([triggerQuote], lateTime, NO_HOLDINGS);

    expect(triggers).toHaveLength(0);
  });

  // 9. Holding tickers → skipped
  it("10. 保有中のティッカー → Cold スキャンをスキップし、トリガーも発火しない", () => {
    const holdings = new Set([DEFAULT_TICKER]);

    // Cold scan should skip
    const quote = makeQuote(DEFAULT_TICKER, 2.0, 9, 30, 1010);
    const triggers = scanner.scan([quote], SCAN_TIME, holdings);

    expect(triggers).toHaveLength(0);
    expect(scanner.getState().hotSet.has(DEFAULT_TICKER)).toBe(false);
  });

  // 11. Cold scan only runs every 5 min per ticker (lastColdScanTime)
  it("11. Cold スキャンは各ティッカーで5分ごとにのみ実行される", () => {
    // First scan at 9:30 → cold scan fires, surgeRatio = 1.5 → promoted
    const quote = makeQuote(DEFAULT_TICKER, 1.5);
    scanner.scan([quote], SCAN_TIME, NO_HOLDINGS);
    expect(scanner.getState().hotSet.has(DEFAULT_TICKER)).toBe(true);

    // Demote back to cold manually to test interval
    const state = scanner.getState() as unknown as {
      hotSet: Map<string, unknown>;
    };
    state.hotSet.delete(DEFAULT_TICKER);
    expect(scanner.getState().hotSet.has(DEFAULT_TICKER)).toBe(false);

    // Scan again immediately (< 5 min elapsed) — cold scan should NOT run
    // We use time only 1 minute later (9:31) which is < COLD_INTERVAL_MS (5 min)
    const time2 = makeTime(9, 31);
    const highSurgeQuote: QuoteData = {
      ticker: DEFAULT_TICKER,
      price: 1010,
      volume: Math.ceil(volumeForRatio(2.0, 100_000, 9, 31)),
    };
    scanner.scan([highSurgeQuote], time2, NO_HOLDINGS);

    // Cold scan was skipped → not promoted again
    expect(scanner.getState().hotSet.has(DEFAULT_TICKER)).toBe(false);

    // Scan again after 5+ minutes (9:36) — cold scan should run
    const time3 = makeTime(9, 36);
    const promotingQuote = makeQuote(DEFAULT_TICKER, 1.5, 9, 36);
    scanner.scan([promotingQuote], time3, NO_HOLDINGS);
    expect(scanner.getState().hotSet.has(DEFAULT_TICKER)).toBe(true);
  });

  // 12. Multiple triggers → sorted by volumeSurgeRatio descending
  it("12. 複数トリガー発火時 → volumeSurgeRatio 降順でソートされる", () => {
    const tickerA = "1111";
    const tickerB = "2222";
    const tickerC = "3333";
    const watchlist: WatchlistEntry[] = [
      makeWatchlistEntry(tickerA),
      makeWatchlistEntry(tickerB),
      makeWatchlistEntry(tickerC),
    ];
    const multiScanner = new BreakoutScanner(watchlist);

    // Step 1: Cold → Hot に全銘柄を昇格
    const hotQuotes: QuoteData[] = [
      { ticker: tickerA, price: 980, volume: Math.ceil(volumeForRatio(1.5, 100_000, 9, 30)) },
      { ticker: tickerB, price: 980, volume: Math.ceil(volumeForRatio(1.5, 100_000, 9, 30)) },
      { ticker: tickerC, price: 980, volume: Math.ceil(volumeForRatio(1.5, 100_000, 9, 30)) },
    ];
    multiScanner.scan(hotQuotes, SCAN_TIME, NO_HOLDINGS);

    // Step 2: 異なるサージ比率でトリガー発火（A=2.5x, B=3.0x, C=2.0x）
    const time2 = makeTime(9, 31);
    const triggerQuotes: QuoteData[] = [
      { ticker: tickerA, price: 1010, volume: Math.ceil(volumeForRatio(2.5, 100_000, 9, 31)) },
      { ticker: tickerB, price: 1010, volume: Math.ceil(volumeForRatio(3.0, 100_000, 9, 31)) },
      { ticker: tickerC, price: 1010, volume: Math.ceil(volumeForRatio(2.0, 100_000, 9, 31)) },
    ];
    const triggers = multiScanner.scan(triggerQuotes, time2, NO_HOLDINGS);

    expect(triggers).toHaveLength(3);
    // B(3.0x) > A(2.5x) > C(2.0x) の順
    expect(triggers[0].ticker).toBe(tickerB);
    expect(triggers[1].ticker).toBe(tickerA);
    expect(triggers[2].ticker).toBe(tickerC);
  });
});
