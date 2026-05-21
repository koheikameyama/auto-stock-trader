"""
緊急: バックフィルで入れた古いデータを削除 → VACUUM FULL でディスク返却

本番DBが容量不足で書き込み不能のため、2024-02-05 より前のデータを削除する。
バッチDELETE (10万行ずつ) → VACUUM FULL で OS にディスク返却。
"""

import os
import psycopg2

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    print("ERROR: DATABASE_URL not set")
    exit(1)

BATCH_SIZE = 100000


def main():
    conn = psycopg2.connect(DATABASE_URL, connect_timeout=30)
    conn.autocommit = True  # VACUUM はトランザクション外で実行

    with conn.cursor() as cur:
        # 削除前
        cur.execute("""
            SELECT
              pg_size_pretty(pg_total_relation_size('"StockDailyBar"')) as size,
              (SELECT COUNT(*) FROM "StockDailyBar")::bigint as rows,
              (SELECT COUNT(*) FROM "StockDailyBar" WHERE market = 'JP' AND date < '2024-02-05')::bigint as to_delete
        """)
        size_before, rows_before, to_delete = cur.fetchone()
        print(f"削除前: テーブルサイズ {size_before}, 総行数 {rows_before:,}, 削除対象 {to_delete:,}", flush=True)

        # 削除（バッチで進める）
        deleted_total = 0
        while True:
            try:
                cur.execute(f"""
                    DELETE FROM "StockDailyBar"
                    WHERE id IN (
                        SELECT id FROM "StockDailyBar"
                        WHERE market = 'JP' AND date < '2024-02-05'
                        LIMIT {BATCH_SIZE}
                    )
                """)
                deleted = cur.rowcount
                deleted_total += deleted
                print(f"  Deleted batch: {deleted:,} (total {deleted_total:,})", flush=True)
                if deleted == 0:
                    break
            except Exception as e:
                print(f"  ERROR: {e}", flush=True)
                # 容量不足で DELETE 自体が失敗する可能性 → break して VACUUM 試す
                break

        print(f"\n削除合計: {deleted_total:,} 行", flush=True)

        # VACUUM FULL でディスク返却（ACCESS EXCLUSIVE LOCK 発生、数分かかる可能性）
        print("\nVACUUM FULL 実行中 (本番DBへの書き込みブロック中)...", flush=True)
        try:
            cur.execute('VACUUM FULL "StockDailyBar"')
            print("VACUUM FULL 完了", flush=True)
        except Exception as e:
            print(f"VACUUM FULL エラー: {e}", flush=True)
            print("通常 VACUUM を試行...", flush=True)
            cur.execute('VACUUM "StockDailyBar"')
            print("VACUUM 完了 (ただしディスクは OS に返却されない可能性)", flush=True)

        # 削除後
        cur.execute("""
            SELECT
              pg_size_pretty(pg_total_relation_size('"StockDailyBar"')) as size,
              (SELECT COUNT(*) FROM "StockDailyBar")::bigint as rows,
              (SELECT MIN(date) FROM "StockDailyBar" WHERE market = 'JP') as min_date,
              (SELECT MAX(date) FROM "StockDailyBar" WHERE market = 'JP') as max_date
        """)
        size_after, rows_after, min_date, max_date = cur.fetchone()
        print(f"\n削除後: テーブルサイズ {size_after}, 総行数 {rows_after:,}", flush=True)
        print(f"残り期間: {min_date} 〜 {max_date}", flush=True)

        # DB 全体サイズ
        cur.execute("SELECT pg_size_pretty(pg_database_size(current_database()))")
        db_size = cur.fetchone()[0]
        print(f"\nDB 全体サイズ: {db_size}", flush=True)

    conn.close()


if __name__ == "__main__":
    main()
