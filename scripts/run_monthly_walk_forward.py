"""
Monthly Walk-Forward Analysis Runner

現役戦略 (gapup, psc) のみを対象に WF を回し、構造的劣化を検知する (停止提案)。

B階層 (weekly-break/momentum --largecap の復活監視) は KOH-516 で撤去 (2026-07-05)。
KOH-511/512 で「大型株戦略は substitute であり加算候補ではない」と決着済みのため、
毎月比較しても offseason に baseline Calmar が下がるたび誤った復活提案を出すだけだった。
再評価は ¥10M+ 運用への移行時に手動で行う (CLAUDE.md 復活判定の論理を参照)。

C階層(構造的却下: breakout/nr7/gapdown-reversal/ma-pullback/ddr/evs/ogf/earnings-gap/
stop-high/squeeze-breakout) は対象外。年1回手動見直し。

劣化検知の季節性ガード (KOH-516): GU/PSC は「D期でだけ稼ぐシーズン性戦略」(却下リスト #21)。
offseason はトレードが薄く OOS PF が低くても「劣化」の証拠にならないため、
トレード数 < MIN_TRADES_PER_WINDOW の窓は disable 判定の評価対象から除外する。

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

# WF 結果の受け渡し先。baseline-health ジョブが artifact 経由で読み込み、
# WF + baseline を束ねた統合 AI レビュー (艦長レイヤー) を生成する。
WF_RESULTS_PATH = os.getenv("WF_RESULTS_PATH", "wf-results.json")


# 監視対象戦略 (現役のみ。B階層=復活監視は KOH-516 で撤去)
STRATEGIES: list[str] = ["gapup", "psc"]

# disable 判定でこのトレード数未満の OOS 窓を「証拠」に数えない (offseason の発火薄ノイズ除外)
MIN_TRADES_PER_WINDOW = 5


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
        timeout=900,  # 15分タイムアウト
    )

    # stdoutをそのまま表示（GitHub Actionsログ用）
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)

    return result.returncode, result.stdout


def parse_window_oos(stdout: str) -> list[dict]:
    """[ウィンドウ別] テーブルから各窓の OOS PF とトレード数を抽出する。

    休止窓は pf=None, trades=None。"∞" は math.inf として扱う。窓番号順で返す。
    """
    windows: list[dict] = []
    section = re.search(r"\[ウィンドウ別\](.*?)(?=\[パラメータ安定性\]|\[本番パラメータ\]|\Z)", stdout, re.DOTALL)
    if not section:
        return windows
    for line in section.group(1).splitlines():
        # 例: "  1    |   3.45 |   2.01 |  56.0%  |          25 | ..."
        # 例: "  2    |   2.34 |    休止 |      -  |           - | ..."
        m = re.match(
            r"\s*(\d+)\s*\|\s*[\d.∞]+\s*\|\s*([\d.∞休止]+)\s*\|\s*[\d.\-\s]+%?\s*\|\s*([\d\-]+)\s*\|",
            line,
        )
        if not m:
            continue
        oos_str = m.group(2).strip()
        trades_str = m.group(3).strip()
        if "休止" in oos_str:
            windows.append({"pf": None, "trades": None})
            continue
        try:
            pf = float("inf") if oos_str == "∞" else float(oos_str)
        except ValueError:
            windows.append({"pf": None, "trades": None})
            continue
        trades = int(trades_str) if trades_str.isdigit() else None
        windows.append({"pf": pf, "trades": trades})
    return windows


def detect_disable_proposal(
    windows: list[dict],
    threshold: float = 1.0,
    lookback: int = 3,
    min_trades: int = MIN_TRADES_PER_WINDOW,
) -> dict | None:
    """直近のOOS窓 lookback 個が全て threshold 未満なら停止提案を返す。

    季節性ガード (KOH-516): 休止窓に加え、トレード数 < min_trades の窓も
    「劣化の証拠」に数えない。offseason は breadth フィルターで発火が薄くなり、
    数件のトレードで PF<1.0 が続くのは劣化でなくサンプル不足のため。
    """
    qualified = [
        w["pf"] for w in windows
        if w["pf"] is not None and (w["trades"] or 0) >= min_trades
    ]
    if len(qualified) < lookback:
        return None
    recent = qualified[-lookback:]
    if all(p < threshold for p in recent):
        return {
            "lookback": lookback,
            "threshold": threshold,
            "min_trades": min_trades,
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
        "window_oos": [],
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

    # 窓別 OOS (PF + トレード数) + 停止提案判定 (季節性ガード付き)
    info["window_oos"] = parse_window_oos(stdout)
    info["disable_proposal"] = detect_disable_proposal(info["window_oos"])

    return info


def notify_slack(results: list[dict]) -> None:
    """Slack に WF 結果サマリー + ルールベース検知フラグを送信する。

    AI評価は WF + baseline を束ねる baseline-health ジョブ側 (艦長レイヤー) に集約。
    ここは決定論的な数値・disable フラグのみを流す。
    """
    if not SLACK_WEBHOOK_URL:
        print("SLACK_WEBHOOK_URL 未設定、Slack通知をスキップ")
        return

    fields = []
    has_failure = False
    disable_proposals: list[str] = []

    for r in results:
        strategy = r["strategy"]
        info = r["info"]
        success = r["success"]

        if not success:
            has_failure = True
            fields.append({
                "title": f"[現役] {strategy}",
                "value": "実行失敗",
                "short": True,
            })
            continue

        fields.append({
            "title": f"[現役] {strategy}",
            "value": (
                f"判定: {info['judgment']}\n"
                f"OOS PF: {info['oos_pf']} / IS/OOS比: {info['is_oos_ratio']}\n"
                f"窓: {info['active_windows']} / {info['total_trades']}tr / 勝率{info['win_rate']}"
            ),
            "short": False,
        })

        proposal = info.get("disable_proposal")
        if proposal:
            recent_str = " → ".join(f"{p:.2f}" for p in proposal["recent_pfs"])
            disable_proposals.append(
                f"*{strategy}*: 直近{proposal['lookback']}窓のOOS PF が全て{proposal['threshold']}未満 ({recent_str})"
            )

    if disable_proposals:
        fields.append({
            "title": ":octagonal_sign: ENTRY_ENABLED=false 提案 (現役戦略の構造的劣化)",
            "value": (
                "以下の戦略で OOS の継続劣化を検知 "
                f"(トレード数<{MIN_TRADES_PER_WINDOW}の offseason 発火薄窓は評価対象外):\n"
                + "\n".join(disable_proposals)
                + "\n\n判断は手動。offseason の季節性で説明できないか（breadth 帯・十分な発火があるのに負けているか）を確認の上、"
                "承認後 `lib/constants/<strategy>.ts` の ENTRY_ENABLED を false に変更"
            ),
            "short": False,
        })

    if has_failure:
        color = "danger"
    elif disable_proposals:
        color = "danger"  # 現役劣化は高優先
    else:
        color = "good"
    title = "Monthly Walk-Forward 結果 (現役: gapup / psc)"

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

    for strategy in STRATEGIES:
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

    # WF 結果を artifact 用に書き出す (baseline-health ジョブが統合レビューで参照)
    try:
        with open(WF_RESULTS_PATH, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"WF結果を書き出し: {WF_RESULTS_PATH}")
    except Exception as e:
        print(f"WF結果の書き出し失敗: {e}", file=sys.stderr)

    # Slack通知 (決定論的な数値 + 検知フラグのみ)
    notify_slack(results)

    # サマリー表示
    print(f"\n{'='*60}")
    print("  Walk-Forward サマリー")
    print(f"{'='*60}")
    for r in results:
        status = "OK" if r["success"] else "FAIL"
        judgment = r["info"].get("judgment", "N/A") if r["success"] else "実行失敗"
        pf = r["info"].get("oos_pf", "N/A") if r["success"] else "N/A"
        print(f"  {r['strategy']:18s} [{status}] 判定: {judgment}  OOS PF: {pf}")

    if any_failure:
        sys.exit(1)


if __name__ == "__main__":
    main()
