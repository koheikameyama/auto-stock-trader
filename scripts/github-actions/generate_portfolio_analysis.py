#!/usr/bin/env python3
"""
ポートフォリオ分析を生成するスクリプト

保有銘柄（PortfolioStock）に対して、毎日AI分析を行い売買判断を生成します。
APIエンドポイントを呼び出すことで、手動実行と同じロジックを使用します。
"""

import os
import sys
from datetime import datetime

import psycopg2
import requests

# scriptsディレクトリをPythonパスに追加
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.user_activity import get_active_user_filter_sql


def get_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("Error: DATABASE_URL environment variable not set")
        sys.exit(1)
    return url


def get_app_url() -> str:
    url = os.environ.get("APP_URL")
    if not url:
        print("Error: APP_URL environment variable not set")
        sys.exit(1)
    return url


def get_cron_secret() -> str:
    secret = os.environ.get("CRON_SECRET")
    if not secret:
        print("Error: CRON_SECRET environment variable not set")
        sys.exit(1)
    return secret


def fetch_portfolio_stocks(conn) -> list[dict]:
    """保有中（quantity > 0）のポートフォリオ銘柄とユーザーIDを取得（アクティブユーザーのみ、チャートデータがある銘柄のみ）"""
    active_filter = get_active_user_filter_sql()
    with conn.cursor() as cur:
        cur.execute(f'''
            SELECT
                ps."stockId",
                ps."userId",
                s.name,
                s."tickerCode"
            FROM "PortfolioStock" ps
            JOIN "Stock" s ON ps."stockId" = s.id
            JOIN "User" u ON ps."userId" = u.id
            WHERE s."hasChartData" = true
              AND {active_filter}
              AND COALESCE(
                (SELECT SUM(
                    CASE WHEN t.type = 'buy' THEN t.quantity
                         WHEN t.type = 'sell' THEN -t.quantity
                         ELSE 0
                    END
                )
                FROM "Transaction" t
                WHERE t."portfolioStockId" = ps.id
                ), 0
            ) > 0
        ''')
        rows = cur.fetchall()
    return [{"stockId": row[0], "userId": row[1], "name": row[2], "tickerCode": row[3]} for row in rows]


def generate_analysis_for_stock(app_url: str, cron_secret: str, stock_id: str, user_id: str) -> dict | None:
    """APIを呼び出してポートフォリオ分析を生成"""
    try:
        response = requests.post(
            f"{app_url}/api/stocks/{stock_id}/portfolio-analysis",
            headers={
                "Authorization": f"Bearer {cron_secret}",
                "Content-Type": "application/json",
            },
            json={"userId": user_id},
            timeout=120
        )

        if response.status_code == 200:
            return response.json()
        else:
            print(f"  Error: {response.status_code} - {response.text[:200]}")
            return None
    except requests.exceptions.Timeout:
        print("  Error: Request timed out")
        return None
    except Exception as e:
        print(f"  Error: {e}")
        return None


def main():
    print("=== Starting Portfolio Analysis Generation ===")
    print(f"Time: {datetime.now().isoformat()}")

    app_url = get_app_url()
    cron_secret = get_cron_secret()
    conn = psycopg2.connect(get_database_url())

    try:
        portfolio_stocks = fetch_portfolio_stocks(conn)
        print(f"Found {len(portfolio_stocks)} stocks in portfolio")

        if not portfolio_stocks:
            print("No stocks in portfolio. Exiting.")
            return

        success_count, error_count = 0, 0

        for ps in portfolio_stocks:
            print(f"\n--- Processing: {ps['name']} ({ps['tickerCode']}) ---")

            result = generate_analysis_for_stock(app_url, cron_secret, ps["stockId"], ps["userId"])

            if not result:
                print("  Failed to generate analysis")
                error_count += 1
                continue

            print(f"  Generated: {result.get('recommendation', 'N/A')}")
            print(f"  Short-term: {result.get('shortTerm', 'N/A')[:60]}...")
            success_count += 1

        print(f"\n=== Summary ===")
        print(f"Success: {success_count}, Errors: {error_count}")

        # 全員失敗した場合はエラー終了
        if success_count == 0 and error_count > 0:
            sys.exit(1)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
