#!/usr/bin/env python3
"""
ユーザーごとのAIおすすめ銘柄生成スクリプト

TypeScript API を呼び出すだけのシンプルなスクリプト。
実際のロジックは /api/recommendations/generate-daily に移行済み。
"""

import os
import re
import sys
import time
import requests
from datetime import datetime

# リトライ設定
MAX_RETRIES = 4
RETRY_WAIT_SECONDS = [10, 30, 60, 120]


def _extract_error_summary(status_code: int, body: str) -> str:
    """エラーレスポンスから要約を抽出する。HTMLの場合はタイトルだけ取る。"""
    if "<html" in body.lower():
        match = re.search(r"<title>(.*?)</title>", body, re.IGNORECASE | re.DOTALL)
        if match:
            return f"HTTP {status_code}: {match.group(1).strip()}"
        return f"HTTP {status_code}: (HTML error page)"
    # JSON等の短いレスポンス
    return f"HTTP {status_code}: {body[:200]}"


def call_api(app_url: str, cron_secret: str, session: str) -> dict:
    """APIを呼び出し、レスポンスを返す。失敗時はリトライする。"""
    last_error = None

    for attempt in range(MAX_RETRIES):
        try:
            if attempt > 0:
                wait = RETRY_WAIT_SECONDS[attempt - 1]
                print(f"\nRetry {attempt}/{MAX_RETRIES - 1} after {wait}s...")
                time.sleep(wait)

            response = requests.post(
                f"{app_url}/api/recommendations/generate-daily",
                headers={
                    "Authorization": f"Bearer {cron_secret}",
                    "Content-Type": "application/json",
                },
                json={"session": session},
                timeout=300,  # 5分タイムアウト
            )

            if response.status_code not in [200, 201]:
                last_error = _extract_error_summary(response.status_code, response.text)
                print(f"Error (attempt {attempt + 1}/{MAX_RETRIES}): {last_error}")
                # 4xx エラーはリトライしない（認証エラーなど）
                if 400 <= response.status_code < 500:
                    print("Client error - not retrying")
                    sys.exit(1)
                continue

            return response.json()

        except requests.exceptions.Timeout:
            last_error = "Request timed out (300s)"
            print(f"Error (attempt {attempt + 1}/{MAX_RETRIES}): {last_error}")
        except requests.exceptions.RequestException as e:
            last_error = str(e)
            print(f"Error (attempt {attempt + 1}/{MAX_RETRIES}): {last_error}")

    print(f"\nAll {MAX_RETRIES} attempts failed. Last error: {last_error}")
    sys.exit(1)


def main():
    session = os.environ.get("SESSION", "evening")
    app_url = os.environ.get("APP_URL")
    cron_secret = os.environ.get("CRON_SECRET")

    if not app_url:
        print("Error: APP_URL environment variable not set")
        sys.exit(1)

    if not cron_secret:
        print("Error: CRON_SECRET environment variable not set")
        sys.exit(1)

    print("=" * 60)
    print("User Daily Recommendation Generation (Python -> TypeScript API)")
    print("=" * 60)
    print(f"Time: {datetime.now().isoformat()}")
    print(f"Session: {session}")
    print(f"API URL: {app_url}/api/recommendations/generate-daily")
    print()

    try:
        result = call_api(app_url, cron_secret, session)
        processed = result.get('processed', 0)
        failed = result.get('failed', 0)
        total = processed + failed

        print(f"✅ Processed: {processed} users")
        print(f"❌ Failed: {failed} users")

        # 失敗したユーザーの詳細を出力
        for r in result.get('results', []):
            if not r.get('success'):
                print(f"  - User {r.get('userId', 'unknown')}: {r.get('error', 'unknown error')}")

        # 全ユーザー失敗、またはユーザーが存在するのに1人も成功しなかった場合のみ失敗
        if total > 0 and processed == 0:
            print(f"\n❌ All {failed} users failed - marking as failure")
            sys.exit(1)

        if failed > 0:
            print(f"\n⚠️ {failed}/{total} users failed (partial failure) - marking as success")

    except Exception as e:
        print(f"Unexpected error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
