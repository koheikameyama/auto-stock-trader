#!/usr/bin/env python3
"""
ヒストリカル株価取得スクリプト
yfinanceを使って過去の株価データを取得
"""

import json
import os
import sys

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import yfinance as yf


def fetch_historical(ticker: str, period: str) -> list[dict]:
    """ヒストリカルデータを取得"""
    try:
        stock = yf.Ticker(ticker)
        hist = stock.history(period=period)

        results = []
        for date, row in hist.iterrows():
            results.append(
                {
                    "date": date.strftime("%Y-%m-%d"),
                    "open": round(row["Open"], 2),
                    "high": round(row["High"], 2),
                    "low": round(row["Low"], 2),
                    "close": round(row["Close"], 2),
                    "volume": int(row["Volume"]),
                }
            )

        return results
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return []


if __name__ == "__main__":
    ticker = sys.argv[1] if len(sys.argv) > 1 else ""
    period = sys.argv[2] if len(sys.argv) > 2 else "1mo"
    results = fetch_historical(ticker, period)
    print(json.dumps(results))
