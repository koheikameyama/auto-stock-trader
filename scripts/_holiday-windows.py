#!/usr/bin/env python3
"""
連休前ガード（トレール引き締め / エントリー veto）を 16窓リセットで測る。

契機= ユーザーの問い「連休前って注文するの危ない？」。調べたところ **live にだけ連休前ガードが
入っていて BT には無い**（live↔BT 乖離の4例目、却下 #3/#51/#54 と同型）:
  position-monitor.ts:640-747 … 非営業日が3日以上続くセッションで breakout/gapup の
  トレール ATR 倍率を ×0.7（WEEKEND_RISK.TRAILING_TIGHTEN_*）。PSC は素通し。

  guard-off(BT本来)  = 基準（16窓 NetRet 合計 796.4% がチェックサム / KOH-558）
  trail0.7-gu(live)  = ★本番で今も動いている未検証の値
  trail0.7-both      = 同じ引き締めを PSC にも広げる
  trail0.5-gu        = 効果の形を見る強い版（採用候補ではない）
  entry-veto         = 連休前セッションは GU/PSC を建てない（live にも無い純粋な候補）
  veto+trail0.7-gu   = live 現状 + veto

却下 #40/#42-49/#54 と同じ手法（12ヶ月固定窓 × 6ヶ月スライド × 16窓、各窓 ¥500K リセット）。
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

ARMS = [
    "guard-off(BT本来)",
    "trail0.7-gu(live)",
    "trail0.7-both",
    "trail0.5-gu",
    "entry-veto",
    "veto+trail0.7-gu",
]
BASE = "guard-off(BT本来)"


def run_window(start, end):
    cmd = [
        "npx", "tsx", "src/backtest/combined-run.ts",
        "--compare-holiday",
        "--start", start, "--end", end, "--budget", "500000",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=5400)
    rows = {}
    for line in out.stdout.splitlines():
        if not line.startswith("WINROW,"):
            continue
        p = line.strip().split(",")
        # WINROW,start,end,label,trades,netRet,maxDD,calmar,pf,preHolidayDays,vetoDays
        try:
            rows[p[3]] = {
                "trades": int(p[4]),
                "netret": float(p[5]),
                "maxdd": float(p[6]),
                "calmar": float(p[7]),
                "pf": float(p[8]),
                "prehol": int(p[9]),
                "vetodays": int(p[10]),
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

    for metric, fmt in [("netret", "{:>18.1f}"), ("calmar", "{:>18.2f}")]:
        print(f"=== {metric} by window ===")
        print(f"{'window':<24}" + "".join(f"{a:>18}" for a in ARMS))
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
            print(f"  {arm:<20} 合計 {arm_sum:>10.2f} | 差 {arm_sum - base_sum:>+9.2f} "
                  f"| 平均差/窓 {mean:>+8.3f} t={t:>+6.2f} "
                  f"| {wins}勝{losses}敗{ties}分 符号検定p={p:.3f}")
        print()

    print("########## 発動状況 / トレード数 合計 ##########")
    for arm in ARMS:
        print(f"  {arm:<20} 連休前セッション={sum(r[2][arm]['prehol'] for r in results):>5}"
              f"  veto日={sum(r[2][arm]['vetodays'] for r in results):>5}"
              f"  trades={sum(r[2][arm]['trades'] for r in results):>6}")


if __name__ == "__main__":
    main()
