#!/usr/bin/env python3
"""
全銘柄の株価データを取得してDBに保存するスクリプト（最適化版）

yf.download() バッチAPIを使用して一括取得し、Stockテーブルの最新価格カラムを更新する。

最適化ポイント:
- yf.download() で一括取得（個別Ticker.history()の数十倍高速）
- --user-stocks-only フラグでユーザー関連銘柄のみに絞り込み可能
- バッチサイズごとに分割してメモリ効率化
"""

import argparse
import os
import sys
import time
from datetime import datetime, timezone

import numpy as np
import psycopg2
import psycopg2.extras
import yfinance as yf

# scriptsディレクトリをPythonパスに追加
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.constants import (
    DOWNLOAD_BATCH_SIZE,
    DB_BATCH_SIZE,
    FETCH_FAIL_WARNING_THRESHOLD,
    MIN_CHART_DATA_POINTS,
    STALE_DATA_DAYS,
    YFINANCE_RATE_LIMIT_MAX_RETRIES,
    YFINANCE_RATE_LIMIT_WAIT_SECONDS,
    YFINANCE_BATCH_SLEEP_SECONDS,
)


def get_database_url() -> str:
    """データベースURLを取得"""
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("Error: DATABASE_URL environment variable not set")
        sys.exit(1)
    return url


def fetch_stocks(conn, user_stocks_only: bool = False) -> list[dict]:
    """DBから銘柄一覧を取得

    user_stocks_only=True の場合、ユーザーに関連する銘柄のみ取得
    （ポートフォリオ/ウォッチリスト/追跡中 + 今日のおすすめ/注目銘柄）
    """
    with conn.cursor() as cur:
        if user_stocks_only:
            cur.execute('''
                SELECT DISTINCT s.id, s."tickerCode"
                FROM "Stock" s
                WHERE s.id IN (
                    SELECT "stockId" FROM "PortfolioStock"
                    UNION
                    SELECT "stockId" FROM "WatchlistStock"
                    UNION
                    SELECT "stockId" FROM "TrackedStock"
                    UNION
                    SELECT "stockId" FROM "UserDailyRecommendation" WHERE date = CURRENT_DATE
                    UNION
                    SELECT "stockId" FROM "DailyFeaturedStock" WHERE date = CURRENT_DATE
                )
                ORDER BY s."tickerCode"
            ''')
        else:
            cur.execute('''
                SELECT id, "tickerCode"
                FROM "Stock"
                ORDER BY "marketCap" DESC NULLS LAST
            ''')
        rows = cur.fetchall()

    return [{"id": row[0], "tickerCode": row[1]} for row in rows]


def ensure_ticker_suffix(ticker_code: str) -> str:
    """東証銘柄の .T サフィックスを確保"""
    return ticker_code if ticker_code.endswith(".T") else f"{ticker_code}.T"


def _is_rate_limit_error(e: Exception) -> bool:
    """Yahoo Finance のレート制限エラーかどうか判定"""
    return (
        "YFRateLimitError" in type(e).__name__
        or "Too Many Requests" in str(e)
        or "Rate limited" in str(e)
    )


def download_batch(symbols: list[str], retry_count: int = 0) -> dict:
    """yf.download() で一括取得し、銘柄別の価格データを返す。
    レートリミット時は指数バックオフでリトライ。
    """
    if not symbols:
        return {}

    try:
        df = yf.download(
            symbols,
            period="2mo",
            group_by="ticker",
            threads=True,
            progress=False,
        )
    except Exception as e:
        if _is_rate_limit_error(e) and retry_count < YFINANCE_RATE_LIMIT_MAX_RETRIES:
            wait = YFINANCE_RATE_LIMIT_WAIT_SECONDS[retry_count]
            print(f"  Rate limited (exception). Waiting {wait}s before retry {retry_count + 1}...")
            time.sleep(wait)
            return download_batch(symbols, retry_count + 1)
        print(f"  Error in yf.download: {e}")
        return {}

    if df.empty:
        # 空の結果もレートリミットの可能性がある
        if retry_count < YFINANCE_RATE_LIMIT_MAX_RETRIES and len(symbols) > 1:
            wait = YFINANCE_RATE_LIMIT_WAIT_SECONDS[retry_count]
            print(f"  Empty result for {len(symbols)} tickers. Waiting {wait}s before retry {retry_count + 1}...")
            time.sleep(wait)
            return download_batch(symbols, retry_count + 1)
        return {}

    results = {}

    # 1銘柄だけの場合、group_by="ticker" でもカラムがフラットになる
    if len(symbols) == 1:
        symbol = symbols[0]
        hist = df
        price_data = _compute_price_data(hist)
        if price_data:
            results[symbol] = price_data
        return results

    for symbol in symbols:
        try:
            hist = df[symbol]
        except (KeyError, TypeError):
            continue

        # NaN行を除去
        hist = hist.dropna(subset=["Close"])
        if len(hist) < 2:
            continue

        price_data = _compute_price_data(hist)
        if price_data:
            results[symbol] = price_data

    # 成功率が50%未満の場合、失敗銘柄をリトライ
    if len(results) < len(symbols) * 0.5 and retry_count < YFINANCE_RATE_LIMIT_MAX_RETRIES:
        failed_symbols = [s for s in symbols if s not in results]
        wait = YFINANCE_RATE_LIMIT_WAIT_SECONDS[retry_count]
        print(f"  Low success rate ({len(results)}/{len(symbols)}). Retrying {len(failed_symbols)} failed tickers after {wait}s...")
        time.sleep(wait)
        retry_results = download_batch(failed_symbols, retry_count + 1)
        results.update(retry_results)

    return results


def _is_zombie_data(hist) -> bool:
    """出来高がすべて0のゾンビデータを検出（上場廃止同等扱い）"""
    if len(hist) < 2:
        return False
    volumes = hist["Volume"].values.astype(float)
    return all(v == 0 for v in volumes)


def _compute_price_data(hist) -> dict | None:
    """DataFrameから価格指標を計算"""
    hist = hist.dropna(subset=["Close"])
    if len(hist) < 2:
        return None

    # 最新データが古すぎる場合は無視
    latest_date = hist.index[-1].to_pydatetime()
    if latest_date.tzinfo is None:
        latest_date = latest_date.replace(tzinfo=timezone.utc)
    if (datetime.now(timezone.utc) - latest_date).days > STALE_DATA_DAYS:
        return None

    latest = hist.iloc[-1]
    latest_price = float(latest["Close"])

    # DECIMAL(12, 2)の上限チェック（10^10未満 = 99億9999万9999.99まで）
    MAX_PRICE = 9_999_999_999.99
    if latest_price > MAX_PRICE or latest_price < 0:
        return None

    volume = int(latest["Volume"]) if not np.isnan(latest["Volume"]) else 0

    # 前日比変化率
    prev_price = float(hist.iloc[-2]["Close"])
    daily_change_rate = ((latest_price - prev_price) / prev_price) * 100 if prev_price > 0 else 0

    # 1週間前（5営業日前）の株価
    week_ago_idx = min(4, len(hist) - 1)
    week_ago_price = float(hist.iloc[-(week_ago_idx + 1)]["Close"])

    # 週間変化率
    change_rate = ((latest_price - week_ago_price) / week_ago_price) * 100

    # ボラティリティ計算（30日間の標準偏差/平均）
    volatility = None
    if len(hist) >= 20:
        close_prices = hist["Close"].values.astype(float)
        avg_price = float(close_prices.mean())
        if avg_price > 0:
            std_dev = float(close_prices.std())
            volatility = round((std_dev / avg_price) * 100, 2)

    # ATR(14) 計算（Average True Range: 14日間の平均真の値幅）
    atr14 = None
    if len(hist) >= 15:
        highs = hist["High"].values.astype(float)
        lows = hist["Low"].values.astype(float)
        closes = hist["Close"].values.astype(float)
        true_ranges = []
        for i in range(1, len(hist)):
            tr = max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1]),
            )
            true_ranges.append(tr)
        if len(true_ranges) >= 14:
            atr14 = round(float(sum(true_ranges[-14:])) / 14, 2)

    # 移動平均乖離率（25日SMA）
    ma_deviation_rate = None
    if len(hist) >= 25:
        close_prices_25 = hist["Close"].values.astype(float)[-25:]
        sma_25 = float(close_prices_25.mean())
        if sma_25 > 0:
            ma_deviation_rate = round(((latest_price - sma_25) / sma_25) * 100, 2)

    # 出来高比率（直近3日 vs 4-30日前）
    volume_ratio = None
    if len(hist) >= 10:
        volumes = hist["Volume"].values.astype(float)
        recent_volumes = volumes[-3:]
        older_volumes = volumes[:-3]
        if len(older_volumes) > 0:
            recent_avg = float(recent_volumes.mean())
            older_avg = float(older_volumes.mean())
            if older_avg > 0:
                volume_ratio = round(recent_avg / older_avg, 2)

    # ギャップアップ率（当日始値 - 前日終値）/ 前日終値 × 100
    gap_up_rate = None
    if len(hist) >= 2 and "Open" in hist.columns:
        today_open = float(hist.iloc[-1]["Open"])
        yesterday_close = float(hist.iloc[-2]["Close"])
        if yesterday_close > 0 and not np.isnan(today_open):
            gap_up_rate = round(((today_open - yesterday_close) / yesterday_close) * 100, 2)

    # 出来高急増率（当日出来高 / 過去平均出来高）
    volume_spike_rate = None
    if len(hist) >= 5:
        volumes = hist["Volume"].values.astype(float)
        avg_volume_period = volumes[:-1]  # 当日を除く過去データ
        if len(avg_volume_period) > 0:
            avg_volume = float(avg_volume_period.mean())
            today_volume = float(volumes[-1])
            if avg_volume > 0 and today_volume > 0:
                volume_spike_rate = round(today_volume / avg_volume, 2)

    # 売買代金（出来高 × 終値）
    turnover_value = None
    if volume > 0:
        turnover_value = int(volume * latest_price)

    # 始値
    latest_open = None
    if "Open" in hist.columns:
        open_val = hist.iloc[-1]["Open"]
        if not np.isnan(open_val):
            latest_open = float(open_val)
            if latest_open > MAX_PRICE or latest_open < 0:
                latest_open = None

    # DECIMAL(8, 2)の上限チェック（10^6未満 = 99万9999.99まで）
    MAX_RATE = 999_999.99

    def clamp_rate(val: float | None) -> float | None:
        if val is None:
            return None
        if val > MAX_RATE:
            return MAX_RATE
        if val < -MAX_RATE:
            return -MAX_RATE
        return val

    # チャート表示・テクニカル分析に十分なデータがあるか判定
    has_chart_data = len(hist) >= MIN_CHART_DATA_POINTS

    # ゾンビデータ検出（出来高0 = 実質取引なし）
    is_zombie = _is_zombie_data(hist)

    return {
        "latestPrice": latest_price,
        "latestPriceDate": latest_date.date(),  # yfinance株価データの実際の日付
        "latestVolume": volume,
        "dailyChangeRate": clamp_rate(round(daily_change_rate, 2)),
        "weekChangeRate": clamp_rate(round(change_rate, 2)),
        "volatility": clamp_rate(volatility),
        "volumeRatio": clamp_rate(volume_ratio),
        "maDeviationRate": clamp_rate(ma_deviation_rate),
        "latestOpen": latest_open,
        "gapUpRate": clamp_rate(gap_up_rate),
        "volumeSpikeRate": clamp_rate(volume_spike_rate),
        "turnoverValue": turnover_value,
        "atr14": atr14,
        "hasChartData": has_chart_data,
        "isZombie": is_zombie,
    }


def update_stock_prices(conn, updates: list[dict]) -> int:
    """株価データをバッチ更新"""
    if not updates:
        return 0

    with conn.cursor() as cur:
        now = datetime.now(timezone.utc)
        data = [
            (
                u["latestPrice"],
                u["latestPriceDate"],
                u["latestVolume"],
                u["dailyChangeRate"],
                u["weekChangeRate"],
                u.get("volatility"),
                u.get("volumeRatio"),
                u.get("maDeviationRate"),
                u.get("latestOpen"),
                u.get("gapUpRate"),
                u.get("volumeSpikeRate"),
                u.get("turnoverValue"),
                u.get("atr14"),
                u.get("hasChartData", True),
                now,
                u["id"]
            )
            for u in updates
        ]
        psycopg2.extras.execute_batch(
            cur,
            '''
            UPDATE "Stock"
            SET "latestPrice" = %s,
                "latestPriceDate" = %s,
                "latestVolume" = %s,
                "dailyChangeRate" = %s,
                "weekChangeRate" = %s,
                "volatility" = %s,
                "volumeRatio" = %s,
                "maDeviationRate" = %s,
                "latestOpen" = %s,
                "gapUpRate" = %s,
                "volumeSpikeRate" = %s,
                "turnoverValue" = %s,
                "atr14" = %s,
                "hasChartData" = %s,
                "priceUpdatedAt" = %s
            WHERE id = %s
            ''',
            data,
            page_size=DB_BATCH_SIZE
        )
    conn.commit()
    return len(updates)


def reset_fetch_fail_counts(conn, stock_ids: list[str]) -> int:
    """取得成功した銘柄の失敗カウントをリセット"""
    if not stock_ids:
        return 0

    with conn.cursor() as cur:
        psycopg2.extras.execute_batch(
            cur,
            'UPDATE "Stock" SET "fetchFailCount" = 0 WHERE id = %s AND "fetchFailCount" > 0',
            [(stock_id,) for stock_id in stock_ids],
            page_size=DB_BATCH_SIZE
        )
    conn.commit()
    return len(stock_ids)


def increment_fetch_fail_counts(conn, stock_ids: list[str]) -> int:
    """取得失敗した銘柄の失敗カウントをインクリメントし、hasChartData を false にする"""
    if not stock_ids:
        return 0

    now = datetime.now(timezone.utc)
    with conn.cursor() as cur:
        psycopg2.extras.execute_batch(
            cur,
            '''
            UPDATE "Stock"
            SET "fetchFailCount" = "fetchFailCount" + 1,
                "lastFetchFailedAt" = %s,
                "hasChartData" = false
            WHERE id = %s
            ''',
            [(now, stock_id) for stock_id in stock_ids],
            page_size=DB_BATCH_SIZE
        )
    conn.commit()
    return len(stock_ids)


def mark_delisted_stocks(conn) -> list[dict]:
    """fetchFailCount >= FETCH_FAIL_WARNING_THRESHOLD の銘柄を isDelisted = true に設定"""
    with conn.cursor() as cur:
        cur.execute('''
            UPDATE "Stock"
            SET "isDelisted" = true
            WHERE "fetchFailCount" >= %s
              AND "isDelisted" = false
            RETURNING id, "tickerCode", name, "fetchFailCount"
        ''', (FETCH_FAIL_WARNING_THRESHOLD,))
        rows = cur.fetchall()

    conn.commit()
    return [
        {"id": r[0], "tickerCode": r[1], "name": r[2], "failCount": r[3]}
        for r in rows
    ]


def mark_zombie_stocks(conn, stock_ids: list[str]) -> list[dict]:
    """ゾンビデータ（出来高0）の銘柄を isDelisted = true に設定"""
    if not stock_ids:
        return []

    with conn.cursor() as cur:
        psycopg2.extras.execute_batch(
            cur,
            '''
            UPDATE "Stock"
            SET "isDelisted" = true,
                "hasChartData" = false
            WHERE id = %s
              AND "isDelisted" = false
            RETURNING id, "tickerCode", name
            ''',
            [(stock_id,) for stock_id in stock_ids],
            page_size=DB_BATCH_SIZE
        )
        rows = cur.fetchall()

    conn.commit()
    return [
        {"id": r[0], "tickerCode": r[1], "name": r[2]}
        for r in rows
    ]


def delete_unused_failed_stocks(conn, min_fail_count: int = FETCH_FAIL_WARNING_THRESHOLD) -> list[dict]:
    """連続N回以上失敗 + ユーザー未使用の銘柄を削除"""
    with conn.cursor() as cur:
        # 削除対象を検索
        cur.execute('''
            SELECT s.id, s."tickerCode", s.name, s."fetchFailCount"
            FROM "Stock" s
            WHERE s."fetchFailCount" >= %s
              AND NOT EXISTS (SELECT 1 FROM "PortfolioStock" ps WHERE ps."stockId" = s.id)
              AND NOT EXISTS (SELECT 1 FROM "WatchlistStock" ws WHERE ws."stockId" = s.id)
              AND NOT EXISTS (SELECT 1 FROM "Transaction" t WHERE t."stockId" = s.id)
              AND NOT EXISTS (SELECT 1 FROM "TrackedStock" ts WHERE ts."stockId" = s.id)
        ''', (min_fail_count,))
        targets = cur.fetchall()

        if not targets:
            return []

        deleted = []
        for stock_id, ticker_code, name, fail_count in targets:
            cur.execute('DELETE FROM "Stock" WHERE id = %s', (stock_id,))
            deleted.append({
                "id": stock_id,
                "tickerCode": ticker_code,
                "name": name,
                "failCount": fail_count
            })

    conn.commit()
    return deleted


def main():
    parser = argparse.ArgumentParser(description="Fetch stock prices")
    parser.add_argument(
        "--user-stocks-only",
        action="store_true",
        help="ユーザー関連銘柄のみ取得（保有/ウォッチリスト/追跡中 + 今日のおすすめ/注目銘柄）",
    )
    args = parser.parse_args()

    mode = "user-stocks-only" if args.user_stocks_only else "all stocks"

    print("=" * 60)
    print("Stock Price Fetcher (Batch Download)")
    print("=" * 60)
    print(f"Time: {datetime.now().isoformat()}")
    print(f"Mode: {mode}")
    print(f"Config: DOWNLOAD_BATCH_SIZE={DOWNLOAD_BATCH_SIZE}")
    print()

    # DB接続
    db_url = get_database_url()
    conn = psycopg2.connect(db_url)

    try:
        # 銘柄一覧を取得
        stocks = fetch_stocks(conn, user_stocks_only=args.user_stocks_only)
        print(f"Found {len(stocks)} stocks to fetch")

        if not stocks:
            print("No stocks to process. Exiting.")
            return

        # ticker → stock info のマップ
        symbol_to_stock = {}
        for stock in stocks:
            symbol = ensure_ticker_suffix(stock["tickerCode"])
            symbol_to_stock[symbol] = stock

        all_symbols = list(symbol_to_stock.keys())

        # バッチごとに yf.download() で取得
        total_updated = 0
        total_errors = 0
        batch_size = DOWNLOAD_BATCH_SIZE

        # 成功/失敗した銘柄を追跡
        all_success_ids = []
        all_failed_ids = []
        all_zombie_ids = []

        for batch_start in range(0, len(all_symbols), batch_size):
            batch_symbols = all_symbols[batch_start:batch_start + batch_size]
            batch_num = batch_start // batch_size + 1
            total_batches = (len(all_symbols) + batch_size - 1) // batch_size

            print(f"Batch {batch_num}/{total_batches}: downloading {len(batch_symbols)} tickers...")
            start_time = time.time()

            price_data_map = download_batch(batch_symbols)
            elapsed = time.time() - start_time
            print(f"  Downloaded in {elapsed:.1f}s ({len(price_data_map)} succeeded)")

            # フィルタ適用 & DB更新データ作成
            updates = []
            success_symbols = set(price_data_map.keys())

            for symbol, price_data in price_data_map.items():
                stock = symbol_to_stock.get(symbol)
                if not stock:
                    continue

                is_zombie = price_data.pop("isZombie", False)
                if is_zombie:
                    all_zombie_ids.append(stock["id"])

                updates.append({
                    "id": stock["id"],
                    **price_data,
                })

            # 成功/失敗を追跡
            for symbol in batch_symbols:
                stock = symbol_to_stock.get(symbol)
                if not stock:
                    continue
                if symbol in success_symbols:
                    all_success_ids.append(stock["id"])
                else:
                    all_failed_ids.append(stock["id"])

            errors_in_batch = len(batch_symbols) - len(price_data_map)
            total_errors += errors_in_batch

            # DB更新
            updated = update_stock_prices(conn, updates)
            total_updated += updated
            print(f"  Updated {updated} stocks (errors: {errors_in_batch})")

            # バッチ間の待機（レート制限対策）
            if batch_start + batch_size < len(all_symbols):
                time.sleep(YFINANCE_BATCH_SLEEP_SECONDS)

        print()
        print(f"Completed: {len(all_symbols)} stocks processed")
        print(f"  - Total updated: {total_updated}")
        print(f"  - Errors: {total_errors}")

        # 失敗カウントの更新
        print()
        print("Updating fetch fail counts...")
        reset_fetch_fail_counts(conn, all_success_ids)
        print(f"  - Reset {len(all_success_ids)} successful stocks")
        increment_fetch_fail_counts(conn, all_failed_ids)
        print(f"  - Incremented {len(all_failed_ids)} failed stocks")

        # 連続失敗した銘柄を自動で上場廃止マーク
        marked = mark_delisted_stocks(conn)
        if marked:
            print()
            print(f"Marked {len(marked)} stocks as delisted ({FETCH_FAIL_WARNING_THRESHOLD}+ consecutive failures):")
            for stock in marked:
                print(f"  - {stock['tickerCode']} ({stock['name']}) - {stock['failCount']} failures")

        # ゾンビデータの銘柄を上場廃止扱いに
        zombie_marked = mark_zombie_stocks(conn, all_zombie_ids)
        if zombie_marked:
            print()
            print(f"Marked {len(zombie_marked)} stocks as delisted (zombie data - zero volume):")
            for stock in zombie_marked:
                print(f"  - {stock['tickerCode']} ({stock['name']})")

        # 連続失敗 + ユーザー未使用の銘柄を削除
        deleted = delete_unused_failed_stocks(conn)
        if deleted:
            print()
            print(f"Deleted {len(deleted)} unused stocks with {FETCH_FAIL_WARNING_THRESHOLD}+ consecutive failures:")
            for stock in deleted:
                print(f"  - {stock['tickerCode']} ({stock['name']}) - {stock['failCount']} failures")

        print("=" * 60)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
