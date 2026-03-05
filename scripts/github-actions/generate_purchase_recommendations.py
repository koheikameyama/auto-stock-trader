#!/usr/bin/env python3
"""
購入判断分析を生成するスクリプト

ウォッチリスト（気になる銘柄）に対して、毎日AI分析を行い購入判断を生成します。
APIエンドポイントを呼び出すことで、手動実行と同じロジックを使用します。

ユーザーの投資スタイル（安定配当型/成長投資型/アクティブ型）別の分析結果を参照し、
該当スタイルで買い推奨（recommendation='buy' かつ confidence>=閾値）の場合のみ通知を送信します。
"""

import os
import sys
from datetime import datetime

import psycopg2
import requests

# scriptsディレクトリをPythonパスに追加
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.constants import BUY_RECOMMENDATION_CONFIDENCE_THRESHOLD
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


def fetch_watchlist_stocks(conn) -> list[dict]:
    """ウォッチリストの銘柄IDを取得（アクティブユーザーのウォッチリストのみ、重複排除、チャートデータがある銘柄のみ）"""
    active_filter = get_active_user_filter_sql()
    with conn.cursor() as cur:
        cur.execute(f'''
            SELECT DISTINCT ws."stockId", s.name, s."tickerCode"
            FROM "WatchlistStock" ws
            JOIN "Stock" s ON ws."stockId" = s.id
            JOIN "User" u ON ws."userId" = u.id
            WHERE s."hasChartData" = true
              AND s."isDelisted" = false
              AND {active_filter}
        ''')
        rows = cur.fetchall()
    return [{"stockId": row[0], "name": row[1], "tickerCode": row[2]} for row in rows]


def fetch_watchlist_users_for_stock(conn, stock_id: str) -> list[dict]:
    """指定銘柄をウォッチしているアクティブユーザーIDとウォッチリストIDを取得"""
    active_filter = get_active_user_filter_sql()
    with conn.cursor() as cur:
        cur.execute(f'''
            SELECT ws."userId", ws.id
            FROM "WatchlistStock" ws
            JOIN "User" u ON ws."userId" = u.id
            WHERE ws."stockId" = %s
              AND {active_filter}
        ''', (stock_id,))
        rows = cur.fetchall()
    return [{"userId": row[0], "watchlistId": row[1]} for row in rows]


def fetch_user_investment_styles(conn, user_ids: list[str]) -> dict[str, str]:
    """ユーザーの投資スタイルを一括取得"""
    if not user_ids:
        return {}
    with conn.cursor() as cur:
        cur.execute('''
            SELECT "userId", "investmentStyle"
            FROM "UserSettings"
            WHERE "userId" = ANY(%s)
        ''', (user_ids,))
        rows = cur.fetchall()
    return {row[0]: row[1] for row in rows}


def send_buy_recommendation_notifications(
    app_url: str,
    cron_secret: str,
    notifications: list[dict]
) -> dict:
    """買い推奨通知を送信"""
    if not notifications:
        return {"created": 0, "pushSent": 0, "skipped": 0, "errors": []}

    api_url = f"{app_url}/api/notifications/send"
    headers = {
        "Authorization": f"Bearer {cron_secret}",
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(
            api_url,
            json={"notifications": notifications},
            headers=headers,
            timeout=60
        )

        if not response.ok:
            print(f"  Notification API error: {response.status_code} - {response.text[:200]}")
            return {"created": 0, "pushSent": 0, "skipped": 0, "errors": [response.text]}

        return response.json()
    except Exception as e:
        print(f"  Failed to send notifications: {e}")
        return {"created": 0, "pushSent": 0, "skipped": 0, "errors": [str(e)]}


def generate_recommendation_for_stock(app_url: str, cron_secret: str, stock_id: str) -> dict | None:
    """APIを呼び出して購入判断を生成"""
    try:
        response = requests.post(
            f"{app_url}/api/stocks/{stock_id}/purchase-recommendation",
            headers={"Authorization": f"Bearer {cron_secret}"},
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
    print("=== Starting Purchase Recommendation Generation ===")
    print(f"Time: {datetime.now().isoformat()}")

    session = os.environ.get("SESSION", "")
    informational_sessions = {"pre-morning", "close"}
    suppress_notifications = session in informational_sessions
    if session:
        print(f"Session: {session} (notifications: {'suppressed' if suppress_notifications else 'enabled'})")

    app_url = get_app_url()
    cron_secret = get_cron_secret()
    conn = psycopg2.connect(get_database_url())

    try:
        watchlist_stocks = fetch_watchlist_stocks(conn)
        print(f"Found {len(watchlist_stocks)} stocks in watchlist")

        if not watchlist_stocks:
            print("No stocks in watchlist. Exiting.")
            return

        # ウォッチリスト全ユーザーの投資スタイルを事前一括取得
        all_user_ids = set()
        for ws in watchlist_stocks:
            users = fetch_watchlist_users_for_stock(conn, ws["stockId"])
            all_user_ids.update(u["userId"] for u in users)
        user_styles = fetch_user_investment_styles(conn, list(all_user_ids))
        print(f"Fetched investment styles for {len(user_styles)} users")

        success_count, error_count = 0, 0
        buy_notifications = []

        for ws in watchlist_stocks:
            print(f"\n--- Processing: {ws['name']} ({ws['tickerCode']}) ---")

            result = generate_recommendation_for_stock(app_url, cron_secret, ws["stockId"])

            if not result:
                print("  Failed to generate recommendation")
                error_count += 1
                continue

            recommendation = result.get("recommendation", "")
            confidence = result.get("confidence", 0)
            reason = result.get("reason", "")
            style_analyses = result.get("styleAnalyses")

            print(f"  Generated: {recommendation} (confidence: {confidence})")
            success_count += 1

            # ユーザーごとにスタイル別の買い推奨を判定して通知
            watchlist_users = fetch_watchlist_users_for_stock(conn, ws["stockId"])

            for wu in watchlist_users:
                user_style = user_styles.get(wu["userId"], "BALANCED")

                # スタイル別分析がある場合はそちらを使用
                if style_analyses and user_style in style_analyses:
                    style_data = style_analyses[user_style]
                    style_rec = style_data.get("recommendation", "")
                    style_confidence = style_data.get("confidence", 0)
                    style_reason = style_data.get("reason", reason)
                else:
                    # フォールバック: ベースの推奨を使用
                    style_rec = recommendation
                    style_confidence = confidence
                    style_reason = reason

                # 押し目（dip）は条件付き推奨なので通知しない
                style_buy_timing = style_data.get("buyTiming", None) if style_analyses and user_style in style_analyses else None

                if (
                    style_rec == "buy"
                    and style_confidence >= BUY_RECOMMENDATION_CONFIDENCE_THRESHOLD
                    and style_buy_timing != "dip"
                ):
                    confidence_pct = int(style_confidence * 100)
                    reason_short = style_reason[:50] + "..." if len(style_reason) > 50 else style_reason
                    buy_notifications.append({
                        "userId": wu["userId"],
                        "type": "buy_recommendation",
                        "stockId": ws["stockId"],
                        "title": f"📊 {ws['name']}が買い推奨です",
                        "body": f"AIが買い推奨と判断しました（確信度{confidence_pct}%）。{reason_short}",
                        "url": f"/my-stocks/{wu['watchlistId']}",
                    })

            notified_count = sum(1 for n in buy_notifications if n["stockId"] == ws["stockId"])
            if notified_count > 0:
                print(f"  Buy recommendation for {notified_count}/{len(watchlist_users)} users (style-filtered)")

        # 買い推奨通知を送信
        if buy_notifications and not suppress_notifications:
            print(f"\n=== Sending {len(buy_notifications)} buy recommendation notifications ===")
            notify_result = send_buy_recommendation_notifications(
                app_url, cron_secret, buy_notifications
            )
            print(f"  Created: {notify_result.get('created', 0)}")
            print(f"  Push sent: {notify_result.get('pushSent', 0)}")
            print(f"  Skipped (duplicate): {notify_result.get('skipped', 0)}")
            if notify_result.get("errors"):
                print(f"  Errors: {notify_result['errors']}")
        elif buy_notifications and suppress_notifications:
            print(f"\n=== Skipping {len(buy_notifications)} buy notifications (session={session}, informational mode) ===")

        print(f"\n=== Summary ===")
        print(f"Success: {success_count}, Errors: {error_count}")
        print(f"Buy notifications queued: {len(buy_notifications)}")

        # 全員失敗した場合はエラー終了
        if success_count == 0 and error_count > 0:
            sys.exit(1)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
