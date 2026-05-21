"""
緊急: StockDailyBar の 2024-02-05 以降を dump

ディスク不足で DELETE が動かないため、保持したいデータを先に dump して
GitHub Actions artifact として保存する。後段の workflow で TRUNCATE + restore する。
"""

import os
import psycopg2

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    print("ERROR: DATABASE_URL not set")
    exit(1)

DUMP_FILE = "/tmp/stockdailybar.dump"


def main():
    conn = psycopg2.connect(DATABASE_URL, connect_timeout=60)

    # 事前確認: 行数とサイズ
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
              (SELECT COUNT(*) FROM "StockDailyBar") as total,
              (SELECT COUNT(*) FROM "StockDailyBar" WHERE date >= '2024-02-05') as to_keep,
              (SELECT COUNT(*) FROM "StockDailyBar" WHERE date < '2024-02-05') as to_drop,
              pg_size_pretty(pg_total_relation_size('"StockDailyBar"')) as size
        """)
        total, to_keep, to_drop, size = cur.fetchone()
        print(f"テーブルサイズ: {size}", flush=True)
        print(f"総行数: {total:,}", flush=True)
        print(f"残す (date >= 2024-02-05): {to_keep:,}", flush=True)
        print(f"消す (date < 2024-02-05): {to_drop:,}", flush=True)

    # Step: 残すデータを binary format で dump (ORDER BY なしで sort tmp 不要)
    print(f"\nDumping to {DUMP_FILE}...", flush=True)
    with open(DUMP_FILE, "wb") as f:
        with conn.cursor() as cur:
            cur.copy_expert(
                """
                COPY (
                  SELECT id, "tickerCode", date, open, high, low, close, volume, market
                  FROM "StockDailyBar"
                  WHERE date >= '2024-02-05'
                ) TO STDOUT WITH (FORMAT BINARY)
                """,
                f,
            )

    file_size = os.path.getsize(DUMP_FILE)
    print(f"\nDump 完了: {file_size:,} bytes ({file_size / 1024 / 1024:.1f} MB)", flush=True)

    conn.close()


if __name__ == "__main__":
    main()
