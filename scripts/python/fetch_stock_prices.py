#!/usr/bin/env python3
"""
株価取得スクリプト（バルク最適化版 - 東証専用）
yf.Tickers を使用して複数銘柄の情報を一括取得し、前日終値なども含めて効率的に取得する。
"""

import json
import os
import sys
import time
import re
from datetime import datetime, timedelta

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import yfinance as yf

# 株価データの鮮度チェック（日数）
STALE_DATA_DAYS = 14

# Yahoo Finance レート制限リトライ設定
YFINANCE_RATE_LIMIT_MAX_RETRIES = 5
YFINANCE_RATE_LIMIT_WAIT_SECONDS = [30, 60, 120, 240, 480]  # 指数バックオフ（秒）


def _is_rate_limit_error(e: Exception) -> bool:
    """Yahoo Finance のレート制限エラーかどうか判定"""
    return (
        "YFRateLimitError" in type(e).__name__
        or "Too Many Requests" in str(e)
        or "Rate limited" in str(e)
    )


def fetch_prices_bulk(ticker_inputs: list[str]) -> dict:
    """複数銘柄の株価を一括取得
    Returns: {"prices": [...], "staleTickers": [...]}
            エラー時は追加で "error" キーを含む
    """
    if not ticker_inputs:
        return {"prices": [], "staleTickers": []}

    probes = {}
    all_candidates = []

    # 1. ティッカーの準備
    for original in ticker_inputs:
        # 日本株形式（数字 or 新形式）の場合は .T を付与
        match = re.match(r"^(\d+[A-Z]?)(?:\.[A-Z]+)?$", original)
        if match:
            base = match.group(1)
            candidate = f"{base}.T"
            probes[original] = candidate
            all_candidates.append(candidate)
        else:
            # 米国株、インデックス、または既にサフィックスがある場合
            probes[original] = original
            all_candidates.append(original)

    # 重複除去
    all_candidates = list(set(all_candidates))

    # 2. 一括取得 (history を使用して価格データを取得)
    hist = None
    last_error = None
    for attempt in range(YFINANCE_RATE_LIMIT_MAX_RETRIES):
        try:
            tickers_obj = yf.Tickers(" ".join(all_candidates))
            # period='2d' で直近2営業日分を取得
            hist = tickers_obj.history(period="2d", interval="1d", progress=False)
            break  # 成功
        except Exception as e:
            last_error = e
            if _is_rate_limit_error(e) and attempt < YFINANCE_RATE_LIMIT_MAX_RETRIES - 1:
                wait_time = YFINANCE_RATE_LIMIT_WAIT_SECONDS[attempt]
                print(
                    f"Yahoo Finance rate limited. {wait_time}秒待機してリトライします "
                    f"(試行 {attempt + 1}/{YFINANCE_RATE_LIMIT_MAX_RETRIES})...",
                    file=sys.stderr,
                )
                time.sleep(wait_time)
            else:
                print(f"Error calling yfinance: {e}", file=sys.stderr)
                return {"prices": [], "staleTickers": [], "error": str(e)}
    
    if hist is None:
        print(f"Yahoo Finance API の最大リトライ数を超えました: {last_error}", file=sys.stderr)
        return {"prices": [], "staleTickers": [], "error": "Max retries exceeded"}

    results = []
    stale_tickers = []

    def get_ticker_data(t):
        if hist is None:
            return None
        # yf.Tickers は単一銘柄でも常にMultiIndex DataFrameを返すため、
        # 単一・複数銘柄どちらの場合も .xs() でティッカーを抽出する
        try:
            if t in hist.columns.get_level_values(1):
                return hist.xs(t, axis=1, level=1)
        except Exception:
            pass
        return None

    # 3. 取得結果の解析
    for original in ticker_inputs:
        cand = probes.get(original)
        best_data = get_ticker_data(cand)
        hit_ticker = cand if best_data is not None else None

        if best_data is not None:
            try:
                # 最新行（当日）と前行（前日）
                rows = best_data.dropna(subset=['Close'])
                if rows.empty:
                    continue

                current_row = rows.iloc[-1]
                prev_row = rows.iloc[-2] if len(rows) > 1 else current_row

                current_price = float(current_row['Close'])
                prev_close = float(prev_row['Close'])

                high = float(current_row['High'])
                low = float(current_row['Low'])
                volume = int(current_row['Volume'])

                # 計算
                change = current_price - prev_close
                change_percent = (change / prev_close * 100) if prev_close != 0 else 0

                # 鮮度チェック
                last_date = rows.index[-1]
                last_dt = last_date.to_pydatetime()
                if last_dt.tzinfo is not None:
                    last_dt = last_dt.replace(tzinfo=None)
                if (datetime.now() - last_dt).days > STALE_DATA_DAYS:
                    stale_tickers.append(original)
                    continue

                results.append({
                    "tickerCode": original,
                    "actualTicker": hit_ticker,
                    "currentPrice": round(current_price, 2),
                    "previousClose": round(prev_close, 2),
                    "change": round(change, 2),
                    "changePercent": round(change_percent, 2),
                    "volume": volume,
                    "high": round(high, 2),
                    "low": round(low, 2),
                    "marketTime": int(last_date.timestamp())
                })
            except Exception as e:
                print(f"Error processing {original}: {e}", file=sys.stderr)
        else:
            print(f"No valid data found for {original}", file=sys.stderr)

    return {"prices": results, "staleTickers": stale_tickers}


if __name__ == "__main__":
    if len(sys.argv) > 1:
        ticker_list = sys.argv[1].split(",")
        output = fetch_prices_bulk(ticker_list)
        print(json.dumps(output))
    else:
        print(json.dumps({"prices": [], "staleTickers": []}))
