#!/usr/bin/env python3
"""
既存のPortfolioSnapshotにnikkeiCloseをバックフィルするスクリプト
一度だけ実行する。
"""

import os
import sys
from datetime import datetime, timedelta

import psycopg2
import yfinance as yf


def get_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("Error: DATABASE_URL environment variable not set")
        sys.exit(1)
    return url


def fetch_nikkei_history(days: int = 400) -> dict[str, float]:
    """日経225の過去の終値を日付→終値のマップで返す"""
    ticker = yf.Ticker("^N225")
    hist = ticker.history(period=f"{days}d")
    result = {}
    for date_idx, row in hist.iterrows():
        date_str = date_idx.strftime("%Y-%m-%d")
        result[date_str] = float(row["Close"])
    print(f"Fetched {len(result)} days of Nikkei 225 data")
    return result


def main():
    print("=" * 60)
    print("Backfill nikkeiClose in PortfolioSnapshot")
    print("=" * 60)

    conn = psycopg2.connect(get_database_url())

    try:
        # 1. nikkeiClose が NULL のスナップショット日付を取得
        with conn.cursor() as cur:
            cur.execute('''
                SELECT DISTINCT date
                FROM "PortfolioSnapshot"
                WHERE "nikkeiClose" IS NULL
                ORDER BY date ASC
            ''')
            null_dates = [row[0] for row in cur.fetchall()]

        print(f"Found {len(null_dates)} dates with NULL nikkeiClose")

        if not null_dates:
            print("Nothing to backfill. Exiting.")
            return

        # 2. 日経225のヒストリカルデータを取得
        nikkei_prices = fetch_nikkei_history()

        # 3. 各日付のnikkeiCloseを更新
        updated = 0
        with conn.cursor() as cur:
            for d in null_dates:
                date_str = d.strftime("%Y-%m-%d") if hasattr(d, 'strftime') else str(d)[:10]
                price = nikkei_prices.get(date_str)

                if price is None:
                    # 休日の場合、直前の営業日の終値を使用
                    dt = datetime.strptime(date_str, "%Y-%m-%d")
                    for offset in range(1, 8):
                        prev = (dt - timedelta(days=offset)).strftime("%Y-%m-%d")
                        if prev in nikkei_prices:
                            price = nikkei_prices[prev]
                            break

                if price is not None:
                    cur.execute(
                        'UPDATE "PortfolioSnapshot" SET "nikkeiClose" = %s WHERE date = %s AND "nikkeiClose" IS NULL',
                        (price, d)
                    )
                    updated += cur.rowcount
                else:
                    print(f"  Warning: No Nikkei price found for {date_str}")

            conn.commit()

        print(f"Updated {updated} snapshots")
        print("=" * 60)

    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
