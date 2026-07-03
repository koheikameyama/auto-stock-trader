"""
自社株買い Phase A（KOH-504 観察モード）観察レビュー

毎週金曜に production の BuybackSignal を SELECT し、観察状況を Slack に要約通知。
2026-07-31 以降は「本レビュー（Phase B 可否）」セクションを追加する。

- production DB は読み取り(SELECT)のみ。書き込みは一切しない。
- 接続情報は .env の PROD_DATABASE_URL、無ければ `# DATABASE_URL=...railway...`
  コメント行を parse（ユーザーのローカル .env のトグル運用に追随）。
- Slack は .env の SLACK_WEBHOOK_URL。
- launchd から実行される想定。--dry で Slack 送信せず標準出力のみ。

KOH-504 / 観察開始 2026-07-03 / 本レビュー目標 2026-07-31。
"""
import os, re, sys
from datetime import datetime, date
from zoneinfo import ZoneInfo
import psycopg2
import requests

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(REPO, ".env")
JST = ZoneInfo("Asia/Tokyo")
OBSERVE_START = date(2026, 7, 3)
FULL_REVIEW_ON = date(2026, 7, 31)
DRY = "--dry" in sys.argv


def load_env():
    prod_url = os.environ.get("PROD_DATABASE_URL")
    slack = os.environ.get("SLACK_WEBHOOK_URL")
    if os.path.exists(ENV):
        for l in open(ENV):
            if slack is None:
                m = re.match(r'\s*SLACK_WEBHOOK_URL\s*=\s*"?([^"\n]+)"?', l)
                if m:
                    slack = m.group(1).strip().strip('"')
            if prod_url is None:
                m = re.match(r'\s*#\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?', l)
                if m and any(k in m.group(1) for k in ("rlwy", "railway", "proxy")):
                    prod_url = m.group(1).strip().strip('"')
    return prod_url, slack


def fetch(prod_url):
    c = psycopg2.connect(prod_url)
    cur = c.cursor()
    cur.execute('SELECT COUNT(*), COUNT(*) FILTER (WHERE "isIdle"), '
                'COUNT(*) FILTER (WHERE "executed"), COUNT(*) FILTER (WHERE "observeOnly"), '
                'MIN("disclosedAt"), MAX("disclosedAt"), MAX("createdAt") FROM "BuybackSignal"')
    total, idle, executed, observe, mindisc, maxdisc, lastcreated = cur.fetchone()
    cur.execute('SELECT COUNT(*), COUNT(*) FILTER (WHERE "isIdle") FROM "BuybackSignal" '
                'WHERE "createdAt" >= now() - interval \'7 days\'')
    w_total, w_idle = cur.fetchone()
    cur.execute('SELECT "skipReason", COUNT(*) FROM "BuybackSignal" '
                'WHERE "skipReason" IS NOT NULL GROUP BY "skipReason" ORDER BY 2 DESC LIMIT 8')
    skips = cur.fetchall()
    cur.execute('SELECT "entryDate","ticker","japanBreadth","isIdle","skipReason" '
                'FROM "BuybackSignal" ORDER BY "createdAt" DESC LIMIT 8')
    recent = cur.fetchall()
    c.close()
    return dict(total=total, idle=idle, executed=executed, observe=observe,
               mindisc=mindisc, maxdisc=maxdisc, lastcreated=lastcreated,
               w_total=w_total, w_idle=w_idle, skips=skips, recent=recent)


def build_message(d):
    today = datetime.now(JST).date()
    weeks = (today - OBSERVE_START).days // 7
    lines = [f"*自社株買い Phase A 観察レビュー* (観察開始 {OBSERVE_START}, 経過 {weeks}週)"]
    lines.append(f"累計シグナル: *{d['total']}* (idle帯 {d['idle']} / 発注済 {d['executed']} / observeOnly {d['observe']})")
    lines.append(f"直近7日の新規: {d['w_total']} (idle帯 {d['w_idle']})")
    if d["maxdisc"]:
        last = d["maxdisc"].astimezone(JST) if d["maxdisc"].tzinfo else d["maxdisc"]
        lines.append(f"最新開示: {last:%Y-%m-%d %H:%M} / 開示期間 {d['mindisc']:%m-%d}〜{d['maxdisc']:%m-%d}")
    else:
        lines.append("開示: まだ0件")

    # 鮮度(zero-fetch)監視: 直近作成がN日以上前なら警告
    if d["lastcreated"]:
        lc = d["lastcreated"].astimezone(JST) if d["lastcreated"].tzinfo else d["lastcreated"].replace(tzinfo=JST)
        days_since = (datetime.now(JST) - lc).days
        if days_since >= 5:
            lines.append(f":warning: 最終記録から *{days_since}日* 経過。monitor停止/取得ゼロの可能性を要確認")
    if d["skips"]:
        lines.append("skipReason: " + ", ".join(f"{r or '（空）'}×{c}" for r, c in d["skips"]))

    # 本レビュー（4週後）
    if today >= FULL_REVIEW_ON:
        lines.append("")
        lines.append("*── 本レビュー（Phase B 可否評価）──*")
        checks = []
        # ① live取得が動いているか
        checks.append(("① live TDnet取得", d["total"] > 0 and (d["w_total"] > 0 or d["total"] >= 3),
                       f"累計{d['total']}/直近7日{d['w_total']}"))
        # ② idle判定が働いているか（idle帯シグナルが存在）
        checks.append(("② idle判定", d["idle"] > 0 or d["total"] == 0,
                       f"idle帯 {d['idle']}/{d['total']}"))
        # ③ サンプル数（Phase B判断の目安 >=5）
        checks.append(("③ サンプル数(>=5目安)", d["total"] >= 5, f"{d['total']}件"))
        for name, ok, detail in checks:
            lines.append(f"{':white_check_mark:' if ok else ':x:'} {name}: {detail}")
        all_ok = all(ok for _, ok, _ in checks)
        if all_ok:
            lines.append(":rocket: *3項目クリア → Phase B（実弾発注）移行を提案*。live pipeline健全。")
        else:
            lines.append(":hourglass: 未達項目あり → 観察継続 or 原因調査（monitor稼働/やのしん取得/breadth閾値を確認）")

    lines.append("")
    lines.append("_read-only SELECT / KOH-504 / scripts/buyback_phase_a_review.py_")
    return "\n".join(lines)


def main():
    prod_url, slack = load_env()
    if not prod_url:
        print("ERROR: production DB URL が取得できません（PROD_DATABASE_URL か .env コメント行）", file=sys.stderr)
        sys.exit(1)
    try:
        d = fetch(prod_url)
    except Exception as e:
        msg = f":x: *自社株買い Phase A レビュー失敗*: {str(e)[:200]}"
        print(msg)
        if not DRY and slack:
            requests.post(slack, json={"text": msg}, timeout=20)
        sys.exit(1)
    msg = build_message(d)
    print(msg)
    if DRY:
        print("\n[--dry] Slack送信スキップ")
        return
    if slack:
        r = requests.post(slack, json={"text": msg}, timeout=20)
        print(f"\nSlack posted: HTTP {r.status_code}")
    else:
        print("\nWARN: SLACK_WEBHOOK_URL 無し、通知スキップ", file=sys.stderr)


if __name__ == "__main__":
    main()
