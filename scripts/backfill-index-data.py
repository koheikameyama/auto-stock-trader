"""
市場指数データのバックフィル（^N225）

yfinanceで日経225（^N225）の2年分OHLCVを取得し、
StockDailyBarに INSERT（skipDuplicates相当）する。

Usage:
  python scripts/backfill-index-data.py [--yes]
"""

import os
import sys
import uuid
from datetime import date

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

SKIP_CONFIRM = "--yes" in sys.argv

if "localhost" not in DATABASE_URL and "127.0.0.1" not in DATABASE_URL:
    print(f"本番DB に接続します: {DATABASE_URL[:50]}...")
    if not SKIP_CONFIRM:
        print("続行しますか？ (y/N): ", end="")
        if input().strip().lower() != "y":
            print("中止しました")
            sys.exit(0)
    else:
        print("--yes フラグにより確認スキップ")

# 対象指数
INDEX_TICKERS = [
    ("^N225", "日経225"),
]
PERIOD = "2y"


def fetch_index_data(ticker: str) -> list[tuple]:
    """yfinanceで指数データを取得"""
    try:
        data = yf.download(
            ticker,
            period=PERIOD,
            interval="1d",
            auto_adjust=True,
            progress=False,
        )
    except Exception as e:
        print(f"  yfinance error ({ticker}): {e}")
        return []

    if data.empty:
        print(f"  データなし: {ticker}")
        return []

    # MultiIndexカラムの場合はフラット化
    if isinstance(data.columns, __import__('pandas').MultiIndex):
        data.columns = data.columns.get_level_values(0)

    import math
    bars = []
    for idx, row in data.iterrows():
        dt = idx.to_pydatetime() if hasattr(idx, "to_pydatetime") else idx
        if hasattr(dt, "date"):
            dt = dt.date()
        try:
            o = float(row["Open"])
            h = float(row["High"])
            lo = float(row["Low"])
            c = float(row["Close"])
            v_raw = row.get("Volume")
            vol = int(float(v_raw)) if v_raw is not None else 0
        except (TypeError, ValueError):
            continue
        if any(math.isnan(x) for x in [o, h, lo, c]):
            continue
        bars.append((str(uuid.uuid4()), ticker, dt, o, h, lo, c, vol))

    return bars


def insert_bars(conn, bars: list[tuple]) -> int:
    """バルクINSERT（ON CONFLICT DO NOTHING）"""
    if not bars:
        return 0
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO "StockDailyBar" (id, "tickerCode", date, open, high, low, close, volume)
            VALUES %s
            ON CONFLICT ("tickerCode", date) DO NOTHING
            """,
            bars,
        )
        inserted = cur.rowcount
    conn.commit()
    return inserted


def main():
    print("=" * 60)
    print("市場指数データ バックフィル")
    print("=" * 60)

    conn = psycopg2.connect(DATABASE_URL, connect_timeout=30)

    for ticker, name in INDEX_TICKERS:
        print(f"\n{name} ({ticker}) を取得中...")
        bars = fetch_index_data(ticker)
        if not bars:
            continue

        print(f"  取得: {len(bars)}日分")
        inserted = insert_bars(conn, bars)
        print(f"  新規INSERT: {inserted}件")

        # 確認
        with conn.cursor() as cur:
            cur.execute(
                'SELECT MIN(date), MAX(date), COUNT(*) FROM "StockDailyBar" WHERE "tickerCode" = %s',
                (ticker,),
            )
            min_d, max_d, cnt = cur.fetchone()
        print(f"  DB: {min_d} 〜 {max_d} ({cnt}件)")

    conn.close()
    print("\n完了")


if __name__ == "__main__":
    main()
