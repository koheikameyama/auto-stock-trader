#!/usr/bin/env python3
"""
業績データを取得してDBに保存するスクリプト

yfinanceから損益計算書データを取得し、Stockテーブルの業績カラムを更新する。

全銘柄をROTATION_DAYS日（デフォルト7日）で取得できるよう、
銘柄数から動的に1日の取得数を計算。
earningsUpdatedAtがNULLまたは古い順に取得。

取得データ:
- latestRevenue: 直近通期売上高
- latestNetIncome: 直近通期純利益
- revenueGrowth: 売上高前年比（%）
- netIncomeGrowth: 純利益前年比（%）
- eps: 1株当たり利益（EPS）
- isProfitable: 黒字かどうか
- profitTrend: 'increasing' | 'decreasing' | 'stable'
"""

import math
import os
import sys
import time
from datetime import datetime

import psycopg2
import psycopg2.extras
import yfinance as yf

# scriptsディレクトリをPythonパスに追加
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.constants import EARNINGS_ROTATION_DAYS, EARNINGS_SLEEP_INTERVAL


def get_database_url() -> str:
    """データベースURLを取得"""
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("Error: DATABASE_URL environment variable not set")
        sys.exit(1)
    return url


def get_total_stock_count(conn) -> int:
    """全銘柄数を取得"""
    with conn.cursor() as cur:
        cur.execute('SELECT COUNT(*) FROM "Stock"')
        return cur.fetchone()[0]


def calculate_daily_limit(total_stocks: int, rotation_days: int) -> int:
    """1日の取得数を計算（全銘柄をrotation_days日で取得）"""
    return math.ceil(total_stocks / rotation_days)


def fetch_stocks_to_update(conn, limit: int) -> list[dict]:
    """更新が必要な銘柄を取得（earningsUpdatedAtがNULLまたは古い順）"""
    with conn.cursor() as cur:
        cur.execute('''
            SELECT id, "tickerCode", name
            FROM "Stock"
            ORDER BY
                CASE WHEN "earningsUpdatedAt" IS NULL THEN 0 ELSE 1 END,
                "earningsUpdatedAt" ASC NULLS FIRST
            LIMIT %s
        ''', (limit,))
        rows = cur.fetchall()

    return [{"id": row[0], "tickerCode": row[1], "name": row[2]} for row in rows]


def fetch_earnings_data(ticker_code: str) -> dict | None:
    """yfinanceから業績データを取得"""
    try:
        stock = yf.Ticker(ticker_code)
        income = stock.income_stmt

        if income is None or income.empty:
            return None

        # 直近2年分のデータを取得
        years = income.columns[:2] if len(income.columns) >= 2 else income.columns

        # 売上高（Total Revenue）
        latest_revenue = None
        prev_revenue = None
        if "Total Revenue" in income.index:
            latest_revenue = float(income.loc["Total Revenue", years[0]]) if len(years) > 0 else None
            prev_revenue = float(income.loc["Total Revenue", years[1]]) if len(years) > 1 else None

        # 純利益（Net Income）
        latest_net_income = None
        prev_net_income = None
        if "Net Income" in income.index:
            latest_net_income = float(income.loc["Net Income", years[0]]) if len(years) > 0 else None
            prev_net_income = float(income.loc["Net Income", years[1]]) if len(years) > 1 else None

        # EPS（1株当たり利益）- Basic EPSを優先、なければDiluted EPS
        eps = None
        if "Basic EPS" in income.index and len(years) > 0:
            try:
                eps = float(income.loc["Basic EPS", years[0]])
            except:
                pass
        if eps is None and "Diluted EPS" in income.index and len(years) > 0:
            try:
                eps = float(income.loc["Diluted EPS", years[0]])
            except:
                pass

        # 前年比計算
        revenue_growth = None
        if latest_revenue and prev_revenue and prev_revenue != 0:
            revenue_growth = ((latest_revenue - prev_revenue) / abs(prev_revenue)) * 100

        net_income_growth = None
        if latest_net_income and prev_net_income and prev_net_income != 0:
            net_income_growth = ((latest_net_income - prev_net_income) / abs(prev_net_income)) * 100

        # 黒字判定
        is_profitable = latest_net_income > 0 if latest_net_income is not None else None

        # トレンド判定
        profit_trend = None
        if net_income_growth is not None:
            if net_income_growth > 5:
                profit_trend = "increasing"
            elif net_income_growth < -5:
                profit_trend = "decreasing"
            else:
                profit_trend = "stable"

        # 次回決算発表日を取得（stock.calendar から）
        next_earnings_date = None
        try:
            calendar = stock.calendar
            if calendar is not None:
                if isinstance(calendar, dict) and "Earnings Date" in calendar:
                    dates = calendar["Earnings Date"]
                    if dates:
                        val = dates[0]
                        if hasattr(val, "date"):
                            next_earnings_date = val.date()
                        elif hasattr(val, "to_pydatetime"):
                            next_earnings_date = val.to_pydatetime().date()
                elif hasattr(calendar, "loc") and "Earnings Date" in calendar.index:
                    val = calendar.loc["Earnings Date"].iloc[0]
                    if hasattr(val, "date"):
                        next_earnings_date = val.date()
        except Exception:
            pass

        # 配当権利落ち日を取得（日本株ではデータの信頼性が低い場合あり）
        ex_dividend_date = None
        try:
            if calendar is not None:
                if isinstance(calendar, dict) and "Ex-Dividend Date" in calendar:
                    val = calendar["Ex-Dividend Date"]
                    if hasattr(val, "date"):
                        ex_dividend_date = val.date()
                    elif hasattr(val, "to_pydatetime"):
                        ex_dividend_date = val.to_pydatetime().date()
                elif hasattr(calendar, "loc") and "Ex-Dividend Date" in calendar.index:
                    val = calendar.loc["Ex-Dividend Date"]
                    if hasattr(val, "iloc"):
                        val = val.iloc[0]
                    if hasattr(val, "date"):
                        ex_dividend_date = val.date()
        except Exception:
            pass

        return {
            "latestRevenue": latest_revenue,
            "latestNetIncome": latest_net_income,
            "revenueGrowth": revenue_growth,
            "netIncomeGrowth": net_income_growth,
            "eps": eps,
            "isProfitable": is_profitable,
            "profitTrend": profit_trend,
            "nextEarningsDate": next_earnings_date,
            "exDividendDate": ex_dividend_date,
        }

    except Exception as e:
        # エラーは静かに処理（ログは出さない）
        return None


def update_earnings_data(conn, stock_id: str, data: dict | None):
    """業績データをDBに更新（データがない場合もearningsUpdatedAtを更新）"""
    with conn.cursor() as cur:
        if data:
            cur.execute('''
                UPDATE "Stock"
                SET
                    "latestRevenue" = %s,
                    "latestNetIncome" = %s,
                    "revenueGrowth" = %s,
                    "netIncomeGrowth" = %s,
                    "eps" = %s,
                    "isProfitable" = %s,
                    "profitTrend" = %s,
                    "nextEarningsDate" = %s,
                    "exDividendDate" = %s,
                    "earningsUpdatedAt" = NOW()
                WHERE id = %s
            ''', (
                data.get("latestRevenue"),
                data.get("latestNetIncome"),
                data.get("revenueGrowth"),
                data.get("netIncomeGrowth"),
                data.get("eps"),
                data.get("isProfitable"),
                data.get("profitTrend"),
                data.get("nextEarningsDate"),
                data.get("exDividendDate"),
                stock_id,
            ))
        else:
            # データがない場合もearningsUpdatedAtを更新（次のローテーションまでスキップ）
            cur.execute('''
                UPDATE "Stock"
                SET "earningsUpdatedAt" = NOW()
                WHERE id = %s
            ''', (stock_id,))


def main():
    rotation_days = EARNINGS_ROTATION_DAYS
    sleep_interval = EARNINGS_SLEEP_INTERVAL

    conn = psycopg2.connect(get_database_url())

    try:
        # 全銘柄数から1日の取得数を計算
        total_stocks = get_total_stock_count(conn)
        daily_limit = calculate_daily_limit(total_stocks, rotation_days)

        print("=" * 60)
        print("業績データの分散取得を開始")
        print(f"開始時刻: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"全銘柄数: {total_stocks}銘柄")
        print(f"ローテーション: {rotation_days}日")
        print(f"今日の取得数: {daily_limit}銘柄")
        print("=" * 60)

        # 更新が必要な銘柄を取得
        stocks = fetch_stocks_to_update(conn, daily_limit)
        print(f"\n対象銘柄数: {len(stocks)}")

        if not stocks:
            print("対象銘柄がありません（全て最新）")
            return

        success_count = 0
        no_data_count = 0
        error_count = 0
        start_time = time.time()

        for i, stock in enumerate(stocks):
            ticker = stock["tickerCode"]

            # 進捗表示（100件ごと）
            if i > 0 and i % 100 == 0:
                elapsed = time.time() - start_time
                rate = i / elapsed
                remaining = (len(stocks) - i) / rate / 60
                print(f"  進捗: {i}/{len(stocks)} ({i/len(stocks)*100:.0f}%) 残り約{remaining:.0f}分")

            # 業績データを取得
            data = fetch_earnings_data(ticker)

            # DBに更新
            try:
                update_earnings_data(conn, stock["id"], data)
                conn.commit()

                if data:
                    profitable = "黒" if data.get("isProfitable") else "赤"
                    print(f"[{i+1}] {ticker}: {profitable}")
                    success_count += 1
                else:
                    no_data_count += 1

            except Exception as e:
                print(f"[{i+1}] {ticker}: DB更新エラー - {e}")
                conn.rollback()
                error_count += 1

            # レート制限対策
            time.sleep(sleep_interval)

        elapsed_total = (time.time() - start_time) / 60

        print("\n" + "=" * 60)
        print(f"完了: 成功={success_count}, データなし={no_data_count}, エラー={error_count}")
        print(f"実行時間: {elapsed_total:.1f}分")
        print(f"終了時刻: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print("=" * 60)

        # 全員失敗した場合はエラー終了
        if success_count == 0 and no_data_count == 0 and error_count > 0:
            sys.exit(1)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
