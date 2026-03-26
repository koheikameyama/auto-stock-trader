# Breakout + Score Filter Verification Design

## Purpose

Verify whether adding a scoring filter to the breakout strategy improves expected value (expectancy), profit factor (PF), and risk-adjusted returns. The scoring system was previously removed because it underperformed as a standalone entry strategy, but it may add value as a filter on top of breakout signals.

## Approach

B案: Create a lightweight, backtest-only scoring module. Run a single backtest comparing filter-on/off across multiple thresholds and categories.

## Module: `src/backtest/scoring-filter.ts`

A single-file scoring engine that computes 3 category scores from OHLCV data.

### Scoring Categories

| Category | Max Points | Sub-scores |
|----------|-----------|------------|
| Trend Quality | 40 | MA Alignment (18) + Weekly Trend (12) + Trend Continuity (10) |
| Entry Timing | 35 | Pullback Depth (15) + Prior Breakout (12) + Candlestick Signal (8) |
| Risk Quality | 25 | ATR Stability (10) + Range Contraction (8) + Volume Stability (7) |
| **Total** | **100** | |

### Excluded from Backtest

- Sector momentum bonus: requires external sector-vs-Nikkei data (defaults to 0)
- Earnings/dividend gates: requires external calendar data (skipped)
- Liquidity/price/volatility gates: already implemented in breakout simulation

### Sub-score Details

#### Trend Quality (40 pts)

**MA Alignment (0-18):**
- Perfect order (close > SMA5 > SMA25 > SMA75): 18
- close > SMA5 > SMA25: 14
- close > SMA25, close < SMA5: 8
- Pullback in uptrend (close < SMA25, close > SMA75, SMA25 > SMA75): 4
- close > SMA75 only: 2
- Otherwise: 0

**Weekly Trend (0-12):**
- Weekly close aggregated from daily bars, SMA13 of weekly closes
- changeRate = (weeklySma13 - prevWeeklySma13) / prevWeeklySma13 * 100
- Above SMA13 + rising (changeRate > 0.5%): 12
- Above SMA13 + flat: 8
- Below SMA13 + rising: 4
- Otherwise: 0

**Trend Continuity (0-10):**
- Days above SMA25: 10-30 days (sweet spot): 10, <10: 7, 30-50: 5, >50: 2, 0: 0

#### Entry Timing (35 pts)

**Pullback Depth (0-15):**
- deviationRate25 = (close - SMA25) / SMA25 * 100
- < -3%: 0 (too deep)
- -1% to 2% with reversal sign: 15
- -1% to 2%: 10
- Between SMA5 and SMA25 (dev > 2%): 10
- Just recovered above SMA25: 8
- 2-5% deviation: 6
- Above SMA5: 4
- Otherwise: 0

**Prior Breakout (0-12):**
- 20-day high within 7 days + volume ratio > 1.5: 12
- 20-day high within 7 days + volume ratio > 1.2: 9
- 20-day high within 7 days: 7
- 10-day high within 5 days: 5
- Close near 10-day high (>= 95%): 2
- Otherwise: 0

**Candlestick Signal (0-8):**
- Bullish engulfing + volume > avg: 8
- Hammer: 6
- 3 consecutive bullish + increasing volume: 5
- Strong bullish bar: 4
- Doji: 3
- Otherwise: 0

#### Risk Quality (25 pts)

**ATR Stability (0-10):**
- ATR CV (coefficient of variation over 20 days)
- CV < 0.15: 10, < 0.25: 7, < 0.35: 4, >= 0.35: 0

**Range Contraction (0-8):**
- BB width percentile over 60 days
- < 20th percentile: 8, < 40th: 5, < 60th: 3, >= 60th: 0

**Volume Stability (0-7):**
- volumeMA5 vs volumeMA25 + volume CV over 25 days
- Increasing + CV < 0.5: 7, Increasing + CV < 0.8: 5
- Stable + CV < 0.5: 3, Stable + CV < 0.8: 1, Otherwise: 0

### Input / Output

**Input:** `OHLCVData[]` (the same array the backtest simulation already has per ticker)

**Output:**
```typescript
interface ScoreFilterResult {
  total: number;   // 0-100
  trend: number;   // 0-40
  timing: number;  // 0-35
  risk: number;    // 0-25
}
```

### Data Requirements

All indicators are computed from OHLCV. Minimum 100 bars of history needed per ticker (80 for BB width percentile lookback + buffer).

The existing `analyzeTechnicals()` provides: SMA5/25/75, ATR14, Bollinger Bands, volume analysis (avgVolume20, volumeRatio). Additional calculations needed:
- Weekly SMA13 (aggregate daily to weekly, compute 13-period SMA)
- Days above SMA25 (count consecutive days)
- ATR CV (stddev/mean of ATR14 over 20 days)
- BB width percentile (rank current BB width in 60-day history)
- Volume CV (stddev/mean of volume over 25 days)

## Integration Point

In `breakout-simulation.ts` > `detectBreakoutEntries()`, after all existing gates pass and before the entry is added to the `entries` array:

```
Volume surge + High breakout
  -> Existing gates (liquidity, price, volatility, maxChaseAtr)
  -> [Score calculation -> Threshold check]  <-- NEW
  -> Entry added to candidates
```

The scoring filter is disabled by default (threshold = 0). When `--score-compare` is active, the simulation runs multiple times with different thresholds.

## CLI: `--score-compare` Option

Added to `breakout-run.ts`. When specified:

1. Fetch data once (all tickers, full date range)
2. Run 14 simulations sequentially with the same data:

| # | Filter | Threshold |
|---|--------|-----------|
| 1 | (none) | - |
| 2-5 | total >= | 40, 50, 60, 70 |
| 6-8 | trend >= | 15, 20, 25 |
| 9-11 | timing >= | 15, 20, 25 |
| 12-14 | risk >= | 10, 15, 20 |

3. Print comparison table:

```
=== Score Filter Comparison (2025-04 to 2026-03) ===
Filter          | Trades | WinRate | PF   | Expectancy | MaxDD  | RR
----------------|--------|---------|------|------------|--------|-----
(none)          |    120 |  38.3%  | 1.42 |    +0.67%  | -8.2%  | 1.8
total >= 40     |    105 |  39.0%  | 1.48 |    +0.72%  | -7.5%  | 1.9
total >= 50     |     82 |  41.5%  | 1.55 |    +0.85%  | -6.8%  | 2.0
...
```

## Scope

### In Scope

- `src/backtest/scoring-filter.ts`: New file, scoring logic
- `src/backtest/breakout-simulation.ts`: Add optional score filter hook
- `src/backtest/breakout-run.ts`: Add `--score-compare` CLI option, comparison report
- `src/backtest/types.ts`: Add score filter types if needed

### Out of Scope

- Restoring `src/core/scoring/` directory
- Walk-forward integration of score parameters
- Real trading integration
- UI/Web changes
- Tests for scoring-filter.ts (verification tool, not production code)

## Performance

- 14 simulations, data fetch once
- Each simulation: same speed as current (~tens of seconds)
- Total estimated runtime: ~10 minutes

## Success Criteria

The filter is considered effective if any threshold shows:
- Higher expectancy than baseline
- PF improvement without catastrophic trade count reduction (>50% drop)
- Better or comparable max drawdown
