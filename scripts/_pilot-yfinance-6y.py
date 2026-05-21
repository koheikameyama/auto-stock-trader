"""
yfinance パイロット試験: 5銘柄 × 6年 (2018-2023) のデータ品質確認

- 期間カバレッジ
- 株式分割イベントの検出と価格調整の妥当性
- 既存本番データ (2024-02 以降) との突合

DB INSERT は行わない (read-only 品質確認のみ)
"""

import os
import sys
from datetime import datetime

import yfinance as yf
import pandas as pd
import psycopg2

DATABASE_URL = os.getenv("DATABASE_URL")

TICKERS = [
    ("7203.T", "トヨタ"),
    ("6758.T", "ソニー"),
    ("4063.T", "信越化学"),
    ("9433.T", "KDDI"),
    ("7974.T", "任天堂"),  # 2022/10 10株分割イベントあり
]

START = "2018-01-01"
END = "2024-02-28"


def fetch_and_report(ticker: str, name: str) -> dict:
    print(f"\n{'=' * 60}")
    print(f"  {ticker}  {name}")
    print(f"{'=' * 60}")

    # 期間取得 (auto_adjust=True で配当・分割を反映した close を使う)
    df = yf.download(ticker, start=START, end=END, auto_adjust=True, progress=False)
    if df.empty:
        print(f"  ❌ データ取得失敗")
        return {"ticker": ticker, "ok": False}

    # MultiIndex の場合は flatten
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]

    print(f"  期間: {df.index.min().date()} 〜 {df.index.max().date()}")
    print(f"  総営業日数: {len(df)}")

    # 年別カバレッジ
    print(f"  年別:")
    for year in sorted(df.index.year.unique()):
        ydf = df[df.index.year == year]
        close_min = float(ydf["Close"].min())
        close_max = float(ydf["Close"].max())
        print(f"    {year}: {len(ydf):3d}日 / Close ¥{close_min:>8,.0f} - ¥{close_max:>8,.0f}")

    # 株式分割・配当イベント
    t = yf.Ticker(ticker)
    try:
        actions = t.actions
        if actions is not None and not actions.empty:
            splits = actions[actions["Stock Splits"] != 0]
            divs = actions[actions["Dividends"] != 0]
            in_period_splits = splits[(splits.index.date >= datetime.strptime(START, "%Y-%m-%d").date()) & (splits.index.date <= datetime.strptime(END, "%Y-%m-%d").date())]
            in_period_divs = divs[(divs.index.date >= datetime.strptime(START, "%Y-%m-%d").date()) & (divs.index.date <= datetime.strptime(END, "%Y-%m-%d").date())]
            if len(in_period_splits) > 0:
                print(f"  株式分割イベント (期間内):")
                for date, row in in_period_splits.iterrows():
                    ratio = row["Stock Splits"]
                    print(f"    {date.date()}: {ratio}x")
            else:
                print(f"  株式分割: なし")
            print(f"  配当: {len(in_period_divs)}回 (期間内)")
    except Exception as e:
        print(f"  ⚠️ actions 取得失敗: {e}")

    # 欠損確認 (5営業日連続欠損が無いか)
    df_sorted = df.sort_index()
    gap_days = []
    prev = None
    for d in df_sorted.index:
        if prev is not None:
            diff = (d - prev).days
            if diff > 5:  # 週末2日除いても3営業日以上の欠損
                gap_days.append((prev.date(), d.date(), diff))
        prev = d
    if gap_days:
        print(f"  ⚠️ 5日以上の欠損ギャップ {len(gap_days)}件 (最大3件表示):")
        for s, e, diff in gap_days[:3]:
            print(f"    {s} → {e} ({diff}日)")

    return {
        "ticker": ticker,
        "ok": True,
        "rows": len(df),
        "from": df.index.min().date(),
        "to": df.index.max().date(),
        "close_last": float(df["Close"].iloc[-1]),
    }


def check_overlap_with_db(ticker: str, expected_last_close: float):
    """既存本番データと突合: 2024-02-XX 付近の終値が yfinance と本番DBで一致するか"""
    if not DATABASE_URL:
        print(f"    DATABASE_URL なし、突合スキップ")
        return
    code = ticker.replace(".T", "")
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT date, close FROM "StockDailyBar"
                WHERE "tickerCode" = %s AND market = 'JP'
                ORDER BY date ASC LIMIT 1
                """,
                (code,),
            )
            row = cur.fetchone()
            if row:
                db_date, db_close = row
                print(f"    DB最古: {db_date} close ¥{float(db_close):,.0f}")
                # yfinance で同じ日付の close を取得
                t = yf.Ticker(ticker)
                hist = t.history(start=str(db_date), end=str(db_date) + " 00:00:00", auto_adjust=True)
                if not hist.empty:
                    yf_close = float(hist["Close"].iloc[0])
                    diff_pct = abs(yf_close - float(db_close)) / float(db_close) * 100
                    sign = "✓" if diff_pct < 1.0 else "⚠️"
                    print(f"    yf 同日: close ¥{yf_close:,.0f} ({sign} 乖離 {diff_pct:.2f}%)")
        conn.close()
    except Exception as e:
        print(f"    DB突合エラー: {e}")


def main():
    print("=" * 60)
    print(f"yfinance パイロット試験: {START} 〜 {END}")
    print("=" * 60)

    results = []
    for ticker, name in TICKERS:
        r = fetch_and_report(ticker, name)
        if r["ok"]:
            print(f"  本番DB突合:")
            check_overlap_with_db(ticker, r["close_last"])
        results.append(r)

    print(f"\n{'=' * 60}")
    print("サマリー")
    print(f"{'=' * 60}")
    ok = [r for r in results if r["ok"]]
    print(f"取得成功: {len(ok)}/{len(results)}")
    for r in ok:
        print(f"  {r['ticker']}: {r['from']} 〜 {r['to']} ({r['rows']} 行)")


if __name__ == "__main__":
    main()
