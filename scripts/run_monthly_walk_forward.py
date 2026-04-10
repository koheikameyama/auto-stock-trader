"""
Monthly Walk-Forward Analysis Runner

breakout / gapup 両戦略の walk-forward 分析を実行し、
結果を解析して AI 評価 + Slack 通知する。

Usage:
  python scripts/run_monthly_walk_forward.py
"""

import subprocess
import sys
import os
import re
import json
import urllib.request


SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")


def run_walk_forward(strategy: str) -> tuple[int, str]:
    """Walk-forward スクリプトを実行し、(returncode, stdout) を返す"""
    cmd = f"walk-forward:{strategy}"
    print(f"\n{'='*60}")
    print(f"  {strategy} walk-forward 実行開始")
    print(f"{'='*60}\n")

    result = subprocess.run(
        ["npm", "run", cmd],
        capture_output=True,
        text=True,
        timeout=600,  # 10分タイムアウト
    )

    # stdoutをそのまま表示（GitHub Actionsログ用）
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)

    return result.returncode, result.stdout


def parse_wf_result(stdout: str) -> dict:
    """Walk-forward の stdout から主要指標を抽出する"""
    info = {
        "judgment": "不明",
        "oos_pf": "N/A",
        "is_oos_ratio": "N/A",
        "active_windows": "N/A",
        "total_trades": "N/A",
        "win_rate": "N/A",
        "window_table": "",
        "param_stability": "",
    }

    # 判定行
    m = re.search(r"判定:\s*(.+)", stdout)
    if m:
        info["judgment"] = m.group(1).strip()

    # 集計PF
    m = re.search(r"集計PF:\s*([\d.]+)", stdout)
    if m:
        info["oos_pf"] = m.group(1)

    # IS/OOS PF比
    m = re.search(r"IS/OOS PF比:\s*([\d.]+)", stdout)
    if m:
        info["is_oos_ratio"] = m.group(1)

    # アクティブウィンドウ
    m = re.search(r"アクティブウィンドウ:\s*(\d+/\d+)", stdout)
    if m:
        info["active_windows"] = m.group(1)

    # 総トレード
    m = re.search(r"総トレード:\s*(\d+)", stdout)
    if m:
        info["total_trades"] = m.group(1)

    # 勝率
    m = re.search(r"勝率:\s*([\d.]+%)", stdout)
    if m:
        info["win_rate"] = m.group(1)

    # ウィンドウ別テーブル（AI評価用）
    m = re.search(r"(\[ウィンドウ別\].*?\[パラメータ安定性\])", stdout, re.DOTALL)
    if m:
        info["window_table"] = m.group(1).strip()

    # パラメータ安定性
    m = re.search(r"(\[パラメータ安定性\].*?)$", stdout, re.DOTALL)
    if m:
        info["param_stability"] = m.group(1).strip()

    return info


def generate_ai_review(results: list[dict]) -> str:
    """OpenAI gpt-4o-mini で WF 結果を評価する"""
    if not OPENAI_API_KEY:
        print("OPENAI_API_KEY 未設定、AI評価をスキップ")
        return ""

    # プロンプト用データ構築
    data_sections: list[str] = []
    for r in results:
        if not r["success"]:
            data_sections.append(f"## {r['strategy']}\n実行失敗")
            continue

        info = r["info"]
        data_sections.append(
            f"## {r['strategy']}\n"
            f"- 判定: {info['judgment']}\n"
            f"- OOS集計PF: {info['oos_pf']}\n"
            f"- IS/OOS PF比: {info['is_oos_ratio']}\n"
            f"- アクティブウィンドウ: {info['active_windows']}\n"
            f"- 総トレード: {info['total_trades']}\n"
            f"- 勝率: {info['win_rate']}\n"
            f"\n{info['window_table']}\n"
            f"\n{info['param_stability']}"
        )

    wf_data = "\n\n".join(data_sections)

    messages = [
        {
            "role": "system",
            "content": (
                "あなたはプロの株式トレーダー兼クオンツアナリストです。\n"
                "Walk-Forward分析の結果を評価し、運用判断の助言を行います。\n\n"
                "現在の運用状況:\n"
                "- gapup戦略で単独運用中\n"
                "- breakout戦略はエッジ消失のためエントリー無効化中\n"
                "- 月次でWFを実行し、両戦略のエッジを監視している\n\n"
                "以下の観点で評価してください:\n"
                "1. 各戦略の健全性（PF、IS/OOS乖離、パラメータ安定性）\n"
                "2. breakout復活の兆候があるか\n"
                "3. gapupのエッジが維持されているか、劣化の兆候はないか\n"
                "4. 運用上のアクション提案（パラメータ変更、戦略切替等）\n\n"
                "JSON形式で回答してください:\n"
                '{"review": "評価テキスト（3-5文、日本語）", "action": "推奨アクション（1文）"}'
            ),
        },
        {
            "role": "user",
            "content": f"今月のWalk-Forward結果:\n\n{wf_data}",
        },
    ]

    payload = {
        "model": "gpt-4o-mini",
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 500,
        "response_format": {"type": "json_object"},
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENAI_API_KEY}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            content = body["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            review = parsed.get("review", "")
            action = parsed.get("action", "")
            print(f"\n[AI評価] {review}")
            print(f"[推奨アクション] {action}")
            return f"{review}\n\n*推奨アクション:* {action}"
    except Exception as e:
        print(f"AI評価失敗: {e}", file=sys.stderr)
        return ""


def notify_slack(results: list[dict], ai_review: str) -> None:
    """Slack に WF 結果サマリー + AI評価を送信する"""
    if not SLACK_WEBHOOK_URL:
        print("SLACK_WEBHOOK_URL 未設定、Slack通知をスキップ")
        return

    fields = []
    has_failure = False

    for r in results:
        strategy = r["strategy"]
        info = r["info"]
        success = r["success"]

        if not success:
            has_failure = True
            fields.append({
                "title": f"{strategy}",
                "value": "実行失敗",
                "short": True,
            })
            continue

        is_robust = "堅牢" in info["judgment"]
        emoji = "" if is_robust else ""

        fields.append({
            "title": f"{strategy} {emoji}",
            "value": (
                f"判定: {info['judgment']}\n"
                f"OOS PF: {info['oos_pf']} / IS/OOS比: {info['is_oos_ratio']}\n"
                f"窓: {info['active_windows']} / {info['total_trades']}tr / 勝率{info['win_rate']}"
            ),
            "short": False,
        })

    if ai_review:
        fields.append({
            "title": "AI評価",
            "value": ai_review,
            "short": False,
        })

    color = "danger" if has_failure else "good"
    title = "Monthly Walk-Forward 結果"

    payload = {
        "attachments": [{
            "fallback": title,
            "color": color,
            "title": title,
            "fields": fields,
            "footer": "Stock Buddy",
        }],
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        SLACK_WEBHOOK_URL,
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=10)
        print("Slack通知送信完了")
    except Exception as e:
        print(f"Slack通知失敗: {e}", file=sys.stderr)


def main():
    strategies = ["breakout", "gapup"]
    results = []
    any_failure = False

    for strategy in strategies:
        try:
            returncode, stdout = run_walk_forward(strategy)
            success = returncode == 0
            info = parse_wf_result(stdout) if success else {}
        except subprocess.TimeoutExpired:
            print(f"{strategy} walk-forward タイムアウト", file=sys.stderr)
            success = False
            info = {}
        except Exception as e:
            print(f"{strategy} walk-forward エラー: {e}", file=sys.stderr)
            success = False
            info = {}

        if not success:
            any_failure = True

        results.append({
            "strategy": strategy,
            "success": success,
            "info": info,
        })

    # AI評価
    ai_review = generate_ai_review(results)

    # Slack通知
    notify_slack(results, ai_review)

    # サマリー表示
    print(f"\n{'='*60}")
    print("  Walk-Forward サマリー")
    print(f"{'='*60}")
    for r in results:
        status = "OK" if r["success"] else "FAIL"
        judgment = r["info"].get("judgment", "N/A") if r["success"] else "実行失敗"
        pf = r["info"].get("oos_pf", "N/A") if r["success"] else "N/A"
        print(f"  {r['strategy']:12s} [{status}] 判定: {judgment}  OOS PF: {pf}")

    if any_failure:
        sys.exit(1)


if __name__ == "__main__":
    main()
