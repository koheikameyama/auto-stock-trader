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
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, TypeVar

T = TypeVar("T")

import uvicorn
import yfinance as yf
from curl_cffi.requests import Session as CurlSession
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
# セッションプール（プロキシ対応）
# ========================================
#
# yfinance はデフォルトでシングルトンセッション（同一 Cookie）を使うため、
# rotation residential プロキシを使っても Yahoo 側から同一ユーザーに見える。
# → リクエストごとに独立した curl_cffi Session を渡し、Cookie を分離する。

PROXY = os.environ.get("YFINANCE_PROXY", "")
_SESSION_POOL_SIZE = 5

_session_pool: list[CurlSession] = []
_session_index = 0
_session_lock = threading.Lock()


def _create_session() -> CurlSession:
    """プロキシ付きの独立した curl_cffi Session を作成"""
    session = CurlSession(impersonate="chrome")
    if PROXY:
        session.proxies = {"http": PROXY, "https": PROXY}
    return session


def _init_session_pool() -> None:
    """セッションプールを初期化"""
    global _session_pool
    _session_pool = [_create_session() for _ in range(_SESSION_POOL_SIZE)]
    proxy_display = PROXY.split("@")[-1] if "@" in PROXY else PROXY
    if PROXY:
        logger.info(f"Session pool initialized: {_SESSION_POOL_SIZE} sessions, proxy={proxy_display}")
    else:
        logger.info(f"Session pool initialized: {_SESSION_POOL_SIZE} sessions, no proxy")


def get_session() -> CurlSession:
    """ラウンドロビンでセッションを取得（各セッションが独立した Cookie を持つ）"""
    global _session_index
    with _session_lock:
        session = _session_pool[_session_index % _SESSION_POOL_SIZE]
        _session_index += 1
    return session


def _refresh_all_sessions() -> None:
    """rate limit 時に全セッションを新しい Cookie で再作成する"""
    with _session_lock:
        for i in range(_SESSION_POOL_SIZE):
            _session_pool[i] = _create_session()
    logger.info(f"All {_SESSION_POOL_SIZE} sessions refreshed due to rate limit")


_init_session_pool()


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
_REQUEST_TIMEOUT_S = 30.0  # yfinance リクエストのタイムアウト（秒）


async def throttled(fn: Callable[[], T]) -> T:
    """Yahoo Finance へのリクエストを直列化し、リクエスト間に1秒ディレイを入れる"""
    async with _semaphore:
        loop = asyncio.get_event_loop()
        result: T = await asyncio.wait_for(
            loop.run_in_executor(None, fn),  # type: ignore[arg-type]
            timeout=_REQUEST_TIMEOUT_S,
        )
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
    """リトライ可能なエラーか判定（rate limit は除外 — TS 側のバックオフに委ねる）"""
    # rate limit はサイドカーではリトライしない
    if _is_rate_limit_error(e):
        return False
    # asyncio.wait_for によるタイムアウト
    if isinstance(e, (asyncio.TimeoutError, TimeoutError)):
        return True
    msg = str(e)
    # yfinance 内部のパースエラー（'str' object has no attribute 'get' 等）
    if "has no attribute" in msg:
        return True
    # ネットワーク系
    if any(code in msg for code in ("ConnectionError", "Timeout", "ReadTimeout")):
        return True
    return False


async def throttled_with_retry(fn: Callable[[], T]) -> T:
    """throttled + リトライ（yfinance 内部エラー対策）"""
    last_error: Exception | None = None
    for attempt in range(_RETRY_MAX + 1):
        try:
            return await throttled(fn)
        except Exception as e:
            last_error = e
            # rate limit → セッション入れ替えて即座に raise（TS 側のバックオフに委ねる）
            if _is_rate_limit_error(e):
                _refresh_all_sessions()
                raise
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
    if _is_rate_limit_error(e):
        return 429
    if isinstance(e, (asyncio.TimeoutError, TimeoutError)):
        return 504
    return 500


def _error_detail(e: Exception) -> str:
    """例外のエラーメッセージを返す（空なら型名を使う）"""
    msg = str(e)
    if msg:
        return msg
    return f"{type(e).__name__}: request timed out after {_REQUEST_TIMEOUT_S}s"


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
            session = get_session()
            ticker = yf.Ticker(symbol, session=session)
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
        raise HTTPException(status_code=_error_status(e), detail=_error_detail(e))


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
                session = get_session()
                ticker = yf.Ticker(s, session=session)
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


def _df_to_bars(df, *, require_positive_close: bool = False) -> list[dict]:
    """DataFrame を OHLCV バー一覧に変換する共通ヘルパー"""
    if df is None or df.empty:
        return []
    bars = []
    for date, row in df.iterrows():
        o = safe_float_or_none(row.get("Open"))
        h = safe_float_or_none(row.get("High"))
        l = safe_float_or_none(row.get("Low"))
        c = safe_float_or_none(row.get("Close"))
        if o is None or h is None or l is None or c is None:
            continue
        if require_positive_close and c <= 0:
            continue
        ts = date if hasattr(date, "strftime") else date[1] if isinstance(date, tuple) else date
        bars.append({
            "date": ts.strftime("%Y-%m-%d"),
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "volume": safe_float(row.get("Volume")),
        })
    return bars


@app.get("/historical")
async def get_historical(symbol: str, days: int = 200):
    """ヒストリカルOHLCVデータを取得"""
    symbol = normalize_ticker(symbol)
    try:
        def _fetch():
            session = get_session()
            df = yf.download(symbol, period=f"{days}d", interval="1d", progress=False, auto_adjust=True, session=session)
            return df

        df = await throttled_with_retry(_fetch)
        return _df_to_bars(df, require_positive_close=True)
    except Exception as e:
        logger.error(f"Failed to fetch historical data for {symbol}: {e}")
        raise HTTPException(status_code=_error_status(e), detail=_error_detail(e))


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
            session = get_session()
            df = yf.download(symbol, start=req.start, end=req.end, interval="1d", progress=False, auto_adjust=True, session=session)
            return df

        df = await throttled_with_retry(_fetch)
        return _df_to_bars(df)
    except Exception as e:
        logger.error(f"Failed to fetch historical range for {symbol}: {e}")
        raise HTTPException(status_code=_error_status(e), detail=_error_detail(e))


class HistoricalBatchRequest(BaseModel):
    symbols: list[str]
    start: str   # YYYY-MM-DD
    end: str     # YYYY-MM-DD


@app.post("/historical/batch")
async def get_historical_batch(req: HistoricalBatchRequest):
    """複数銘柄のヒストリカルデータを yf.download() で一括取得"""
    symbols = [normalize_ticker(s) for s in req.symbols]
    try:
        def _fetch():
            session = get_session()
            df = yf.download(symbols, start=req.start, end=req.end, interval="1d", progress=False, auto_adjust=True, group_by="ticker", session=session)
            return df

        df = await throttled_with_retry(_fetch)

        if df is None or df.empty:
            return {}

        result: dict[str, list[dict]] = {}

        if len(symbols) == 1:
            # 単一銘柄の場合、MultiIndex にならない
            result[symbols[0]] = _df_to_bars(df)
        else:
            for symbol in symbols:
                try:
                    symbol_df = df[symbol]
                    bars = _df_to_bars(symbol_df)
                    if bars:
                        result[symbol] = bars
                except KeyError:
                    logger.warning(f"No data for {symbol} in batch download")

        return result
    except Exception as e:
        logger.error(f"Failed to fetch historical batch: {e}")
        raise HTTPException(status_code=_error_status(e), detail=_error_detail(e))


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
    """市場指標データを yf.download() で一括取得"""
    symbols_list = list(MARKET_SYMBOLS.values())

    try:
        def _fetch():
            session = get_session()
            df = yf.download(symbols_list, period="5d", interval="1d", progress=False, auto_adjust=True, group_by="ticker", session=session)
            return df

        df = await throttled_with_retry(_fetch)

        result: dict[str, dict | None] = {}
        for key, symbol in MARKET_SYMBOLS.items():
            try:
                symbol_df = df[symbol] if len(symbols_list) > 1 else df
                # 直近の有効な2行を取得（当日 + 前日）
                valid = symbol_df.dropna(subset=["Close"])
                if valid.empty:
                    result[key] = None
                    continue

                last_row = valid.iloc[-1]
                price = safe_float(last_row.get("Close"))
                prev_close = safe_float(valid.iloc[-2].get("Close")) if len(valid) >= 2 else price
                change = price - prev_close if price and prev_close else 0.0
                change_pct = (change / prev_close * 100) if prev_close else 0.0

                result[key] = {
                    "price": price,
                    "previousClose": prev_close,
                    "change": round(change, 2),
                    "changePercent": round(change_pct, 4),
                }
            except Exception as e:
                logger.warning(f"Failed to parse market index {symbol} from batch: {e}")
                result[key] = None

        return result
    except Exception as e:
        logger.warning(f"Failed to fetch market data via yf.download: {e}")
        # フォールバック: 個別取得
        result: dict[str, dict | None] = {}
        for key, symbol in MARKET_SYMBOLS.items():
            try:
                def _fetch_single(s=symbol):
                    session = get_session()
                    ticker = yf.Ticker(s, session=session)
                    try:
                        info = ticker.info
                        if isinstance(info, dict):
                            return info
                    except Exception:
                        pass
                    return _build_info_from_fast_info(ticker)
                info = await throttled_with_retry(_fetch_single)
                result[key] = parse_index_quote_from_info(info)
            except Exception as inner_e:
                logger.warning(f"Failed to fetch market index {symbol}: {inner_e}")
                result[key] = None
        return result


@app.get("/events")
async def get_events(symbol: str):
    """コーポレートイベント情報を取得"""
    symbol = normalize_ticker(symbol)
    try:
        def _fetch():
            session = get_session()
            ticker = yf.Ticker(symbol, session=session)
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
            session = get_session()
            search = yf.Search(req.query, news_count=req.news_count, session=session)
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
