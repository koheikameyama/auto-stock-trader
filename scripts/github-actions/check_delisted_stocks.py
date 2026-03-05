#!/usr/bin/env python3
"""
ポートフォリオ・ウォッチリストの銘柄について上場廃止ニュースをチェックするスクリプト

処理フロー:
1. DBからポートフォリオ・ウォッチリストに登録されている銘柄を取得
2. yfinance で各銘柄のニュースを取得
3. OpenAI gpt-4o-mini で上場廃止関連ニュースかどうかを判定
4. 該当銘柄のユーザーに通知を送信
"""

import json
import os
import sys
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta

import psycopg2
import psycopg2.extras
import requests
import yfinance as yf
from openai import OpenAI

# scriptsディレクトリをPythonパスに追加
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# ロギング設定
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# 並列取得数
CONCURRENCY = 5
# 1銘柄あたり取得するニュースの最大件数
MAX_NEWS_PER_STOCK = 10
# OpenAI バッチ処理のサイズ
DELISTING_CHECK_BATCH_SIZE = 20


def get_env_variable(name: str, required: bool = True) -> str | None:
    """環境変数を取得"""
    value = os.environ.get(name)
    if required and not value:
        logger.error(f"Error: {name} environment variable not set")
        sys.exit(1)
    return value


def fetch_user_stocks(conn) -> list[dict]:
    """ポートフォリオ・ウォッチリストに登録されている銘柄を取得（重複排除）"""
    with conn.cursor() as cur:
        cur.execute('''
            SELECT DISTINCT s.id, s."tickerCode", s.name, s.market
            FROM "Stock" s
            WHERE s."isDelisted" = false
              AND (
                EXISTS (
                    SELECT 1 FROM "PortfolioStock" p WHERE p."stockId" = s.id
                )
                OR EXISTS (
                    SELECT 1 FROM "WatchlistStock" w WHERE w."stockId" = s.id
                )
              )
            ORDER BY s."tickerCode"
        ''')
        rows = cur.fetchall()
    return [
        {"id": row[0], "tickerCode": row[1], "name": row[2], "market": row[3]}
        for row in rows
    ]


def fetch_stock_users(conn, stock_id: str) -> list[dict]:
    """指定銘柄を保有/ウォッチしているユーザーとリンク先URLを取得"""
    users = []
    with conn.cursor() as cur:
        # ポートフォリオ
        cur.execute('''
            SELECT p."userId", p.id as "userStockId", 'portfolio' as source
            FROM "PortfolioStock" p
            WHERE p."stockId" = %s
        ''', (stock_id,))
        for row in cur.fetchall():
            users.append({
                "userId": row[0],
                "userStockId": row[1],
                "source": row[2],
            })

        # ウォッチリスト
        cur.execute('''
            SELECT w."userId", w.id as "userStockId", 'watchlist' as source
            FROM "WatchlistStock" w
            WHERE w."stockId" = %s
        ''', (stock_id,))
        for row in cur.fetchall():
            users.append({
                "userId": row[0],
                "userStockId": row[1],
                "source": row[2],
            })

    return users


def to_yfinance_ticker(ticker_code: str, market: str) -> str:
    """ティッカーコードをyfinance形式に変換"""
    if market == "JP" and not ticker_code.endswith(".T"):
        return f"{ticker_code}.T"
    return ticker_code


def fetch_news_for_stock(stock: dict) -> list[dict]:
    """1銘柄のニュースを取得"""
    yf_ticker = to_yfinance_ticker(stock["tickerCode"], stock["market"])
    try:
        ticker = yf.Ticker(yf_ticker)
        news_items = ticker.news or []
        result = []
        for item in news_items[:MAX_NEWS_PER_STOCK]:
            title = item.get("title", "")
            url = item.get("link") or item.get("url", "")
            if not title:
                continue
            result.append({
                "stockId": stock["id"],
                "tickerCode": stock["tickerCode"],
                "stockName": stock["name"],
                "market": stock["market"],
                "title": title,
                "url": url,
            })
        return result
    except Exception as e:
        logger.warning(f"Failed to fetch news for {yf_ticker}: {e}")
        return []


def check_delisting_news_batch(
    client: OpenAI, news_items: list[dict]
) -> list[dict]:
    """ニュースタイトルから上場廃止関連かどうかを一括判定。該当するもののみ返す"""
    if not news_items:
        return []

    titles_text = "\n".join(
        f"{i}: [{item['tickerCode']}] {item['title']}"
        for i, item in enumerate(news_items)
    )

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "user",
                    "content": (
                        "以下の株式ニュースタイトルの中から、上場廃止（delisting）に関連するニュースを判定してください。\n"
                        "上場廃止に関連するニュースとは以下を含みます:\n"
                        "- 上場廃止の決定・予定\n"
                        "- 監理銘柄・整理銘柄への指定\n"
                        "- MBO（経営陣による買収）やTOB（株式公開買付け）による非公開化\n"
                        "- 株式併合による実質的な上場廃止\n"
                        "- 合併・吸収による上場廃止\n"
                        "- 債務超過や上場基準未達による上場廃止リスク\n"
                        "- delisting, going private, tender offer, squeeze out\n\n"
                        "各ニュースについて、上場廃止に関連する場合のみ結果に含めてください。\n"
                        "関連しないニュースは結果に含めないでください。\n\n"
                        f"{titles_text}"
                    ),
                }
            ],
            temperature=0.1,
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "delisting_check",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "results": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "index": {"type": "integer", "description": "ニュースのインデックス番号"},
                                        "reason": {"type": "string", "description": "上場廃止関連と判断した理由（日本語）"},
                                    },
                                    "required": ["index", "reason"],
                                    "additionalProperties": False,
                                },
                            }
                        },
                        "required": ["results"],
                        "additionalProperties": False,
                    },
                },
            },
        )
        parsed = json.loads(response.choices[0].message.content or "{}")
        delisting_indices = {r["index"]: r["reason"] for r in parsed.get("results", [])}

        flagged = []
        for idx, reason in delisting_indices.items():
            if 0 <= idx < len(news_items):
                item = news_items[idx].copy()
                item["delistingReason"] = reason
                flagged.append(item)

        return flagged
    except Exception as e:
        logger.error(f"OpenAI delisting check failed: {e}")
        return []


def send_notifications(app_url: str, cron_secret: str, notifications: list[dict]) -> dict:
    """通知APIを呼び出し"""
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
            logger.error(f"API returned {response.status_code}: {response.text}")
            return {"created": 0, "pushSent": 0, "skipped": 0, "errors": [response.text]}

        return response.json()
    except Exception as e:
        logger.error(f"Failed to call notification API: {e}")
        return {"created": 0, "pushSent": 0, "skipped": 0, "errors": [str(e)]}


def main():
    logger.info("=" * 60)
    logger.info("Delisted Stock News Checker")
    logger.info("=" * 60)
    logger.info(f"Time: {datetime.now().isoformat()}")

    db_url = get_env_variable("DATABASE_URL")
    app_url = get_env_variable("APP_URL")
    cron_secret = get_env_variable("CRON_SECRET")
    openai_key = get_env_variable("OPENAI_API_KEY")

    client = OpenAI(api_key=openai_key)
    conn = psycopg2.connect(db_url)

    try:
        # 1. ポートフォリオ・ウォッチリストの銘柄を取得
        stocks = fetch_user_stocks(conn)
        logger.info(f"Found {len(stocks)} stocks in user portfolios/watchlists")

        if not stocks:
            logger.info("No stocks to check. Exiting.")
            return

        # 2. yfinanceでニュース取得（並列）
        logger.info(f"Fetching news (concurrency={CONCURRENCY})...")
        all_news: list[dict] = []
        processed = 0

        with ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
            futures = {
                executor.submit(fetch_news_for_stock, stock): stock
                for stock in stocks
            }
            for future in as_completed(futures):
                news_items = future.result()
                all_news.extend(news_items)
                processed += 1
                if processed % 100 == 0:
                    logger.info(f"  Progress: {processed}/{len(stocks)} stocks, {len(all_news)} news collected")

        logger.info(f"Total news collected: {len(all_news)}")

        if not all_news:
            logger.info("No news found. Exiting.")
            return

        # 3. OpenAIで上場廃止ニュース判定（バッチ処理）
        logger.info(f"Checking for delisting news in batches of {DELISTING_CHECK_BATCH_SIZE}...")
        flagged_news: list[dict] = []

        for batch_start in range(0, len(all_news), DELISTING_CHECK_BATCH_SIZE):
            batch = all_news[batch_start: batch_start + DELISTING_CHECK_BATCH_SIZE]
            flagged = check_delisting_news_batch(client, batch)
            flagged_news.extend(flagged)

        logger.info(f"Delisting-related news found: {len(flagged_news)}")

        if not flagged_news:
            logger.info("No delisting news detected. Exiting.")
            return

        # 4. 該当銘柄のユーザーに通知を作成
        # 銘柄IDごとにフラグ付きニュースをグループ化
        flagged_by_stock: dict[str, list[dict]] = {}
        for item in flagged_news:
            stock_id = item["stockId"]
            if stock_id not in flagged_by_stock:
                flagged_by_stock[stock_id] = []
            flagged_by_stock[stock_id].append(item)

        notifications = []
        for stock_id, items in flagged_by_stock.items():
            users = fetch_stock_users(conn, stock_id)
            first_item = items[0]
            stock_name = first_item["stockName"]
            ticker_code = first_item["tickerCode"]
            reason = first_item["delistingReason"]

            for user in users:
                notifications.append({
                    "userId": user["userId"],
                    "type": "delisting_warning",
                    "stockId": stock_id,
                    "title": f"🚫 {stock_name}に上場廃止関連ニュース",
                    "body": f"{stock_name}({ticker_code})について上場廃止に関連するニュースが検出されました。{reason}",
                    "url": f"/my-stocks/{user['userStockId']}",
                })

        logger.info(f"Total notifications to send: {len(notifications)}")

        # 5. 通知送信
        if notifications:
            result = send_notifications(app_url, cron_secret, notifications)
            logger.info(f"  Created: {result.get('created', 0)}")
            logger.info(f"  Push sent: {result.get('pushSent', 0)}")
            logger.info(f"  Skipped (duplicate): {result.get('skipped', 0)}")
            if result.get('errors'):
                logger.warning(f"  Errors: {len(result['errors'])}")

        logger.info("=" * 60)
        logger.info("✅ Delisted stock news check completed")

    except Exception as e:
        logger.error(f"❌ Error: {e}")
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
