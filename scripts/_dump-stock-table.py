"""
本番 Stock テーブルを binary format で dump
ローカル DB への銘柄マスタ移植用、artifact として保存される
"""

import os
import psycopg2

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    print("ERROR: DATABASE_URL not set")
    exit(1)

DUMP_FILE = "/tmp/stock-table.dump"


def main():
    conn = psycopg2.connect(DATABASE_URL, connect_timeout=60)

    with conn.cursor() as cur:
        cur.execute('SELECT COUNT(*) FROM "Stock"')
        total = cur.fetchone()[0]
        cur.execute('SELECT COUNT(*) FROM "Stock" WHERE "isActive" = true AND "isDelisted" = false AND "isRestricted" = false AND market = \'JP\'')
        active = cur.fetchone()[0]
        print(f"Stock 総行数: {total:,}", flush=True)
        print(f"JP active: {active:,}", flush=True)

    with open(DUMP_FILE, "wb") as f:
        with conn.cursor() as cur:
            cur.copy_expert(
                'COPY "Stock" TO STDOUT WITH (FORMAT BINARY)',
                f,
            )

    size = os.path.getsize(DUMP_FILE)
    print(f"Dump: {size:,} bytes ({size / 1024 / 1024:.1f} MB)", flush=True)

    conn.close()


if __name__ == "__main__":
    main()
