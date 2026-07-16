"""
Monthly Baseline Health Runner

本番構成 baseline (GU3+PSC2) の combined BT を直近24ヶ月ローリング窓・現運用規模
(¥500K) で実行し、絶対値指標 (Calmar / MaxDD) の劣化を検知する。

旧 run_monthly_combined_compare.py (strategy-mix 比較: baseline vs +WB/+MOM) は
KOH-516 で撤去 (2026-07-05)。理由:
- KOH-511/512 で「大型株戦略は substitute であり加算候補ではない」と決着済み
- offseason は baseline Calmar が構造的に下がるため、休止戦略が Calmar で
  「勝った」ように見える誤検知を毎月出すだけだった (2026-07 の +WB 提案が実例)
再評価は ¥10M+ 運用への移行時に手動で行う (CLAUDE.md 復活判定の論理を参照)。

季節性対応 (KOH-516):
- BT窓を「2024-03-01 固定開始 (毎月伸びる)」→「直近24ヶ月ローリング」に変更。
  固定開始だと offseason 長期化で Calmar が機械的に希釈され、閾値と比較不能になる
- Calmar info は offseason では構造的に割れるため FYI 扱い (警告にしない)。
  警告として扱うのは Calmar danger と MaxDD warning/danger のみ

閾値の実値は下の BASELINE_* 定数を参照 (エンジン修正や本番パラメータ変更のたびに
較正し直すため、docstring には数値を書かない)。

Usage:
  python scripts/run_monthly_baseline_health.py
"""

import subprocess
import sys
import os
import re
import json
import urllib.request
from datetime import date


SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# WF ジョブが artifact で残した結果 (統合レビューの片翼)
WF_RESULTS_PATH = os.getenv("WF_RESULTS_PATH", "wf-results.json")
CAPTAIN_PROMPT_PATH = os.path.join(
    os.path.dirname(__file__), "..", "prompts", "monthly-strategy-captain.txt"
)

# 本番運用規模。閾値の較正元 (2026-07-16 baseline Calmar=28.1, MaxDD=11.0%) も ¥500K
BUDGET = 500_000

# ローリング窓の長さ (月)
WINDOW_MONTHS = 24

# baseline絶対値劣化検知の閾値
#
# ⚠️ 本番パラメータを変えたら、この較正元も measure し直すこと (KOH-564)。
#    閾値は「baseline に対する相対値」として設計されているので、baseline を動かす変更
#    (出口パラメータ・エントリー条件・枠 等) を入れると意図した比率が崩れる。
#
# 較正の履歴:
#   2026-07-15 KOH-548: 却下 #39 (exit-checker のイントラバー先読み修正) で baseline の
#     絶対値が動いたため再較正。同一窓 (24ヶ月ローリング, ¥500K) の実測:
#       旧 end-of-bar   : Calmar  8.77 / MaxDD 10.7%  ← 旧較正元 (9.37 / 10.0%) と整合
#       新 stop-at-open : Calmar 32.8  / MaxDD 11.4%
#   2026-07-16 KOH-564: 上の 32.8 は **PSC trail=0.5 時代の baseline** だった。同日の
#     KOH-552 で trail 0.5→0.3 に変えた結果 baseline が下がり、較正元とずれていた。
#     同一窓 (2024-06-01 起点, ¥500K) での実測が原因を示す:
#       PSC trail=0.5 (較正時): Calmar 36.22 / MaxDD  8.8%
#       PSC trail=0.3 (現行)  : Calmar 25.18 / MaxDD 10.0%   ← -30%
#     ヘルスチェックの実窓 (2024-07-01 起点) では Calmar 28.1 / MaxDD 11.0%。
#     実害は出ていなかった (28.1 は全閾値の正常圏内) が、INFO までの余裕が 15% しか
#     残っておらず、offseason で baseline が少し下がるだけで FYI が鳴く状態だった。
#
# 閾値の「意図」(較正元に対する比率) は KOH-548 から不変。較正元だけ現行 baseline に
# 置き直す。据え置くと INFO が実質「baseline の 85%」= ノイズ源になる。
#
# Calmar warning は offseason で構造的に割れるため info (FYI) 扱い (KOH-516)
# danger は本番運用見直しを検討すべき水準
BASELINE_CALMAR_INFO = 20.6     # FYI: 較正元 28.1 の約73%。offseason 中は想定内
BASELINE_CALMAR_DANGER = 14.6   # 較正元から約-48%
BASELINE_MAXDD_WARNING = 14.0   # 通常 ~11.0% から +30% (DDはレジーム問わず意味を持つ)
BASELINE_MAXDD_DANGER = 20.0    # 通常 ~11.0% から +80%


def rolling_window_start(today: date, months: int = WINDOW_MONTHS) -> str:
    """直近 `months` ヶ月ローリング窓の開始日 (月初) を YYYY-MM-DD で返す"""
    total = today.year * 12 + (today.month - 1) - months
    return f"{total // 12:04d}-{total % 12 + 1:02d}-01"


def run_baseline(start: str) -> tuple[int, str]:
    """baseline (GU3+PSC2) の combined BT を実行"""
    cmd = [
        "npm", "run", "backtest:combined", "--",
        "--start", start,
        "--budget", str(BUDGET),
    ]
    print(f"\n{'='*60}")
    print(f"  baseline combined BT 実行開始 (start={start}, budget=¥{BUDGET:,})")
    print(f"{'='*60}\n")

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=1800,  # 30分タイムアウト
    )

    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)

    return result.returncode, result.stdout


def _parse_metric_block(block: str) -> dict:
    """printMetrics 形式のブロックから指標を抽出する"""
    metrics: dict = {}
    m = re.search(r"トレード数:\s*(\d+)", block)
    if m:
        metrics["trades"] = int(m.group(1))
    m = re.search(r"勝率:\s*([\d.]+)%", block)
    if m:
        metrics["win_rate"] = float(m.group(1))
    m = re.search(r"PF:\s*([\d.]+|∞)", block)
    if m:
        metrics["pf"] = float("inf") if m.group(1) == "∞" else float(m.group(1))
    m = re.search(r"期待値:\s*([+-]?[\d.]+)%", block)
    if m:
        metrics["expect"] = float(m.group(1))
    m = re.search(r"最大DD:\s*([\d.]+)%", block)
    if m:
        metrics["max_dd"] = float(m.group(1))
    m = re.search(r"純損益:\s*¥[-\d,]+\s*\(([+-]?[\d.]+)%\)", block)
    if m:
        metrics["net_ret"] = float(m.group(1))
    return metrics


def parse_results(stdout: str, years: float) -> dict:
    """combined-run のプレーン出力から [全体] / [GapUp] / [PostSurgeConsolidation] を抽出"""
    rows: dict[str, dict] = {}
    for label in ["全体", "GapUp", "PostSurgeConsolidation"]:
        m = re.search(rf"\[{label}\](.*?)(?=\n\[|\Z)", stdout, re.DOTALL)
        if not m:
            continue
        metrics = _parse_metric_block(m.group(1))
        # Calmar (年率) = (NetRet / years) / MaxDD — compare-strategy-mix と同じ定義
        net_ret = metrics.get("net_ret")
        max_dd = metrics.get("max_dd")
        if net_ret is not None and max_dd is not None and max_dd > 0 and years > 0:
            metrics["calmar"] = round((net_ret / years) / max_dd, 2)
        rows[label] = metrics
    return {"rows": rows}


def detect_baseline_degradation(parsed: dict) -> dict | None:
    """baseline (全体) の絶対値劣化を検知する。

    Returns None if healthy. Otherwise dict with:
    - severity: "info" (FYI, offseason想定内) / "warning" / "danger"
    - alerts: list of human-readable strings
    """
    baseline = parsed["rows"].get("全体")
    if not baseline:
        return None

    calmar = baseline.get("calmar")
    max_dd = baseline.get("max_dd")
    if calmar is None or max_dd is None:
        return None

    alerts: list[str] = []
    severity = "ok"

    def bump(level: str) -> None:
        nonlocal severity
        order = ["ok", "info", "warning", "danger"]
        if order.index(level) > order.index(severity):
            severity = level

    if calmar < BASELINE_CALMAR_DANGER:
        alerts.append(f"Calmar {calmar} < {BASELINE_CALMAR_DANGER} (danger閾値)")
        bump("danger")
    elif calmar < BASELINE_CALMAR_INFO:
        alerts.append(
            f"Calmar {calmar} < {BASELINE_CALMAR_INFO} (参考: offseason 中は想定内の圧縮)"
        )
        bump("info")

    if max_dd > BASELINE_MAXDD_DANGER:
        alerts.append(f"MaxDD {max_dd}% > {BASELINE_MAXDD_DANGER}% (danger閾値)")
        bump("danger")
    elif max_dd > BASELINE_MAXDD_WARNING:
        alerts.append(f"MaxDD {max_dd}% > {BASELINE_MAXDD_WARNING}% (warning閾値)")
        bump("warning")

    if not alerts:
        return None

    return {
        "severity": severity,
        "alerts": alerts,
        "baseline_calmar": calmar,
        "baseline_max_dd": max_dd,
    }


def load_wf_results() -> list[dict]:
    """WF ジョブが artifact で残した wf-results.json を読み込む。

    WF ジョブ失敗時や artifact 未取得時は空リストを返し、baseline 単独でレビューする。
    """
    try:
        with open(WF_RESULTS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            print(f"WF結果を読み込み: {WF_RESULTS_PATH} ({len(data)}戦略)")
            return data
    except FileNotFoundError:
        print(f"WF結果なし ({WF_RESULTS_PATH}) — baseline 単独で統合レビューを生成")
    except Exception as e:
        print(f"WF結果の読み込み失敗: {e}", file=sys.stderr)
    return []


def _build_wf_section(wf_results: list[dict]) -> tuple[str, str]:
    """WF結果から (レビュー用テキスト, 本番パラメータテキスト) を組み立てる"""
    if not wf_results:
        return "（WF結果を取得できず。baseline の情報のみで評価する）", "（取得失敗）"

    lines: list[str] = []
    prod_lines: list[str] = []
    for r in wf_results:
        if not r.get("success"):
            lines.append(f"## {r.get('strategy')} [現役]\n実行失敗")
            continue
        info = r.get("info", {})
        flag_notes: list[str] = []
        if info.get("disable_proposal"):
            p = info["disable_proposal"]
            recent = " → ".join(f"{x:.2f}" for x in p["recent_pfs"])
            flag_notes.append(
                f"[disable_proposal] 直近{p['lookback']}窓 OOS PF 全て<{p['threshold']} ({recent}) "
                f"※トレード数<{p.get('min_trades', 5)}の発火薄窓は除外済み"
            )
        flags = ("\n- 機械フラグ: " + " / ".join(flag_notes)) if flag_notes else ""
        lines.append(
            f"## {r.get('strategy')} [現役]\n"
            f"- 判定: {info.get('judgment')}\n"
            f"- OOS集計PF: {info.get('oos_pf')} / IS/OOS比: {info.get('is_oos_ratio')}\n"
            f"- アクティブ窓: {info.get('active_windows')} / 総トレード: {info.get('total_trades')} / 勝率: {info.get('win_rate')}"
            f"{flags}"
        )
        if "production_params" in info:
            prod_lines.append(f"- {r.get('strategy')}: {info['production_params']}")

    prod_text = "\n".join(prod_lines) if prod_lines else "（取得失敗）"
    return "\n\n".join(lines), prod_text


def _build_baseline_section(parsed: dict, degradation: dict | None, start: str) -> str:
    """baseline BT 結果からレビュー用テキストを組み立てる"""
    rows = parsed.get("rows", {})
    baseline = rows.get("全体", {})
    lines: list[str] = [f"BT窓: {start} 〜 今日 (直近{WINDOW_MONTHS}ヶ月ローリング, ¥{BUDGET:,})"]
    if baseline:
        lines.append(
            f"baseline (GU3+PSC2) 全体: Calmar {baseline.get('calmar')} / NetRet {baseline.get('net_ret')}% / "
            f"MaxDD {baseline.get('max_dd')}% / PF {baseline.get('pf')} / {baseline.get('trades')}tr"
        )
    for label, name in [("GapUp", "GapUp"), ("PostSurgeConsolidation", "PSC")]:
        row = rows.get(label, {})
        if row:
            lines.append(
                f"{name}: PF {row.get('pf')} / 期待値 {row.get('expect')}% / {row.get('trades')}tr"
            )
    if degradation:
        lines.append(
            f"[baseline劣化検知/{degradation['severity']}] " + " / ".join(degradation["alerts"])
        )
    else:
        lines.append("[baseline劣化検知] なし (健全)")
    return "\n".join(lines)


def generate_captain_review(
    parsed: dict,
    degradation: dict | None,
    wf_results: list[dict],
    baseline_success: bool,
    start: str,
) -> str:
    """WF + baseline を束ねた統合 AI レビュー (艦長レイヤー) を gpt-4o-mini で生成する。

    Returns Slack 表示用の整形テキスト。失敗時は空文字。
    """
    if not OPENAI_API_KEY:
        print("OPENAI_API_KEY 未設定、統合レビューをスキップ")
        return ""

    wf_section, prod_text = _build_wf_section(wf_results)
    baseline_section = (
        _build_baseline_section(parsed, degradation, start)
        if baseline_success
        else "baseline combined BT は実行失敗。WF のみで評価する。"
    )

    try:
        with open(CAPTAIN_PROMPT_PATH, encoding="utf-8") as f:
            system_prompt = f.read().replace("{production_params}", prod_text)
    except Exception as e:
        print(f"プロンプト読み込み失敗: {e}", file=sys.stderr)
        return ""

    user_content = (
        "今月のWalk-Forward結果 (現役: gapup / psc):\n\n"
        f"{wf_section}\n\n"
        "==============================\n\n"
        "今月の baseline (GU3+PSC2) ヘルス:\n\n"
        f"{baseline_section}"
    )

    payload = {
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.2,
        "max_tokens": 700,
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
            parsed_review = json.loads(content)
    except Exception as e:
        print(f"統合レビュー失敗: {e}", file=sys.stderr)
        return ""

    summary = (parsed_review.get("summary") or "").strip()
    verdicts = parsed_review.get("flag_verdicts") or []
    action = (parsed_review.get("action") or "").strip()

    print(f"\n[統合レビュー] {summary}")
    for v in verdicts:
        print(f"  - {v}")
    print(f"[推奨アクション] {action}")

    parts = [summary] if summary else []
    if verdicts:
        parts.append("*フラグ判定:*\n" + "\n".join(f"• {v}" for v in verdicts))
    if action:
        parts.append(f"*推奨アクション:* {action}")
    return "\n\n".join(parts)


def notify_slack(
    parsed: dict,
    degradation: dict | None,
    success: bool,
    start: str,
    captain_review: str = "",
) -> None:
    if not SLACK_WEBHOOK_URL:
        print("SLACK_WEBHOOK_URL 未設定、Slack通知をスキップ")
        return

    fields = []

    if not success:
        fields.append({
            "title": "実行失敗",
            "value": "baseline combined BT が失敗しました。GitHub Actionsログを確認してください。",
            "short": False,
        })
    else:
        # baseline 絶対値アラート (danger / warning のみ警告表示、info は FYI)
        if degradation and degradation["severity"] in ("danger", "warning"):
            emoji = ":octagonal_sign:" if degradation["severity"] == "danger" else ":warning:"
            fields.append({
                "title": f"{emoji} baseline 劣化検知 ({degradation['severity']})",
                "value": (
                    "baseline (GU3+PSC2) の絶対値指標が警戒水準を超過しました:\n"
                    + "\n".join(f"- {a}" for a in degradation["alerts"])
                    + (
                        "\n\n*danger水準*: 本番運用見直しを検討。原因調査 (相場レジーム変化 / 戦略劣化 / データ品質) の上、"
                        "必要なら一時停止も検討してください。"
                        if degradation["severity"] == "danger"
                        else "\n\n*warning水準*: 通常運用範囲を逸脱。次月の数値も併せて観察してください。"
                    )
                ),
                "short": False,
            })

        rows = parsed["rows"]
        baseline = rows.get("全体", {})
        if baseline:
            summary_lines = [
                f"*baseline (GU3+PSC2)*: Calmar {baseline.get('calmar', 'N/A')} / NetRet {baseline.get('net_ret', 'N/A')}% / "
                f"MaxDD {baseline.get('max_dd', 'N/A')}% / PF {baseline.get('pf', 'N/A')} / {baseline.get('trades', 'N/A')}tr",
            ]
            for label, name in [("GapUp", "GapUp"), ("PostSurgeConsolidation", "PSC")]:
                row = rows.get(label, {})
                if row:
                    summary_lines.append(
                        f"*{name}*: PF {row.get('pf', 'N/A')} / 期待値 {row.get('expect', 'N/A')}% / {row.get('trades', 'N/A')}tr"
                    )
            summary_lines.append(f"_BT窓: {start} 〜 (直近{WINDOW_MONTHS}ヶ月ローリング, ¥{BUDGET:,})_")
            fields.append({
                "title": "Baseline ヘルス",
                "value": "\n".join(summary_lines),
                "short": False,
            })

        # FYI (info): offseason 想定内の Calmar 圧縮
        if degradation and degradation["severity"] == "info":
            fields.append({
                "title": ":information_source: 参考 (offseason 想定内)",
                "value": (
                    "\n".join(f"- {a}" for a in degradation["alerts"])
                    + "\n\nGU/PSC は D期でだけ大きく稼ぐシーズン性戦略のため、offseason の Calmar 圧縮は劣化ではありません。"
                    "D期入りの検知は regime-shift-notify (強気モニター) が担当します。"
                ),
                "short": False,
            })
        elif not degradation:
            fields.append({
                "title": "結論",
                "value": "baseline (GU3+PSC2) は健全水準。変更不要。",
                "short": False,
            })

    # 統合 AI レビュー (艦長レイヤー: WF + baseline を束ねた所見)
    if captain_review:
        fields.append({
            "title": ":compass: 統合レビュー (WF + baseline)",
            "value": captain_review,
            "short": False,
        })

    # 色: 実行失敗/danger > warning > 正常 (info は正常色)
    if not success:
        color = "danger"
    elif degradation and degradation["severity"] == "danger":
        color = "danger"
    elif degradation and degradation["severity"] == "warning":
        color = "warning"
    else:
        color = "good"

    payload = {
        "attachments": [{
            "fallback": "Monthly Baseline Health",
            "color": color,
            "title": "Monthly Baseline Health (GU3+PSC2)",
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


def main():
    today = date.today()
    start = rolling_window_start(today)
    start_date = date.fromisoformat(start)
    years = (today - start_date).days / 365.25

    try:
        returncode, stdout = run_baseline(start)
        success = returncode == 0
    except subprocess.TimeoutExpired:
        print("baseline combined BT タイムアウト", file=sys.stderr)
        success = False
        stdout = ""
    except Exception as e:
        print(f"baseline combined BT エラー: {e}", file=sys.stderr)
        success = False
        stdout = ""

    parsed = parse_results(stdout, years) if success else {"rows": {}}
    degradation = detect_baseline_degradation(parsed) if success else None

    # WF 結果 (artifact) を読み込み、WF + baseline を束ねた統合レビューを生成
    wf_results = load_wf_results()
    captain_review = generate_captain_review(
        parsed, degradation, wf_results, success, start
    )

    notify_slack(parsed, degradation, success, start, captain_review)

    print(f"\n{'='*60}")
    print("  サマリー")
    print(f"{'='*60}")
    if success:
        baseline = parsed["rows"].get("全体", {})
        print(f"  BT窓: {start} 〜 {today} ({years:.2f}年, ¥{BUDGET:,})")
        print(f"  baseline: Calmar {baseline.get('calmar', 'N/A')} / MaxDD {baseline.get('max_dd', 'N/A')}% / NetRet {baseline.get('net_ret', 'N/A')}%")
        if degradation:
            print(f"  劣化検知: severity={degradation['severity']}")
            for a in degradation["alerts"]:
                print(f"    - {a}")
        else:
            print("  劣化検知: なし (健全)")
    else:
        print("  実行失敗")

    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
