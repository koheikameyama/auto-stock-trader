#!/usr/bin/env python3
"""
AI分析パフォーマンス日次レポート

毎日、過去7日間の3種類のAI分析パフォーマンスを集計してDBに保存する。
- おすすめ銘柄 (RecommendationOutcome type=daily)
- 購入推奨 (RecommendationOutcome type=purchase)
- ポートフォリオ分析 (RecommendationOutcome type=analysis)

RecommendationOutcome.returnAfter7Days を使用（evaluate_recommendation_outcomes.py が事前に計算済み）。
"""

import os
import sys
from datetime import datetime, timedelta, timezone, date
from collections import defaultdict
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import json

import psycopg2

from openai import OpenAI

# scriptsディレクトリをPythonパスに追加
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.constants import (
    OPENAI_MODEL,
    OPENAI_TEMPERATURE,
    OPENAI_MAX_TOKENS_INSIGHT,
    OPENAI_MAX_TOKENS_IMPROVEMENT,
    AI_CONCURRENCY_LIMIT,
    REPORT_EVALUATION_DELAY_DAYS,
    REPORT_EVALUATION_WINDOW_DAYS,
    DAILY_SUCCESS_THRESHOLD,
    PURCHASE_BUY_SUCCESS_THRESHOLD,
    PURCHASE_STAY_SUCCESS_THRESHOLD,
    PURCHASE_REMOVE_SUCCESS_THRESHOLD,
    ANALYSIS_UP_SUCCESS_THRESHOLD,
    ANALYSIS_DOWN_SUCCESS_THRESHOLD,
    ANALYSIS_NEUTRAL_SUCCESS_THRESHOLD,
)

# .envファイルから環境変数を読み込む（ローカル実行用）
env_path = Path(__file__).resolve().parents[2] / ".env"
if env_path.exists():
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def get_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("Error: DATABASE_URL not set")
        sys.exit(1)
    return url


def get_openai_client() -> OpenAI | None:
    """OpenAIクライアントを取得（APIキーがない場合はNone）"""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("Warning: OPENAI_API_KEY not set, skipping AI insights")
        return None
    return OpenAI(api_key=api_key)


def generate_single_insight(client: OpenAI, category: str, data: dict) -> str | None:
    """単一カテゴリのAIインサイトを生成（1行）"""
    if data["count"] == 0:
        return None

    if category == "daily":
        data_text = f"""おすすめ銘柄のパフォーマンス:
- 分析件数: {data['count']}件
- 平均リターン: {data['avgReturn']:+.2f}%
- プラス率: {data['positiveRate']:.1f}%
- 成功率(+3%以上): {data['successRate']:.1f}%"""
        if data.get("best"):
            best_items = [f"{b['name']}({b['performance']:+.1f}%)" for b in data['best'][:2]]
            data_text += f"\n- ベスト: {', '.join(best_items)}"
        if data.get("worst"):
            worst_items = [f"{w['name']}({w['performance']:+.1f}%)" for w in data['worst'][:2]]
            data_text += f"\n- ワースト: {', '.join(worst_items)}"
        if data.get("topSectors"):
            top_text = ", ".join([f"{s}({d['avgReturn']:+.1f}%)" for s, d in data['topSectors'][:2]])
            data_text += f"\n- 好調セクター: {top_text}"
        if data.get("bottomSectors"):
            bottom_text = ", ".join([f"{s}({d['avgReturn']:+.1f}%)" for s, d in data['bottomSectors'][:2]])
            data_text += f"\n- 不調セクター: {bottom_text}"

    elif category == "purchase":
        data_text = f"""購入推奨のパフォーマンス:
- 分析件数: {data['count']}件
- 判断成功率: {data['successRate']:.1f}%
- 平均騰落率: {data['avgReturn']:+.2f}%"""
        for rec, stats in data.get("byRecommendation", {}).items():
            label = {"buy": "買い", "stay": "様子見", "remove": "見送り"}.get(rec, rec)
            data_text += f"\n- {label}判断: {stats['successRate']:.0f}%的中 ({stats['count']}件)"
        if data.get("topSectors"):
            top_text = ", ".join([f"{s}({d['successRate']:.0f}%)" for s, d in data['topSectors'][:2]])
            data_text += f"\n- 的中率高いセクター: {top_text}"
        if data.get("bottomSectors"):
            bottom_text = ", ".join([f"{s}({d['successRate']:.0f}%)" for s, d in data['bottomSectors'][:2]])
            data_text += f"\n- 的中率低いセクター: {bottom_text}"

    elif category == "analysis":
        data_text = f"""ポートフォリオ分析（短期予測）のパフォーマンス:
- 分析件数: {data['count']}件
- 予測的中率: {data['successRate']:.1f}%
- 平均騰落率: {data['avgReturn']:+.2f}%"""
        for trend, stats in data.get("byTrend", {}).items():
            label = {"up": "上昇予測", "down": "下落予測", "neutral": "横ばい予測"}.get(trend, trend)
            data_text += f"\n- {label}: {stats['successRate']:.0f}%的中 ({stats['count']}件)"
        if data.get("topSectors"):
            top_text = ", ".join([f"{s}({d['successRate']:.0f}%)" for s, d in data['topSectors'][:2]])
            data_text += f"\n- 予測精度高いセクター: {top_text}"
        if data.get("bottomSectors"):
            bottom_text = ", ".join([f"{s}({d['successRate']:.0f}%)" for s, d in data['bottomSectors'][:2]])
            data_text += f"\n- 予測精度低いセクター: {bottom_text}"
    else:
        return None

    prompt = f"""{data_text}

上記データを分析し、1行（40文字以内）でインサイトを提供してください。
具体的な数値を引用し、課題や傾向を簡潔に指摘してください。

【重要】提供されたデータのみを使用してください。外部情報や推測は含めないでください。"""

    try:
        response = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": "あなたは株式投資AIの分析官です。簡潔に日本語で回答してください。提供されたデータのみを使用し、外部情報や推測は含めないでください。"},
                {"role": "user", "content": prompt},
            ],
            temperature=OPENAI_TEMPERATURE,
            max_tokens=OPENAI_MAX_TOKENS_INSIGHT,
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        print(f"    Warning: {category} insight failed: {e}")
        return None


def generate_ai_insights(daily: dict, purchase: dict, analysis: dict, sector_trends: dict | None = None) -> dict | None:
    """各カテゴリごとにAIインサイトを生成（並列処理）"""
    client = get_openai_client()
    if not client:
        return None

    total_count = daily["count"] + purchase["count"] + analysis["count"]
    if total_count == 0:
        return None

    insights = {}

    # 並列実行するタスクを定義 (key, category, data)
    tasks: list[tuple[str, str, dict]] = []
    if daily["count"] > 0:
        tasks.append(("daily", "daily", daily))
    if purchase["count"] > 0:
        tasks.append(("purchase", "purchase", purchase))
    if analysis["count"] > 0:
        tasks.append(("analysis", "analysis", analysis))

    # ThreadPoolExecutorで並列実行
    with ThreadPoolExecutor(max_workers=AI_CONCURRENCY_LIMIT) as executor:
        futures = {executor.submit(generate_single_insight, client, category, data): key for key, category, data in tasks}
        for future in as_completed(futures):
            key = futures[future]
            try:
                insights[key] = future.result()
            except Exception as e:
                print(f"    Warning: Task failed: {e}")

    return insights if any(insights.values()) else None


# ===== RecommendationOutcome からデータ取得（共通） =====

def get_outcomes_by_type(conn, outcome_type: str, start_date: date, end_date: date) -> list[dict]:
    """
    RecommendationOutcome から returnAfter7Days が評価済みのレコードを取得。
    3タイプ（daily/purchase/analysis）共通クエリ。
    """
    jst = timezone(timedelta(hours=9))
    start_utc = datetime.combine(start_date, datetime.min.time(), tzinfo=jst).astimezone(timezone.utc)
    end_utc = datetime.combine(end_date + timedelta(days=1), datetime.min.time(), tzinfo=jst).astimezone(timezone.utc)

    with conn.cursor() as cur:
        cur.execute('''
            SELECT
                o."recommendedAt",
                o."tickerCode",
                o.sector,
                o.prediction,
                o."returnAfter7Days",
                o.volatility,
                o."marketCap",
                s.name,
                s.per,
                s.pbr,
                s."fiftyTwoWeekHigh",
                s."fiftyTwoWeekLow",
                s."latestPrice"
            FROM "RecommendationOutcome" o
            JOIN "Stock" s ON o."stockId" = s.id
            WHERE o.type = %s
              AND o."recommendedAt" >= %s
              AND o."recommendedAt" < %s
              AND o."returnAfter7Days" IS NOT NULL
            ORDER BY o."recommendedAt" DESC
        ''', (outcome_type, start_utc, end_utc))

        return [
            {
                "date": row[0],
                "tickerCode": row[1],
                "sector": row[2],
                "prediction": row[3],
                "return7Days": float(row[4]),
                "volatility": float(row[5]) if row[5] else None,
                "marketCap": float(row[6]) if row[6] else None,
                "name": row[7],
                "per": float(row[8]) if row[8] else None,
                "pbr": float(row[9]) if row[9] else None,
                "fiftyTwoWeekHigh": float(row[10]) if row[10] else None,
                "fiftyTwoWeekLow": float(row[11]) if row[11] else None,
                "latestPrice": float(row[12]) if row[12] else None,
            }
            for row in cur.fetchall()
        ]


# ===== おすすめ銘柄 (type=daily) =====

def analyze_daily_outcomes(data: list[dict]) -> dict:
    """おすすめ銘柄のパフォーマンスを分析

    成功基準: 騰落率 > -3%（大きく下がらなければ成功）
    """
    if not data:
        return {"count": 0, "avgReturn": 0, "positiveRate": 0, "successRate": 0, "best": [], "worst": [], "failures": []}

    valid = [{**d, "performance": d["return7Days"]} for d in data]

    perfs = [v["performance"] for v in valid]
    sorted_valid = sorted(valid, key=lambda x: x["performance"], reverse=True)

    # ユニークな銘柄のみ（同じ銘柄が複数日に推奨されている場合の重複排除）
    seen_tickers = set()
    unique_best = []
    for v in sorted_valid:
        if v["tickerCode"] not in seen_tickers:
            unique_best.append(v)
            seen_tickers.add(v["tickerCode"])
        if len(unique_best) >= 3:
            break

    seen_tickers = set()
    unique_worst = []
    for v in reversed(sorted_valid):
        if v["tickerCode"] not in seen_tickers:
            unique_worst.append(v)
            seen_tickers.add(v["tickerCode"])
        if len(unique_worst) >= 3:
            break

    # セクター別分析
    by_sector = defaultdict(list)
    for v in valid:
        sector = v.get("sector") or "その他"
        by_sector[sector].append(v["performance"])

    sector_stats = {}
    for sector, perfs_list in by_sector.items():
        if len(perfs_list) >= 2:  # 2件以上のみ
            sector_stats[sector] = {
                "count": len(perfs_list),
                "avgReturn": sum(perfs_list) / len(perfs_list),
                "successRate": sum(1 for p in perfs_list if p > DAILY_SUCCESS_THRESHOLD) / len(perfs_list) * 100,
            }

    sorted_sectors = sorted(sector_stats.items(), key=lambda x: x[1]["avgReturn"], reverse=True)
    top_sectors = sorted_sectors[:3] if len(sorted_sectors) >= 3 else sorted_sectors
    bottom_sectors = sorted_sectors[-3:] if len(sorted_sectors) >= 3 else []

    def categorize_market_cap(mc):
        if mc is None:
            return "不明"
        if mc >= 10000:
            return "大型株"
        if mc >= 1000:
            return "中型株"
        return "小型株"

    def categorize_valuation(per, pbr):
        if per is None and pbr is None:
            return "不明"
        issues = []
        if per and per > 20:
            issues.append("高PER")
        if pbr and pbr > 2:
            issues.append("高PBR")
        if per and per < 10:
            issues.append("低PER")
        if pbr and pbr < 1:
            issues.append("低PBR")
        return "・".join(issues) if issues else "標準"

    def categorize_price_position(latest, high, low):
        if latest is None or high is None or low is None:
            return "不明"
        if high == low:
            return "横ばい"
        position = (latest - low) / (high - low) * 100
        if position >= 80:
            return "高値圏"
        if position <= 20:
            return "安値圏"
        return "中間"

    # 失敗銘柄を収集、ユニーク化
    failure_by_ticker = {}
    for v in valid:
        if v["performance"] <= DAILY_SUCCESS_THRESHOLD:
            ticker = v["tickerCode"]
            if ticker not in failure_by_ticker or v["performance"] < failure_by_ticker[ticker]["performance"]:
                failure_by_ticker[ticker] = {
                    "name": v["name"],
                    "tickerCode": ticker,
                    "sector": v.get("sector") or "その他",
                    "performance": v["performance"],
                    "marketCapCategory": categorize_market_cap(v.get("marketCap")),
                    "valuation": categorize_valuation(v.get("per"), v.get("pbr")),
                    "pricePosition": categorize_price_position(
                        v.get("latestPrice"), v.get("fiftyTwoWeekHigh"), v.get("fiftyTwoWeekLow")
                    ),
                    "volatility": v.get("volatility"),
                }

    failures = list(failure_by_ticker.values())
    failures.sort(key=lambda x: x["performance"])

    return {
        "count": len(valid),
        "avgReturn": sum(perfs) / len(perfs),
        "positiveRate": sum(1 for p in perfs if p > 0) / len(perfs) * 100,
        "successRate": sum(1 for p in perfs if p > DAILY_SUCCESS_THRESHOLD) / len(perfs) * 100,
        "best": unique_best,
        "worst": unique_worst,
        "topSectors": top_sectors,
        "bottomSectors": bottom_sectors,
        "failures": failures[:3],
    }


# ===== 購入推奨 (type=purchase) =====

def analyze_purchase_outcomes(data: list[dict]) -> dict:
    """購入推奨のパフォーマンスを分析

    成功基準（緩和版）:
    - buy: 騰落率 > -3%（大きく下がらなければ成功）
    - stay: 騰落率 <= 5%（5%以上の急騰を見逃さなければ成功）
    - remove: 騰落率 < 3%（大きく上がらなければ成功）
    """
    if not data:
        return {"count": 0, "avgReturn": 0, "successRate": 0, "byRecommendation": {}, "failures": []}

    valid = []
    for d in data:
        perf = d["return7Days"]
        rec = d["prediction"]
        if rec == "buy":
            is_success = perf > PURCHASE_BUY_SUCCESS_THRESHOLD
        elif rec == "stay":
            is_success = perf <= PURCHASE_STAY_SUCCESS_THRESHOLD
        elif rec == "remove":
            is_success = perf < PURCHASE_REMOVE_SUCCESS_THRESHOLD
        else:
            is_success = None
        valid.append({**d, "performance": perf, "isSuccess": is_success})

    perfs = [v["performance"] for v in valid]
    successes = [v["isSuccess"] for v in valid if v["isSuccess"] is not None]

    by_rec = defaultdict(list)
    for v in valid:
        if v["isSuccess"] is not None:
            by_rec[v["prediction"]].append(v["isSuccess"])

    by_rec_stats = {}
    for rec, results in by_rec.items():
        by_rec_stats[rec] = {
            "count": len(results),
            "successRate": sum(1 for r in results if r) / len(results) * 100 if results else 0
        }

    # セクター別分析
    by_sector = defaultdict(list)
    for v in valid:
        if v["isSuccess"] is not None:
            sector = v.get("sector") or "その他"
            by_sector[sector].append(v["isSuccess"])

    sector_stats = {}
    for sector, results in by_sector.items():
        if len(results) >= 2:
            sector_stats[sector] = {
                "count": len(results),
                "successRate": sum(1 for r in results if r) / len(results) * 100,
            }

    sorted_sectors = sorted(sector_stats.items(), key=lambda x: x[1]["successRate"], reverse=True)
    top_sectors = sorted_sectors[:3] if len(sorted_sectors) >= 3 else sorted_sectors
    bottom_sectors = sorted_sectors[-3:] if len(sorted_sectors) >= 3 else []

    # 失敗例を収集
    failures = [
        {
            "name": v["name"],
            "tickerCode": v["tickerCode"],
            "recommendation": v["prediction"],
            "performance": v["performance"],
        }
        for v in valid
        if v["isSuccess"] is False
    ]
    failures.sort(key=lambda x: -x["performance"] if x["recommendation"] == "stay" else x["performance"])

    return {
        "count": len(valid),
        "avgReturn": sum(perfs) / len(perfs),
        "successRate": sum(1 for s in successes if s) / len(successes) * 100 if successes else 0,
        "byRecommendation": by_rec_stats,
        "topSectors": top_sectors,
        "bottomSectors": bottom_sectors,
        "failures": failures[:3],
    }


# ===== ポートフォリオ分析 (type=analysis) =====

def analyze_analysis_outcomes(data: list[dict]) -> dict:
    """ポートフォリオ分析のパフォーマンスを分析

    成功基準（緩和版）:
    - up: 騰落率 > -3%（大きく下がらなければ成功）
    - down: 騰落率 < 3%（大きく上がらなければ成功）
    - neutral: -5% <= 騰落率 <= 5%（大きく動かなければ成功）
    """
    if not data:
        return {"count": 0, "avgReturn": 0, "successRate": 0, "byTrend": {}, "failures": []}

    valid = []
    for d in data:
        perf = d["return7Days"]
        trend = d["prediction"]
        if trend == "up":
            is_success = perf > ANALYSIS_UP_SUCCESS_THRESHOLD
        elif trend == "down":
            is_success = perf < ANALYSIS_DOWN_SUCCESS_THRESHOLD
        elif trend == "neutral":
            is_success = -ANALYSIS_NEUTRAL_SUCCESS_THRESHOLD <= perf <= ANALYSIS_NEUTRAL_SUCCESS_THRESHOLD
        else:
            is_success = None
        valid.append({**d, "performance": perf, "isSuccess": is_success})

    perfs = [v["performance"] for v in valid]
    successes = [v["isSuccess"] for v in valid if v["isSuccess"] is not None]

    by_trend = defaultdict(list)
    for v in valid:
        if v["isSuccess"] is not None and v["prediction"]:
            by_trend[v["prediction"]].append(v["isSuccess"])

    by_trend_stats = {}
    for trend, results in by_trend.items():
        by_trend_stats[trend] = {
            "count": len(results),
            "successRate": sum(1 for r in results if r) / len(results) * 100 if results else 0
        }

    # セクター別分析
    by_sector = defaultdict(list)
    for v in valid:
        if v["isSuccess"] is not None:
            sector = v.get("sector") or "その他"
            by_sector[sector].append(v["isSuccess"])

    sector_stats = {}
    for sector, results in by_sector.items():
        if len(results) >= 2:
            sector_stats[sector] = {
                "count": len(results),
                "successRate": sum(1 for r in results if r) / len(results) * 100,
            }

    sorted_sectors = sorted(sector_stats.items(), key=lambda x: x[1]["successRate"], reverse=True)
    top_sectors = sorted_sectors[:3] if len(sorted_sectors) >= 3 else sorted_sectors
    bottom_sectors = sorted_sectors[-3:] if len(sorted_sectors) >= 3 else []

    # 失敗例を収集
    failures = [
        {
            "name": v["name"],
            "tickerCode": v["tickerCode"],
            "shortTermTrend": v["prediction"],
            "performance": v["performance"],
        }
        for v in valid
        if v["isSuccess"] is False
    ]
    failures.sort(key=lambda x: abs(x["performance"]), reverse=True)

    return {
        "count": len(valid),
        "avgReturn": sum(perfs) / len(perfs),
        "successRate": sum(1 for s in successes if s) / len(successes) * 100 if successes else 0,
        "byTrend": by_trend_stats,
        "topSectors": top_sectors,
        "bottomSectors": bottom_sectors,
        "failures": failures[:3],
    }


# ===== DB保存 =====

def save_report_to_db(
    conn,
    daily: dict,
    purchase: dict,
    analysis: dict,
    insights: dict | None,
):
    """日次レポートをDBに保存（過去7日間の滚动集計）"""
    jst_offset = timezone(timedelta(hours=9))
    today_jst = datetime.now(jst_offset).date()

    details = {
        "daily": {
            "best": [{"name": b["name"], "tickerCode": b["tickerCode"], "performance": b["performance"]} for b in daily.get("best", [])[:3]],
            "worst": [{"name": w["name"], "tickerCode": w["tickerCode"], "performance": w["performance"]} for w in daily.get("worst", [])[:3]],
            "topSectors": [{"sector": s, "avgReturn": d["avgReturn"], "count": d["count"]} for s, d in daily.get("topSectors", [])],
            "bottomSectors": [{"sector": s, "avgReturn": d["avgReturn"], "count": d["count"]} for s, d in daily.get("bottomSectors", [])],
        },
        "purchase": {
            "byRecommendation": purchase.get("byRecommendation", {}),
            "topSectors": [{"sector": s, "successRate": d["successRate"], "count": d["count"]} for s, d in purchase.get("topSectors", [])],
            "bottomSectors": [{"sector": s, "successRate": d["successRate"], "count": d["count"]} for s, d in purchase.get("bottomSectors", [])],
        },
        "analysis": {
            "byTrend": analysis.get("byTrend", {}),
            "topSectors": [{"sector": s, "successRate": d["successRate"], "count": d["count"]} for s, d in analysis.get("topSectors", [])],
            "bottomSectors": [{"sector": s, "successRate": d["successRate"], "count": d["count"]} for s, d in analysis.get("bottomSectors", [])],
        },
    }

    with conn.cursor() as cur:
        cur.execute('''
            INSERT INTO "DailyAIReport" (
                id,
                date,
                "dailyRecommendationCount",
                "dailyRecommendationAvgReturn",
                "dailyRecommendationPlusRate",
                "dailyRecommendationSuccessRate",
                "purchaseRecommendationCount",
                "purchaseRecommendationAvgReturn",
                "purchaseRecommendationPlusRate",
                "purchaseRecommendationSuccessRate",
                "stockAnalysisCount",
                "stockAnalysisAvgReturn",
                "stockAnalysisPlusRate",
                "stockAnalysisSuccessRate",
                details,
                "createdAt"
            ) VALUES (
                gen_random_uuid()::text,
                %s,
                %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, NOW()
            )
            ON CONFLICT (date) DO UPDATE SET
                "dailyRecommendationCount" = EXCLUDED."dailyRecommendationCount",
                "dailyRecommendationAvgReturn" = EXCLUDED."dailyRecommendationAvgReturn",
                "dailyRecommendationPlusRate" = EXCLUDED."dailyRecommendationPlusRate",
                "dailyRecommendationSuccessRate" = EXCLUDED."dailyRecommendationSuccessRate",
                "purchaseRecommendationCount" = EXCLUDED."purchaseRecommendationCount",
                "purchaseRecommendationAvgReturn" = EXCLUDED."purchaseRecommendationAvgReturn",
                "purchaseRecommendationPlusRate" = EXCLUDED."purchaseRecommendationPlusRate",
                "purchaseRecommendationSuccessRate" = EXCLUDED."purchaseRecommendationSuccessRate",
                "stockAnalysisCount" = EXCLUDED."stockAnalysisCount",
                "stockAnalysisAvgReturn" = EXCLUDED."stockAnalysisAvgReturn",
                "stockAnalysisPlusRate" = EXCLUDED."stockAnalysisPlusRate",
                "stockAnalysisSuccessRate" = EXCLUDED."stockAnalysisSuccessRate",
                details = EXCLUDED.details
        ''', (
            today_jst,
            daily["count"] if daily["count"] > 0 else None,
            daily["avgReturn"] if daily["count"] > 0 else None,
            daily["positiveRate"] if daily["count"] > 0 else None,
            daily["successRate"] if daily["count"] > 0 else None,
            purchase["count"] if purchase["count"] > 0 else None,
            purchase["avgReturn"] if purchase["count"] > 0 else None,
            None,  # purchaseはplusRateがない（issue #3で対応予定）
            purchase["successRate"] if purchase["count"] > 0 else None,
            analysis["count"] if analysis["count"] > 0 else None,
            analysis["avgReturn"] if analysis["count"] > 0 else None,
            None,  # analysisはplusRateがない（issue #3で対応予定）
            analysis["successRate"] if analysis["count"] > 0 else None,
            json.dumps(details, ensure_ascii=False),
        ))
        conn.commit()
    print("   Report saved to database")


def get_sector_trends(conn) -> dict:
    """最新のセクタートレンドを取得（セクター名 → {compositeScore, trendDirection}）"""
    with conn.cursor() as cur:
        cur.execute('''
            SELECT sector, "compositeScore", "trendDirection"
            FROM "SectorTrend"
            WHERE date = (SELECT MAX(date) FROM "SectorTrend")
        ''')
        return {
            row[0]: {"compositeScore": row[1], "trendDirection": row[2]}
            for row in cur.fetchall()
        }


def main():
    print("=" * 60)
    print("Daily AI Analysis Performance Report")
    print("=" * 60)
    print(f"Time: {datetime.now().isoformat()}")

    conn = psycopg2.connect(get_database_url())

    try:
        # 1. 評価対象の日付範囲を計算
        jst_offset = timezone(timedelta(hours=9))
        today_jst = datetime.now(jst_offset).date()
        # 推奨から EVALUATION_DELAY 日後に評価する
        eval_end = today_jst - timedelta(days=REPORT_EVALUATION_DELAY_DAYS)
        eval_start = eval_end - timedelta(days=REPORT_EVALUATION_WINDOW_DAYS - 1)

        print(f"\n1. Fetching data from RecommendationOutcome...")
        print(f"   Evaluation period: {eval_start} ~ {eval_end}")

        daily_data = get_outcomes_by_type(conn, "daily", eval_start, eval_end)
        print(f"   Daily outcomes: {len(daily_data)} records")

        purchase_data = get_outcomes_by_type(conn, "purchase", eval_start, eval_end)
        print(f"   Purchase outcomes: {len(purchase_data)} records")

        analysis_data = get_outcomes_by_type(conn, "analysis", eval_start, eval_end)
        print(f"   Analysis outcomes: {len(analysis_data)} records")

        # 2. パフォーマンス分析
        print("\n2. Analyzing performance...")
        daily_stats = analyze_daily_outcomes(daily_data)
        print(f"   Daily: {daily_stats['count']} valid records")

        purchase_stats = analyze_purchase_outcomes(purchase_data)
        print(f"   Purchase: {purchase_stats['count']} valid records")

        analysis_stats = analyze_analysis_outcomes(analysis_data)
        print(f"   Analysis: {analysis_stats['count']} valid records")

        # 3. セクタートレンド取得
        print("\n3. Fetching sector trends...")
        sector_trends = get_sector_trends(conn)
        print(f"   Got trends for {len(sector_trends)} sectors")

        # 4. AIインサイト生成
        print("\n4. Generating AI insights...")
        insights = generate_ai_insights(daily_stats, purchase_stats, analysis_stats, sector_trends)
        if insights:
            for key, value in insights.items():
                if value:
                    label = {
                        "daily": "おすすめ",
                        "purchase": "購入推奨",
                        "analysis": "分析",
                    }.get(key, key)
                    print(f"   {label}: {value[:50]}...")
        else:
            print("   Skipped (no API key or error)")

        # 5. DBに保存
        print("\n5. Saving report to database...")
        save_report_to_db(conn, daily_stats, purchase_stats, analysis_stats, insights)

        print("\n" + "=" * 60)
        print("Report completed!")

    finally:
        conn.close()


if __name__ == "__main__":
    main()
