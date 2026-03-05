#!/usr/bin/env python3
"""
全銘柄の個別ニュースをyfinanceで取得してMarketNewsテーブルに保存するスクリプト

処理フロー:
1. DBから isDelisted=false の全銘柄を取得
2. yfinance Ticker.news で各銘柄のニュースを取得（最新10件）
3. OpenAI gpt-4o-mini でセンチメントをバッチ分析
4. MarketNews テーブルに保存（tickerCode フィールドに銘柄コードを設定）
5. ポートフォリオ・ウォッチリスト銘柄のニュースから上場廃止関連を検出し通知
"""

import json
import logging
import os
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras
import requests
import yfinance as yf
from openai import OpenAI

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
# OpenAI バッチ処理のサイズ（まとめて分析する件数）
SENTIMENT_BATCH_SIZE = 30
# バッチ間のスリープ（秒）
BATCH_SLEEP_SECONDS = 1.0
# 上場廃止チェックのバッチサイズ
DELISTING_CHECK_BATCH_SIZE = 20


def get_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("Error: DATABASE_URL environment variable not set")
        sys.exit(1)
    return url


def fetch_all_stocks(conn) -> list[dict]:
    """isDelisted=false の全銘柄を取得"""
    with conn.cursor() as cur:
        cur.execute('''
            SELECT id, "tickerCode", market
            FROM "Stock"
            WHERE "isDelisted" = false
            ORDER BY "marketCap" DESC NULLS LAST
        ''')
        rows = cur.fetchall()
    return [{"id": row[0], "tickerCode": row[1], "market": row[2]} for row in rows]


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
            published_ts = item.get("providerPublishTime")
            publisher = item.get("publisher", "yfinance")
            if not title or not url:
                continue
            published_at = (
                datetime.fromtimestamp(published_ts, tz=timezone.utc)
                if published_ts
                else datetime.now(timezone.utc)
            )
            result.append({
                "tickerCode": stock["tickerCode"],
                "market": stock["market"],
                "title": title,
                "url": url,
                "source": publisher,
                "publishedAt": published_at,
            })
        return result
    except Exception as e:
        print(f"  Warning: Failed to fetch news for {yf_ticker}: {e}")
        return []


def analyze_sentiments_batch(
    client: OpenAI, items: list[dict]
) -> dict[int, str]:
    """複数ニュースのセンチメントを一括分析。{index: sentiment} を返す"""
    if not items:
        return {}

    titles_text = "\n".join(
        f"{i}: {item['title']}" for i, item in enumerate(items)
    )

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "user",
                    "content": (
                        "以下の株式ニュースのタイトルについて、各行のセンチメントを判定してください。\n"
                        "センチメントは株価・企業業績への影響を基準に判断します。\n\n"
                        f"{titles_text}"
                    ),
                }
            ],
            temperature=0.1,
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "sentiment_batch",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "results": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "index": {"type": "integer"},
                                        "sentiment": {
                                            "type": "string",
                                            "enum": ["positive", "negative", "neutral"],
                                        },
                                    },
                                    "required": ["index", "sentiment"],
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
        return {r["index"]: r["sentiment"] for r in parsed.get("results", [])}
    except Exception as e:
        print(f"  Warning: OpenAI sentiment analysis failed: {e}")
        return {}


def save_news_batch(conn, news_list: list[dict]) -> int:
    """MarketNewsテーブルにバッチINSERT（既存のurl+tickerCodeは無視）"""
    if not news_list:
        return 0

    now = datetime.now(timezone.utc)
    data = [
        (
            str(uuid.uuid4()),
            item["title"],
            "",  # content: yfinanceはタイトルのみ提供
            item["url"],
            item["source"],
            None,  # sector
            item.get("sentiment"),
            item["publishedAt"],
            now,
            item["market"],
            "日本" if item["market"] == "JP" else "米国",
            item["tickerCode"],
        )
        for item in news_list
    ]

    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            '''
            INSERT INTO "MarketNews"
              (id, title, content, url, source, sector, sentiment,
               "publishedAt", "createdAt", market, region, "tickerCode")
            VALUES %s
            ON CONFLICT (url, "tickerCode") DO NOTHING
            ''',
            data,
            page_size=100,
        )
    conn.commit()

    # ON CONFLICT で除外された件数は取れないので、挿入試行件数を返す
    return len(data)


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


def fetch_stock_users(conn, stock_id: str) -> list[dict]:
    """指定銘柄を保有/ウォッチしているユーザーとリンク先URLを取得"""
    users = []
    with conn.cursor() as cur:
        # ポートフォリオ
        cur.execute('''
            SELECT p."userId", p.id as "userStockId"
            FROM "PortfolioStock" p
            WHERE p."stockId" = %s
        ''', (stock_id,))
        for row in cur.fetchall():
            users.append({"userId": row[0], "userStockId": row[1]})

        # ウォッチリスト
        cur.execute('''
            SELECT w."userId", w.id as "userStockId"
            FROM "WatchlistStock" w
            WHERE w."stockId" = %s
        ''', (stock_id,))
        for row in cur.fetchall():
            users.append({"userId": row[0], "userStockId": row[1]})

    return users


def save_delisting_flags(conn, flagged_news: list[dict], stocks_by_ticker: dict[str, dict]) -> int:
    """上場廃止ニュース検出結果をStockテーブルに保存"""
    now = datetime.now(timezone.utc)
    updates = []

    # 銘柄ごとに最初のニュースの理由を使用
    seen_tickers: set[str] = set()
    for item in flagged_news:
        ticker = item["tickerCode"]
        if ticker in seen_tickers:
            continue
        seen_tickers.add(ticker)
        stock = stocks_by_ticker.get(ticker)
        if stock:
            updates.append((now, item["delistingReason"], stock["id"]))

    if not updates:
        return 0

    with conn.cursor() as cur:
        psycopg2.extras.execute_batch(
            cur,
            '''
            UPDATE "Stock"
            SET "delistingNewsDetectedAt" = %s,
                "delistingNewsReason" = %s
            WHERE id = %s
            ''',
            updates,
        )
    conn.commit()
    return len(updates)


def send_delisting_notifications(
    app_url: str, cron_secret: str, conn, flagged_news: list[dict], stocks_by_ticker: dict[str, dict]
) -> None:
    """上場廃止関連ニュースが見つかった銘柄のユーザーに通知を送信"""
    # 銘柄IDごとにグループ化
    flagged_by_stock: dict[str, list[dict]] = {}
    for item in flagged_news:
        ticker_code = item["tickerCode"]
        stock = stocks_by_ticker.get(ticker_code)
        if not stock:
            continue
        stock_id = stock["id"]
        if stock_id not in flagged_by_stock:
            flagged_by_stock[stock_id] = []
        flagged_by_stock[stock_id].append(item)

    notifications = []
    for stock_id, items in flagged_by_stock.items():
        users = fetch_stock_users(conn, stock_id)
        if not users:
            continue

        first_item = items[0]
        ticker_code = first_item["tickerCode"]
        stock = stocks_by_ticker[ticker_code]
        stock_name = stock.get("name", ticker_code)
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

    if not notifications:
        logger.info("  No users to notify for delisting news")
        return

    logger.info(f"  Sending {len(notifications)} delisting notifications...")
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
        if response.ok:
            result = response.json()
            logger.info(f"  Created: {result.get('created', 0)}, Push sent: {result.get('pushSent', 0)}, Skipped: {result.get('skipped', 0)}")
        else:
            logger.error(f"  Notification API returned {response.status_code}: {response.text}")
    except Exception as e:
        logger.error(f"  Failed to send delisting notifications: {e}")


def main():
    print("=" * 60)
    print("Stock News Fetcher (yfinance)")
    print("=" * 60)
    print(f"Time: {datetime.now().isoformat()}")

    openai_key = os.environ.get("OPENAI_API_KEY")
    client = OpenAI(api_key=openai_key) if openai_key else None
    if not client:
        print("Warning: OPENAI_API_KEY not set. Sentiment analysis will be skipped.")

    app_url = os.environ.get("APP_URL")
    cron_secret = os.environ.get("CRON_SECRET")

    db_url = get_database_url()
    conn = psycopg2.connect(db_url)

    try:
        # 全銘柄を取得
        stocks = fetch_all_stocks(conn)
        print(f"Found {len(stocks)} active stocks")

        if not stocks:
            print("No stocks to process. Exiting.")
            return

        # yfinanceで並列ニュース取得
        print(f"\nFetching news (concurrency={CONCURRENCY})...")
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
                if processed % 500 == 0:
                    print(f"  Progress: {processed}/{len(stocks)} stocks processed, {len(all_news)} news collected")

        print(f"Total news collected: {len(all_news)}")

        if not all_news:
            print("No news found. Exiting.")
            return

        # OpenAIでセンチメント分析（バッチ処理）
        if client:
            print(f"\nAnalyzing sentiments in batches of {SENTIMENT_BATCH_SIZE}...")
            for batch_start in range(0, len(all_news), SENTIMENT_BATCH_SIZE):
                batch = all_news[batch_start: batch_start + SENTIMENT_BATCH_SIZE]
                sentiments = analyze_sentiments_batch(client, batch)
                for i, item in enumerate(batch):
                    item["sentiment"] = sentiments.get(i, "neutral")
                if batch_start > 0 and batch_start % (SENTIMENT_BATCH_SIZE * 10) == 0:
                    print(f"  Sentiment progress: {batch_start}/{len(all_news)}")
                    time.sleep(BATCH_SLEEP_SECONDS)
            print("Sentiment analysis complete.")
        else:
            for item in all_news:
                item["sentiment"] = None

        # DBに保存
        print(f"\nSaving {len(all_news)} news to database...")
        saved = save_news_batch(conn, all_news)
        print(f"Inserted (attempted): {saved}")

        # 上場廃止ニュースチェック（全銘柄対象）
        if client and app_url and cron_secret:
            print(f"\nChecking for delisting news in batches of {DELISTING_CHECK_BATCH_SIZE}...")
            flagged_news: list[dict] = []
            for batch_start in range(0, len(all_news), DELISTING_CHECK_BATCH_SIZE):
                batch = all_news[batch_start: batch_start + DELISTING_CHECK_BATCH_SIZE]
                flagged = check_delisting_news_batch(client, batch)
                flagged_news.extend(flagged)
            print(f"Delisting-related news found: {len(flagged_news)}")

            if flagged_news:
                # tickerCode → stock のマップを作成（名前取得用にDBから再取得）
                flagged_tickers = {item["tickerCode"] for item in flagged_news}
                stocks_by_ticker: dict[str, dict] = {}
                with conn.cursor() as cur:
                    for ticker in flagged_tickers:
                        cur.execute(
                            'SELECT id, "tickerCode", name FROM "Stock" WHERE "tickerCode" = %s',
                            (ticker,)
                        )
                        row = cur.fetchone()
                        if row:
                            stocks_by_ticker[ticker] = {"id": row[0], "tickerCode": row[1], "name": row[2]}

                # DBに上場廃止ニュース検出結果を保存
                saved_count = save_delisting_flags(conn, flagged_news, stocks_by_ticker)
                logger.info(f"  Saved delisting flags for {saved_count} stocks")

                # ポートフォリオ・ウォッチリストのユーザーに通知
                send_delisting_notifications(app_url, cron_secret, conn, flagged_news, stocks_by_ticker)
        elif not app_url or not cron_secret:
            print("\nSkipping delisting check: APP_URL or CRON_SECRET not set")

        print("\n" + "=" * 60)
        print(f"Done. Processed {len(stocks)} stocks, collected {len(all_news)} news items.")
        print("=" * 60)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
