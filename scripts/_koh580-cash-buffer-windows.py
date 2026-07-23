#!/usr/bin/env python3
"""
KOH-580: 買余力バッファ（掛目）の Calmar コストを 16窓リセットで計測。

8708.T の [sub:11430] 発注失敗（立花が日計り取引の規制対象銘柄で買付可能額に掛目を効かせる）緩和策として、
live の maxByBalance を「現金 × buffer」に絞る案の Calmar コストを測る。

アーム（combined-run の --compare-cash-buffer が単発窓で出力）:
  skip = BT本来（現金超過は発注見送り）= 記録上の baseline（16窓合計が ≒796.4% になるチェックサム）
  1.00 = shrink-to-fit @100%（現行 live 相当。live は skip せず maxByBalance に縮小して取る）
  0.90 / 0.80 = shrink-to-fit @buffer（提案する掛目バッファ）

判定は 1.00（現行 live 相当）を基準に 0.90 / 0.80 が有意に劣るかを対応のある t検定 / 符号検定で見る。
（skip→shrink の機構差を排除し haircut だけを測るため、基準は skip ではなく 1.00）
却下 #40/#42-47 と同じ手法（12ヶ月固定窓 × 6ヶ月スライド × 16窓、各窓 ¥500K リセット）。
"""
import subprocess
import sys
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from math import comb

# 16窓: 2018-01 起点、12ヶ月固定、6ヶ月スライド（却下 #40/#42-47 と同一）
WINDOWS = []
ym = (2018, 1)
for _ in range(16):
    y, m = ym
    start = f"{y:04d}-{m:02d}-01"
    ey, em = (y + 1, m)
    end = f"{ey:04d}-{em:02d}-01"
    WINDOWS.append((start, end))
    m += 6
    if m > 12:
        m -= 12
        y += 1
    ym = (y, m)

ARMS = ["skip", "1.00", "0.90", "0.80"]


def run_window(start, end):
    cmd = [
        "npx", "tsx", "src/backtest/combined-run.ts",
        "--compare-cash-buffer",
        "--start", start, "--end", end, "--budget", "500000",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    rows = {}
    for line in out.stdout.splitlines():
        if not line.startswith("WINROW,"):
            continue
        _, s, e, label, trades, netret, maxdd, calmar, pf = line.split(",")
        rows[label] = {
            "trades": int(trades), "netret": float(netret),
            "maxdd": float(maxdd), "calmar": float(calmar), "pf": float(pf),
        }
    if set(rows) != set(ARMS):
        sys.stderr.write(f"[WARN] {start}->{end}: 不完全な出力 {set(rows)}\n{out.stdout[-800:]}\n{out.stderr[-800:]}\n")
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
    se = sd / (n ** 0.5)
    return mean / se, mean


def sign_test_p(wins, losses):
    # 両側符号検定（同点除外）
    n = wins + losses
    if n == 0:
        return 1.0
    k = max(wins, losses)
    p = sum(comb(n, i) for i in range(k, n + 1)) / (2 ** n) * 2
    return min(1.0, p)


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
                      f"1.00={rows['1.00']['calmar']:.2f} "
                      f"0.90={rows['0.90']['calmar']:.2f} "
                      f"0.80={rows['0.80']['calmar']:.2f}", flush=True)
            else:
                s, e = futs[fut]
                print(f"  [{done}/16] {s} -> {e}  FAILED", flush=True)

    ordered = [results[w] for w in WINDOWS if w in results]
    n = len(ordered)
    if n < 16:
        print(f"\n[WARN] {n}/16 窓のみ成功。以降は成功窓のみで集計。")

    print(f"\n=== 集計 ({n}/16 窓) ===")
    for metric in ("netret", "calmar", "maxdd", "trades"):
        print(f"\n[{metric}]")
        for a in ARMS:
            vals = [r[a][metric] for r in ordered]
            print(f"  {a:5s} 合計={sum(vals):9.2f}  平均={statistics.mean(vals):8.3f}")

    # チェックサム: skip 合計 NetRet が記録の 16窓 baseline ≒796.4% と一致するはず
    skip_sum = sum(r["skip"]["netret"] for r in ordered)
    print(f"\n[チェックサム] skip NetRet 合計 = {skip_sum:.1f}%  (記録の16窓 baseline ≒ 796.4%)")

    # 判定: 基準=1.00（現行 live 相当）に対し 0.90 / 0.80 が有意に劣るか
    print("\n=== 対応のある検定 (基準=1.00 現行live相当) ===")
    for cand in ("0.90", "0.80"):
        for metric in ("calmar", "netret"):
            diffs = [r[cand][metric] - r["1.00"][metric] for r in ordered]
            t, mean = paired_t(diffs)
            wins = sum(1 for d in diffs if d > 1e-9)   # 候補が勝った窓
            losses = sum(1 for d in diffs if d < -1e-9)
            ties = n - wins - losses
            p_sign = sign_test_p(wins, losses)
            print(f"  {cand} - 1.00 [{metric:6s}]  "
                  f"平均差={mean:+8.3f}  t={t:+6.2f}  "
                  f"{cand}勝ち {wins}/{n} (同点{ties})  符号検定p={p_sign:.3f}")


if __name__ == "__main__":
    main()
