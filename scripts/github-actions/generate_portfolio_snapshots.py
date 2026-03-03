#!/usr/bin/env python3
"""
ポートフォリオスナップショットを記録するスクリプト

全ユーザーのポートフォリオ状態を日次で記録します。
取引時間終了後（15:30 JST以降）に実行を想定。
"""

import os
import sys
from datetime import datetime
from decimal import Decimal
from collections import defaultdict

import psycopg2
import psycopg2.extras
import yfinance as yf

# scriptsディレクトリをパスに追加
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib.date_utils import get_today_jst_date


def get_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("Error: DATABASE_URL environment variable not set")
        sys.exit(1)
    return url


def fetch_users_with_holdings(conn) -> list[str]:
    """保有銘柄があるユーザーIDを取得"""
    with conn.cursor() as cur:
        cur.execute('''
            SELECT DISTINCT t."userId"
            FROM "Transaction" t
            GROUP BY t."userId", t."stockId"
            HAVING SUM(CASE WHEN t.type = 'buy' THEN t.quantity ELSE -t.quantity END) > 0
        ''')
        return [row[0] for row in cur.fetchall()]


def calculate_holdings_from_transactions(transactions: list[dict]) -> tuple[int, Decimal]:
    """
    トランザクション一覧から保有数量と平均取得単価を計算
    - 買い: 数量を加算、コストを加算
    - 売り: 数量を減算、コストを按分で減算（平均取得単価分）
    """
    total_quantity = 0
    total_cost = Decimal("0")

    for tx in transactions:
        price = Decimal(str(tx["price"]))
        quantity = tx["quantity"]

        if tx["type"] == "buy":
            total_cost += price * quantity
            total_quantity += quantity
        elif tx["type"] == "sell":
            if total_quantity > 0:
                avg_price = total_cost / total_quantity
                total_cost -= avg_price * quantity
                total_quantity -= quantity

    avg_price = total_cost / total_quantity if total_quantity > 0 else Decimal("0")
    return max(0, total_quantity), avg_price


def fetch_user_holdings(conn, user_ids: list[str]) -> tuple[dict, dict[str, Decimal]]:
    """
    ユーザーごとの保有銘柄情報と累計確定損益を一括取得
    N+1問題を避けるため、全ユーザーのデータを一括取得

    Returns:
        (holdings, realized_gains):
            holdings: ユーザーID → 保有銘柄リスト
            realized_gains: ユーザーID → 累計確定損益
    """
    if not user_ids:
        return {}, {}

    with conn.cursor() as cur:
        # トランザクションを時系列順で取得
        cur.execute('''
            SELECT
                t."userId",
                t."stockId",
                t.type,
                t.quantity,
                t.price,
                t."transactionDate",
                s.name,
                s."tickerCode",
                s.sector,
                s."latestPrice",
                t."totalAmount"
            FROM "Transaction" t
            JOIN "Stock" s ON t."stockId" = s.id
            WHERE t."userId" = ANY(%s)
            ORDER BY t."userId", t."stockId", t."transactionDate" ASC
        ''', (user_ids,))

        # ユーザー・銘柄ごとにトランザクションをグループ化
        user_stock_transactions = defaultdict(lambda: defaultdict(list))
        stock_info = {}

        for row in cur.fetchall():
            user_id = row[0]
            stock_id = row[1]
            user_stock_transactions[user_id][stock_id].append({
                "type": row[2],
                "quantity": row[3],
                "price": row[4],
                "totalAmount": Decimal(str(row[10])) if row[10] else Decimal("0"),
            })
            # 銘柄情報を保存（最後のものが使われる）
            stock_info[stock_id] = {
                "name": row[6],
                "tickerCode": row[7],
                "sector": row[8] or "その他",
                "latestPrice": Decimal(str(row[9])) if row[9] else Decimal("0"),
            }

        # 各ユーザー・銘柄の保有状況を計算
        holdings = defaultdict(list)
        realized_gains: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))

        for user_id, stocks in user_stock_transactions.items():
            for stock_id, transactions in stocks.items():
                quantity, avg_price = calculate_holdings_from_transactions(transactions)
                if quantity > 0:
                    info = stock_info[stock_id]
                    holdings[user_id].append({
                        "stockId": stock_id,
                        "name": info["name"],
                        "tickerCode": info["tickerCode"],
                        "sector": info["sector"],
                        "latestPrice": info["latestPrice"],
                        "quantity": quantity,
                        "avgPrice": avg_price,
                    })
                elif quantity == 0:
                    # 売却済み銘柄: 確定損益を計算（売却総額 - 購入総額）
                    buy_txs = [t for t in transactions if t["type"] == "buy"]
                    sell_txs = [t for t in transactions if t["type"] == "sell"]
                    if buy_txs and sell_txs:
                        total_buy = sum(t["totalAmount"] for t in buy_txs)
                        total_sell = sum(t["totalAmount"] for t in sell_txs)
                        realized_gains[user_id] += total_sell - total_buy

        return dict(holdings), dict(realized_gains)


def calculate_snapshot(holdings: list[dict]) -> dict:
    """保有銘柄情報からスナップショットを計算"""
    total_value = Decimal("0")
    total_cost = Decimal("0")
    stock_breakdown = []
    sector_totals = defaultdict(Decimal)

    for h in holdings:
        current_value = h["latestPrice"] * h["quantity"]
        cost = h["avgPrice"] * h["quantity"]

        total_value += current_value
        total_cost += cost
        sector_totals[h["sector"]] += current_value

        stock_breakdown.append({
            "stockId": h["stockId"],
            "name": h["name"],
            "tickerCode": h["tickerCode"],
            "sector": h["sector"],
            "value": float(current_value),
            "cost": float(cost),
        })

    # 構成比率を計算
    if total_value > 0:
        for item in stock_breakdown:
            item["percent"] = round(float(Decimal(str(item["value"])) / total_value * 100), 2)

    # セクター別内訳
    sector_breakdown = []
    for sector, value in sector_totals.items():
        percent = round(float(value / total_value * 100), 2) if total_value > 0 else 0
        sector_breakdown.append({
            "sector": sector,
            "value": float(value),
            "percent": percent,
        })

    # 値でソート（降順）
    stock_breakdown.sort(key=lambda x: x["value"], reverse=True)
    sector_breakdown.sort(key=lambda x: x["value"], reverse=True)

    unrealized_gain = total_value - total_cost
    gain_percent = (unrealized_gain / total_cost * 100) if total_cost > 0 else Decimal("0")

    return {
        "totalValue": total_value,
        "totalCost": total_cost,
        "unrealizedGain": unrealized_gain,
        "unrealizedGainPercent": gain_percent,
        "stockCount": len(holdings),
        "stockBreakdown": stock_breakdown,
        "sectorBreakdown": sector_breakdown,
    }


def upsert_snapshots(conn, snapshots: list[dict], date: datetime):
    """スナップショットをバッチでUPSERT"""
    if not snapshots:
        return 0

    import json

    values = []
    for s in snapshots:
        values.append((
            s["userId"],
            date,
            float(s["totalValue"]),
            float(s["totalCost"]),
            float(s["unrealizedGain"]),
            float(s["unrealizedGainPercent"]),
            s["stockCount"],
            json.dumps(s["sectorBreakdown"], ensure_ascii=False),
            json.dumps(s["stockBreakdown"], ensure_ascii=False),
            float(s["nikkeiClose"]) if s.get("nikkeiClose") is not None else None,
            float(s["realizedGain"]) if s.get("realizedGain") is not None else None,
            float(s["sp500Close"]) if s.get("sp500Close") is not None else None,
        ))

    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            '''
            INSERT INTO "PortfolioSnapshot" (
                "id", "userId", "date", "totalValue", "totalCost",
                "unrealizedGain", "unrealizedGainPercent", "stockCount",
                "sectorBreakdown", "stockBreakdown", "nikkeiClose", "realizedGain",
                "sp500Close", "createdAt"
            )
            VALUES %s
            ON CONFLICT ("userId", "date") DO UPDATE SET
                "totalValue" = EXCLUDED."totalValue",
                "totalCost" = EXCLUDED."totalCost",
                "unrealizedGain" = EXCLUDED."unrealizedGain",
                "unrealizedGainPercent" = EXCLUDED."unrealizedGainPercent",
                "stockCount" = EXCLUDED."stockCount",
                "sectorBreakdown" = EXCLUDED."sectorBreakdown",
                "stockBreakdown" = EXCLUDED."stockBreakdown",
                "nikkeiClose" = EXCLUDED."nikkeiClose",
                "realizedGain" = EXCLUDED."realizedGain",
                "sp500Close" = EXCLUDED."sp500Close"
            ''',
            values,
            template='''(
                gen_random_uuid()::text, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, NOW()
            )''',
            page_size=100
        )
        conn.commit()

    return len(values)


def fetch_nikkei_close() -> float | None:
    """日経225の最新終値を取得"""
    try:
        ticker = yf.Ticker("^N225")
        hist = ticker.history(period="5d")
        if hist.empty:
            print("Warning: Nikkei 225 data not available")
            return None
        close = float(hist["Close"].iloc[-1])
        print(f"Nikkei 225 close: ¥{close:,.0f}")
        return close
    except Exception as e:
        print(f"Warning: Failed to fetch Nikkei 225: {e}")
        return None


def fetch_sp500_close() -> float | None:
    """S&P 500の最新終値を取得"""
    try:
        ticker = yf.Ticker("^GSPC")
        hist = ticker.history(period="5d")
        if hist.empty:
            print("Warning: S&P 500 data not available")
            return None
        close = float(hist["Close"].iloc[-1])
        print(f"S&P 500 close: ${close:,.2f}")
        return close
    except Exception as e:
        print(f"Warning: Failed to fetch S&P 500: {e}")
        return None


def main():
    print("=" * 60)
    print("Portfolio Snapshot Generation")
    print("=" * 60)
    print(f"Time: {datetime.now().isoformat()}")

    conn = psycopg2.connect(get_database_url())
    today = get_today_jst_date()
    print(f"Snapshot date: {today}")

    try:
        # 0. ベンチマーク終値を取得（全ユーザー共通）
        nikkei_close = fetch_nikkei_close()
        sp500_close = fetch_sp500_close()

        # 1. 保有銘柄があるユーザーを取得
        user_ids = fetch_users_with_holdings(conn)
        print(f"Found {len(user_ids)} users with holdings")

        if not user_ids:
            print("No users with holdings. Exiting.")
            return

        # 2. 全ユーザーの保有情報と確定損益を一括取得
        all_holdings, realized_gains = fetch_user_holdings(conn, user_ids)
        print(f"Fetched holdings for {len(all_holdings)} users")

        # 3. 各ユーザーのスナップショットを計算
        snapshots = []
        for user_id, holdings in all_holdings.items():
            snapshot = calculate_snapshot(holdings)
            snapshot["userId"] = user_id
            snapshot["nikkeiClose"] = nikkei_close
            snapshot["sp500Close"] = sp500_close
            snapshot["realizedGain"] = realized_gains.get(user_id, Decimal("0"))
            snapshots.append(snapshot)
            print(f"  User {user_id[:8]}...: {snapshot['stockCount']} stocks, ¥{float(snapshot['totalValue']):,.0f}")

        # 4. バッチでUPSERT
        count = upsert_snapshots(conn, snapshots, today)

        print("=" * 60)
        print(f"SUCCESS: {count} snapshots saved")
        print("=" * 60)

    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
