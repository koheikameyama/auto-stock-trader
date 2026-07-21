#!/usr/bin/env python3
"""
KOH-577: 日経キルスイッチの判定時制 off / same-day(BT) / lagged(本番) を
16窓リセット (12ヶ月固定窓 × 6ヶ月スライド, 各窓 ¥500K) で比較し、
対応のある t検定 / 符号検定で lagged(本番) が sameday(BT)・off と有意に違うかを測る。

却下 #42-47 と同じ手法。各窓は combined-run の --compare-nikkei-killswitch を叩く。
"""
import subprocess
import sys
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from math import comb

# 16窓: 2018-01 起点、12ヶ月固定、6ヶ月スライド
WINDOWS = []
ym = (2018, 1)
for _ in range(16):
    y, m = ym
    start = f"{y:04d}-{m:02d}-01"
    ey, em = (y + 1, m)
    end = f"{ey:04d}-{em:02d}-01"
    WINDOWS.append((start, end))
    # +6ヶ月
    m += 6
    if m > 12:
        m -= 12
        y += 1
    ym = (y, m)

CONFIGS = ["off", "sameday", "lagged"]


def run_window(start, end):
    cmd = [
        "npx", "tsx", "src/backtest/combined-run.ts",
        "--compare-nikkei-killswitch",
        "--start", start, "--end", end, "--budget", "500000",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
    rows = {}
    for line in out.stdout.splitlines():
        if not line.startswith("WINROW,"):
            continue
        _, s, e, label, trades, netret, maxdd, calmar, pf = line.split(",")
        rows[label] = {
            "trades": int(trades), "netret": float(netret),
            "maxdd": float(maxdd), "calmar": float(calmar), "pf": float(pf),
        }
    if set(rows) != set(CONFIGS):
        sys.stderr.write(f"[WARN] {start}->{end}: 不完全な出力 {set(rows)}\n{out.stdout[-500:]}\n")
        return None
    return (start, end, rows)


def paired_t(diffs):
    n = len(diffs)
    if n < 2:
        return float("nan"), float("nan")
    mean = statistics.mean(diffs)
    sd = statistics.stdev(diffs)
    if sd == 0:
        return float("inf") if mean != 0 else 0.0, 0.0
    se = sd / (n ** 0.5)
    t = mean / se
    return t, mean


def sign_test_p(wins, losses):
    # 両側符号検定 (同点除外)。n=wins+losses, k=max(wins,losses)
    n = wins + losses
    if n == 0:
        return 1.0
    k = max(wins, losses)
    p = sum(comb(n, i) for i in range(k, n + 1)) / (2 ** n) * 2
    return min(1.0, p)


def main():
    results = {}
    print(f"16窓を並列実行 (4並列)...", flush=True)
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(run_window, s, e): (s, e) for s, e in WINDOWS}
        done = 0
        for fut in as_completed(futs):
            r = fut.result()
            done += 1
            if r:
                s, e, rows = r
                results[(s, e)] = rows
                print(f"  [{done}/16] {s} -> {e}  "
                      f"off={rows['off']['netret']:.1f}% same={rows['sameday']['netret']:.1f}% "
                      f"lag={rows['lagged']['netret']:.1f}%", flush=True)
            else:
                s, e = futs[fut]
                print(f"  [{done}/16] {s} -> {e}  FAILED", flush=True)

    ordered = [results[w] for w in WINDOWS if w in results]
    n = len(ordered)
    print(f"\n=== 集計 ({n}/16 窓) ===")
    for metric in ("netret", "calmar", "maxdd", "trades"):
        print(f"\n[{metric}]")
        for c in CONFIGS:
            vals = [r[c][metric] for r in ordered]
            print(f"  {c:8s} 合計={sum(vals):9.2f}  平均={statistics.mean(vals):8.3f}")

    # lagged(本番) を基準に、sameday(BT) / off との差を検定
    print("\n=== 対応のある検定 (基準=lagged 本番模倣) ===")
    for base in ("sameday", "off"):
        for metric in ("netret", "calmar"):
            diffs = [r["lagged"][metric] - r[base][metric] for r in ordered]
            t, mean = paired_t(diffs)
            wins = sum(1 for d in diffs if d > 1e-9)   # lagged が勝った窓
            losses = sum(1 for d in diffs if d < -1e-9)
            ties = n - wins - losses
            p_sign = sign_test_p(wins, losses)
            print(f"  lagged - {base:8s} [{metric:6s}]  "
                  f"平均差={mean:+8.3f}  t={t:+6.2f}  "
                  f"lagged勝ち {wins}/{n} (同点{ties})  符号検定p={p_sign:.3f}")


if __name__ == "__main__":
    main()
