#!/usr/bin/env python3
"""
全銘柄の個別ニュースをyfinanceで取得してMarketNewsテーブルに保存するスクリプト

処理フロー:
1. DBから isDelisted=false の全銘柄を取得
2. yfinance Ticker.news で各銘柄のニュースを取得（最新10件）
3. OpenAI gpt-4o-mini でセンチメントをバッチ分析
4. MarketNews テーブルに保存（tickerCode フィールドに銘柄コードを設定）
"""

import json
import os
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras
import yfinance as yf
from openai import OpenAI

# 並列取得数
CONCURRENCY = 5
# 1銘柄あたり取得するニュースの最大件数
MAX_NEWS_PER_STOCK = 10
# OpenAI バッチ処理のサイズ（まとめて分析する件数）
SENTIMENT_BATCH_SIZE = 30
# バッチ間のスリープ（秒）
BATCH_SLEEP_SECONDS = 1.0


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


def main():
    print("=" * 60)
    print("Stock News Fetcher (yfinance)")
    print("=" * 60)
    print(f"Time: {datetime.now().isoformat()}")

    openai_key = os.environ.get("OPENAI_API_KEY")
    client = OpenAI(api_key=openai_key) if openai_key else None
    if not client:
        print("Warning: OPENAI_API_KEY not set. Sentiment analysis will be skipped.")

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

        print("\n" + "=" * 60)
        print(f"Done. Processed {len(stocks)} stocks, collected {len(all_news)} news items.")
        print("=" * 60)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
