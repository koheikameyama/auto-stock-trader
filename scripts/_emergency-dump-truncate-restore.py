"""
緊急: dump → TRUNCATE → restore を1つのworkflow runで実行
本番DB を 2024-02-05 以降のみに復旧する。
"""

import os
import psycopg2

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    print("ERROR: DATABASE_URL not set")
    exit(1)

DUMP_FILE = "/tmp/stockdailybar.dump"
CUTOFF_DATE = "2024-02-05"


def main():
    conn = psycopg2.connect(DATABASE_URL, connect_timeout=60)
    conn.autocommit = True

    # ===== Step 1: Dump =====
    print("=" * 60, flush=True)
    print(f"Step 1: Dump (date >= {CUTOFF_DATE})", flush=True)
    print("=" * 60, flush=True)

    with conn.cursor() as cur:
        cur.execute(f"""
            SELECT COUNT(*) FROM "StockDailyBar" WHERE date >= '{CUTOFF_DATE}'
        """)
        expected = cur.fetchone()[0]
        print(f"Dump対象: {expected:,} 行", flush=True)

    with open(DUMP_FILE, "wb") as f:
        with conn.cursor() as cur:
            cur.copy_expert(
                f"""
                COPY (
                  SELECT id, "tickerCode", date, open, high, low, close, volume, market
                  FROM "StockDailyBar"
                  WHERE date >= '{CUTOFF_DATE}'
                ) TO STDOUT WITH (FORMAT BINARY)
                """,
                f,
            )

    file_size = os.path.getsize(DUMP_FILE)
    print(f"Dump完了: {file_size:,} bytes ({file_size / 1024 / 1024:.1f} MB)", flush=True)

    # 安全装置: dump が異常に小さい場合は中止
    if file_size < 10_000_000:  # 10MB未満ならおかしい
        print("ERROR: Dump サイズが異常に小さい。TRUNCATE を中止します", flush=True)
        return

    # ===== Step 2: TRUNCATE =====
    print("\n" + "=" * 60, flush=True)
    print("Step 2: TRUNCATE", flush=True)
    print("=" * 60, flush=True)

    with conn.cursor() as cur:
        cur.execute('SELECT COUNT(*) FROM "StockDailyBar"')
        before = cur.fetchone()[0]
        print(f"TRUNCATE 前: {before:,} 行", flush=True)

    with conn.cursor() as cur:
        cur.execute('TRUNCATE TABLE "StockDailyBar"')

    with conn.cursor() as cur:
        cur.execute('SELECT COUNT(*) FROM "StockDailyBar"')
        after_trunc = cur.fetchone()[0]
        print(f"TRUNCATE 後: {after_trunc:,} 行", flush=True)

    # ===== Step 3: Restore =====
    print("\n" + "=" * 60, flush=True)
    print("Step 3: Restore from dump", flush=True)
    print("=" * 60, flush=True)

    with open(DUMP_FILE, "rb") as f:
        with conn.cursor() as cur:
            cur.copy_expert(
                'COPY "StockDailyBar" (id, "tickerCode", date, open, high, low, close, volume, market) FROM STDIN WITH (FORMAT BINARY)',
                f,
            )

    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*), MIN(date), MAX(date),
              pg_size_pretty(pg_total_relation_size('"StockDailyBar"'))
            FROM "StockDailyBar"
        """)
        count, min_date, max_date, size = cur.fetchone()
        print(f"Restore 後: {count:,} 行, {min_date} 〜 {max_date}, テーブルサイズ {size}", flush=True)

    if count != expected:
        print(f"⚠️ 行数不一致: expected={expected:,}, actual={count:,}", flush=True)
    else:
        print("✓ 行数一致", flush=True)

    # ===== Step 4: VACUUM ANALYZE =====
    print("\n" + "=" * 60, flush=True)
    print("Step 4: VACUUM ANALYZE", flush=True)
    print("=" * 60, flush=True)
    with conn.cursor() as cur:
        cur.execute('VACUUM ANALYZE "StockDailyBar"')
        print("VACUUM ANALYZE 完了", flush=True)

    # 最終 DB サイズ
    with conn.cursor() as cur:
        cur.execute("SELECT pg_size_pretty(pg_database_size(current_database()))")
        db_size = cur.fetchone()[0]
        print(f"\nDB 全体サイズ: {db_size}", flush=True)

    conn.close()


if __name__ == "__main__":
    main()
