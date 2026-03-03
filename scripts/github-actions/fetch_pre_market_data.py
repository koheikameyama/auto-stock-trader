#!/usr/bin/env python3
"""
海外市場データ（プレマーケットデータ）を取得してDBに保存するスクリプト

毎朝07:00 JST（平日のみ）に実行し、以下のデータを取得:
- CME日経225先物 (NKD=F)
- USD/JPY為替 (USDJPY=X)
- S&P 500 (^GSPC)
- NASDAQ (^IXIC)

寄り付きギャップ予測の入力データとして使用する。
"""

import os
import sys
import time

import psycopg2
import psycopg2.extras
import yfinance as yf

# scriptsディレクトリをPythonパスに追加
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.constants import (
    PRE_MARKET_TICKERS,
    PRE_MARKET_FETCH_DAYS,
    YFINANCE_RATE_LIMIT_MAX_RETRIES,
    YFINANCE_RATE_LIMIT_WAIT_SECONDS,
)
from lib.date_utils import get_today_jst_date


def get_database_url() -> str:
    """データベースURLを取得"""
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("Error: DATABASE_URL environment variable not set")
        sys.exit(1)
    return url


def _is_rate_limit_error(e: Exception) -> bool:
    """Yahoo Finance のレート制限エラーかどうか判定"""
    return (
        "YFRateLimitError" in type(e).__name__
        or "Too Many Requests" in str(e)
        or "Rate limited" in str(e)
    )


def fetch_market_data(retry_count: int = 0) -> dict:
    """yf.download() で海外市場データを一括取得し、各指標の終値と変化率を返す"""
    symbols = list(PRE_MARKET_TICKERS.values())
    print(f"Fetching market data for: {symbols}")

    try:
        df = yf.download(
            symbols,
            period=f"{PRE_MARKET_FETCH_DAYS}d",
            group_by="ticker",
            threads=True,
            progress=False,
        )
    except Exception as e:
        if _is_rate_limit_error(e) and retry_count < YFINANCE_RATE_LIMIT_MAX_RETRIES:
            wait = YFINANCE_RATE_LIMIT_WAIT_SECONDS[retry_count]
            print(f"  Rate limited. Waiting {wait}s before retry {retry_count + 1}...")
            time.sleep(wait)
            return fetch_market_data(retry_count + 1)
        print(f"  Error in yf.download: {e}")
        return {}

    if df.empty:
        if retry_count < YFINANCE_RATE_LIMIT_MAX_RETRIES:
            wait = YFINANCE_RATE_LIMIT_WAIT_SECONDS[retry_count]
            print(f"  Empty result. Waiting {wait}s before retry {retry_count + 1}...")
            time.sleep(wait)
            return fetch_market_data(retry_count + 1)
        print("  No data returned after retries")
        return {}

    results = {}

    for key, symbol in PRE_MARKET_TICKERS.items():
        try:
            hist = df[symbol]
        except (KeyError, TypeError):
            print(f"  Warning: No data for {symbol}")
            continue

        # NaN行を除去
        hist = hist.dropna(subset=["Close"])
        if len(hist) < 2:
            print(f"  Warning: Insufficient data for {symbol} ({len(hist)} rows)")
            continue

        latest_close = float(hist["Close"].iloc[-1])
        prev_close = float(hist["Close"].iloc[-2])

        if prev_close == 0:
            change_rate = 0.0
        else:
            change_rate = round(((latest_close - prev_close) / prev_close) * 100, 2)

        results[key] = {
            "close": latest_close,
            "changeRate": change_rate,
        }
        print(f"  {key} ({symbol}): close={latest_close:.2f}, change={change_rate:+.2f}%")

    return results


def save_to_db(conn, data: dict) -> None:
    """PreMarketDataテーブルにUPSERT"""
    today = get_today_jst_date()

    nikkei = data.get("nikkei_futures", {})
    usdjpy = data.get("usdjpy", {})
    sp500 = data.get("sp500", {})
    nasdaq = data.get("nasdaq", {})
    vix = data.get("vix", {})
    wti = data.get("wti", {})

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "PreMarketData" (
                id, date,
                "nikkeiFuturesClose", "nikkeiFuturesChangeRate",
                "usdjpyClose", "usdjpyChangeRate",
                "sp500Close", "sp500ChangeRate",
                "nasdaqClose", "nasdaqChangeRate",
                "vixClose", "vixChangeRate",
                "wtiClose", "wtiChangeRate",
                "createdAt", "updatedAt"
            ) VALUES (
                gen_random_uuid(), %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                NOW(), NOW()
            )
            ON CONFLICT (date) DO UPDATE SET
                "nikkeiFuturesClose" = EXCLUDED."nikkeiFuturesClose",
                "nikkeiFuturesChangeRate" = EXCLUDED."nikkeiFuturesChangeRate",
                "usdjpyClose" = EXCLUDED."usdjpyClose",
                "usdjpyChangeRate" = EXCLUDED."usdjpyChangeRate",
                "sp500Close" = EXCLUDED."sp500Close",
                "sp500ChangeRate" = EXCLUDED."sp500ChangeRate",
                "nasdaqClose" = EXCLUDED."nasdaqClose",
                "nasdaqChangeRate" = EXCLUDED."nasdaqChangeRate",
                "vixClose" = EXCLUDED."vixClose",
                "vixChangeRate" = EXCLUDED."vixChangeRate",
                "wtiClose" = EXCLUDED."wtiClose",
                "wtiChangeRate" = EXCLUDED."wtiChangeRate",
                "updatedAt" = NOW()
            """,
            (
                today,
                nikkei.get("close"), nikkei.get("changeRate"),
                usdjpy.get("close"), usdjpy.get("changeRate"),
                sp500.get("close"), sp500.get("changeRate"),
                nasdaq.get("close"), nasdaq.get("changeRate"),
                vix.get("close"), vix.get("changeRate"),
                wti.get("close"), wti.get("changeRate"),
            ),
        )

    conn.commit()
    print(f"✅ PreMarketData saved for {today}")


def main():
    print("=" * 60)
    print("Pre-market data fetch started")
    print("=" * 60)

    # 1. 海外市場データを取得
    data = fetch_market_data()
    if not data:
        print("❌ No market data fetched. Exiting.")
        sys.exit(1)

    print(f"\nFetched {len(data)}/{len(PRE_MARKET_TICKERS)} indicators")

    # 2. DBに保存
    conn = psycopg2.connect(get_database_url())
    try:
        save_to_db(conn, data)
    finally:
        conn.close()

    print("\n✅ Pre-market data fetch completed successfully")


if __name__ == "__main__":
    main()
