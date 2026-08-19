#!/usr/bin/env python3
"""
使い捨て: 優待を「D期増幅器」として測る。却下#57 が残した再評価案件。

3つの枠割り当て順 (mcap/mom20/ticker) × 4窓 (fullcycle + 3期) を GU3単独・総資産基準の
combined BT で回し、baseline と比較する。目的は2つ:

  (A) 却下#41 の核心テスト: 3並び順の Calmar 振れ幅 vs 優待エッジ(baseline比)。
      振れ幅の方が大きければ「そもそも決着不能」で即却下。
  (B) 年代別で D期(2024-26)だけ効き offseason(2021-23)で毀損する構造が
      枠割り当てを固定しても残るか。

BTエンジン・本番コードは無変更。既存フラグ (--enable-buyback --buyback-json
--buyback-breadth-max 1) の組合せのみ。並び順はソート済みJSONで制御 (_yutai-sort-jsons.ts)。

実行: python3 scripts/_yutai-amplifier-arms.py
"""
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

WINDOWS = [
    ("fullcycle", "2018-04-01", "2026-07-31"),
    ("era1_18-20", "2018-04-01", "2020-12-31"),
    ("era2_21-23", "2021-01-01", "2023-12-31"),
    ("era3_24-26", "2024-01-01", "2026-07-31"),
]

# arm名 -> buyback JSON (None=baseline)
ARMS = {
    "baseline": None,
    "yutai_pubdate": "/tmp/yutai_lag1.json",  # 生成時のpubdate順(却下#57 が使った順)
    "yutai_mcap": "/tmp/yutai_mcap.json",
    "yutai_mom20": "/tmp/yutai_mom20.json",
    "yutai_ticker": "/tmp/yutai_ticker.json",
}

BUDGET = "500000"


def years(start: str, end: str) -> float:
    from datetime import date
    ys, ms, ds = map(int, start.split("-"))
    ye, me, de = map(int, end.split("-"))
    return ((date(ye, me, de) - date(ys, ms, ds)).days) / 365.25


def run_one(arm: str, json_path, win_name: str, start: str, end: str):
    cmd = [
        "npx", "tsx", "src/backtest/combined-run.ts",
        "--start", start, "--end", end, "--budget", BUDGET,
    ]
    if json_path is not None:
        cmd += ["--enable-buyback", "--buyback-json", json_path, "--buyback-breadth-max", "1"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    out = p.stdout + p.stderr
    # 最初の「純損益: ¥... (X%)」と「最大DD: Y%」と「トレード数: N」を採る
    m_ret = re.search(r"純損益:\s*¥[\d,\-]+\s*\(([-\d.]+)%\)", out)
    m_dd = re.search(r"最大DD:\s*([\d.]+)%", out)
    m_tr = re.search(r"トレード数:\s*(\d+)", out)
    netret = float(m_ret.group(1)) if m_ret else None
    maxdd = float(m_dd.group(1)) if m_dd else None
    trades = int(m_tr.group(1)) if m_tr else None
    calmar = None
    if netret is not None and maxdd and maxdd > 0:
        calmar = (netret / years(start, end)) / maxdd
    return (win_name, arm, dict(netret=netret, maxdd=maxdd, trades=trades, calmar=calmar))


def main():
    jobs = []
    for win_name, start, end in WINDOWS:
        for arm, jp in ARMS.items():
            jobs.append((arm, jp, win_name, start, end))

    results = {}  # (win, arm) -> metrics
    print(f"[run] {len(jobs)} ジョブ (並列4)...", file=sys.stderr, flush=True)
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(run_one, *j): j for j in jobs}
        for fut in as_completed(futs):
            win, arm, m = fut.result()
            results[(win, arm)] = m
            print(f"  ✓ {win:14s} {arm:14s} Calmar={m['calmar']!s:>7.7} "
                  f"NetRet={m['netret']!s:>8.8}% DD={m['maxdd']}% tr={m['trades']}",
                  file=sys.stderr, flush=True)

    # 表: 窓 × arm の Calmar
    print("\n" + "=" * 92)
    print("優待 D期増幅器: 枠割り当て順 × 年代別 Calmar (年率, NetRet/年数/MaxDD)")
    print("=" * 92)
    header = "窓".ljust(16) + "".join(a.rjust(18) for a in ARMS)
    print(header)
    for win_name, _, _ in WINDOWS:
        row = win_name.ljust(16)
        base_c = results[(win_name, "baseline")]["calmar"]
        for arm in ARMS:
            c = results[(win_name, arm)]["calmar"]
            if arm == "baseline":
                row += f"{c:.2f}".rjust(18)
            else:
                dpct = (c - base_c) / base_c * 100 if base_c else 0
                row += f"{c:.2f}({dpct:+.0f}%)".rjust(18)
        print(row)

    # 却下#41 テスト: 各窓で3並び順の Calmar 振れ幅 vs 対baseline平均改善
    print("\n" + "=" * 92)
    print("却下#41 テスト: 並び順ノイズ vs エッジ")
    print("=" * 92)
    sort_arms = ("yutai_pubdate", "yutai_mcap", "yutai_mom20", "yutai_ticker")
    print("窓".ljust(16) + "並び順4値のCalmar".rjust(34) + "振れ幅".rjust(12) + "対base平均".rjust(14))
    for win_name, _, _ in WINDOWS:
        base_c = results[(win_name, "baseline")]["calmar"]
        sorts = [results[(win_name, a)]["calmar"] for a in sort_arms]
        spread = max(sorts) - min(sorts)
        avg_edge = sum(sorts) / len(sorts) - base_c
        vals = "/".join(f"{s:.1f}" for s in sorts)
        print(win_name.ljust(16) + vals.rjust(28) + f"{spread:.2f}".rjust(12) + f"{avg_edge:+.2f}".rjust(14))

    # NetRet/DD/trades 詳細
    print("\n" + "=" * 92)
    print("詳細 (NetRet% / MaxDD% / trades)")
    print("=" * 92)
    for win_name, _, _ in WINDOWS:
        print(f"[{win_name}]")
        for arm in ARMS:
            m = results[(win_name, arm)]
            print(f"  {arm:14s} NetRet {m['netret']:>9.1f}%  DD {m['maxdd']:>5.1f}%  tr {m['trades']}")


if __name__ == "__main__":
    main()
