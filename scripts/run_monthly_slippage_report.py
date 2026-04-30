"""
Monthly Execution Slippage Report Runner

scripts/analyze-execution-slippage.ts を実行し、本番の約定スリッページを集計して
Slack 通知する。

BT で使用しているスリッページ仮定 (light/standard/heavy) と比べて実績が悪化していないか
継続監視するのが目的。

Usage:
  python scripts/run_monthly_slippage_report.py

Required env:
  DATABASE_URL: 本番DB接続文字列 (Railway)
  SLACK_WEBHOOK_URL: Slack Incoming Webhook
"""

import json
import os
import re
import subprocess
import sys
import urllib.request


SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "")

# BTのスリッページ仮定 (lib/trading-costs.ts の standard プロファイル相当)
# entry引け成行は概ね -10bps想定、SL/TS は -20bps想定
BT_ENTRY_AVG_BPS_ABS_LIMIT = 30  # 平均絶対値がこれを超えたら警告
BT_EXIT_AVG_BPS_LIMIT = -50  # SL/TS の平均が -50bps を割ったら警告 (大きい不利スリ)


def run_slippage_script() -> tuple[int, str]:
    """analyze-execution-slippage.ts を tsx で実行する"""
    print("=" * 60)
    print("  execution-slippage 分析実行")
    print("=" * 60)

    result = subprocess.run(
        ["npx", "tsx", "scripts/analyze-execution-slippage.ts"],
        capture_output=True,
        text=True,
        timeout=300,
    )

    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)

    return result.returncode, result.stdout


def parse_section(stdout: str, section_header: str) -> list[dict]:
    """
    "=== Entry Slippage..." または "=== Exit Slippage..." セクションを parse して、
    [{ name, n, avg_bps, abs_avg_bps, median_bps, p90_bps }, ...] を返す。
    """
    # セクション全体を切り出す
    section_match = re.search(
        rf"=== {re.escape(section_header)}.*?(?=\n===|\n---|\Z)",
        stdout,
        re.DOTALL,
    )
    if not section_match:
        return []

    section = section_match.group(0)
    entries: list[dict] = []

    # 各 [name] ブロックを取り出す
    block_pattern = re.compile(
        r"\[([^\]]+)\]\s*n=(\d+)\s*\n"
        r"\s*平均:\s*([+-]?\d+)bps.*?平均絶対値:\s*([+-]?\d+)bps.*?\n"
        r"\s*中央値:\s*([+-]?\d+)bps.*?\n"
        r"\s*P10:.*?P25:.*?\n"
        r"\s*P75:.*?P90:\s*([+-]?\d+)bps",
        re.DOTALL,
    )

    for m in block_pattern.finditer(section):
        entries.append({
            "name": m.group(1),
            "n": int(m.group(2)),
            "avg_bps": int(m.group(3)),
            "abs_avg_bps": int(m.group(4)),
            "median_bps": int(m.group(5)),
            "p90_bps": int(m.group(6)),
        })

    return entries


def fmt_bps(v: int) -> str:
    sign = "+" if v >= 0 else ""
    return f"{sign}{v}bps ({v / 100:.2f}%)"


def detect_alerts(entry_entries: list[dict], exit_entries: list[dict]) -> list[str]:
    """BT仮定からの逸脱を検出してアラート文字列リストを返す"""
    alerts: list[str] = []

    for e in entry_entries:
        if e["name"] == "__all__":
            continue
        if e["abs_avg_bps"] > BT_ENTRY_AVG_BPS_ABS_LIMIT:
            alerts.append(
                f":warning: *Entry/{e['name']}* 平均絶対値 {fmt_bps(e['abs_avg_bps'])} "
                f"(閾値 {BT_ENTRY_AVG_BPS_ABS_LIMIT}bps 超)"
            )

    for e in exit_entries:
        if e["avg_bps"] < BT_EXIT_AVG_BPS_LIMIT:
            alerts.append(
                f":warning: *Exit/{e['name']}* 平均 {fmt_bps(e['avg_bps'])} "
                f"(閾値 {BT_EXIT_AVG_BPS_LIMIT}bps 下回り)"
            )

    return alerts


def build_slack_fields(
    entry_entries: list[dict],
    exit_entries: list[dict],
    alerts: list[str],
) -> list[dict]:
    fields: list[dict] = []

    if entry_entries:
        lines = []
        for e in entry_entries:
            lines.append(
                f"*{e['name']}* (n={e['n']}): "
                f"平均 {fmt_bps(e['avg_bps'])} / "
                f"絶対値平均 {fmt_bps(e['abs_avg_bps'])} / "
                f"P90 {fmt_bps(e['p90_bps'])}"
            )
        fields.append({
            "title": "Entry Slippage (buy 引け成行)",
            "value": "\n".join(lines),
            "short": False,
        })
    else:
        fields.append({
            "title": "Entry Slippage",
            "value": "データなし",
            "short": False,
        })

    if exit_entries:
        lines = []
        for e in exit_entries:
            lines.append(
                f"*{e['name']}* (n={e['n']}): "
                f"平均 {fmt_bps(e['avg_bps'])} / "
                f"絶対値平均 {fmt_bps(e['abs_avg_bps'])} / "
                f"P90 {fmt_bps(e['p90_bps'])}"
            )
        fields.append({
            "title": "Exit Slippage (実績 vs 想定決済価格)",
            "value": "\n".join(lines),
            "short": False,
        })
    else:
        fields.append({
            "title": "Exit Slippage",
            "value": "SL/TS決済の実績データなし",
            "short": False,
        })

    if alerts:
        fields.append({
            "title": "アラート",
            "value": "\n".join(alerts),
            "short": False,
        })

    return fields


def notify_slack(
    entry_entries: list[dict],
    exit_entries: list[dict],
    alerts: list[str],
    success: bool,
) -> None:
    if not SLACK_WEBHOOK_URL:
        print("SLACK_WEBHOOK_URL 未設定、Slack通知をスキップ")
        return

    if not success:
        title = "Monthly Execution Slippage 失敗"
        color = "danger"
        fields = [{
            "title": "実行失敗",
            "value": "詳細はGitHub Actionsログを確認してください",
            "short": False,
        }]
    else:
        title = "Monthly Execution Slippage Report"
        color = "warning" if alerts else "good"
        fields = build_slack_fields(entry_entries, exit_entries, alerts)

    payload = {
        "attachments": [{
            "fallback": title,
            "color": color,
            "title": title,
            "fields": fields,
            "footer": "Auto Stock Trader",
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


def main() -> None:
    try:
        returncode, stdout = run_slippage_script()
    except subprocess.TimeoutExpired:
        print("slippage 分析タイムアウト", file=sys.stderr)
        notify_slack([], [], [], success=False)
        sys.exit(1)
    except Exception as e:
        print(f"slippage 分析エラー: {e}", file=sys.stderr)
        notify_slack([], [], [], success=False)
        sys.exit(1)

    if returncode != 0:
        notify_slack([], [], [], success=False)
        sys.exit(1)

    entry_entries = parse_section(stdout, "Entry Slippage")
    exit_entries = parse_section(stdout, "Exit Slippage")
    alerts = detect_alerts(entry_entries, exit_entries)

    print(f"\n--- parse結果: entry {len(entry_entries)}件 / exit {len(exit_entries)}件 / alert {len(alerts)}件 ---")

    notify_slack(entry_entries, exit_entries, alerts, success=True)


if __name__ == "__main__":
    main()
