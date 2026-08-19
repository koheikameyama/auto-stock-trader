#!/usr/bin/env python3
"""
KOH-590: レジーム条件付き BE 発動倍率を 16窓リセット (12ヶ月固定窓 × 6ヶ月スライド, 各窓 ¥500K)
で比較し、対応のある t検定 / 符号検定にかける。却下 #42-49/#51 と同じ手法。

問い: 却下 #37 は「BE をグローバルに 0.3 未満へ下げると WF で単調に悪化（純粋な過学習次元）」
      と現エンジンで結論したが、「平時は 0.3 のまま、荒れた局面だけ絞る」条件付き版なら
      別の答えになるか。

★判定は Calmar で行う（NetRet ではない）。
  却下 #46 で risk% を NetRet で見ると p=0.013 の偽陽性が出て、Calmar で測り直すと p=0.114 で
  消えた実例がある。主KPI は Calmar なのでそちらを基準にする。NetRet は参考表示。

★条件に日経は使わない。日経 ≤ -3% の日は却下 #51 で「GU/PSC は保有ゼロ＝噛む相手がいない」
  と実測済みで、条件として成立しないため。
★breadth は前営業日の確定値で判定（当日 breadth は本番 15:20 に存在しない。却下 #41 の罠）。
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
    WINDOWS.append((f"{y:04d}-{m:02d}-01", f"{y + 1:04d}-{m:02d}-01"))
    m += 6
    if m > 12:
        m -= 12
        y += 1
    ym = (y, m)

CONFIGS = ["base-0.3", "vix!=normal-0.15", "vix!=normal-0.10", "breadth<60-0.15", "breadth<54-0.15"]
BASE = "base-0.3"


def run_window(start, end):
    cmd = [
        "npx", "tsx", "src/backtest/combined-run.ts",
        "--compare-conditional-be",
        "--start", start, "--end", end, "--budget", "500000",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=2400)
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
        return (float("inf") if mean != 0 else 0.0), mean
    return mean / (sd / (n ** 0.5)), mean


def sign_test_p(wins, losses):
    """両側符号検定（同点除外）。同点を負けに算入すると基準側を過小評価する（却下 #46 の教訓）。"""
    n = wins + losses
    if n == 0:
        return 1.0
    k = max(wins, losses)
    return min(1.0, sum(comb(n, i) for i in range(k, n + 1)) / (2 ** n) * 2)


def main():
    results = {}
    print("16窓を並列実行 (4並列)...", flush=True)
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
                      + "  ".join(f"{c.split('-')[0]}={rows[c]['calmar']:.1f}" for c in CONFIGS),
                      flush=True)
            else:
                s, e = futs[fut]
                print(f"  [{done}/16] {s} -> {e}  FAILED", flush=True)

    ordered = [results[w] for w in WINDOWS if w in results]
    n = len(ordered)
    print(f"\n=== 集計 ({n}/16 窓) ===")
    for metric in ("calmar", "netret", "maxdd", "trades"):
        print(f"\n[{metric}]")
        for c in CONFIGS:
            vals = [r[c][metric] for r in ordered]
            print(f"  {c:18s} 合計={sum(vals):9.2f}  平均={statistics.mean(vals):8.3f}")

    print("\n※ base-0.3 の netret 合計が 796.4 なら 16窓 baseline と一致（測定系チェックサム）")

    print(f"\n=== 対応のある検定 (基準={BASE})  ★判定は calmar ===")
    for arm in CONFIGS:
        if arm == BASE:
            continue
        for metric in ("calmar", "netret"):
            diffs = [r[arm][metric] - r[BASE][metric] for r in ordered]
            t, mean = paired_t(diffs)
            wins = sum(1 for d in diffs if d > 1e-9)
            losses = sum(1 for d in diffs if d < -1e-9)
            ties = n - wins - losses
            mark = "★" if metric == "calmar" else " "
            print(f" {mark}{arm:18s} [{metric:6s}]  平均差={mean:+8.3f}  t={t:+6.2f}  "
                  f"勝ち {wins}/{n} (同点{ties})  符号検定p={sign_test_p(wins, losses):.3f}")

    print(f"\n=== 窓別 calmar ===")
    print(f"  {'窓':23s} " + " ".join(f"{c:>18s}" for c in CONFIGS))
    for (s, e), r in ((w, results[w]) for w in WINDOWS if w in results):
        print(f"  {s}->{e} " + " ".join(f"{r[c]['calmar']:18.2f}" for c in CONFIGS))


if __name__ == "__main__":
    main()
