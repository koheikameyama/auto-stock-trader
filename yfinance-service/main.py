"""
yfinance サイドカーサービス

Yahoo Finance データを yfinance 経由で取得する FastAPI サーバー。
Node.js ワーカーから localhost HTTP 経由で呼び出される。
"""

import asyncio
import logging
import math
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, TypeVar

T = TypeVar("T")

import uvicorn
import yfinance as yf
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

try:
    from yfinance.exceptions import YFRateLimitError
except ImportError:
    YFRateLimitError = None  # type: ignore[misc,assignment]

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("yfinance-service")

app = FastAPI(title="yfinance sidecar")

# ========================================
# 認証
# ========================================

SIDECAR_SECRET = os.environ.get("SIDECAR_SECRET", "")

# ========================================
# プロキシ設定（グローバル）
# ========================================

PROXY = os.environ.get("YFINANCE_PROXY", "")
if PROXY:
    # curl_cffi の Session.proxies は dict を期待する
    yf.config.network.proxy = {"http": PROXY, "https": PROXY}
    logger.info(f"Proxy configured: {PROXY.split('@')[-1] if '@' in PROXY else PROXY}")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)
    if SIDECAR_SECRET:
        api_key = request.headers.get("x-api-key", "")
        if api_key != SIDECAR_SECRET:
            raise HTTPException(status_code=401, detail="Unauthorized")
    return await call_next(request)


# ========================================
# レート制限（直列化 + 1秒ディレイ）
# ========================================

_semaphore = asyncio.Semaphore(1)
_MIN_DELAY_S = 1.0


async def throttled(fn: Callable[[], T]) -> T:
    """Yahoo Finance へのリクエストを直列化し、リクエスト間に1秒ディレイを入れる"""
    async with _semaphore:
        loop = asyncio.get_event_loop()
        result: T = await loop.run_in_executor(None, fn)  # type: ignore[arg-type]
        await asyncio.sleep(_MIN_DELAY_S)
        return result


# ========================================
# ティッカー正規化（TypeScript 版と同じロジック）
# ========================================

def normalize_ticker(ticker_code: str) -> str:
    if not ticker_code:
        raise ValueError("ticker_code is required")
    if "." in ticker_code:
        return ticker_code
    if ticker_code.startswith("^"):
        return ticker_code
    if re.match(r"^\d+$", ticker_code) or re.match(r"^\d+[A-Za-z]$", ticker_code):
        return f"{ticker_code}.T"
    return ticker_code


# ========================================
# リトライ
# ========================================

_RETRY_MAX = 2  # 最大2回リトライ（計3回試行）
_RETRY_DELAY_S = 2.0


def _is_retryable(e: Exception) -> bool:
    """リトライ可能なエラーか判定"""
    msg = str(e)
    # yfinance 内部のパースエラー（'str' object has no attribute 'get' 等）
    if "has no attribute" in msg:
        return True
    # ネットワーク系
    if any(code in msg for code in ("ConnectionError", "Timeout", "ReadTimeout")):
        return True
    return _is_rate_limit_error(e)


async def throttled_with_retry(fn: Callable[[], T]) -> T:
    """throttled + リトライ（yfinance 内部エラー対策）"""
    last_error: Exception | None = None
    for attempt in range(_RETRY_MAX + 1):
        try:
            return await throttled(fn)
        except Exception as e:
            last_error = e
            if not _is_retryable(e) or attempt >= _RETRY_MAX:
                raise
            logger.warning(
                f"リトライ {attempt + 1}/{_RETRY_MAX} after {_RETRY_DELAY_S}s: {e}"
            )
            await asyncio.sleep(_RETRY_DELAY_S)
    raise last_error  # type: ignore[misc]


# ========================================
# ユーティリティ
# ========================================

def _is_rate_limit_error(e: Exception) -> bool:
    """レート制限エラーかどうか判定"""
    if YFRateLimitError is not None and isinstance(e, YFRateLimitError):
        return True
    msg = str(e).lower()
    return "rate limit" in msg or "too many requests" in msg or "429" in msg


def _error_status(e: Exception) -> int:
    """例外に応じた HTTP ステータスコードを返す"""
    return 429 if _is_rate_limit_error(e) else 500


def safe_float(value: Any, default: float = 0.0) -> float:
    """NaN/None を安全に変換"""
    if value is None:
        return default
    try:
        f = float(value)
        return default if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return default


def safe_float_or_none(value: Any) -> float | None:
    """NaN/None → None"""
    if value is None:
        return None
    try:
        f = float(value)
        return None if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return None


def _build_info_from_fast_info(ticker: yf.Ticker) -> dict:
    """fast_info から info 互換の dict を構築する"""
    fi = ticker.fast_info
    return {
        "currentPrice": safe_float_or_none(getattr(fi, "last_price", None)),
        "previousClose": safe_float_or_none(getattr(fi, "previous_close", None)),
        "volume": safe_float_or_none(getattr(fi, "last_volume", None)),
        "dayHigh": safe_float_or_none(getattr(fi, "day_high", None)),
        "dayLow": safe_float_or_none(getattr(fi, "day_low", None)),
        "open": safe_float_or_none(getattr(fi, "open", None)),
        "marketCap": safe_float_or_none(getattr(fi, "market_cap", None)),
    }


def parse_quote_from_info(info: dict, symbol: str) -> dict:
    """yfinance の info dict を StockQuote 形式に変換"""
    if not isinstance(info, dict):
        raise ValueError(f"Expected dict from yfinance info, got {type(info).__name__}: {info}")
    price = safe_float(info.get("currentPrice") or info.get("regularMarketPrice"))
    prev_close = safe_float(info.get("previousClose") or info.get("regularMarketPreviousClose"))
    change = price - prev_close if price and prev_close else 0.0
    change_pct = (change / prev_close * 100) if prev_close else 0.0

    return {
        "tickerCode": symbol,
        "price": price,
        "previousClose": prev_close,
        "change": round(change, 2),
        "changePercent": round(change_pct, 4),
        "volume": safe_float(info.get("volume") or info.get("regularMarketVolume")),
        "high": safe_float(info.get("dayHigh") or info.get("regularMarketDayHigh")),
        "low": safe_float(info.get("dayLow") or info.get("regularMarketDayLow")),
        "open": safe_float(info.get("open") or info.get("regularMarketOpen")),
        "per": safe_float_or_none(info.get("trailingPE")),
        "pbr": safe_float_or_none(info.get("priceToBook")),
        "eps": safe_float_or_none(info.get("trailingEps")),
        "marketCap": safe_float_or_none(info.get("marketCap")),
    }


def parse_index_quote_from_info(info: dict) -> dict:
    """yfinance の info dict を IndexQuote 形式に変換"""
    if not isinstance(info, dict):
        raise ValueError(f"Expected dict from yfinance info, got {type(info).__name__}: {info}")
    price = safe_float(
        info.get("regularMarketPrice") or info.get("currentPrice")
    )
    prev_close = safe_float(
        info.get("regularMarketPreviousClose") or info.get("previousClose") or info.get("regularMarketPrice")
    )
    change = price - prev_close if price and prev_close else 0.0
    change_pct = (change / prev_close * 100) if prev_close else 0.0

    return {
        "price": price,
        "previousClose": prev_close,
        "change": round(change, 2),
        "changePercent": round(change_pct, 4),
    }


# ========================================
# エンドポイント
# ========================================

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/quote")
async def get_quote(symbol: str):
    """個別銘柄のリアルタイムクォートを取得"""
    symbol = normalize_ticker(symbol)
    try:
        def _fetch():
            ticker = yf.Ticker(symbol)
            try:
                info = ticker.info
                if isinstance(info, dict):
                    return info
                logger.warning(f"ticker.info returned {type(info).__name__} for {symbol}, falling back to fast_info")
            except Exception as e:
                logger.warning(f"ticker.info raised {type(e).__name__} for {symbol}: {e}, falling back to fast_info")
            return _build_info_from_fast_info(ticker)
        info = await throttled_with_retry(_fetch)
        return parse_quote_from_info(info, symbol)
    except Exception as e:
        logger.error(f"Failed to fetch quote for {symbol}: {e}")
        raise HTTPException(status_code=_error_status(e), detail=str(e))


class QuotesBatchRequest(BaseModel):
    symbols: list[str]


@app.post("/quotes")
async def get_quotes_batch(req: QuotesBatchRequest):
    """複数銘柄のクォートをバッチ取得"""
    symbols = [normalize_ticker(s) for s in req.symbols]
    results = []

    for symbol in symbols:
        try:
            def _fetch(s=symbol):
                ticker = yf.Ticker(s)
                try:
                    info = ticker.info
                    if isinstance(info, dict):
                        return info
                    logger.warning(f"ticker.info returned {type(info).__name__} for {s}, falling back to fast_info")
                except Exception as e:
                    logger.warning(f"ticker.info raised {type(e).__name__} for {s}: {e}, falling back to fast_info")
                return _build_info_from_fast_info(ticker)
            info = await throttled_with_retry(_fetch)
            results.append(parse_quote_from_info(info, symbol))
        except Exception as e:
            logger.error(f"Failed to fetch quote for {symbol}: {e}")
            results.append(None)

    return results


@app.get("/historical")
async def get_historical(symbol: str, days: int = 200):
    """ヒストリカルOHLCVデータを取得"""
    symbol = normalize_ticker(symbol)
    try:
        def _fetch():
            ticker = yf.Ticker(symbol)
            df = ticker.history(period=f"{days}d", interval="1d")
            return df

        df = await throttled_with_retry(_fetch)

        if df is None or df.empty:
            return []

        bars = []
        for date, row in df.iterrows():
            o = safe_float_or_none(row.get("Open"))
            h = safe_float_or_none(row.get("High"))
            l = safe_float_or_none(row.get("Low"))
            c = safe_float_or_none(row.get("Close"))
            if o is not None and h is not None and l is not None and c is not None and c > 0:
                bars.append({
                    "date": date.strftime("%Y-%m-%d"),
                    "open": o,
                    "high": h,
                    "low": l,
                    "close": c,
                    "volume": safe_float(row.get("Volume")),
                })

        return bars
    except Exception as e:
        logger.error(f"Failed to fetch historical data for {symbol}: {e}")
        raise HTTPException(status_code=_error_status(e), detail=str(e))


class HistoricalRangeRequest(BaseModel):
    symbol: str
    start: str  # YYYY-MM-DD
    end: str    # YYYY-MM-DD


@app.post("/historical")
async def get_historical_range(req: HistoricalRangeRequest):
    """バックテスト用: 期間指定でヒストリカルデータを取得"""
    symbol = normalize_ticker(req.symbol)
    try:
        def _fetch():
            ticker = yf.Ticker(symbol)
            df = ticker.history(start=req.start, end=req.end, interval="1d")
            return df

        df = await throttled_with_retry(_fetch)

        if df is None or df.empty:
            return []

        bars = []
        for date, row in df.iterrows():
            o = safe_float_or_none(row.get("Open"))
            h = safe_float_or_none(row.get("High"))
            l = safe_float_or_none(row.get("Low"))
            c = safe_float_or_none(row.get("Close"))
            if o is not None and h is not None and l is not None and c is not None:
                bars.append({
                    "date": date.strftime("%Y-%m-%d"),
                    "open": o,
                    "high": h,
                    "low": l,
                    "close": c,
                    "volume": safe_float(row.get("Volume")),
                })

        return bars
    except Exception as e:
        logger.error(f"Failed to fetch historical range for {symbol}: {e}")
        raise HTTPException(status_code=_error_status(e), detail=str(e))


# 市場指標シンボル
MARKET_SYMBOLS = {
    "nikkei": "^N225",
    "sp500": "^GSPC",
    "vix": "^VIX",
    "usdjpy": "JPY=X",
    "cmeFutures": "NKD=F",
}


@app.get("/market")
async def get_market():
    """市場指標データを一括取得"""
    result: dict[str, dict | None] = {}
    for key, symbol in MARKET_SYMBOLS.items():
        try:
            def _fetch(s=symbol):
                ticker = yf.Ticker(s)
                try:
                    info = ticker.info
                    if isinstance(info, dict):
                        return info
                    logger.warning(f"ticker.info returned {type(info).__name__} for {s}, falling back to fast_info")
                except Exception as e:
                    logger.warning(f"ticker.info raised {type(e).__name__} for {s}: {e}, falling back to fast_info")
                return _build_info_from_fast_info(ticker)
            info = await throttled_with_retry(_fetch)
            result[key] = parse_index_quote_from_info(info)
        except Exception as e:
            logger.warning(f"Failed to fetch market index {symbol}: {e}")
            result[key] = None
    return result


@app.get("/events")
async def get_events(symbol: str):
    """コーポレートイベント情報を取得"""
    symbol = normalize_ticker(symbol)
    try:
        def _fetch():
            ticker = yf.Ticker(symbol)
            try:
                info = ticker.info
                if not isinstance(info, dict):
                    logger.warning(f"ticker.info returned {type(info).__name__} for {symbol}, falling back to fast_info")
                    info = _build_info_from_fast_info(ticker)
            except Exception as e:
                logger.warning(f"ticker.info raised {type(e).__name__} for {symbol}: {e}, falling back to fast_info")
                info = _build_info_from_fast_info(ticker)
            cal = None
            try:
                cal = ticker.calendar
            except Exception:
                pass
            return info, cal

        info, cal = await throttled_with_retry(_fetch)

        # 決算日
        next_earnings_date = None
        if cal is not None:
            # cal は dict の場合がある
            if isinstance(cal, dict):
                earnings_dates = cal.get("Earnings Date", [])
                if earnings_dates:
                    now = datetime.now(timezone.utc)
                    future = [d for d in earnings_dates if isinstance(d, datetime) and d > now]
                    if future:
                        next_earnings_date = future[0].isoformat()
                    elif earnings_dates:
                        last = earnings_dates[-1]
                        if isinstance(last, datetime):
                            next_earnings_date = last.isoformat()

        # 配当落ち日
        ex_dividend_date = None
        ex_div_raw = info.get("exDividendDate")
        if ex_div_raw:
            if isinstance(ex_div_raw, (int, float)):
                ex_dividend_date = datetime.fromtimestamp(ex_div_raw, tz=timezone.utc).isoformat()
            elif isinstance(ex_div_raw, datetime):
                ex_dividend_date = ex_div_raw.isoformat()

        # 1株あたり配当金額（年間配当を2で割る: 日本株は通常年2回）
        dividend_rate = safe_float_or_none(info.get("dividendRate"))
        dividend_per_share = None
        if dividend_rate is not None:
            dividend_per_share = round(dividend_rate / 2, 2)

        # 株式分割
        last_split_factor = info.get("lastSplitFactor")
        last_split_date = None
        lsd_raw = info.get("lastSplitDate")
        if lsd_raw:
            if isinstance(lsd_raw, (int, float)):
                last_split_date = datetime.fromtimestamp(lsd_raw, tz=timezone.utc).isoformat()
            elif isinstance(lsd_raw, datetime):
                last_split_date = lsd_raw.isoformat()

        return {
            "nextEarningsDate": next_earnings_date,
            "exDividendDate": ex_dividend_date,
            "dividendPerShare": dividend_per_share,
            "lastSplitFactor": last_split_factor,
            "lastSplitDate": last_split_date,
        }
    except Exception as e:
        logger.error(f"Failed to fetch events for {symbol}: {e}")
        # コーポレートイベントは失敗時に空を返す（既存動作と一致）
        return {
            "nextEarningsDate": None,
            "exDividendDate": None,
            "dividendPerShare": None,
            "lastSplitFactor": None,
            "lastSplitDate": None,
        }


class SearchRequest(BaseModel):
    query: str
    news_count: int = 10


@app.post("/search")
async def search_news(req: SearchRequest):
    """銘柄関連ニュースを検索"""
    try:
        def _fetch():
            search = yf.Search(req.query, news_count=req.news_count)
            return search.news

        news = await throttled_with_retry(_fetch)

        if not news:
            return {"news": []}

        items = []
        for n in news[:req.news_count]:
            title = n.get("title", "")
            link = n.get("link", "")
            if not title or not link:
                continue
            pub_time = n.get("providerPublishTime")
            published_at = None
            if pub_time:
                if isinstance(pub_time, (int, float)):
                    published_at = datetime.fromtimestamp(pub_time, tz=timezone.utc).isoformat()
                elif isinstance(pub_time, str):
                    published_at = pub_time

            items.append({
                "title": title,
                "link": link,
                "providerPublishTime": published_at,
            })

        return {"news": items}
    except Exception as e:
        logger.error(f"Failed to search news for {req.query}: {e}")
        return {"news": []}


# ========================================
# エントリーポイント
# ========================================

if __name__ == "__main__":
    port = int(os.environ.get("YFINANCE_PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
