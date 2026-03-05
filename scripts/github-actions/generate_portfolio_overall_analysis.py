#!/usr/bin/env python3
"""
ポートフォリオ総評を生成するスクリプト

全ユーザーに対して、市場分析・ポートフォリオ総評（セクター分散度、ボラティリティなど）を生成します。
ポートフォリオがないユーザーにはセクター戦略ベースの市場分析を提供します。
APIエンドポイントを呼び出してバッチ処理を実行します。

実行タイミング: 15:30 JST（大引け後のみ）
※ ワークフローのジョブレベルで実行条件を制御
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


def fetch_eligible_users(conn) -> list[dict]:
    """対象ユーザーを取得（アクティブユーザーのみ）"""
    active_filter = get_active_user_filter_sql()
    with conn.cursor() as cur:
        cur.execute(f'''
            SELECT
                u.id,
                (SELECT COUNT(*) FROM "PortfolioStock" ps
                 WHERE ps."userId" = u.id
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
                ) as portfolio_count,
                (SELECT COUNT(*) FROM "WatchlistStock" ws WHERE ws."userId" = u.id) as watchlist_count
            FROM "User" u
            WHERE {active_filter}
        ''')
        rows = cur.fetchall()
        return [
            {
                "userId": row[0],
                "portfolioCount": row[1],
                "watchlistCount": row[2],
            }
            for row in rows
        ]


def generate_analysis_for_user(app_url: str, cron_secret: str, user_id: str, session: str) -> dict | None:
    """APIを呼び出してポートフォリオ総評を生成"""
    try:
        response = requests.post(
            f"{app_url}/api/portfolio/overall-analysis",
            headers={
                "Authorization": f"Bearer {cron_secret}",
                "Content-Type": "application/json",
            },
            json={"userId": user_id, "session": session},
            timeout=120
        )

        if response.status_code == 200:
            return response.json()
        else:
            print(f"  Error: {response.status_code} - {response.text[:500]}")
            return None
    except requests.exceptions.Timeout:
        print("  Error: Request timed out")
        return None
    except Exception as e:
        print(f"  Error: {e}")
        return None


def main():
    session = os.environ.get("SESSION", "morning")

    print("=" * 60)
    print(f"ポートフォリオ総評の生成を開始（セッション: {session}）")
    print("=" * 60)

    app_url = get_app_url()
    cron_secret = get_cron_secret()
    conn = psycopg2.connect(get_database_url())

    try:
        # 対象ユーザーを取得
        users = fetch_eligible_users(conn)
        print(f"\n対象ユーザー数: {len(users)}")

        if not users:
            print("対象ユーザーがいません")
            return

        success_count = 0
        error_count = 0

        for user in users:
            user_id = user["userId"]
            print(f"\n処理中: {user_id[:8]}... (P:{user['portfolioCount']}, W:{user['watchlistCount']})")

            result = generate_analysis_for_user(app_url, cron_secret, user_id, session)

            if not result:
                print("  -> 分析生成に失敗")
                error_count += 1
                continue

            portfolio = result.get('portfolio', {})
            print(f"  -> 完了: {portfolio.get('status', 'N/A')}")
            success_count += 1

        print("\n" + "=" * 60)
        print(f"完了: 成功={success_count}, エラー={error_count}")
        print("=" * 60)

        # 全員失敗した場合はエラー終了
        if success_count == 0 and error_count > 0:
            sys.exit(1)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
