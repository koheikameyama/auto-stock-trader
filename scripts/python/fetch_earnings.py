#!/usr/bin/env python3
"""
業績データを取得するPythonスクリプト
yfinanceから損益計算書データを取得してJSON形式で出力
"""

import json
import os
import sys

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import yfinance as yf


def fetch_earnings(ticker_codes: list[str]) -> list[dict]:
    """複数銘柄の業績データを取得"""
    results = []

    for ticker_code in ticker_codes:
        try:
            stock = yf.Ticker(ticker_code)
            income = stock.income_stmt

            if income is None or income.empty:
                results.append({
                    "tickerCode": ticker_code,
                    "hasData": False,
                })
                continue

            # 直近2年分のデータを取得
            years = income.columns[:2] if len(income.columns) >= 2 else income.columns

            # 売上高
            latest_revenue = None
            prev_revenue = None
            if "Total Revenue" in income.index:
                latest_revenue = float(income.loc["Total Revenue", years[0]]) if len(years) > 0 else None
                prev_revenue = float(income.loc["Total Revenue", years[1]]) if len(years) > 1 else None

            # 純利益
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

            results.append({
                "tickerCode": ticker_code,
                "hasData": True,
                "latestRevenue": latest_revenue,
                "latestNetIncome": latest_net_income,
                "revenueGrowth": round(revenue_growth, 2) if revenue_growth else None,
                "netIncomeGrowth": round(net_income_growth, 2) if net_income_growth else None,
                "eps": round(eps, 2) if eps else None,
                "isProfitable": is_profitable,
                "profitTrend": profit_trend,
            })

        except Exception as e:
            results.append({
                "tickerCode": ticker_code,
                "hasData": False,
                "error": str(e),
            })

    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps([]))
        sys.exit(0)

    ticker_codes = sys.argv[1].split(",")
    results = fetch_earnings(ticker_codes)
    print(json.dumps(results))
