"""
EarningsDate テーブル バックフィル

yfinance で過去2年分の決算日を取得し、EarningsDateテーブルに格納。

Usage:
  python scripts/backfill-earnings-dates.py
  python scripts/backfill-earnings-dates.py --yes   # 確認スキップ
"""

import os
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

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

CONCURRENCY = 5
INSERT_PAGE_SIZE = 500


def get_active_tickers(conn) -> list[str]:
    """アクティブな銘柄コード一覧を取得"""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT "tickerCode" FROM "Stock"
            WHERE "isDelisted" = false AND "isActive" = true AND "isRestricted" = false
            ORDER BY "tickerCode"
        """)
        return [row[0] for row in cur.fetchall()]


def fetch_earnings_dates(ticker: str) -> list[tuple]:
    """yfinance で決算日を取得"""
    # .T サフィックス付きのYahoo Financeティッカー
    yf_ticker = ticker if ticker.startswith("^") else ticker.replace(".T", "") + ".T" if ".T" not in ticker else ticker

    try:
        t = yf.Ticker(yf_ticker)
        # get_earnings_dates は直近の決算日リストを返す
        eds = t.get_earnings_dates(limit=12)  # 四半期×3年分
        if eds is None or eds.empty:
            return []

        rows = []
        seen = set()
        for idx in eds.index:
            dt = idx.to_pydatetime() if hasattr(idx, "to_pydatetime") else idx
            if hasattr(dt, "date"):
                dt = dt.date()
            # 重複チェック
            key = (ticker, str(dt))
            if key in seen:
                continue
            seen.add(key)
            rows.append((str(uuid.uuid4()), ticker, dt))
        return rows
    except Exception as e:
        print(f"  {ticker}: error - {e}", flush=True)
        return []


def insert_earnings(conn, all_rows: list[tuple]) -> int:
    """バルクINSERT（ON CONFLICT DO NOTHING）"""
    if not all_rows:
        return 0

    inserted = 0
    with conn.cursor() as cur:
        for i in range(0, len(all_rows), INSERT_PAGE_SIZE):
            batch = all_rows[i : i + INSERT_PAGE_SIZE]
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO "EarningsDate" (id, "tickerCode", date)
                VALUES %s
                ON CONFLICT ("tickerCode", date) DO NOTHING
                """,
                batch,
                page_size=INSERT_PAGE_SIZE,
            )
            inserted += cur.rowcount
    conn.commit()
    return inserted


def main():
    print("=" * 60, flush=True)
    print("EarningsDate バックフィル", flush=True)
    print("=" * 60, flush=True)

    conn = psycopg2.connect(DATABASE_URL, connect_timeout=30)

    tickers = get_active_tickers(conn)
    print(f"対象銘柄: {len(tickers)}件", flush=True)

    # 既存データ確認
    with conn.cursor() as cur:
        cur.execute('SELECT COUNT(*) FROM "EarningsDate"')
        existing = cur.fetchone()[0]
    print(f"既存データ: {existing:,}件", flush=True)
    conn.close()

    total_rows = 0
    failed_tickers: list[str] = []
    all_rows: list[tuple] = []

    # 並列取得
    batch_size = 50
    total_batches = (len(tickers) + batch_size - 1) // batch_size

    for batch_idx in range(total_batches):
        start = batch_idx * batch_size
        end = min(start + batch_size, len(tickers))
        batch_tickers = tickers[start:end]

        print(
            f"\n[{batch_idx + 1}/{total_batches}] {batch_tickers[0]}〜{batch_tickers[-1]} ({len(batch_tickers)}銘柄)",
            flush=True,
        )

        batch_rows: list[tuple] = []
        with ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
            futures = {executor.submit(fetch_earnings_dates, t): t for t in batch_tickers}
            for future in as_completed(futures):
                t = futures[future]
                try:
                    rows = future.result()
                    if rows:
                        batch_rows.extend(rows)
                    else:
                        failed_tickers.append(t)
                except Exception as e:
                    print(f"  {t}: exception - {e}", flush=True)
                    failed_tickers.append(t)

        all_rows.extend(batch_rows)
        total_rows += len(batch_rows)

        print(f"  取得: {len(batch_rows)}件", flush=True)
        time.sleep(1)  # レート制限回避

    # DB挿入
    print(f"\nDB挿入中... ({total_rows}件)", flush=True)
    for retry in range(3):
        try:
            insert_conn = psycopg2.connect(DATABASE_URL, connect_timeout=30)
            inserted = insert_earnings(insert_conn, all_rows)
            insert_conn.close()
            break
        except Exception as e:
            print(f"  DB error (retry {retry + 1}/3): {e}", flush=True)
            if retry < 2:
                time.sleep(5)
            else:
                print("  SKIP: DB挿入に失敗", flush=True)
                inserted = 0

    # 最終確認
    final_conn = psycopg2.connect(DATABASE_URL, connect_timeout=30)
    with final_conn.cursor() as cur:
        cur.execute('SELECT COUNT(*) FROM "EarningsDate"')
        final_count = cur.fetchone()[0]
        cur.execute('SELECT COUNT(DISTINCT "tickerCode") FROM "EarningsDate"')
        ticker_count = cur.fetchone()[0]
    final_conn.close()

    print("\n" + "=" * 60, flush=True)
    print("完了", flush=True)
    print("=" * 60, flush=True)
    print(f"取得件数: {total_rows:,}", flush=True)
    print(f"新規INSERT: {inserted:,}", flush=True)
    print(f"失敗銘柄: {len(failed_tickers)}", flush=True)
    print(f"DB: {final_count:,}件 ({ticker_count}銘柄)", flush=True)


if __name__ == "__main__":
    main()
