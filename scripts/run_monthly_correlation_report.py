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


ALERT_HALT_RATIO = 0.4
MIN_RELIABLE_MONTHLY_N = 10


def parse_overall(stdout: str) -> dict:
    info = {
        "both_active_corr": None,
        "fullday_corr": None,
        "union_corr": None,
        "trading_days": None,
        "both_active_days": None,
        "both_loss_days": None,
        "both_win_days": None,
        "opposite_days": None,
        "gu_exit_days": None,
        "psc_exit_days": None,
        # 全営業日カバレッジ
        "coverage_both_active": None,
        "coverage_one_active": None,
        "coverage_both_idle": None,
        "coverage_halt_total": None,
        "halt_breadth_lower": None,
        "halt_breadth_upper": None,
        "halt_index_below": None,
        "halt_vix_crisis": None,
    }

    m = re.search(r"営業日数:\s*(\d+)日", stdout)
    if m:
        info["trading_days"] = int(m.group(1))

    m = re.search(r"GU決済日数:\s*(\d+)\s*/\s*PSC決済日数:\s*(\d+)", stdout)
    if m:
        info["gu_exit_days"] = int(m.group(1))
        info["psc_exit_days"] = int(m.group(2))

    m = re.search(r"両アクティブ日のみ\s*\(n=\d+\):\s*([+-]?\d+\.\d+)", stdout)
    if m:
        info["both_active_corr"] = float(m.group(1))

    m = re.search(r"全営業日ベース\s*\(n=\d+,[^)]*\):\s*([+-]?\d+\.\d+)", stdout)
    if m:
        info["fullday_corr"] = float(m.group(1))

    m = re.search(r"union\(参考・旧実装\)\s*\(n=\d+\):\s*([+-]?\d+\.\d+)", stdout)
    if m:
        info["union_corr"] = float(m.group(1))

    # 同日決済の内訳
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

    # 全営業日カバレッジ（[全営業日カバレッジ] セクション内のみ）
    cov_section = re.search(r"\[全営業日カバレッジ\](.*?)\[月次相関\]", stdout, re.DOTALL)
    if cov_section:
        s = cov_section.group(1)
        m = re.search(r"両戦略同日決済:\s*(\d+)日", s)
        if m:
            info["coverage_both_active"] = int(m.group(1))
        m = re.search(r"片戦略のみ決済:\s*(\d+)日", s)
        if m:
            info["coverage_one_active"] = int(m.group(1))
        m = re.search(r"両戦略アクティブ可・無決済:\s*(\d+)日", s)
        if m:
            info["coverage_both_idle"] = int(m.group(1))
        m = re.search(r"両戦略halt\(共通フィルター発火\):\s*(\d+)日", s)
        if m:
            info["coverage_halt_total"] = int(m.group(1))
        m = re.search(r"breadth\s*<[^:]*:\s*(\d+)日", s)
        if m:
            info["halt_breadth_lower"] = int(m.group(1))
        m = re.search(r"breadth\s*>[^:]*:\s*(\d+)日", s)
        if m:
            info["halt_breadth_upper"] = int(m.group(1))
        m = re.search(r"日経\s*<\s*SMA50:\s*(\d+)日", s)
        if m:
            info["halt_index_below"] = int(m.group(1))
        m = re.search(r"VIX\s*>[^:]*:\s*(\d+)日", s)
        if m:
            info["halt_vix_crisis"] = int(m.group(1))

    return info


def parse_monthly(stdout: str) -> list[dict]:
    """月次相関テーブルをパース。新フォーマット: 月 | 相関(全営業日) | 両Active日 | 信頼性"""
    months: list[dict] = []
    section = re.search(r"\[月次相関\](.*?)\[判定\]", stdout, re.DOTALL)
    if not section:
        return months
    for line in section.group(1).splitlines():
        # 例: "  2026-04 |  +0.964 |          4 |  "
        m = re.match(r"\s*(\d{4}-\d{2})\s*\|\s*([+-]?\d+\.\d+)\s*\|\s*(\d+)\s*\|\s*(✓|\s)?", line)
        if m:
            n = int(m.group(3))
            months.append({
                "month": m.group(1),
                "corr": float(m.group(2)),
                "n": n,
                "reliable": n >= MIN_RELIABLE_MONTHLY_N,
            })
    return months


def build_alerts(overall: dict, monthly: list[dict]) -> list[str]:
    alerts: list[str] = []

    # 全営業日相関を主指標とする（halt/idle 含むポートフォリオ実態）
    if overall["fullday_corr"] is not None and overall["fullday_corr"] > ALERT_OVERALL_CORR:
        alerts.append(
            f":warning: *全営業日相関 {overall['fullday_corr']:.3f}* が閾値 {ALERT_OVERALL_CORR} を超過 "
            f"（戦略間で独立性が失われている可能性）"
        )

    # 月次相関は信頼サンプル(n≥10)のみで判定
    reliable_recent = [m for m in monthly[-3:] if m["reliable"]]
    high_corr_recent = [m for m in reliable_recent if m["corr"] > ALERT_OVERALL_CORR]
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

    # halt比率が40%以上 → 共通フィルター発火が多すぎ＝稼働率懸念
    if overall["trading_days"] and overall["coverage_halt_total"] is not None:
        ratio = overall["coverage_halt_total"] / overall["trading_days"]
        if ratio > ALERT_HALT_RATIO:
            alerts.append(
                f":warning: halt比率 {ratio*100:.0f}% (>{ALERT_HALT_RATIO*100:.0f}%) "
                f"({overall['coverage_halt_total']}/{overall['trading_days']}日) — 稼働率低下"
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
    if overall["fullday_corr"] is not None:
        overall_lines.append(f"*全営業日相関*: *{overall['fullday_corr']:.3f}*  (halt/idle日含む実態)")
    if overall["both_active_corr"] is not None:
        overall_lines.append(f"両アクティブ日のみ相関: {overall['both_active_corr']:+.3f}")
    if overall["trading_days"] is not None:
        overall_lines.append(f"営業日数: {overall['trading_days']}日")
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

    # 全営業日カバレッジ: 撤退日の可視化
    if overall["trading_days"] and overall["coverage_halt_total"] is not None:
        td = overall["trading_days"]
        def fmt(n, label):
            return f"{label}: {n}日 ({n/td*100:.1f}%)" if n is not None else f"{label}: -"
        cov_lines = [
            fmt(overall["coverage_both_active"], "両戦略同日決済"),
            fmt(overall["coverage_one_active"], "片戦略のみ決済"),
            fmt(overall["coverage_both_idle"], "両アクティブ可・無決済"),
            f"*両戦略halt(共通フィルター発火): {overall['coverage_halt_total']}日 ({overall['coverage_halt_total']/td*100:.1f}%)*",
        ]
        halt_breakdown = []
        if overall["halt_breadth_lower"] is not None:
            halt_breakdown.append(f"breadth下限veto {overall['halt_breadth_lower']}")
        if overall["halt_breadth_upper"] is not None:
            halt_breakdown.append(f"上限veto {overall['halt_breadth_upper']}")
        if overall["halt_index_below"] is not None:
            halt_breakdown.append(f"日経<SMA50 {overall['halt_index_below']}")
        if overall["halt_vix_crisis"] is not None:
            halt_breakdown.append(f"VIX crisis {overall['halt_vix_crisis']}")
        if halt_breakdown:
            cov_lines.append("  └ " + " / ".join(halt_breakdown))
        fields.append({
            "title": "全営業日カバレッジ",
            "value": "\n".join(cov_lines),
            "short": False,
        })

    if monthly:
        recent = monthly[-6:]
        lines = []
        for m in recent:
            flag = " ✓" if m["reliable"] else "  (n<10 参考値)"
            lines.append(f"{m['month']}: {m['corr']:+.3f} (n={m['n']}){flag}")
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
    notify_slack(True, fields, alerts)


if __name__ == "__main__":
    main()
