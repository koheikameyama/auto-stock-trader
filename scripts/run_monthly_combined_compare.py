"""
Monthly Combined Strategy Mix Comparison Runner

`npm run backtest:combined -- --compare-strategy-mix` を実行し、
baseline (GU3+PSC2) vs +WB / +MOM / +WB+MOM の Calmar を比較する。

suspended 戦略を入れた構成が baseline を Calmar で上回ったら ⚠️ Slack 通知。
本番投入の最終判断材料として使う (主KPI Calmar > PF > 期待値)。

Usage:
  python scripts/run_monthly_combined_compare.py
"""

import subprocess
import sys
import os
import re
import json
import urllib.request
from typing import Optional


SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# WF ジョブが artifact で残した結果 (統合レビューの片翼)
WF_RESULTS_PATH = os.getenv("WF_RESULTS_PATH", "wf-results.json")
CAPTAIN_PROMPT_PATH = os.path.join(
    os.path.dirname(__file__), "..", "prompts", "monthly-strategy-captain.txt"
)

# baseline絶対値劣化検知の閾値
# 根拠: 2026-04-22検証時 baseline Calmar=9.37, MaxDD=10.0%
# warning = 通常運用範囲を逸脱、要観察
# danger  = 本番運用見直しを検討すべき水準
BASELINE_CALMAR_WARNING = 7.0   # 現状から -25%
BASELINE_CALMAR_DANGER = 5.0    # 現状から -47%
BASELINE_MAXDD_WARNING = 13.0   # 通常 ~10% から +30%
BASELINE_MAXDD_DANGER = 18.0    # 通常 ~10% から +80%

# baseline 比較サマリー行のパース正規表現
# 例: "+WB largecap          |       +0.82 |      +12.3% |     -1.2%"
BASELINE_DIFF_LINE = re.compile(
    r"^\s*(\+WB largecap|\+MOM largecap|\+WB\+MOM)\s*\|\s*([+-]?[\d.]+)\s*\|\s*([+-]?[\d.]+)%\s*\|\s*([+-]?[\d.]+)%"
)

# Strategy Mix 比較行のパース (絶対値)
# 例: "baseline (GU3+PSC2)   |    474 | 45.4% |  3.23 |  +1.16% |  10.7% | +171.1% |   7.47 |  13.7%"
ABSOLUTE_LINE = re.compile(
    r"^\s*(baseline \(GU3\+PSC2\)|\+WB largecap|\+MOM largecap|\+WB\+MOM)\s*\|"
    r"\s*(\d+)\s*\|\s*([\d.]+)%\s*\|\s*([\d.∞]+)\s*\|"
    r"\s*([+-]?[\d.]+)%\s*\|\s*([\d.]+)%\s*\|\s*([+-]?[\d.]+)%\s*\|\s*([\d.]+)\s*\|"
)


def run_compare() -> tuple[int, str]:
    """combined-run の compare-strategy-mix を実行"""
    cmd = [
        "npm", "run", "backtest:combined", "--",
        "--compare-strategy-mix",
        "--start", "2024-03-01",  # CLAUDE.md レジーム別検証と同じ24ヶ月期間
        "--budget", "10000000",   # 大型株combined検証で使った¥10M
    ]
    print(f"\n{'='*60}")
    print("  compare-strategy-mix 実行開始")
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


def parse_results(stdout: str) -> dict:
    """combined-run の出力から各構成の指標を抽出する"""
    rows: dict[str, dict] = {}

    # 絶対値テーブルのパース
    for line in stdout.splitlines():
        m = ABSOLUTE_LINE.match(line)
        if not m:
            continue
        label = m.group(1)
        rows[label] = {
            "trades": int(m.group(2)),
            "win_rate": float(m.group(3)),
            "pf": float(m.group(4)) if m.group(4) != "∞" else float("inf"),
            "expect": float(m.group(5)),
            "max_dd": float(m.group(6)),
            "net_ret": float(m.group(7)),
            "calmar": float(m.group(8)),
        }

    # baseline比較サマリーのパース (差分)
    diffs: dict[str, dict] = {}
    in_diff_section = False
    for line in stdout.splitlines():
        if "[baseline比較サマリー]" in line:
            in_diff_section = True
            continue
        if not in_diff_section:
            continue
        m = BASELINE_DIFF_LINE.match(line)
        if not m:
            continue
        label = m.group(1)
        diffs[label] = {
            "calmar_diff": float(m.group(2)),
            "net_ret_diff": float(m.group(3)),
            "max_dd_diff": float(m.group(4)),
        }

    return {"rows": rows, "diffs": diffs}


def detect_revival_candidates(parsed: dict) -> list[dict]:
    """suspended 構成が baseline を Calmar で上回った構成を抽出"""
    candidates = []
    for label, diff in parsed["diffs"].items():
        if diff["calmar_diff"] > 0:
            row = parsed["rows"].get(label, {})
            base = parsed["rows"].get("baseline (GU3+PSC2)", {})
            candidates.append({
                "label": label,
                "calmar": row.get("calmar"),
                "calmar_diff": diff["calmar_diff"],
                "net_ret": row.get("net_ret"),
                "net_ret_diff": diff["net_ret_diff"],
                "max_dd": row.get("max_dd"),
                "max_dd_diff": diff["max_dd_diff"],
                "baseline_calmar": base.get("calmar"),
            })
    return candidates


def detect_baseline_degradation(parsed: dict) -> dict | None:
    """baseline (GU3+PSC2) の絶対値劣化を検知する。

    Returns None if baseline is healthy. Otherwise returns dict with:
    - severity: "warning" or "danger"
    - alerts: list of human-readable strings
    """
    baseline = parsed["rows"].get("baseline (GU3+PSC2)")
    if not baseline:
        return None

    calmar = baseline.get("calmar")
    max_dd = baseline.get("max_dd")
    if calmar is None or max_dd is None:
        return None

    alerts: list[str] = []
    severity = "ok"

    if calmar < BASELINE_CALMAR_DANGER:
        alerts.append(f"Calmar {calmar} < {BASELINE_CALMAR_DANGER} (danger閾値)")
        severity = "danger"
    elif calmar < BASELINE_CALMAR_WARNING:
        alerts.append(f"Calmar {calmar} < {BASELINE_CALMAR_WARNING} (warning閾値)")
        if severity == "ok":
            severity = "warning"

    if max_dd > BASELINE_MAXDD_DANGER:
        alerts.append(f"MaxDD {max_dd}% > {BASELINE_MAXDD_DANGER}% (danger閾値)")
        severity = "danger"
    elif max_dd > BASELINE_MAXDD_WARNING:
        alerts.append(f"MaxDD {max_dd}% > {BASELINE_MAXDD_WARNING}% (warning閾値)")
        if severity == "ok":
            severity = "warning"

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

    WF ジョブ失敗時や artifact 未取得時は空リストを返し、combined 単独でレビューする。
    """
    try:
        with open(WF_RESULTS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            print(f"WF結果を読み込み: {WF_RESULTS_PATH} ({len(data)}戦略)")
            return data
    except FileNotFoundError:
        print(f"WF結果なし ({WF_RESULTS_PATH}) — combined 単独で統合レビューを生成")
    except Exception as e:
        print(f"WF結果の読み込み失敗: {e}", file=sys.stderr)
    return []


def _build_wf_section(wf_results: list[dict]) -> tuple[str, str]:
    """WF結果から (レビュー用テキスト, 本番パラメータテキスト) を組み立てる"""
    if not wf_results:
        return "（WF結果を取得できず。combined の情報のみで評価する）", "（取得失敗）"

    lines: list[str] = []
    prod_lines: list[str] = []
    for r in wf_results:
        tier_label = "現役" if r.get("tier") == "active" else "停止中"
        if not r.get("success"):
            lines.append(f"## {r.get('strategy')} [{tier_label}]\n実行失敗")
            continue
        info = r.get("info", {})
        flag_notes: list[str] = []
        if r.get("tier") == "active" and info.get("disable_proposal"):
            p = info["disable_proposal"]
            recent = " → ".join(f"{x:.2f}" for x in p["recent_pfs"])
            flag_notes.append(f"[disable_proposal] 直近{p['lookback']}窓 OOS PF 全て<{p['threshold']} ({recent})")
        if r.get("tier") == "suspended" and info.get("revival_proposal"):
            p = info["revival_proposal"]
            recent = " → ".join(f"{x:.2f}" for x in p["recent_pfs"])
            flag_notes.append(f"[revival_proposal] 堅牢かつ直近{p['lookback']}窓 OOS PF 全て≥{p['threshold']} ({recent})")
        flags = ("\n- 機械フラグ: " + " / ".join(flag_notes)) if flag_notes else ""
        lines.append(
            f"## {r.get('strategy')} [{tier_label}]\n"
            f"- 判定: {info.get('judgment')}\n"
            f"- OOS集計PF: {info.get('oos_pf')} / IS/OOS比: {info.get('is_oos_ratio')}\n"
            f"- アクティブ窓: {info.get('active_windows')} / 総トレード: {info.get('total_trades')} / 勝率: {info.get('win_rate')}"
            f"{flags}"
        )
        if "production_params" in info:
            prod_lines.append(f"- {r.get('strategy')}: {info['production_params']}")

    prod_text = "\n".join(prod_lines) if prod_lines else "（取得失敗）"
    return "\n\n".join(lines), prod_text


def _build_combined_section(parsed: dict, candidates: list[dict], degradation: dict | None) -> str:
    """combined 比較結果からレビュー用テキストを組み立てる"""
    rows = parsed.get("rows", {})
    baseline = rows.get("baseline (GU3+PSC2)", {})
    lines: list[str] = []
    if baseline:
        lines.append(
            f"baseline (GU3+PSC2): Calmar {baseline.get('calmar')} / NetRet {baseline.get('net_ret')}% / "
            f"MaxDD {baseline.get('max_dd')}% / PF {baseline.get('pf')}"
        )
    for label in ["+WB largecap", "+MOM largecap", "+WB+MOM"]:
        row = rows.get(label, {})
        diff = parsed.get("diffs", {}).get(label, {})
        if row and diff:
            cd = diff.get("calmar_diff", 0.0)
            lines.append(
                f"{label}: Calmar {row.get('calmar')} ({'+' if cd >= 0 else ''}{cd:.2f} vs baseline) / "
                f"NetRet {row.get('net_ret')}% / MaxDD {row.get('max_dd')}%"
            )
    if degradation:
        lines.append(
            f"[baseline劣化検知/{degradation['severity']}] " + " / ".join(degradation["alerts"])
        )
    if candidates:
        for c in candidates:
            lines.append(
                f"[本番投入候補] {c['label']}: Calmar {c['calmar']} ({c['calmar_diff']:+.2f} vs baseline) / "
                f"NetRet {c['net_ret']}% ({c['net_ret_diff']:+.1f}%) / MaxDD {c['max_dd']}% ({c['max_dd_diff']:+.1f}%)"
            )
    else:
        lines.append("[本番投入候補] なし (baseline が Calmar で最良)")
    return "\n".join(lines)


def generate_captain_review(
    parsed: dict,
    candidates: list[dict],
    degradation: dict | None,
    wf_results: list[dict],
    combined_success: bool,
) -> str:
    """WF + combined を束ねた統合 AI レビュー (艦長レイヤー) を gpt-4o-mini で生成する。

    Returns Slack 表示用の整形テキスト。失敗時は空文字。
    """
    if not OPENAI_API_KEY:
        print("OPENAI_API_KEY 未設定、統合レビューをスキップ")
        return ""

    wf_section, prod_text = _build_wf_section(wf_results)
    combined_section = (
        _build_combined_section(parsed, candidates, degradation)
        if combined_success
        else "combined compare-strategy-mix は実行失敗。WF のみで評価する。"
    )

    try:
        with open(CAPTAIN_PROMPT_PATH, encoding="utf-8") as f:
            system_prompt = f.read().replace("{production_params}", prod_text)
    except Exception as e:
        print(f"プロンプト読み込み失敗: {e}", file=sys.stderr)
        return ""

    user_content = (
        "今月のWalk-Forward結果:\n\n"
        f"{wf_section}\n\n"
        "==============================\n\n"
        "今月のcombined戦略ミックス比較:\n\n"
        f"{combined_section}"
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


def notify_slack(parsed: dict, candidates: list[dict], degradation: dict | None, success: bool, captain_review: str = "") -> None:
    if not SLACK_WEBHOOK_URL:
        print("SLACK_WEBHOOK_URL 未設定、Slack通知をスキップ")
        return

    fields = []

    if not success:
        fields.append({
            "title": "実行失敗",
            "value": "combined compare-strategy-mix が失敗しました。GitHub Actionsログを確認してください。",
            "short": False,
        })
    else:
        # baseline 絶対値劣化アラート (最優先で表示)
        if degradation:
            severity_label = "danger" if degradation["severity"] == "danger" else "warning"
            emoji = ":octagonal_sign:" if degradation["severity"] == "danger" else ":warning:"
            fields.append({
                "title": f"{emoji} baseline 劣化検知 ({severity_label})",
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

        # 各構成のサマリーを1フィールドにまとめる
        rows = parsed["rows"]
        baseline = rows.get("baseline (GU3+PSC2)", {})
        if baseline:
            summary_lines = [
                f"*baseline (GU3+PSC2)*: Calmar {baseline.get('calmar', 'N/A')} / NetRet {baseline.get('net_ret', 'N/A')}% / MaxDD {baseline.get('max_dd', 'N/A')}% / PF {baseline.get('pf', 'N/A')}",
            ]
            for label in ["+WB largecap", "+MOM largecap", "+WB+MOM"]:
                row = rows.get(label, {})
                diff = parsed["diffs"].get(label, {})
                if row and diff:
                    calmar_diff = diff["calmar_diff"]
                    diff_emoji = "" if calmar_diff > 0 else ""
                    summary_lines.append(
                        f"*{label}* {diff_emoji}: Calmar {row.get('calmar', 'N/A')} ({'+' if calmar_diff >= 0 else ''}{calmar_diff:.2f}) / NetRet {row.get('net_ret', 'N/A')}% / MaxDD {row.get('max_dd', 'N/A')}%"
                    )
            fields.append({
                "title": "Strategy Mix 比較",
                "value": "\n".join(summary_lines),
                "short": False,
            })

        if candidates:
            cand_lines = []
            for c in candidates:
                cand_lines.append(
                    f"*{c['label']}*: Calmar {c['calmar']} ({c['calmar_diff']:+.2f} vs baseline {c['baseline_calmar']}) / "
                    f"NetRet {c['net_ret']}% ({c['net_ret_diff']:+.1f}%) / MaxDD {c['max_dd']}% ({c['max_dd_diff']:+.1f}%)"
                )
            fields.append({
                "title": ":sparkles: 本番投入候補 (suspended構成が baseline を Calmar で超過)",
                "value": (
                    "以下の構成で baseline より Calmar が高い結果。本番投入を検討してください:\n"
                    + "\n".join(cand_lines)
                    + "\n\n判断は手動。WF判定 (monthly-walk-forward の結果) と合わせて評価し、"
                    "問題なければ `combined-run.ts` の defaultLimits または production構成を変更"
                ),
                "short": False,
            })
        elif not degradation:
            fields.append({
                "title": "結論",
                "value": "baseline (GU3+PSC2) が Calmar で最良。suspended戦略の本番投入は不要。",
                "short": False,
            })

    # 統合 AI レビュー (艦長レイヤー: WF + combined を束ねた所見)
    if captain_review:
        fields.append({
            "title": ":compass: 統合レビュー (WF + combined)",
            "value": captain_review,
            "short": False,
        })

    # 色: baseline danger > 実行失敗 > baseline warning > 候補あり > 正常
    if not success:
        color = "danger"
    elif degradation and degradation["severity"] == "danger":
        color = "danger"
    elif degradation and degradation["severity"] == "warning":
        color = "warning"
    elif candidates:
        color = "warning"
    else:
        color = "good"

    payload = {
        "attachments": [{
            "fallback": "Monthly Combined Strategy Mix Comparison",
            "color": color,
            "title": "Monthly Combined Strategy Mix 比較",
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
    try:
        returncode, stdout = run_compare()
        success = returncode == 0
    except subprocess.TimeoutExpired:
        print("compare-strategy-mix タイムアウト", file=sys.stderr)
        success = False
        stdout = ""
    except Exception as e:
        print(f"compare-strategy-mix エラー: {e}", file=sys.stderr)
        success = False
        stdout = ""

    parsed = parse_results(stdout) if success else {"rows": {}, "diffs": {}}
    candidates = detect_revival_candidates(parsed) if success else []
    degradation = detect_baseline_degradation(parsed) if success else None

    # WF 結果 (artifact) を読み込み、WF + combined を束ねた統合レビューを生成
    wf_results = load_wf_results()
    captain_review = generate_captain_review(
        parsed, candidates, degradation, wf_results, success
    )

    notify_slack(parsed, candidates, degradation, success, captain_review)

    print(f"\n{'='*60}")
    print("  サマリー")
    print(f"{'='*60}")
    if success:
        print(f"  パース済み構成: {len(parsed['rows'])}件")
        print(f"  本番投入候補: {len(candidates)}件")
        for c in candidates:
            print(f"    - {c['label']}: Calmar {c['calmar']} ({c['calmar_diff']:+.2f} vs baseline)")
        if degradation:
            print(f"  baseline 劣化検知: severity={degradation['severity']}")
            for a in degradation["alerts"]:
                print(f"    - {a}")
        else:
            print(f"  baseline 劣化検知: なし (健全)")
    else:
        print("  実行失敗")

    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
