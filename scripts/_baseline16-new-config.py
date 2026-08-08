#!/usr/bin/env python3
"""
16窓ハーネスの再ベースライン化 (2026-08-08)。

背景: 却下#42 以降の全検定が使ってきたチェックサム (NetRet合計 796.4% / Calmar合計 85.91)
は旧構成 (GU3+PSC2・cash基準サイジング) の数字。2026-08-03/04 に baseline が二重に変わった
(PSC 停止 → GU3単独 / サイジング cash基準 → 総資産基準) ため、新構成の16窓チェックサムを
ここで確立する。今後の16窓検定は本スクリプトの出力を基準・検算値として使うこと。

手法: 却下#40/#42-49 と同一 (12ヶ月固定窓 × 6ヶ月スライド × 16窓、各窓 ¥500K リセット)。
比較モードは使わず plain run (現既定 = GU3単独・総資産基準) の [全体] ブロックをパースする。
Calmar は combined-run と同じ (netRet ÷ years) ÷ maxDD、years = 日数/365。

旧チェックサムの再現は各窓に --cash-based-sizing を付け、combined-run の defaultLimits を
GU3+PSC2 に戻す必要がある (現既定では再現しない)。
"""
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date

WINDOWS = []
ym = (2018, 1)
for _ in range(16):
    y, m = ym
    start = f"{y:04d}-{m:02d}-01"
    end = f"{y + 1:04d}-{m:02d}-01"
    WINDOWS.append((start, end))
    m += 6
    if m > 12:
        m -= 12
        y += 1
    ym = (y, m)


def parse_date(s):
    y, m, d = s.split("-")
    return date(int(y), int(m), int(d))


def run_window(start, end):
    cmd = [
        "npx", "tsx", "src/backtest/combined-run.ts",
        "--start", start, "--end", end, "--budget", "500000",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=5400)
    # [全体] ブロック (最初の printMetrics) をパース
    text = out.stdout
    m_block = re.search(r"\[全体\](.*?)(?:\n\[|\Z)", text, re.DOTALL)
    if not m_block:
        sys.stderr.write(f"[WARN] {start}->{end}: [全体] ブロックなし\n{text[-800:]}\n{out.stderr[-400:]}\n")
        return None
    block = m_block.group(1)

    def grab(pattern, cast=float):
        mm = re.search(pattern, block)
        return cast(mm.group(1)) if mm else None

    trades = grab(r"トレード数: (\d+)", int)
    winrate = grab(r"勝率: ([\d.]+)%")
    pf_m = re.search(r"PF: ([\d.]+|∞)", block)
    pf = float("inf") if pf_m and pf_m.group(1) == "∞" else (float(pf_m.group(1)) if pf_m else None)
    maxdd = grab(r"最大DD: ([\d.]+)%")
    netret = grab(r"純損益: ¥[-\d,]+ \((-?[\d.]+)%\)")
    if netret is None:  # 手数料ゼロ窓 (トレード0件) は総損益行を使う
        netret = grab(r"総損益: ¥[-\d,]+ \((-?[\d.]+)%\)") or 0.0
    if trades is None or maxdd is None:
        sys.stderr.write(f"[WARN] {start}->{end}: パース不完全\n{block}\n")
        return None
    years = (parse_date(end) - parse_date(start)).days / 365
    calmar = (netret / years) / maxdd if maxdd > 0 else 0.0
    return (start, end, {
        "trades": trades, "winrate": winrate, "pf": pf,
        "maxdd": maxdd, "netret": netret, "calmar": calmar,
    })


def main():
    results = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(run_window, s, e): (s, e) for s, e in WINDOWS}
        for fut in as_completed(futs):
            r = fut.result()
            if r:
                results.append(r)
                sys.stderr.write(f"[done] {r[0]} -> {r[1]}\n")
    results.sort()

    print(f"\n完了窓: {len(results)}/16")
    if len(results) < 16:
        print("!!! 窓が欠けている。チェックサムとして無効 !!!")

    print(f"\n{'window':<26}{'trades':>8}{'winR%':>8}{'PF':>8}{'maxDD%':>8}{'netRet%':>10}{'calmar':>10}")
    for start, end, r in results:
        pf_str = "inf" if r["pf"] == float("inf") else f"{r['pf']:.2f}"
        print(f"{start}->{end:<14}{r['trades']:>8}{r['winrate']:>8.1f}{pf_str:>8}"
              f"{r['maxdd']:>8.1f}{r['netret']:>10.1f}{r['calmar']:>10.2f}")

    print("\n########## 新構成 (GU3単独・総資産基準) 16窓チェックサム ##########")
    print(f"NetRet 合計: {sum(r[2]['netret'] for r in results):.2f}%")
    print(f"Calmar 合計: {sum(r[2]['calmar'] for r in results):.2f}")
    print(f"MaxDD 合計:  {sum(r[2]['maxdd'] for r in results):.2f}")
    print(f"Trades 合計: {sum(r[2]['trades'] for r in results)}")


if __name__ == "__main__":
    main()
