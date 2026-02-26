#!/usr/bin/env python3
"""
株価アラートチェックスクリプト

ポートフォリオ・ウォッチリストの銘柄を監視し、条件達成時に通知を送信する。

通知トリガー:
- 急騰（+5%以上）：ポートフォリオ
- 急落（-5%以下）：ポートフォリオ
- 指値到達（ポートフォリオ）
- 逆指値到達（ストップロス）
- 買い時到達（ウォッチリスト）
"""

import json
import os
import sys
import logging
from decimal import Decimal
import psycopg2
import requests

# scriptsディレクトリをPythonパスに追加
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.constants import SURGE_THRESHOLD, PLUNGE_THRESHOLD, PROFIT_MILESTONES

# ロギング設定
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def get_env_variable(name: str, required: bool = True) -> str | None:
    """環境変数を取得"""
    value = os.environ.get(name)
    if required and not value:
        logger.error(f"Error: {name} environment variable not set")
        sys.exit(1)
    return value


def fetch_latest_stock_analyses(conn, stock_ids: list[str]) -> dict[str, dict]:
    """最新のStockAnalysisのstyleAnalysesを一括取得"""
    if not stock_ids:
        return {}
    with conn.cursor() as cur:
        cur.execute('''
            SELECT DISTINCT ON ("stockId")
                "stockId", "styleAnalyses"
            FROM "StockAnalysis"
            WHERE "stockId" = ANY(%s)
              AND "styleAnalyses" IS NOT NULL
            ORDER BY "stockId", "analyzedAt" DESC
        ''', (stock_ids,))
        rows = cur.fetchall()
    result = {}
    for row in rows:
        if row[1]:
            result[row[0]] = row[1] if isinstance(row[1], dict) else json.loads(row[1])
    return result


def fetch_portfolio_surge_plunge_alerts(conn, surge_threshold: float, plunge_threshold: float) -> list[dict]:
    """
    ポートフォリオ銘柄の急騰・急落アラートをチェック

    条件:
    - 急騰: dailyChangeRate >= surge_threshold
    - 急落: dailyChangeRate <= plunge_threshold
    - 保有株数 > 0
    """
    alerts = []

    with conn.cursor() as cur:
        cur.execute('''
            SELECT
                p."userId",
                s.id as "stockId",
                s.name as "stockName",
                s."tickerCode",
                s."latestPrice",
                s."dailyChangeRate",
                COALESCE(
                    (SELECT SUM(
                        CASE WHEN t.type = 'buy' THEN t.quantity
                             WHEN t.type = 'sell' THEN -t.quantity
                             ELSE 0
                        END
                    )
                    FROM "Transaction" t
                    WHERE t."portfolioStockId" = p.id
                    ), 0
                ) as "totalQuantity",
                p.id as "userStockId"
            FROM "PortfolioStock" p
            JOIN "Stock" s ON p."stockId" = s.id
            WHERE s."dailyChangeRate" IS NOT NULL
              AND (s."dailyChangeRate" >= %s OR s."dailyChangeRate" <= %s)
        ''', (surge_threshold, plunge_threshold))

        for row in cur.fetchall():
            total_quantity = row[6] or 0
            if total_quantity <= 0:
                continue  # 保有なしはスキップ

            change_rate = float(row[5]) if row[5] else 0
            alert_type = "surge" if change_rate >= surge_threshold else "plunge"

            alerts.append({
                "userId": row[0],
                "stockId": row[1],
                "stockName": row[2],
                "tickerCode": row[3],
                "latestPrice": float(row[4]) if row[4] else None,
                "changeRate": change_rate,
                "type": alert_type,
                "userStockId": row[7],
            })

    return alerts


def fetch_portfolio_sell_target_alerts(conn) -> list[dict]:
    """
    ポートフォリオ銘柄の売却目標到達アラートをチェック

    ユーザーが targetReturnRate を設定している銘柄のみ対象。
    → 平均取得単価 * (1 + targetReturnRate/100) を目標価格とする。
    AIの suggestedSellPrice は参考情報のため通知には使用しない。

    条件: 現在価格 >= 目標価格 かつ 保有株数 > 0
    """
    alerts = []

    with conn.cursor() as cur:
        cur.execute('''
            SELECT
                p."userId",
                s.id as "stockId",
                s.name as "stockName",
                s."tickerCode",
                s."latestPrice",
                us."targetReturnRate",
                COALESCE(
                    (SELECT SUM(
                        CASE WHEN t.type = 'buy' THEN t.quantity
                             WHEN t.type = 'sell' THEN -t.quantity
                             ELSE 0
                         END
                    )
                    FROM "Transaction" t
                    WHERE t."portfolioStockId" = p.id
                    ), 0
                ) as "totalQuantity",
                COALESCE(
                    (SELECT SUM(t.quantity * t.price) / NULLIF(SUM(t.quantity), 0)
                    FROM "Transaction" t
                    WHERE t."portfolioStockId" = p.id AND t.type = 'buy'
                    ), 0
                ) as "averageCost",
                p.id as "userStockId",
                us."investmentStyle"
            FROM "PortfolioStock" p
            JOIN "Stock" s ON p."stockId" = s.id
            LEFT JOIN "UserSettings" us ON us."userId" = p."userId"
            WHERE s."latestPrice" IS NOT NULL
              AND us."targetReturnRate" IS NOT NULL
        ''')

        for row in cur.fetchall():
            total_quantity = row[6] or 0
            if total_quantity <= 0:
                continue  # 保有なしはスキップ

            latest_price = float(row[4]) if row[4] else 0
            user_target_rate = float(row[5]) if row[5] else None
            average_cost = float(row[7]) if row[7] else 0
            user_stock_id = row[8]
            investment_style = row[9] or "BALANCED"

            # ユーザー設定がない場合はスキップ（AIフォールバックなし）
            if user_target_rate is None or average_cost <= 0:
                continue

            # 目標価格 = 平均取得単価 * (1 + targetReturnRate/100)
            target_price = average_cost * (1 + user_target_rate / 100)

            # 現在価格が目標価格以上なら通知
            if latest_price >= target_price:
                gain_percent = ((latest_price - average_cost) / average_cost) * 100

                alerts.append({
                    "userId": row[0],
                    "stockId": row[1],
                    "stockName": row[2],
                    "tickerCode": row[3],
                    "latestPrice": latest_price,
                    "targetPrice": target_price,
                    "averageCost": average_cost,
                    "gainPercent": gain_percent,
                    "type": "sell_target",
                    "userStockId": user_stock_id,
                    "investmentStyle": investment_style,
                })

    return alerts


def fetch_portfolio_stop_loss_alerts(conn) -> list[dict]:
    """
    ポートフォリオ銘柄の逆指値（ストップロス）アラートをチェック

    ユーザーが stopLossRate を設定している銘柄のみ対象。
    → 平均取得単価 * (1 + stopLossRate/100) を逆指値価格とする。
    AIの StockAnalysis.stopLossPrice は参考情報のため通知には使用しない。

    条件: 現在価格 <= 逆指値価格 かつ 保有株数 > 0
    例: 取得単価1000円、stopLossRate=-10% → 逆指値900円
    """
    alerts = []

    with conn.cursor() as cur:
        cur.execute('''
            SELECT
                p."userId",
                s.id as "stockId",
                s.name as "stockName",
                s."tickerCode",
                s."latestPrice",
                us."stopLossRate",
                COALESCE(
                    (SELECT SUM(
                        CASE WHEN t.type = 'buy' THEN t.quantity
                             WHEN t.type = 'sell' THEN -t.quantity
                             ELSE 0
                         END
                    )
                    FROM "Transaction" t
                    WHERE t."portfolioStockId" = p.id
                    ), 0
                ) as "totalQuantity",
                COALESCE(
                    (SELECT SUM(t.quantity * t.price) / NULLIF(SUM(t.quantity), 0)
                    FROM "Transaction" t
                    WHERE t."portfolioStockId" = p.id AND t.type = 'buy'
                    ), 0
                ) as "averageCost",
                p.id as "userStockId",
                us."investmentStyle"
            FROM "PortfolioStock" p
            JOIN "Stock" s ON p."stockId" = s.id
            LEFT JOIN "UserSettings" us ON us."userId" = p."userId"
            WHERE s."latestPrice" IS NOT NULL
              AND us."stopLossRate" IS NOT NULL
        ''')

        for row in cur.fetchall():
            total_quantity = row[6] or 0
            if total_quantity <= 0:
                continue  # 保有なしはスキップ

            latest_price = float(row[4]) if row[4] else 0
            user_stop_loss_rate = float(row[5]) if row[5] else None
            average_cost = float(row[7]) if row[7] else 0
            user_stock_id = row[8]
            investment_style = row[9] or "BALANCED"

            # ユーザー設定がない場合はスキップ（AIフォールバックなし）
            if user_stop_loss_rate is None or average_cost <= 0:
                continue

            # 逆指値価格 = 平均取得単価 * (1 + stopLossRate/100)
            stop_loss_price = average_cost * (1 + user_stop_loss_rate / 100)

            # 現在価格が逆指値以下なら通知
            if latest_price <= stop_loss_price:
                loss_percent = ((latest_price - average_cost) / average_cost) * 100

                alerts.append({
                    "userId": row[0],
                    "stockId": row[1],
                    "stockName": row[2],
                    "tickerCode": row[3],
                    "latestPrice": latest_price,
                    "stopLossPrice": stop_loss_price,
                    "averageCost": average_cost,
                    "lossPercent": loss_percent,
                    "type": "stop_loss",
                    "userStockId": user_stock_id,
                    "investmentStyle": investment_style,
                })

    return alerts


def fetch_watchlist_buy_target_alerts(conn) -> list[dict]:
    """
    ウォッチリスト銘柄の買い時到達アラートをチェック

    条件:
    - ユーザーが targetBuyPrice を設定している
    - 現在価格 <= 目標買値

    AIの買い判断（PurchaseRecommendation.recommendation）も取得し、通知メッセージを分岐させる
    """
    alerts = []

    with conn.cursor() as cur:
        cur.execute('''
            SELECT
                w."userId",
                s.id as "stockId",
                s.name as "stockName",
                s."tickerCode",
                s."latestPrice",
                w."targetBuyPrice",
                pr.recommendation,
                w.id as "watchlistStockId"
            FROM "WatchlistStock" w
            JOIN "Stock" s ON w."stockId" = s.id
            LEFT JOIN LATERAL (
                SELECT recommendation
                FROM "PurchaseRecommendation"
                WHERE "stockId" = s.id
                ORDER BY date DESC
                LIMIT 1
            ) pr ON true
            WHERE s."latestPrice" IS NOT NULL
              AND w."targetBuyPrice" IS NOT NULL
        ''')

        for row in cur.fetchall():
            latest_price = float(row[4]) if row[4] else 0
            user_target_price = float(row[5]) if row[5] else None
            purchase_recommendation = row[6]  # "buy" or "stay"
            watchlist_stock_id = row[7]

            if user_target_price is None:
                continue

            target_price = user_target_price

            # 現在価格が目標買値以下なら通知
            if latest_price <= target_price:
                discount_percent = ((target_price - latest_price) / target_price) * 100 if target_price > 0 else 0

                alerts.append({
                    "userId": row[0],
                    "stockId": row[1],
                    "stockName": row[2],
                    "tickerCode": row[3],
                    "latestPrice": latest_price,
                    "targetPrice": target_price,
                    "discountPercent": discount_percent,
                    "purchaseRecommendation": purchase_recommendation,
                    "type": "buy_target",
                    "watchlistStockId": watchlist_stock_id,
                })

    return alerts


def fetch_portfolio_profit_milestone_alerts(conn, milestones: list[int]) -> list[dict]:
    """
    ポートフォリオ銘柄の利確マイルストーン通知をチェック

    条件:
    - 保有株数 > 0
    - 含み益率が milestones のいずれかを達成（最大のマイルストーンを通知）
    """
    alerts = []

    with conn.cursor() as cur:
        cur.execute('''
            SELECT
                p."userId",
                s.id as "stockId",
                s.name as "stockName",
                s."tickerCode",
                s."latestPrice",
                COALESCE(
                    (SELECT SUM(
                        CASE WHEN t.type = 'buy' THEN t.quantity
                             WHEN t.type = 'sell' THEN -t.quantity
                             ELSE 0
                         END
                    )
                    FROM "Transaction" t
                    WHERE t."portfolioStockId" = p.id
                    ), 0
                ) as "totalQuantity",
                COALESCE(
                    (SELECT SUM(t.quantity * t.price) / NULLIF(SUM(t.quantity), 0)
                    FROM "Transaction" t
                    WHERE t."portfolioStockId" = p.id AND t.type = 'buy'
                    ), 0
                ) as "averageCost",
                p.id as "userStockId",
                us."investmentStyle"
            FROM "PortfolioStock" p
            JOIN "Stock" s ON p."stockId" = s.id
            LEFT JOIN "UserSettings" us ON us."userId" = p."userId"
            WHERE s."latestPrice" IS NOT NULL
        ''')

        for row in cur.fetchall():
            total_quantity = row[5] or 0
            if total_quantity <= 0:
                continue

            latest_price = float(row[4]) if row[4] else 0
            average_cost = float(row[6]) if row[6] else 0
            user_stock_id = row[7]
            investment_style = row[8] or "BALANCED"

            if average_cost <= 0:
                continue

            profit_percent = ((latest_price - average_cost) / average_cost) * 100

            # 到達している最大のマイルストーンを判定
            hit_milestone = None
            for m in sorted(milestones, reverse=True):
                if profit_percent >= m:
                    hit_milestone = m
                    break

            if hit_milestone is not None:
                alerts.append({
                    "userId": row[0],
                    "stockId": row[1],
                    "stockName": row[2],
                    "tickerCode": row[3],
                    "latestPrice": latest_price,
                    "averageCost": average_cost,
                    "profitPercent": profit_percent,
                    "milestone": hit_milestone,
                    "userStockId": user_stock_id,
                    "investmentStyle": investment_style,
                })

    return alerts


def send_notifications(app_url: str, cron_secret: str, notifications: list[dict]) -> dict:
    """通知APIを呼び出し"""
    if not notifications:
        return {"created": 0, "pushSent": 0, "skipped": 0, "errors": []}

    api_url = f"{app_url}/api/notifications/send"
    headers = {
        "Authorization": f"Bearer {cron_secret}",
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(
            api_url,
            json={"notifications": notifications},
            headers=headers,
            timeout=60
        )

        if not response.ok:
            logger.error(f"API returned {response.status_code}: {response.text}")
            return {"created": 0, "pushSent": 0, "skipped": 0, "errors": [response.text]}

        return response.json()
    except Exception as e:
        logger.error(f"Failed to call notification API: {e}")
        return {"created": 0, "pushSent": 0, "skipped": 0, "errors": [str(e)]}


def main():
    logger.info("=" * 60)
    logger.info("Price Alert Checker")
    logger.info("=" * 60)

    db_url = get_env_variable("DATABASE_URL")
    app_url = get_env_variable("APP_URL")
    cron_secret = get_env_variable("CRON_SECRET")

    conn = psycopg2.connect(db_url)

    try:
        notifications = []

        # 1. ポートフォリオ: 急騰・急落
        logger.info("Checking portfolio surge/plunge alerts...")
        surge_plunge_alerts = fetch_portfolio_surge_plunge_alerts(
            conn,
            SURGE_THRESHOLD,
            PLUNGE_THRESHOLD
        )
        logger.info(f"  Found {len(surge_plunge_alerts)} portfolio surge/plunge alerts")

        for alert in surge_plunge_alerts:
            if alert["type"] == "surge":
                notifications.append({
                    "userId": alert["userId"],
                    "type": "surge",
                    "stockId": alert["stockId"],
                    "title": f"📈 {alert['stockName']}が急騰中",
                    "body": f"本日 +{alert['changeRate']:.1f}% 上昇しています（{alert['latestPrice']:,.0f}円）",
                    "url": f"/my-stocks/{alert['userStockId']}",
                    "triggerPrice": alert["latestPrice"],
                    "changeRate": alert["changeRate"],
                })
            elif alert["type"] == "plunge":
                notifications.append({
                    "userId": alert["userId"],
                    "type": "plunge",
                    "stockId": alert["stockId"],
                    "title": f"📉 {alert['stockName']}が急落中",
                    "body": f"本日 {alert['changeRate']:.1f}% 下落しています（{alert['latestPrice']:,.0f}円）",
                    "url": f"/my-stocks/{alert['userStockId']}",
                    "triggerPrice": alert["latestPrice"],
                    "changeRate": alert["changeRate"],
                })

        # 2. ポートフォリオ: 指値到達
        logger.info("Checking portfolio sell target alerts...")
        sell_target_alerts = fetch_portfolio_sell_target_alerts(conn)
        logger.info(f"  Found {len(sell_target_alerts)} sell target alerts")

        # 3. ポートフォリオ: 逆指値（ストップロス）到達
        logger.info("Checking portfolio stop loss alerts...")
        stop_loss_alerts = fetch_portfolio_stop_loss_alerts(conn)
        logger.info(f"  Found {len(stop_loss_alerts)} stop loss alerts")

        # sell_target/stop_loss対象銘柄のStockAnalysis（スタイル別分析）を一括取得
        portfolio_alert_stock_ids = list(set(
            a["stockId"] for a in sell_target_alerts + stop_loss_alerts
        ))
        stock_analyses = fetch_latest_stock_analyses(conn, portfolio_alert_stock_ids)
        logger.info(f"  Fetched style analyses for {len(stock_analyses)} stocks")

        for alert in sell_target_alerts:
            body = f"現在価格 {alert['latestPrice']:,.0f}円（+{alert['gainPercent']:.1f}%）が売却目標価格 {alert['targetPrice']:,.0f}円 を超えました"

            # スタイル別AI分析をメッセージに付加
            user_style = alert.get("investmentStyle", "BALANCED")
            style_data = stock_analyses.get(alert["stockId"], {}).get(user_style, {})
            style_rec = style_data.get("recommendation", "")
            if style_rec == "sell":
                body += "。AIも売却を推奨しています"
            elif style_rec == "buy":
                body += "。※AIはまだ保有継続を推奨しています"

            notifications.append({
                "userId": alert["userId"],
                "type": "sell_target",
                "stockId": alert["stockId"],
                "title": f"🎯 {alert['stockName']}が目標価格に到達",
                "body": body,
                "url": f"/my-stocks/{alert['userStockId']}",
                "triggerPrice": alert["latestPrice"],
                "targetPrice": alert["targetPrice"],
                "changeRate": alert.get("gainPercent"),
            })

        for alert in stop_loss_alerts:
            body = f"現在価格 {alert['latestPrice']:,.0f}円（{alert['lossPercent']:.1f}%）が撤退ライン {alert['stopLossPrice']:,.0f}円 を下回りました"

            # スタイル別AI分析をメッセージに付加
            user_style = alert.get("investmentStyle", "BALANCED")
            style_data = stock_analyses.get(alert["stockId"], {}).get(user_style, {})
            style_rec = style_data.get("recommendation", "")
            if style_rec == "sell":
                body += "。AIも売却を推奨しています"
            elif style_rec == "buy":
                body += "。※AIは回復を予測しています"

            notifications.append({
                "userId": alert["userId"],
                "type": "stop_loss",
                "stockId": alert["stockId"],
                "title": f"⚠️ {alert['stockName']}が撤退ラインに到達",
                "body": body,
                "url": f"/my-stocks/{alert['userStockId']}",
                "triggerPrice": alert["latestPrice"],
                "targetPrice": alert["stopLossPrice"],
                "changeRate": alert["lossPercent"],
            })

        # 4. ウォッチリスト: 買い時到達
        logger.info("Checking watchlist buy target alerts...")
        buy_target_alerts = fetch_watchlist_buy_target_alerts(conn)
        logger.info(f"  Found {len(buy_target_alerts)} buy target alerts")

        for alert in buy_target_alerts:
            is_buy = alert.get("purchaseRecommendation") == "buy"

            if is_buy:
                title = f"💰 {alert['stockName']}が買い時です"
                body = f"現在価格 {alert['latestPrice']:,.0f}円 が目標買値 {alert['targetPrice']:,.0f}円 以下になりました"
            else:
                title = f"📍 {alert['stockName']}が目標買値に到達"
                body = f"現在価格 {alert['latestPrice']:,.0f}円（目標買値 {alert['targetPrice']:,.0f}円）※現在は様子見判断です"

            notifications.append({
                "userId": alert["userId"],
                "type": "buy_target",
                "stockId": alert["stockId"],
                "title": title,
                "body": body,
                "url": f"/my-stocks/{alert['watchlistStockId']}",
                "triggerPrice": alert["latestPrice"],
                "targetPrice": alert["targetPrice"],
            })

        # 5. ポートフォリオ: 利確マイルストーン
        logger.info("Checking portfolio profit milestone alerts...")
        profit_milestone_alerts = fetch_portfolio_profit_milestone_alerts(conn, PROFIT_MILESTONES)
        logger.info(f"  Found {len(profit_milestone_alerts)} profit milestone alerts")

        # 利確マイルストーン対象のStockAnalysis（スタイル別分析）を一括取得
        milestone_stock_ids = list(set(
            a["stockId"] for a in profit_milestone_alerts
        ))
        milestone_analyses = fetch_latest_stock_analyses(conn, milestone_stock_ids)

        for alert in profit_milestone_alerts:
            milestone = alert["milestone"]
            user_style = alert.get("investmentStyle", "BALANCED")

            title = f"💹 {alert['stockName']}が+{milestone}%に到達"

            body = f"含み益が+{alert['profitPercent']:.1f}%（{alert['latestPrice']:,.0f}円 / 取得単価{alert['averageCost']:,.0f}円）になりました。"

            # 投資スタイル別のアドバイス
            if user_style == "CONSERVATIVE":
                if milestone >= 20:
                    body += "利益確定をおすすめします"
                else:
                    body += "一部利確を検討してみましょう"
            elif user_style == "BALANCED":
                if milestone >= 30:
                    body += "利益確定のタイミングです"
                elif milestone >= 20:
                    body += "半分利確して残りはトレーリングストップで守る方法もあります"
                else:
                    body += "利確の検討時期です。一部売却でリスクを減らせます"
            else:  # AGGRESSIVE
                if milestone >= 30:
                    body += "大幅な利益が出ています。一部利確も選択肢です"
                else:
                    body += "まだ上昇余地があるかもしれません。撤退ラインの引き上げを検討しましょう"

            # AI分析がある場合は付加
            style_data = milestone_analyses.get(alert["stockId"], {}).get(user_style, {})
            style_rec = style_data.get("recommendation", "")
            if style_rec == "sell":
                body += "。AIも利益確定を推奨しています"

            notifications.append({
                "userId": alert["userId"],
                "type": "profit_milestone",
                "stockId": alert["stockId"],
                "title": title,
                "body": body,
                "url": f"/my-stocks/{alert['userStockId']}",
                "triggerPrice": alert["latestPrice"],
                "changeRate": alert["profitPercent"],
            })

        # 6. 通知送信
        logger.info(f"Total notifications to send: {len(notifications)}")

        if notifications:
            result = send_notifications(app_url, cron_secret, notifications)
            logger.info(f"  Created: {result.get('created', 0)}")
            logger.info(f"  Push sent: {result.get('pushSent', 0)}")
            logger.info(f"  Skipped (duplicate): {result.get('skipped', 0)}")
            if result.get('errors'):
                logger.warning(f"  Errors: {len(result['errors'])}")
        else:
            logger.info("  No alerts to send")

        logger.info("=" * 60)
        logger.info("✅ Price alert check completed")

    except Exception as e:
        logger.error(f"❌ Error: {e}")
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
