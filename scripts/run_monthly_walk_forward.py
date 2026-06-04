"""
Monthly Walk-Forward Analysis Runner

A階層(現役): gapup, psc → 劣化検知 (停止提案)
B階層(復活候補): weekly-break(--largecap), momentum(--largecap)
                → 堅牢化検知 (復活検討提案)

C階層(構造的却下: breakout/nr7/gapdown-reversal/ma-pullback/ddr/evs/ogf/earnings-gap/
stop-high/squeeze-breakout) は対象外。年1回手動見直し。
squeeze-breakout は WF で恒常的に過学習 (2026-06 OOS PF 0.65) かつ既に
ENTRY_ENABLED=false のため、毎月回してもノイズにしかならず C階層へ格下げ (2026-06-04)。

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


# 監視対象戦略の定義
# tier: "active"   = 本番稼働中 → 劣化したら ENTRY_ENABLED=false 提案
#       "suspended" = combined資金競合等で本番停止中 → 堅牢化したら復活検討提案
STRATEGIES: list[dict] = [
    {"name": "gapup", "tier": "active", "extra_args": []},
    {"name": "psc", "tier": "active", "extra_args": []},
    {"name": "weekly-break", "tier": "suspended", "extra_args": ["--largecap"]},
    {"name": "momentum", "tier": "suspended", "extra_args": ["--largecap"]},
]


def run_walk_forward(strategy: str, extra_args: list[str]) -> tuple[int, str]:
    """Walk-forward スクリプトを実行し、(returncode, stdout) を返す"""
    cmd = f"walk-forward:{strategy}"
    label = strategy + (f" {' '.join(extra_args)}" if extra_args else "")
    print(f"\n{'='*60}")
    print(f"  {label} walk-forward 実行開始")
    print(f"{'='*60}\n")

    npm_args = ["npm", "run", cmd]
    if extra_args:
        npm_args.append("--")
        npm_args.extend(extra_args)

    result = subprocess.run(
        npm_args,
        capture_output=True,
        text=True,
        timeout=900,  # 15分タイムアウト (largecap時に時間がかかる戦略があるため)
    )

    # stdoutをそのまま表示（GitHub Actionsログ用）
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)

    return result.returncode, result.stdout


def parse_window_oos_pfs(stdout: str) -> list[float | None]:
    """[ウィンドウ別] テーブルから各窓の OOS PF を抽出する。

    休止窓は None。"∞" は math.inf として扱う。窓番号順 (1, 2, 3, ...) で返す。
    """
    pfs: list[float | None] = []
    section = re.search(r"\[ウィンドウ別\](.*?)(?=\[パラメータ安定性\]|\[本番パラメータ\]|\Z)", stdout, re.DOTALL)
    if not section:
        return pfs
    for line in section.group(1).splitlines():
        # 例: "  1    |   3.45 |   2.01 |  56.0%  |          25 | ..."
        # 例: "  2    |   2.34 |    休止 |      -  |           - | ..."
        m = re.match(r"\s*(\d+)\s*\|\s*[\d.∞]+\s*\|\s*([\d.∞休止]+)\s*\|", line)
        if not m:
            continue
        oos_str = m.group(2).strip()
        if "休止" in oos_str:
            pfs.append(None)
        elif oos_str == "∞":
            pfs.append(float("inf"))
        else:
            try:
                pfs.append(float(oos_str))
            except ValueError:
                pfs.append(None)
    return pfs


def detect_disable_proposal(oos_pfs: list[float | None], threshold: float = 1.0, lookback: int = 3) -> dict | None:
    """直近のOOS窓 lookback 個 (休止を除く) が全て threshold 未満なら停止提案を返す"""
    active = [p for p in oos_pfs if p is not None]
    if len(active) < lookback:
        return None
    recent = active[-lookback:]
    if all(p < threshold for p in recent):
        return {
            "lookback": lookback,
            "threshold": threshold,
            "recent_pfs": recent,
        }
    return None


def detect_revival_proposal(judgment: str, oos_pfs: list[float | None], threshold: float = 1.5, lookback: int = 2) -> dict | None:
    """suspended 戦略向け: 全体判定が「堅牢」かつ直近OOS窓 lookback 個 (休止を除く) が
    全て threshold 以上なら本番復活検討の提案を返す。

    threshold=1.5 は「OOS PF >= 1.5 が継続的に出ている」という強めの条件。
    本番投入は combined BT で Calmar 改善が確認できた時に最終判断するため、
    ここは "再評価のトリガー" の役割。
    """
    if "堅牢" not in judgment:
        return None
    active = [p for p in oos_pfs if p is not None]
    if len(active) < lookback:
        return None
    recent = active[-lookback:]
    if all(p >= threshold for p in recent):
        return {
            "lookback": lookback,
            "threshold": threshold,
            "recent_pfs": recent,
        }
    return None


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
        "window_oos_pfs": [],
        "disable_proposal": None,
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
    m = re.search(r"(\[パラメータ安定性\].*?)\[本番パラメータ\]", stdout, re.DOTALL)
    if m:
        info["param_stability"] = m.group(1).strip()
    else:
        # フォールバック（本番パラメータセクションがない場合）
        m = re.search(r"(\[パラメータ安定性\].*?)$", stdout, re.DOTALL)
        if m:
            info["param_stability"] = m.group(1).strip()

    # 本番パラメータ
    m = re.search(r"\[本番パラメータ\](.*?)$", stdout, re.DOTALL)
    if m:
        info["production_params"] = m.group(1).strip()

    # 窓別 OOS PF + 提案判定
    # disable_proposal / revival_proposal は呼び出し側で tier に応じて参照する
    info["window_oos_pfs"] = parse_window_oos_pfs(stdout)
    info["disable_proposal"] = detect_disable_proposal(info["window_oos_pfs"])
    info["revival_proposal"] = detect_revival_proposal(info["judgment"], info["window_oos_pfs"])

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

    # 本番パラメータをプロンプトテンプレートに注入
    production_params_lines: list[str] = []
    for r in results:
        if r["success"] and "production_params" in r["info"]:
            production_params_lines.append(f"- {r['strategy']}: {r['info']['production_params']}")
    production_params_text = "\n".join(production_params_lines) if production_params_lines else "（取得失敗）"

    prompt_path = os.path.join(os.path.dirname(__file__), "..", "prompts", "walk-forward-evaluation.txt")
    with open(prompt_path, encoding="utf-8") as f:
        system_prompt = f.read().replace("{production_params}", production_params_text)

    messages = [
        {
            "role": "system",
            "content": system_prompt,
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
    disable_proposals: list[str] = []
    revival_proposals: list[str] = []

    for r in results:
        strategy = r["strategy"]
        tier = r["tier"]
        info = r["info"]
        success = r["success"]
        tier_label = "[現役]" if tier == "active" else "[停止中]"

        if not success:
            has_failure = True
            fields.append({
                "title": f"{tier_label} {strategy}",
                "value": "実行失敗",
                "short": True,
            })
            continue

        is_robust = "堅牢" in info["judgment"]
        emoji = "" if is_robust else ""

        fields.append({
            "title": f"{tier_label} {strategy} {emoji}",
            "value": (
                f"判定: {info['judgment']}\n"
                f"OOS PF: {info['oos_pf']} / IS/OOS比: {info['is_oos_ratio']}\n"
                f"窓: {info['active_windows']} / {info['total_trades']}tr / 勝率{info['win_rate']}"
            ),
            "short": False,
        })

        # active戦略のみ disable提案を見る
        if tier == "active":
            proposal = info.get("disable_proposal")
            if proposal:
                recent_str = " → ".join(f"{p:.2f}" for p in proposal["recent_pfs"])
                disable_proposals.append(
                    f"*{strategy}*: 直近{proposal['lookback']}窓のOOS PF が全て{proposal['threshold']}未満 ({recent_str})"
                )

        # suspended戦略のみ revival提案を見る
        if tier == "suspended":
            proposal = info.get("revival_proposal")
            if proposal:
                recent_str = " → ".join(f"{p:.2f}" for p in proposal["recent_pfs"])
                revival_proposals.append(
                    f"*{strategy}*: 全体判定「堅牢」かつ直近{proposal['lookback']}窓のOOS PF が全て{proposal['threshold']}以上 ({recent_str})"
                )

    if disable_proposals:
        fields.append({
            "title": ":octagonal_sign: ENTRY_ENABLED=false 提案 (active戦略の劣化)",
            "value": (
                "以下の戦略で OOS の継続劣化を検知。本番停止を検討してください:\n"
                + "\n".join(disable_proposals)
                + "\n\n判断は手動。承認後 `lib/constants/<strategy>.ts` の ENTRY_ENABLED を false に変更"
            ),
            "short": False,
        })

    if revival_proposals:
        fields.append({
            "title": ":sparkles: 復活検討提案 (suspended戦略の堅牢化)",
            "value": (
                "以下の停止中戦略で OOS が継続的に堅牢化。combined BT で Calmar 改善を確認の上、本番投入を検討してください:\n"
                + "\n".join(revival_proposals)
                + "\n\n次ステップ: `npm run backtest:combined -- --enable-wb-largecap` 等で Calmar 比較 (combined-compare ジョブの結果も参照)"
            ),
            "short": False,
        })

    if ai_review:
        fields.append({
            "title": "AI評価",
            "value": ai_review,
            "short": False,
        })

    if has_failure:
        color = "danger"
    elif disable_proposals:
        color = "danger"  # active劣化は高優先
    elif revival_proposals:
        color = "warning"
    else:
        color = "good"
    title = "Monthly Walk-Forward 結果"

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


def main():
    results = []
    any_failure = False

    for s in STRATEGIES:
        strategy = s["name"]
        tier = s["tier"]
        extra_args = s["extra_args"]
        try:
            returncode, stdout = run_walk_forward(strategy, extra_args)
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
            "tier": tier,
            "extra_args": extra_args,
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
        tier_label = "active" if r["tier"] == "active" else "suspended"
        print(f"  [{tier_label:9s}] {r['strategy']:18s} [{status}] 判定: {judgment}  OOS PF: {pf}")

    if any_failure:
        sys.exit(1)


if __name__ == "__main__":
    main()
