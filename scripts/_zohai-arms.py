#!/usr/bin/env python3
"""
使い捨て: 却下#33 (増配・復配) を新 baseline (GU3単独・総資産基準) で再測定する。

KOH-600 の棚卸し分類 A で唯一未測定だった項目。当時の却下は「combo (増配×業績予想併記) を
--enable-buyback 流用で combined 共有プールに流すと fullcycle で唯一悪化 (-20%)」が決定打
だったが、旧エンジン (却下#39 以前) + 旧構成 (GU3+PSC2・cash基準) の判定なので二重に無効。

イベントは _gen-buyback-events.ts --classifier zohai-combo を live 再現定義
(--breadth-lag 1 --breadth-universe daily --max-price 2500) で再生成した 527件。
判定は却下#57 と同じ「fullcycle + 年代別3期」。offseason (era1/era2) で毀損するなら
buyback/優待と同じ結末 = 却下維持。

実行: python3 scripts/_zohai-arms.py
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
    "zohai_combo": "/tmp/zohai_combo_lag1.json",
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
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    out = p.stdout + p.stderr
    m_ret = re.search(r"純損益:\s*¥[\d,\-]+\s*\(([-\d.]+)%\)", out)
    m_dd = re.search(r"最大DD:\s*([\d.]+)%", out)
    m_tr = re.search(r"トレード数:\s*(\d+)", out)
    # buyback レッグ単独 (printMetrics の「自社株買い」ブロック)
    m_bb = re.search(r"\[自社株買い[^\]]*\](.*?)(?:\n\[|\Z)", out, re.DOTALL)
    bb = None
    if m_bb:
        blk = m_bb.group(1)
        b_tr = re.search(r"トレード数:\s*(\d+)", blk)
        b_pf = re.search(r"PF:\s*([\d.]+|∞)", blk)
        b_ret = re.search(r"純損益:\s*¥([\d,\-]+)", blk)
        bb = dict(
            trades=int(b_tr.group(1)) if b_tr else None,
            pf=(b_pf.group(1) if b_pf else None),
            netpnl=(b_ret.group(1) if b_ret else None),
        )
    netret = float(m_ret.group(1)) if m_ret else None
    maxdd = float(m_dd.group(1)) if m_dd else None
    trades = int(m_tr.group(1)) if m_tr else None
    calmar = None
    if netret is not None and maxdd and maxdd > 0:
        calmar = (netret / years(start, end)) / maxdd
    return (win_name, arm, dict(netret=netret, maxdd=maxdd, trades=trades, calmar=calmar, bb=bb))


def main():
    jobs = []
    for win_name, start, end in WINDOWS:
        for arm, jp in ARMS.items():
            jobs.append((arm, jp, win_name, start, end))

    results = {}
    print(f"[run] {len(jobs)} ジョブ (並列4)...", file=sys.stderr, flush=True)
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(run_one, *j): j for j in jobs}
        for fut in as_completed(futs):
            win, arm, m = fut.result()
            results[(win, arm)] = m
            print(f"  ✓ {win:14s} {arm:14s} Calmar={m['calmar']!s:>7.7} "
                  f"NetRet={m['netret']!s:>8.8}% DD={m['maxdd']}% tr={m['trades']}",
                  file=sys.stderr, flush=True)

    print("\n" + "=" * 80)
    print("却下#33 増配combo 再測定: 年代別 Calmar (年率, NetRet/年数/MaxDD)")
    print("=" * 80)
    header = "窓".ljust(16) + "".join(a.rjust(20) for a in ARMS)
    print(header)
    for win_name, _, _ in WINDOWS:
        row = win_name.ljust(16)
        base_c = results[(win_name, "baseline")]["calmar"]
        for arm in ARMS:
            c = results[(win_name, arm)]["calmar"]
            if arm == "baseline":
                row += f"{c:.2f}".rjust(20)
            else:
                dpct = (c - base_c) / base_c * 100 if base_c else 0
                row += f"{c:.2f}({dpct:+.0f}%)".rjust(20)
        print(row)

    print("\n" + "=" * 80)
    print("詳細 (NetRet% / MaxDD% / trades / 増配レッグ)")
    print("=" * 80)
    for win_name, _, _ in WINDOWS:
        print(f"[{win_name}]")
        for arm in ARMS:
            m = results[(win_name, arm)]
            bb = m["bb"]
            bbs = f"  leg: tr={bb['trades']} PF={bb['pf']} pnl=¥{bb['netpnl']}" if bb else ""
            print(f"  {arm:14s} NetRet {m['netret']:>9.1f}%  DD {m['maxdd']:>5.1f}%  tr {m['trades']}{bbs}")


if __name__ == "__main__":
    main()
