"""
Morning Analysis 実行状況チェック

cronjob_morning-analysis.yml の最新実行が成功しているか確認し、
失敗 / 未実行 / 進行中の場合は Slack に通知する。

morning-analysis は平日 8:00 JST (前日 23:00 UTC) に cron-job.org からトリガーされ、
news-collect → market-assessment → watchlist-builder の順に動く。
失敗すると entry-executor 15:24 JST 発注時に watchlist が無く、その日の取引機会を失う。

失敗時は GitHub API でジョブ・ステップ・ログ末尾を取得して Slack に出す。

2モードで動く:
- watchdog モード (env RUN_ID 未設定): 当日の最新 run を探して状態判定
- run-failure モード (env RUN_ID 設定): 指定 run の失敗詳細を Slack に投げる
  morning-analysis の notify-failure job から呼ぶ用

Usage:
  python scripts/check_morning_analysis_status.py

Required env:
  GH_TOKEN: GitHub API トークン (Actions では secrets.GITHUB_TOKEN が自動で渡る)
  GH_REPO:  "owner/repo" 形式 (Actions では自動セット)
  SLACK_WEBHOOK_URL: Slack Incoming Webhook
  RUN_ID (optional): 指定すると run-failure モードで動作
"""

import io
import json
import os
import sys
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone

WORKFLOW_FILE = "cronjob_morning-analysis.yml"
JST = timezone(timedelta(hours=9))
LOG_TAIL_LINES = 30


def gh_api(path: str, token: str) -> dict:
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))


def gh_logs(path: str, token: str) -> bytes:
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read()


def fetch_failure_detail(repo: str, run_id: int, token: str) -> str:
    """失敗したジョブ・ステップ・ログ末尾を抽出して整形する"""
    try:
        jobs = gh_api(
            f"/repos/{repo}/actions/runs/{run_id}/jobs?per_page=30", token
        ).get("jobs", [])
    except Exception as e:
        return f"(ジョブ詳細取得失敗: {e})"

    failed_jobs = [j for j in jobs if j.get("conclusion") == "failure"]
    if not failed_jobs:
        return "(失敗ジョブが見つかりません)"

    # 最初の失敗ジョブの最初の失敗ステップを使う
    job = failed_jobs[0]
    job_name = job.get("name", "?")
    job_url = job.get("html_url", "")

    failed_step = None
    for step in job.get("steps", []):
        if step.get("conclusion") == "failure":
            failed_step = step
            break

    step_name = failed_step.get("name", "?") if failed_step else "?"

    # ログ取得
    log_tail = ""
    try:
        zip_bytes = gh_logs(f"/repos/{repo}/actions/jobs/{job['id']}/logs", token)
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            # 該当ステップのログファイルを探す
            for name in zf.namelist():
                if failed_step and step_name.replace("/", "") in name:
                    with zf.open(name) as f:
                        text = f.read().decode("utf-8", errors="replace")
                        lines = text.strip().split("\n")
                        log_tail = "\n".join(lines[-LOG_TAIL_LINES:])
                    break
            if not log_tail:
                # 1ファイル目の末尾を fallback で使う
                names = zf.namelist()
                if names:
                    with zf.open(names[0]) as f:
                        text = f.read().decode("utf-8", errors="replace")
                        lines = text.strip().split("\n")
                        log_tail = "\n".join(lines[-LOG_TAIL_LINES:])
    except urllib.error.HTTPError as e:
        log_tail = f"(ログ取得失敗 HTTP {e.code})"
    except Exception as e:
        log_tail = f"(ログ取得失敗: {e})"

    detail = (
        f"失敗ジョブ: `{job_name}`\n"
        f"失敗ステップ: `{step_name}`\n"
        f"<{job_url}|失敗ジョブを開く>"
    )
    if log_tail:
        # Slack の attachment text は 8000 chars 程度まで。安全側で 2000 に切る
        if len(log_tail) > 2000:
            log_tail = "...\n" + log_tail[-2000:]
        detail += f"\n```\n{log_tail}\n```"
    return detail


def post_slack(webhook: str, title: str, text: str, color: str) -> None:
    payload = {
        "attachments": [
            {
                "color": color,
                "title": title,
                "text": text,
                "footer": "Auto Stock Trader",
                "mrkdwn_in": ["text"],
            }
        ]
    }
    if color == "danger":
        payload["text"] = "<!here>"
    req = urllib.request.Request(
        webhook,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            res.read()
    except urllib.error.HTTPError as e:
        print(f"Slack 通知失敗: {e}", file=sys.stderr)


def main() -> int:
    token = os.environ["GH_TOKEN"]
    repo = os.environ["GH_REPO"]
    webhook = os.environ["SLACK_WEBHOOK_URL"]

    # run-failure モード: 特定 RUN_ID の失敗詳細を Slack に投げる
    run_id_env = os.environ.get("RUN_ID")
    if run_id_env:
        run_id = int(run_id_env)
        run = gh_api(f"/repos/{repo}/actions/runs/{run_id}", token)
        run_url = run.get("html_url", "")
        created_at_jst = datetime.fromisoformat(
            run["created_at"].replace("Z", "+00:00")
        ).astimezone(JST)
        detail = fetch_failure_detail(repo, run_id, token)
        post_slack(
            webhook,
            "❌ Morning Analysis 失敗",
            (
                f"朝の分析ジョブが失敗しました。\n"
                f"開始: {created_at_jst.strftime('%H:%M JST')}\n"
                f"watchlist が生成されていない可能性があります。\n"
                f"15:24 JST の発注までに手動再実行が必要です。\n"
                f"<{run_url}|Run を確認>\n\n"
                f"{detail}"
            ),
            "danger",
        )
        return 0

    # watchdog モード: 当日の最新 run を探して状態判定
    runs = gh_api(
        f"/repos/{repo}/actions/workflows/{WORKFLOW_FILE}/runs?per_page=5",
        token,
    )
    workflow_runs = runs.get("workflow_runs", [])

    now_jst = datetime.now(JST)
    today_jst = now_jst.date()

    # 当日 JST 7:00 以降に開始された run を探す (8:00 JST 発火 + バッファ)
    today_start_jst = datetime.combine(today_jst, datetime.min.time(), JST).replace(hour=7)
    today_start_utc = today_start_jst.astimezone(timezone.utc)

    today_run = None
    for run in workflow_runs:
        created_at = datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
        if created_at >= today_start_utc:
            today_run = run
            break

    run_url_base = f"https://github.com/{repo}/actions/workflows/{WORKFLOW_FILE}"

    if today_run is None:
        post_slack(
            webhook,
            "⚠️ Morning Analysis 未実行",
            (
                f"本日 ({today_jst.isoformat()}) の morning-analysis が起動していません。\n"
                f"cron-job.org のトリガーが失敗している可能性があります。\n"
                f"15:24 JST の発注までに復旧しないと当日の取引機会を失います。\n"
                f"<{run_url_base}|Workflow を確認>"
            ),
            "danger",
        )
        return 1

    status = today_run["status"]
    conclusion = today_run.get("conclusion")
    run_url = today_run["html_url"]
    run_id = today_run["id"]
    created_at_jst = datetime.fromisoformat(
        today_run["created_at"].replace("Z", "+00:00")
    ).astimezone(JST)

    if status != "completed":
        post_slack(
            webhook,
            "⏳ Morning Analysis 未完了",
            (
                f"本日の morning-analysis がまだ完了していません (status={status})。\n"
                f"開始: {created_at_jst.strftime('%H:%M JST')}\n"
                f"通常 8:00〜8:10 JST に完了します。長時間 in_progress なら異常です。\n"
                f"<{run_url}|Run を確認>"
            ),
            "warning",
        )
        return 1

    if conclusion != "success":
        detail = fetch_failure_detail(repo, run_id, token)
        post_slack(
            webhook,
            "❌ Morning Analysis 失敗",
            (
                f"本日の morning-analysis が失敗しました (conclusion={conclusion})。\n"
                f"開始: {created_at_jst.strftime('%H:%M JST')}\n"
                f"watchlist が生成されていない可能性があります。\n"
                f"15:24 JST の発注までに手動再実行が必要です。\n"
                f"<{run_url}|Run を確認>\n\n"
                f"{detail}"
            ),
            "danger",
        )
        return 1

    print(f"✅ Morning Analysis 正常終了 ({created_at_jst.strftime('%H:%M JST')})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
