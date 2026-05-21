"""
米株 ETF (1547 SPY, 1545 NASDAQ100) の過去データを取得し、Stock + StockDailyBar に保存

A-1: 米株 ETF 戦略のためのデータ準備
"""

import os
import sys
import time
import uuid
from datetime import datetime

import yfinance as yf
import psycopg2
import psycopg2.extras

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("DATABASE_URL="):
                    DATABASE_URL = line.split("=", 1)[1].strip('"').strip("'")
                    break

if not DATABASE_URL:
    print("ERROR: DATABASE_URL が見つかりません")
    sys.exit(1)

# 米株 ETF (yfinance ticker, code, name)
ETFS = [
    ("1547.T", "1547", "SPDR S&P500 ETF", "東証プライム"),
    ("1545.T", "1545", "NEXT FUNDS NASDAQ-100 連動型上場投信", "東証プライム"),
]

START_DATE = "2018-01-01"
END_DATE = None  # 今日まで


def upsert_stocks(conn):
    """Stock テーブルに ETF を UPSERT"""
    with conn.cursor() as cur:
        for _yf_ticker, code, name, market in ETFS:
            cur.execute(
                """
                INSERT INTO "Stock" (id, "tickerCode", name, market, "isActive", "isDelisted", "isRestricted", "createdAt")
                VALUES (%s, %s, %s, %s, true, false, false, NOW())
                ON CONFLICT ("tickerCode") DO UPDATE SET name = EXCLUDED.name
                """,
                (str(uuid.uuid4()), code, name, market),
            )
        conn.commit()
    print(f"Stock UPSERT 完了 ({len(ETFS)} ETFs)")


def fetch_and_insert(conn, yf_ticker, code):
    """yfinance から取得 → StockDailyBar に INSERT"""
    print(f"\n--- {yf_ticker} ({code}) ---")
    df = yf.download(
        yf_ticker,
        start=START_DATE,
        end=END_DATE,
        auto_adjust=True,
        progress=False,
    )
    if df.empty:
        print("  データ取得失敗")
        return 0

    if hasattr(df.columns, "levels"):
        df.columns = [c[0] for c in df.columns]

    bars = []
    for idx, row in df.iterrows():
        dt = idx.to_pydatetime() if hasattr(idx, "to_pydatetime") else idx
        if hasattr(dt, "date"):
            dt = dt.date()
        o, h, l, c, v = (
            row.get("Open"),
            row.get("High"),
            row.get("Low"),
            row.get("Close"),
            row.get("Volume"),
        )
        if all(x is not None and x == x for x in [o, h, l, c, v]):
            bars.append(
                (str(uuid.uuid4()), code, dt, float(o), float(h), float(l), float(c), int(v), "JP")
            )

    print(f"  取得バー数: {len(bars)}")

    if not bars:
        return 0

    inserted = 0
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO "StockDailyBar" (id, "tickerCode", date, open, high, low, close, volume, market)
            VALUES %s
            ON CONFLICT ("tickerCode", date) DO NOTHING
            """,
            bars,
            page_size=500,
        )
        inserted = cur.rowcount
    conn.commit()
    print(f"  INSERT: {inserted} 件")
    return inserted


def main():
    print("=" * 60, flush=True)
    print(f"米株 ETF バックフィル: {START_DATE} 〜 today", flush=True)
    print("=" * 60, flush=True)

    conn = psycopg2.connect(DATABASE_URL, connect_timeout=30)

    # Step 1: Stock テーブルに登録
    upsert_stocks(conn)

    # Step 2: 各 ETF をバックフィル
    total = 0
    for yf_ticker, code, _name, _market in ETFS:
        total += fetch_and_insert(conn, yf_ticker, code)
        time.sleep(1)  # rate limit

    print(f"\n合計 INSERT: {total:,} 件", flush=True)

    # 最終確認
    with conn.cursor() as cur:
        for _yf_ticker, code, _name, _market in ETFS:
            cur.execute(
                """
                SELECT MIN(date), MAX(date), COUNT(*)
                FROM "StockDailyBar" WHERE "tickerCode" = %s
                """,
                (code,),
            )
            min_d, max_d, cnt = cur.fetchone()
            print(f"  {code}: {min_d} 〜 {max_d} ({cnt} 件)", flush=True)

    conn.close()


if __name__ == "__main__":
    main()
