#!/usr/bin/env python3
"""古いデータを定期削除するスクリプト（30日保持）"""

import os
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import psycopg2

# scriptsディレクトリをPythonパスに追加
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.constants import RETENTION_DAYS


def get_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("Error: DATABASE_URL environment variable not set")
        sys.exit(1)
    return url


def get_days_ago_jst(days: int) -> datetime:
    """N日前の日付（JST 00:00:00をUTCに変換）"""
    jst = ZoneInfo("Asia/Tokyo")
    today_jst = datetime.now(jst).replace(hour=0, minute=0, second=0, microsecond=0)
    target_jst = today_jst - timedelta(days=days)
    return target_jst.astimezone(timezone.utc)


def cleanup_old_data():
    conn = psycopg2.connect(get_database_url())
    try:
        # JST基準でN日前を計算
        cutoff_date = get_days_ago_jst(RETENTION_DAYS)
        print(f"Cleanup started at {datetime.now().isoformat()}")
        print(f"Retention: {RETENTION_DAYS} days")
        print(f"Cutoff date: {cutoff_date.date()}")
        print("-" * 50)

        total_deleted = 0

        with conn.cursor() as cur:
            # 1. StockAnalysis（ポートフォリオ分析）
            cur.execute('SELECT COUNT(*) FROM "StockAnalysis" WHERE "analyzedAt" < %s', (cutoff_date,))
            count = cur.fetchone()[0]
            print(f"\n[1/6] StockAnalysis: {count} records to delete")
            if count > 0:
                cur.execute('DELETE FROM "StockAnalysis" WHERE "analyzedAt" < %s', (cutoff_date,))
                print(f"  Deleted: {cur.rowcount}")
                total_deleted += cur.rowcount

            # 2. PurchaseRecommendation（ウォッチリスト購入推奨）
            cur.execute('SELECT COUNT(*) FROM "PurchaseRecommendation" WHERE date < %s', (cutoff_date.date(),))
            count = cur.fetchone()[0]
            print(f"\n[2/6] PurchaseRecommendation: {count} records to delete")
            if count > 0:
                cur.execute('DELETE FROM "PurchaseRecommendation" WHERE date < %s', (cutoff_date.date(),))
                print(f"  Deleted: {cur.rowcount}")
                total_deleted += cur.rowcount

            # 3. UserDailyRecommendation（あなたへのおすすめ）
            cur.execute('SELECT COUNT(*) FROM "UserDailyRecommendation" WHERE date < %s', (cutoff_date.date(),))
            count = cur.fetchone()[0]
            print(f"\n[3/6] UserDailyRecommendation: {count} records to delete")
            if count > 0:
                cur.execute('DELETE FROM "UserDailyRecommendation" WHERE date < %s', (cutoff_date.date(),))
                print(f"  Deleted: {cur.rowcount}")
                total_deleted += cur.rowcount

            # 4. MarketNews（マーケットニュース）
            # RSS取得分（tickerCode IS NULL）: RETENTION_DAYS 保持
            cur.execute('SELECT COUNT(*) FROM "MarketNews" WHERE "tickerCode" IS NULL AND "publishedAt" < %s', (cutoff_date,))
            count = cur.fetchone()[0]
            print(f"\n[4a/7] MarketNews (RSS, tickerCode=null): {count} records to delete")
            if count > 0:
                cur.execute('DELETE FROM "MarketNews" WHERE "tickerCode" IS NULL AND "publishedAt" < %s', (cutoff_date,))
                print(f"  Deleted: {cur.rowcount}")
                total_deleted += cur.rowcount

            # yfinance取得分（tickerCode IS NOT NULL）: 14日保持
            stock_news_cutoff = get_days_ago_jst(14)
            cur.execute('SELECT COUNT(*) FROM "MarketNews" WHERE "tickerCode" IS NOT NULL AND "publishedAt" < %s', (stock_news_cutoff,))
            count = cur.fetchone()[0]
            print(f"\n[4b/7] MarketNews (yfinance, tickerCode!=null): {count} records to delete")
            if count > 0:
                cur.execute('DELETE FROM "MarketNews" WHERE "tickerCode" IS NOT NULL AND "publishedAt" < %s', (stock_news_cutoff,))
                print(f"  Deleted: {cur.rowcount}")
                total_deleted += cur.rowcount

            # 5. SectorTrend（セクタートレンド）
            cur.execute('SELECT COUNT(*) FROM "SectorTrend" WHERE date < %s', (cutoff_date.date(),))
            count = cur.fetchone()[0]
            print(f"\n[5/7] SectorTrend: {count} records to delete")
            if count > 0:
                cur.execute('DELETE FROM "SectorTrend" WHERE date < %s', (cutoff_date.date(),))
                print(f"  Deleted: {cur.rowcount}")
                total_deleted += cur.rowcount

            # 7. データ取得不可銘柄（1ヶ月以上 isDelisted=true）
            # 全リレーションが onDelete: Cascade なので関連データも自動削除される
            cur.execute('''
                SELECT COUNT(*) FROM "Stock"
                WHERE "isDelisted" = true
                  AND "lastFetchFailedAt" < %s
            ''', (cutoff_date,))
            count = cur.fetchone()[0]
            print(f"\n[7/7] Data unavailable stocks ({RETENTION_DAYS}+ days): {count} records to delete")
            if count > 0:
                cur.execute('''
                    DELETE FROM "Stock"
                    WHERE "isDelisted" = true
                      AND "lastFetchFailedAt" < %s
                ''', (cutoff_date,))
                print(f"  Deleted: {cur.rowcount}")
                total_deleted += cur.rowcount

        conn.commit()
        print("\n" + "=" * 50)
        print(f"Cleanup completed! Total deleted: {total_deleted} records")

        # VACUUMで空き領域を回収（削除後のディスク領域を再利用可能に）
        if total_deleted > 0:
            print("\nRunning VACUUM to reclaim disk space...")
            conn.autocommit = True  # VACUUMはトランザクション外で実行
            with conn.cursor() as cur:
                cur.execute('VACUUM ANALYZE "StockAnalysis"')
                cur.execute('VACUUM ANALYZE "PurchaseRecommendation"')
                cur.execute('VACUUM ANALYZE "UserDailyRecommendation"')
                cur.execute('VACUUM ANALYZE "MarketNews"')
                cur.execute('VACUUM ANALYZE "SectorTrend"')
                cur.execute('VACUUM ANALYZE "Stock"')
            print("VACUUM completed!")

    except Exception as e:
        print(f"Error during cleanup: {e}")
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    cleanup_old_data()
