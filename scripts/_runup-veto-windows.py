#!/usr/bin/env python3
"""
「20日で上がりすぎた銘柄はエントリーしない」veto を 16窓リセットで測る。

契機= 生データで「上がりすぎた銘柄は翌"寄り"では落ちない（むしろ +0.4%）が、翌日の
寄→引が -0.3〜-1.2% と一貫マイナス、20日+50%超だと引→引もマイナスに転じる」と観測。
ただし却下 #17/#20 が「既存フィルターへの上乗せは冗長」を4回確認しているため事前確率は低い。

  veto-off(現状) = 基準（16窓 NetRet 合計 796.4% がチェックサム）
  veto>=100% / 70% / 50% / 30% = 20日騰落率がその値以上の銘柄を GU/PSC から外す

却下 #40/#42-49 と同じ手法（12ヶ月固定窓 × 6ヶ月スライド × 16窓、各窓 ¥500K リセット）。
判定は主KPI の Calmar を主、NetRet を従で見る（却下 #46 の教訓: NetRet だけで判断しない）。
"""
import subprocess
import sys
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from math import comb

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

ARMS = ["veto-off(現状)", "veto>=100%", "veto>=70%", "veto>=50%", "veto>=30%"]
BASE = "veto-off(現状)"


def run_window(start, end):
    cmd = [
        "npx", "tsx", "src/backtest/combined-run.ts",
        "--compare-runup-veto",
        "--start", start, "--end", end, "--budget", "500000",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=5400)
    rows = {}
    for line in out.stdout.splitlines():
        if not line.startswith("WINROW,"):
            continue
        p = line.strip().split(",")
        # WINROW,start,end,label,trades,netRet,maxDD,calmar,pf,dropped
        try:
            rows[p[3]] = {
                "trades": int(p[4]),
                "netret": float(p[5]),
                "maxdd": float(p[6]),
                "calmar": float(p[7]),
                "pf": float(p[8]),
                "dropped": int(p[9]),
            }
        except (ValueError, IndexError):
            continue
    if set(rows) != set(ARMS):
        sys.stderr.write(
            f"[WARN] {start}->{end}: 不完全な出力 {set(rows)}\n"
            f"{out.stdout[-800:]}\n{out.stderr[-600:]}\n"
        )
        return None
    return (start, end, rows)


def paired_t(diffs):
    n = len(diffs)
    if n < 2:
        return float("nan"), float("nan")
    mean = statistics.mean(diffs)
    sd = statistics.stdev(diffs)
    if sd == 0:
        return (float("inf") if mean != 0 else 0.0), mean
    return mean / (sd / (n ** 0.5)), mean


def sign_test_p(wins, losses):
    """両側符号検定（同点除外）"""
    n = wins + losses
    if n == 0:
        return 1.0
    k = max(wins, losses)
    p = sum(comb(n, i) for i in range(k, n + 1)) / (2 ** n)
    return min(1.0, 2 * p)


def main():
    results = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(run_window, s, e): (s, e) for s, e in WINDOWS}
        for fut in as_completed(futs):
            r = fut.result()
            if r:
                results.append(r)
    results.sort()

    print(f"\n完了窓: {len(results)}/16\n")
    if len(results) < 16:
        print("!!! 窓が欠けている。集計は不完全 !!!\n")

    for metric, fmt in [("netret", "{:>14.1f}"), ("calmar", "{:>14.2f}")]:
        print(f"=== {metric} by window ===")
        print(f"{'window':<24}" + "".join(f"{a:>14}" for a in ARMS))
        for start, end, rows in results:
            print(f"{start}->{end:<12}" + "".join(fmt.format(rows[a][metric]) for a in ARMS))
        print()

    for metric in ["calmar", "netret", "maxdd"]:
        print(f"########## 判定: {metric.upper()} (基準 = {BASE} / BT本来) ##########")
        base_sum = sum(r[2][BASE][metric] for r in results)
        print(f"{BASE} 合計: {base_sum:.2f}")
        for arm in ARMS:
            if arm == BASE:
                continue
            arm_sum = sum(r[2][arm][metric] for r in results)
            diffs = [r[2][arm][metric] - r[2][BASE][metric] for r in results]
            t, mean = paired_t(diffs)
            wins = sum(1 for d in diffs if d > 1e-9)
            losses = sum(1 for d in diffs if d < -1e-9)
            ties = len(diffs) - wins - losses
            p = sign_test_p(wins, losses)
            print(f"  {arm:<16} 合計 {arm_sum:>10.2f} | 差 {arm_sum - base_sum:>+9.2f} "
                  f"| 平均差/窓 {mean:>+8.3f} t={t:>+6.2f} "
                  f"| {wins}勝{losses}敗{ties}分 符号検定p={p:.3f}")
        print()

    print("########## 除外シグナル数 / 総トレード数 合計 ##########")
    for arm in ARMS:
        print(f"  {arm:<16} dropped={sum(r[2][arm]['dropped'] for r in results):>6}"
              f"  trades={sum(r[2][arm]['trades'] for r in results):>6}")


if __name__ == "__main__":
    main()
