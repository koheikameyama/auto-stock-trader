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

SKIP_CONFIRM = "--yes" in sys.argv  # 確認スキップ

# 本番DB確認
if "localhost" not in DATABASE_URL and "127.0.0.1" not in DATABASE_URL:
    print(f"本番DB に接続します: {DATABASE_URL[:50]}...")
    if not SKIP_CONFIRM:
        print("続行しますか？ (y/N): ", end="")
        if input().strip().lower() != "y":
            print("中止しました")
            sys.exit(0)
    else:
        print("--yes フラグにより確認スキップ")

BATCH_SIZE = 100  # yfinance一括取得サイズ
PERIOD = "2y"    # 2年分
INSERT_PAGE_SIZE = 500  # INSERT バッチサイズ（小さめで接続切れ防止）


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
    with conn.cursor() as cur:
        for i in range(0, len(all_bars), INSERT_PAGE_SIZE):
            batch = all_bars[i:i + INSERT_PAGE_SIZE]
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO "StockDailyBar" (id, "tickerCode", date, open, high, low, close, volume)
                VALUES %s
                ON CONFLICT ("tickerCode", date) DO NOTHING
                """,
                batch,
                page_size=INSERT_PAGE_SIZE,
            )
            inserted += cur.rowcount
    conn.commit()
    return inserted


def do_insert(all_bars: list[tuple]) -> int:
    """DB挿入（リトライ付き、バッチごとに接続）"""
    inserted = 0
    for retry in range(3):
        batch_conn = None
        try:
            batch_conn = psycopg2.connect(DATABASE_URL, connect_timeout=30)
            inserted = insert_bars(batch_conn, all_bars)
            batch_conn.close()
            return inserted
        except Exception as e:
            print(f"  DB error (retry {retry + 1}/3): {e}", flush=True)
            if batch_conn:
                try:
                    batch_conn.close()
                except Exception:
                    pass
            if retry < 2:
                time.sleep(5)
            else:
                print("  SKIP: DB挿入に失敗", flush=True)
    return inserted


def main():
    print("=" * 60, flush=True)
    print("StockDailyBar 2年分バックフィル", flush=True)
    print("=" * 60, flush=True)

    conn = psycopg2.connect(DATABASE_URL, connect_timeout=30)

    # 既存データ確認
    min_date, max_date, count = get_existing_date_range(conn)
    print(f"既存データ: {min_date} 〜 {max_date} ({count:,}件)", flush=True)

    # アクティブ銘柄取得
    tickers = get_active_tickers(conn)
    print(f"対象銘柄: {len(tickers)}件", flush=True)
    conn.close()

    total_batches = (len(tickers) + BATCH_SIZE - 1) // BATCH_SIZE
    total_inserted = 0
    total_bars = 0
    failed_tickers: list[str] = []

    # パイプライン: 現バッチのDB挿入中に次バッチをpre-fetch
    with ThreadPoolExecutor(max_workers=1) as executor:
        # 最初のバッチのfetchを先行開始
        current_future = executor.submit(fetch_ohlcv_batch, tickers[:BATCH_SIZE])

        for batch_idx in range(total_batches):
            start = batch_idx * BATCH_SIZE
            end = min(start + BATCH_SIZE, len(tickers))
            batch_tickers = tickers[start:end]

            # 次バッチのfetchを先行開始（現バッチの処理と並行）
            next_start = end
            next_batch_tickers = tickers[next_start:next_start + BATCH_SIZE] if next_start < len(tickers) else None
            if next_batch_tickers:
                next_future = executor.submit(fetch_ohlcv_batch, next_batch_tickers)

            print(f"\n[{batch_idx + 1}/{total_batches}] {batch_tickers[0]}〜{batch_tickers[-1]} ({len(batch_tickers)}銘柄)", flush=True)

            # 現バッチのfetch結果を待つ
            results = current_future.result()

            # バーを収集
            all_bars = []
            for t in batch_tickers:
                bars = results.get(t, [])
                if not bars:
                    failed_tickers.append(t)
                all_bars.extend(bars)
            total_bars += len(all_bars)

            # DB挿入（次バッチのfetchと並行して実行される）
            inserted = do_insert(all_bars)
            total_inserted += inserted

            print(f"  取得: {len(results)}/{len(batch_tickers)}銘柄, {len(all_bars)}バー, 新規INSERT: {inserted}件", flush=True)

            # 次バッチへ
            if next_batch_tickers:
                current_future = next_future
                time.sleep(1)  # レート制限回避（短縮: 2s→1s）

    # 最終確認
    final_conn = psycopg2.connect(DATABASE_URL, connect_timeout=30)
    min_date2, max_date2, count2 = get_existing_date_range(final_conn)
    final_conn.close()

    print("\n" + "=" * 60, flush=True)
    print("完了", flush=True)
    print("=" * 60, flush=True)
    print(f"取得バー数: {total_bars:,}", flush=True)
    print(f"新規INSERT: {total_inserted:,}", flush=True)
    print(f"失敗銘柄: {len(failed_tickers)}", flush=True)
    print(f"DB: {min_date2} 〜 {max_date2} ({count2:,}件)", flush=True)


if __name__ == "__main__":
    main()
