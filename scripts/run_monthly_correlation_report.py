"""
Monthly GU/PSC Correlation Report Runner

combined-run の --corr-report を実行し、戦略間の相関係数を Slack 通知する。
GU/PSC が独立した戦略として機能しているか継続監視するのが目的。

Usage:
  python scripts/run_monthly_correlation_report.py [--start YYYY-MM-DD] [--end YYYY-MM-DD]

Required env:
  DATABASE_URL: 本番DB接続文字列 (Railway)
  SLACK_WEBHOOK_URL: Slack Incoming Webhook
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import date, timedelta


SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "")

# 警告閾値: 全期間相関がこれを超えたら戦略間で独立性が失われている
ALERT_OVERALL_CORR = 0.5


def default_window() -> tuple[str, str]:
    """直近24ヶ月をデフォルト窓とする"""
    today = date.today()
    end = today
    start = today.replace(day=1) - timedelta(days=365 * 2)
    return start.isoformat(), end.isoformat()


def run_corr_report(start: str, end: str) -> tuple[int, str]:
    print("=" * 60)
    print(f"  GU/PSC Correlation Report 実行 ({start} → {end})")
    print("=" * 60)

    result = subprocess.run(
        ["npx", "tsx", "src/backtest/combined-run.ts", "--corr-report", "--start", start, "--end", end],
        capture_output=True,
        text=True,
        timeout=900,
    )
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    return result.returncode, result.stdout


def parse_overall(stdout: str) -> dict:
    info = {
        "overall_corr": None,
        "both_active_days": None,
        "both_loss_days": None,
        "both_win_days": None,
        "opposite_days": None,
        "gu_exit_days": None,
        "psc_exit_days": None,
    }

    m = re.search(r"GU決済日数:\s*(\d+)\s*/\s*PSC決済日数:\s*(\d+)", stdout)
    if m:
        info["gu_exit_days"] = int(m.group(1))
        info["psc_exit_days"] = int(m.group(2))

    m = re.search(r"Pearson相関係数\(全union日\):\s*([+-]?\d+\.\d+)", stdout)
    if m:
        info["overall_corr"] = float(m.group(1))

    m = re.search(r"両戦略同日決済:\s*(\d+)日", stdout)
    if m:
        info["both_active_days"] = int(m.group(1))

    m = re.search(r"両方プラス:\s*(\d+)日", stdout)
    if m:
        info["both_win_days"] = int(m.group(1))

    m = re.search(r"両方マイナス\(共倒れ\):\s*(\d+)日", stdout)
    if m:
        info["both_loss_days"] = int(m.group(1))

    m = re.search(r"逆方向\(片勝ち片負け\):\s*(\d+)日", stdout)
    if m:
        info["opposite_days"] = int(m.group(1))

    return info


def parse_monthly(stdout: str) -> list[dict]:
    months: list[dict] = []
    section = re.search(r"\[月次相関\](.*?)\[判定\]", stdout, re.DOTALL)
    if not section:
        return months
    for line in section.group(1).splitlines():
        m = re.match(r"\s*(\d{4}-\d{2})\s*\|\s*([+-]?\d+\.\d+)\s*\|\s*(\d+)", line)
        if m:
            months.append({
                "month": m.group(1),
                "corr": float(m.group(2)),
                "n": int(m.group(3)),
            })
    return months


def build_alerts(overall: dict, monthly: list[dict]) -> list[str]:
    alerts: list[str] = []

    if overall["overall_corr"] is not None and overall["overall_corr"] > ALERT_OVERALL_CORR:
        alerts.append(
            f":warning: *全期間相関 {overall['overall_corr']:.3f}* が閾値 {ALERT_OVERALL_CORR} を超過 "
            f"（戦略間で独立性が失われている可能性）"
        )

    recent = monthly[-3:] if len(monthly) >= 3 else monthly
    high_corr_recent = [m for m in recent if m["corr"] > ALERT_OVERALL_CORR]
    if len(high_corr_recent) >= 2:
        months_str = ", ".join(f"{m['month']}({m['corr']:.2f})" for m in high_corr_recent)
        alerts.append(f":warning: 直近3ヶ月のうち{len(high_corr_recent)}ヶ月で相関>0.5: {months_str}")

    # 共倒れ日が同日決済の30%以上
    if overall["both_active_days"] and overall["both_loss_days"] is not None:
        if overall["both_active_days"] >= 5:
            ratio = overall["both_loss_days"] / overall["both_active_days"]
            if ratio > 0.3:
                alerts.append(
                    f":warning: 同日決済の {ratio*100:.0f}% で共倒れ "
                    f"({overall['both_loss_days']}/{overall['both_active_days']}日)"
                )

    return alerts


def build_slack_fields(overall: dict, monthly: list[dict], alerts: list[str], start: str, end: str) -> list[dict]:
    fields: list[dict] = []

    fields.append({
        "title": "期間",
        "value": f"{start} → {end}",
        "short": False,
    })

    overall_lines = []
    if overall["overall_corr"] is not None:
        overall_lines.append(f"全期間相関: *{overall['overall_corr']:.3f}*")
    if overall["gu_exit_days"] is not None:
        overall_lines.append(f"GU決済 {overall['gu_exit_days']}日 / PSC決済 {overall['psc_exit_days']}日")
    if overall["both_active_days"] is not None:
        overall_lines.append(
            f"同日決済 {overall['both_active_days']}日 "
            f"(両勝 {overall['both_win_days']} / 共倒れ {overall['both_loss_days']} / 逆方向 {overall['opposite_days']})"
        )

    fields.append({
        "title": "全期間統計",
        "value": "\n".join(overall_lines) if overall_lines else "データなし",
        "short": False,
    })

    if monthly:
        recent = monthly[-6:]
        lines = [f"{m['month']}: {m['corr']:+.3f} (n={m['n']})" for m in recent]
        fields.append({
            "title": f"直近{len(recent)}ヶ月の月次相関",
            "value": "\n".join(lines),
            "short": False,
        })

    if alerts:
        fields.append({
            "title": "アラート",
            "value": "\n".join(alerts),
            "short": False,
        })

    return fields


def notify_slack(success: bool, fields: list[dict], alerts: list[str]) -> None:
    if not SLACK_WEBHOOK_URL:
        print("SLACK_WEBHOOK_URL 未設定、Slack通知をスキップ")
        return

    if not success:
        title = "Monthly Correlation Report 失敗"
        color = "danger"
    else:
        title = "Monthly GU/PSC Correlation Report"
        color = "warning" if alerts else "good"

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
    parser = argparse.ArgumentParser()
    default_start, default_end = default_window()
    parser.add_argument("--start", default=default_start)
    parser.add_argument("--end", default=default_end)
    args = parser.parse_args()

    try:
        returncode, stdout = run_corr_report(args.start, args.end)
    except subprocess.TimeoutExpired:
        print("Correlation report タイムアウト", file=sys.stderr)
        notify_slack(False, [{"title": "実行失敗", "value": "タイムアウト", "short": False}], [])
        sys.exit(1)
    except Exception as e:
        print(f"Correlation report エラー: {e}", file=sys.stderr)
        notify_slack(False, [{"title": "実行失敗", "value": str(e), "short": False}], [])
        sys.exit(1)

    if returncode != 0:
        notify_slack(False, [{"title": "実行失敗", "value": "詳細はGitHub Actionsログを確認", "short": False}], [])
        sys.exit(1)

    overall = parse_overall(stdout)
    monthly = parse_monthly(stdout)
    alerts = build_alerts(overall, monthly)
    fields = build_slack_fields(overall, monthly, alerts, args.start, args.end)
    print(f"\n--- parse: overall_corr={overall['overall_corr']}, monthly={len(monthly)}, alerts={len(alerts)} ---")
    notify_slack(True, fields, alerts)


if __name__ == "__main__":
    main()
