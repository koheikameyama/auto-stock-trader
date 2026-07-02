"""
指数連動 ETF の過去データを取得し Stock + StockDailyBar に保存（押し目戦略のサンプル拡張用）

米株ETF押し目パイロット (_us-etf-dip-backtest.ts) で RSI(2) 押し目にエッジを確認したが、
1547/1545 の2本ではサンプルが薄く WF の窓別判定が退化する。TOPIX/日経225/S&P500 の
多様な指数 ETF を足して WF を意味のある粒度にする。

一時利用 (`_` プレフィックス)。ローカルDBのみ書き込み。本番backfillスクリプトは別。
"""

import os
import sys
import time
import uuid

import yfinance as yf
import psycopg2
import psycopg2.extras

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("DATABASE_URL="):
                    DATABASE_URL = line.split("=", 1)[1].strip('"').strip("'")
                    break

if not DATABASE_URL:
    print("ERROR: DATABASE_URL が見つかりません")
    sys.exit(1)

# ローカルDB以外への書き込みを防ぐガード
if "localhost" not in DATABASE_URL and "127.0.0.1" not in DATABASE_URL:
    print(f"ERROR: 本番DBの可能性があるため中止 ({DATABASE_URL[:40]}...)")
    sys.exit(1)

# 指数連動 ETF (yfinance ticker, code, name) — TOPIX / 日経225 / S&P500 の多様な指数
INDEX_ETFS = [
    ("1306.T", "1306", "NEXT FUNDS TOPIX連動型上場投信", "東証プライム"),
    ("1321.T", "1321", "NEXT FUNDS 日経225連動型上場投信", "東証プライム"),
    ("1330.T", "1330", "上場インデックスファンド225", "東証プライム"),
    ("1348.T", "1348", "MAXIS トピックス上場投信", "東証プライム"),
    ("1475.T", "1475", "iシェアーズ・コア TOPIX ETF", "東証プライム"),
    ("2558.T", "2558", "MAXIS 米国株式(S&P500)上場投信", "東証プライム"),
    ("1655.T", "1655", "iシェアーズ S&P500 米国株 ETF", "東証プライム"),
]

START_DATE = "2018-01-01"
END_DATE = None


def upsert_stocks(conn):
    with conn.cursor() as cur:
        for _yf_ticker, code, name, market in INDEX_ETFS:
            cur.execute(
                """
                INSERT INTO "Stock" (id, "tickerCode", name, market, "isActive", "isDelisted", "isRestricted", "createdAt")
                VALUES (%s, %s, %s, %s, true, false, false, NOW())
                ON CONFLICT ("tickerCode") DO UPDATE SET name = EXCLUDED.name
                """,
                (str(uuid.uuid4()), code, name, market),
            )
        conn.commit()
    print(f"Stock UPSERT 完了 ({len(INDEX_ETFS)} ETFs)")


def fetch_and_insert(conn, yf_ticker, code):
    print(f"\n--- {yf_ticker} ({code}) ---")
    df = yf.download(yf_ticker, start=START_DATE, end=END_DATE, auto_adjust=True, progress=False)
    if df.empty:
        print("  データ取得失敗")
        return 0

    if hasattr(df.columns, "levels"):
        df.columns = [c[0] for c in df.columns]

    bars = []
    for idx, row in df.iterrows():
        dt = idx.to_pydatetime() if hasattr(idx, "to_pydatetime") else idx
        if hasattr(dt, "date"):
            dt = dt.date()
        o, h, l, c, v = row.get("Open"), row.get("High"), row.get("Low"), row.get("Close"), row.get("Volume")
        if all(x is not None and x == x for x in [o, h, l, c, v]):
            bars.append((str(uuid.uuid4()), code, dt, float(o), float(h), float(l), float(c), int(v), "JP"))

    print(f"  取得バー数: {len(bars)}")
    if not bars:
        return 0

    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO "StockDailyBar" (id, "tickerCode", date, open, high, low, close, volume, market)
            VALUES %s
            ON CONFLICT ("tickerCode", date) DO NOTHING
            """,
            bars,
            page_size=500,
        )
        inserted = cur.rowcount
    conn.commit()
    print(f"  INSERT: {inserted} 件")
    return inserted


def main():
    print("=" * 60, flush=True)
    print(f"指数ETF バックフィル: {START_DATE} 〜 today", flush=True)
    print("=" * 60, flush=True)

    conn = psycopg2.connect(DATABASE_URL, connect_timeout=30)
    upsert_stocks(conn)

    total = 0
    for yf_ticker, code, _name, _market in INDEX_ETFS:
        total += fetch_and_insert(conn, yf_ticker, code)
        time.sleep(1)

    print(f"\n合計 INSERT: {total:,} 件", flush=True)

    with conn.cursor() as cur:
        for _yf_ticker, code, _name, _market in INDEX_ETFS:
            cur.execute(
                'SELECT MIN(date), MAX(date), COUNT(*) FROM "StockDailyBar" WHERE "tickerCode" = %s',
                (code,),
            )
            min_d, max_d, cnt = cur.fetchone()
            print(f"  {code}: {min_d} 〜 {max_d} ({cnt} 件)", flush=True)

    conn.close()


if __name__ == "__main__":
    main()
