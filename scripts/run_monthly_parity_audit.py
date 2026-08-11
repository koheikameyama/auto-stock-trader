"""
Monthly live↔BT Parity Audit Runner

audit-live-vs-bt-parity.ts を実行し、本番約定と BT precompute の一致率を Slack に報告する。

背景 (KOH-606): 2026-08-03 の使い捨て監査が一致 12/39 (30.8%) を検出し、
N225 SMA50 フィルターが本番だけ4ヶ月外れていた乖離を発見した。SMA50 (①日次フィルター) も
minAvgVolume (②ユニバース) も「静かに入り込み、月次では誰も見ていない」タイプの乖離
だったため、月次ヘルスチェックに常設して検知を1ヶ月以内に縮める。

severity の設計:
- ①日次マーケットフィルター / ②ユニバースゲート の不一致は「本番とBTが違う戦略を
  実行している」系統的乖離の疑い。件数が少なくても warning、3件以上で danger
  (SMA50 事故は ① が17件だった)。
- ③シグナル条件 の不一致は 15:24 スナップショット判定と確定終値判定の構造差で、
  少数 (過去実測 1/39) は正常。総数5件以上かつ 30% 超のときだけ warning。
- 監査窓にエントリーゼロは offseason では正常 (info)。

Usage:
  python scripts/run_monthly_parity_audit.py
"""

import json
import os
import subprocess
import sys
import urllib.request

SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "")

JSON_PATH = "parity-audit.json"
AUDIT_DAYS = 40  # 月次実行 (第1土曜) の間隔 + バッファ

CAUSE_DAY_FILTER = "①日次マーケットフィルター"
CAUSE_UNIVERSE = "②ユニバースゲート"
CAUSE_SIGNAL = "③シグナル条件"

# 系統的乖離 (①+②) の severity 閾値
SYSTEMIC_DANGER_COUNT = 3
# ③シグナル条件の許容率 (これを超え、かつ総数が十分なら warning)
SIGNAL_MISMATCH_WARN_RATE = 0.30
SIGNAL_MISMATCH_MIN_TOTAL = 5


def run_audit() -> tuple[bool, dict | None]:
    cmd = [
        "npx", "tsx", "scripts/audit-live-vs-bt-parity.ts",
        "--days", str(AUDIT_DAYS),
        "--json", JSON_PATH,
    ]
    print(f"\n{'='*60}")
    print(f"  live↔BT パリティ監査 実行開始 (直近{AUDIT_DAYS}日)")
    print(f"{'='*60}\n")

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    if result.returncode != 0:
        return False, None

    try:
        with open(JSON_PATH, encoding="utf-8") as f:
            return True, json.load(f)
    except Exception as e:
        print(f"JSON読み込み失敗: {e}", file=sys.stderr)
        return False, None


def evaluate(audit: dict) -> dict:
    """severity と表示行を組み立てる"""
    total = audit.get("total", 0)
    causes = audit.get("causes", {})
    systemic = causes.get(CAUSE_DAY_FILTER, 0) + causes.get(CAUSE_UNIVERSE, 0)
    signal_mism = causes.get(CAUSE_SIGNAL, 0)

    if total == 0:
        return {
            "severity": "info",
            "headline": "監査対象の約定なし (offseason のエントリーゼロは正常)",
            "lines": [],
        }

    lines = [
        f"一致 {audit['match']}/{total} ({audit['matchRate']}%)  "
        f"_監査窓: {audit['auditStart']} 〜 {audit['auditEnd']}_"
    ]
    for cause, n in sorted(causes.items(), key=lambda kv: -kv[1]):
        lines.append(f"- {cause}: {n}件")

    # 不一致の明細 (最大10件)
    mismatches = [o for o in audit.get("orders", []) if not o.get("hit")]
    for o in mismatches[:10]:
        st = "GU" if o["strategy"] == "gapup" else "PSC"
        lines.append(f"  ❌ {o['date']} {o['ticker']} {st} [{o['cause']}] {o['detail']}")
    if len(mismatches) > 10:
        lines.append(f"  … 他 {len(mismatches) - 10}件 (GitHub Actions ログ参照)")

    if systemic >= SYSTEMIC_DANGER_COUNT:
        severity = "danger"
        headline = (
            f"系統的乖離の疑い: ①②の不一致が {systemic}件。"
            "本番とBTが違う戦略を実行している可能性があります (SMA50 事故と同型)。"
            "gapup-config / watchlist-builder / market-assessment の突き合わせを行ってください。"
        )
    elif systemic >= 1:
        severity = "warning"
        headline = (
            f"①②の不一致が {systemic}件。単発なら経過観察、来月も出るなら系統的乖離を疑ってください。"
        )
    elif (
        total >= SIGNAL_MISMATCH_MIN_TOTAL
        and signal_mism / total > SIGNAL_MISMATCH_WARN_RATE
    ):
        severity = "warning"
        headline = (
            f"③シグナル条件の不一致率 {signal_mism}/{total} が許容 ({SIGNAL_MISMATCH_WARN_RATE:.0%}) を超過。"
            "15:24→引けの価格ドリフトが常態化していないか確認してください。"
        )
    elif signal_mism > 0:
        severity = "info"
        headline = f"③シグナル条件の不一致 {signal_mism}件のみ (15:24判定と確定終値の構造差。正常範囲)"
    else:
        severity = "ok"
        headline = "全約定が BT シグナルと一致。live↔BT パリティ健全。"

    return {"severity": severity, "headline": headline, "lines": lines}


def notify_slack(success: bool, evaluation: dict | None) -> None:
    if not SLACK_WEBHOOK_URL:
        print("SLACK_WEBHOOK_URL 未設定、Slack通知をスキップ")
        return

    if not success or evaluation is None:
        color = "danger"
        fields = [{
            "title": "実行失敗",
            "value": "パリティ監査の実行に失敗しました。GitHub Actionsログを確認してください。",
            "short": False,
        }]
    else:
        color = {
            "ok": "good", "info": "good", "warning": "warning", "danger": "danger"
        }[evaluation["severity"]]
        emoji = {
            "ok": ":white_check_mark:", "info": ":information_source:",
            "warning": ":warning:", "danger": ":octagonal_sign:",
        }[evaluation["severity"]]
        value = f"{emoji} {evaluation['headline']}"
        if evaluation["lines"]:
            value += "\n\n" + "\n".join(evaluation["lines"])
        fields = [{"title": "監査結果", "value": value, "short": False}]

    payload = {
        "attachments": [{
            "fallback": "Monthly live-BT Parity Audit",
            "color": color,
            "title": "Monthly live↔BT Parity Audit",
            "fields": fields,
            "footer": "Auto Stock Trader",
        }],
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        SLACK_WEBHOOK_URL, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        urllib.request.urlopen(req, timeout=10)
        print("Slack通知送信完了")
    except Exception as e:
        print(f"Slack通知失敗: {e}", file=sys.stderr)


def main():
    try:
        success, audit = run_audit()
    except subprocess.TimeoutExpired:
        print("パリティ監査タイムアウト", file=sys.stderr)
        success, audit = False, None
    except Exception as e:
        print(f"パリティ監査エラー: {e}", file=sys.stderr)
        success, audit = False, None

    evaluation = evaluate(audit) if success and audit is not None else None
    notify_slack(success, evaluation)

    print(f"\n{'='*60}")
    print("  サマリー")
    print(f"{'='*60}")
    if evaluation:
        print(f"  severity: {evaluation['severity']}")
        print(f"  {evaluation['headline']}")
    else:
        print("  実行失敗")

    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
