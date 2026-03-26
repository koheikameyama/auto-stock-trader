"""
StockDailyBar 2年分バックフィル（一回限り）

yfinance で2年分のOHLCVを取得し、本番DBのStockDailyBarに
INSERT（skipDuplicates相当）する。既存データは上書きしない。

Usage:
  python scripts/backfill-daily-bars-2y.py
"""

import os
import sys
import time
import uuid
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

import yfinance as yf
import psycopg2
import psycopg2.extras

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    # .envから読み込み
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

# 本番DB確認
if "localhost" not in DATABASE_URL and "127.0.0.1" not in DATABASE_URL:
    print(f"本番DB に接続します: {DATABASE_URL[:50]}...")
    print("続行しますか？ (y/N): ", end="")
    if input().strip().lower() != "y":
        print("中止しました")
        sys.exit(0)

BATCH_SIZE = 50  # yfinance一括取得サイズ
PERIOD = "2y"    # 2年分
MAX_WORKERS = 3  # 並列DB書き込み数


def get_active_tickers(conn) -> list[str]:
    """アクティブな銘柄コード一覧を取得"""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT "tickerCode" FROM "Stock"
            WHERE "isDelisted" = false AND "isActive" = true AND "isRestricted" = false
            ORDER BY "tickerCode"
        """)
        return [row[0] for row in cur.fetchall()]


def get_existing_date_range(conn) -> tuple:
    """既存データの日付範囲を確認"""
    with conn.cursor() as cur:
        cur.execute('SELECT MIN(date), MAX(date), COUNT(*) FROM "StockDailyBar"')
        return cur.fetchone()


def fetch_ohlcv_batch(tickers: list[str]) -> dict:
    """yfinanceでバッチ取得（tickerCodeは既に.T付き）"""
    ticker_str = " ".join(tickers)

    try:
        data = yf.download(
            ticker_str,
            period=PERIOD,
            interval="1d",
            group_by="ticker",
            auto_adjust=True,
            progress=False,
            threads=True,
        )
    except Exception as e:
        print(f"  yfinance error: {e}")
        return {}

    results = {}
    if len(tickers) == 1:
        # 単一銘柄の場合、DataFrameの構造が異なる
        t = tickers[0]
        if not data.empty:
            bars = []
            for idx, row in data.iterrows():
                dt = idx.to_pydatetime() if hasattr(idx, 'to_pydatetime') else idx
                if hasattr(dt, 'date'):
                    dt = dt.date()
                o, h, l, c, v = row.get("Open"), row.get("High"), row.get("Low"), row.get("Close"), row.get("Volume")
                if all(x is not None and x == x for x in [o, h, l, c, v]):
                    bars.append((str(uuid.uuid4()), t, dt, float(o), float(h), float(l), float(c), int(v)))
            results[t] = bars
    else:
        for t in tickers:
            try:
                ticker_data = data[t]
                if ticker_data.empty:
                    continue
                bars = []
                for idx, row in ticker_data.iterrows():
                    dt = idx.to_pydatetime() if hasattr(idx, 'to_pydatetime') else idx
                    if hasattr(dt, 'date'):
                        dt = dt.date()
                    o, h, l, c, v = row.get("Open"), row.get("High"), row.get("Low"), row.get("Close"), row.get("Volume")
                    if all(x is not None and x == x for x in [o, h, l, c, v]):
                        bars.append((str(uuid.uuid4()), t, dt, float(o), float(h), float(l), float(c), int(v)))
                if bars:
                    results[t] = bars
            except (KeyError, Exception):
                continue

    return results


def insert_bars(conn, all_bars: list[tuple]):
    """バルクINSERT（ON CONFLICT DO NOTHING）"""
    if not all_bars:
        return 0

    inserted = 0
    page_size = 1000
    with conn.cursor() as cur:
        for i in range(0, len(all_bars), page_size):
            batch = all_bars[i:i + page_size]
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO "StockDailyBar" (id, "tickerCode", date, open, high, low, close, volume)
                VALUES %s
                ON CONFLICT ("tickerCode", date) DO NOTHING
                """,
                batch,
                page_size=page_size,
            )
            inserted += cur.rowcount
    conn.commit()
    return inserted


def main():
    print("=" * 60)
    print("StockDailyBar 2年分バックフィル")
    print("=" * 60)

    conn = psycopg2.connect(DATABASE_URL)

    # 既存データ確認
    min_date, max_date, count = get_existing_date_range(conn)
    print(f"既存データ: {min_date} 〜 {max_date} ({count:,}件)")

    # アクティブ銘柄取得
    tickers = get_active_tickers(conn)
    print(f"対象銘柄: {len(tickers)}件")

    total_batches = (len(tickers) + BATCH_SIZE - 1) // BATCH_SIZE
    total_inserted = 0
    total_bars = 0
    failed_tickers = []

    for batch_idx in range(total_batches):
        start = batch_idx * BATCH_SIZE
        end = min(start + BATCH_SIZE, len(tickers))
        batch_tickers = tickers[start:end]

        print(f"\n[{batch_idx + 1}/{total_batches}] {batch_tickers[0]}〜{batch_tickers[-1]} ({len(batch_tickers)}銘柄)")

        results = fetch_ohlcv_batch(batch_tickers)

        # 全バーを収集
        all_bars = []
        for t in batch_tickers:
            bars = results.get(t, [])
            if not bars:
                failed_tickers.append(t)
            all_bars.extend(bars)

        total_bars += len(all_bars)

        # DB挿入
        inserted = insert_bars(conn, all_bars)
        total_inserted += inserted

        print(f"  取得: {len(results)}/{len(batch_tickers)}銘柄, {len(all_bars)}バー, 新規INSERT: {inserted}件")

        # レート制限回避
        if batch_idx < total_batches - 1:
            time.sleep(2)

    # 最終確認
    min_date2, max_date2, count2 = get_existing_date_range(conn)

    print("\n" + "=" * 60)
    print("完了")
    print("=" * 60)
    print(f"取得バー数: {total_bars:,}")
    print(f"新規INSERT: {total_inserted:,}")
    print(f"失敗銘柄: {len(failed_tickers)}")
    print(f"DB: {min_date2} 〜 {max_date2} ({count2:,}件)")

    conn.close()


if __name__ == "__main__":
    main()
