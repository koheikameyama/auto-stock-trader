#!/usr/bin/env python3
"""
KOH-589: 日経キルスイッチの「決済側」を 16窓リセット (12ヶ月固定窓 × 6ヶ月スライド, 各窓 ¥500K)
で比較し、対応のある t検定 / 符号検定にかける。却下 #42-49 と同じ手法。

問い: 日経急落時は「買わない」ではなく「売らない」が正解ではないか。

背景: 本番は日経 ≤ -3% で market-assessment が sentiment="crisis" を書き、position-monitor が
全ポジションを成行決済する。一方 BT の processDefensive は VIX>30 でしか発火しないため、
記録されている全 BT 成績はこの決済を含んでいない (live専用挙動)。

アーム (エントリー側 veto は全アーム本番と同じ lagged/-3% に固定し、決済側だけを振る):
  exit-off     BT本来。日経では決済しない = 「売らない」案
               → 16窓 NetRet 合計が KOH-577 の lagged 806.65% に一致するのがチェックサム
  exit-lagged  現在の本番の実挙動。D-1 の確定終値で判定し D の終値で全決済
               = 「暴落日は食らい、翌営業日に投げる」
  exit-sameday 暴落当日 D の終値で判定し D の終値で全決済 (本番が構造上撃てない理想形)
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
    m += 6
    if m > 12:
        m -= 12
        y += 1
    ym = (y, m)

CONFIGS = ["exit-off", "exit-lagged", "exit-sameday"]
BASE = "exit-off"  # 「売らない」= 提案側を基準に、本番挙動がどれだけ違うかを測る


def run_window(start, end):
    cmd = [
        "npx", "tsx", "src/backtest/combined-run.ts",
        "--compare-nikkei-defensive-exit",
        "--start", start, "--end", end, "--budget", "500000",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=2400)
    rows = {}
    for line in out.stdout.splitlines():
        if not line.startswith("WINROW,"):
            continue
        _, s, e, label, trades, netret, maxdd, calmar, pf, defexits = line.split(",")
        rows[label] = {
            "trades": int(trades), "netret": float(netret),
            "maxdd": float(maxdd), "calmar": float(calmar), "pf": float(pf),
            "defexits": int(defexits),
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
    """両側符号検定 (同点除外)。同点を負けに算入すると基準側を過小評価する (却下 #46 の教訓)。"""
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
                      f"off={rows['exit-off']['netret']:.1f}% "
                      f"lag={rows['exit-lagged']['netret']:.1f}% "
                      f"same={rows['exit-sameday']['netret']:.1f}%  "
                      f"防御決済 lag={rows['exit-lagged']['defexits']} same={rows['exit-sameday']['defexits']}",
                      flush=True)
            else:
                s, e = futs[fut]
                print(f"  [{done}/16] {s} -> {e}  FAILED", flush=True)

    ordered = [results[w] for w in WINDOWS if w in results]
    n = len(ordered)
    print(f"\n=== 集計 ({n}/16 窓) ===")
    for metric in ("netret", "calmar", "maxdd", "trades", "defexits"):
        print(f"\n[{metric}]")
        for c in CONFIGS:
            vals = [r[c][metric] for r in ordered]
            print(f"  {c:13s} 合計={sum(vals):9.2f}  平均={statistics.mean(vals):8.3f}")

    print(f"\n※ exit-off の netret 合計が 806.65 なら KOH-577 lagged と一致 (測定系チェックサム)")

    print(f"\n=== 対応のある検定 (基準={BASE} =「売らない」) ===")
    for arm in CONFIGS:
        if arm == BASE:
            continue
        for metric in ("netret", "calmar"):
            diffs = [r[arm][metric] - r[BASE][metric] for r in ordered]
            t, mean = paired_t(diffs)
            wins = sum(1 for d in diffs if d > 1e-9)
            losses = sum(1 for d in diffs if d < -1e-9)
            ties = n - wins - losses
            print(f"  {arm:13s} - {BASE} [{metric:6s}]  "
                  f"平均差={mean:+8.3f}  t={t:+6.2f}  "
                  f"{arm}勝ち {wins}/{n} (同点{ties})  符号検定p={sign_test_p(wins, losses):.3f}")

    # 窓別 (合計だけ見ると誤判定する。却下 #42 の教訓)
    print(f"\n=== 窓別 netret ===")
    print(f"  {'窓':21s} " + " ".join(f"{c:>13s}" for c in CONFIGS) + "   防御決済(lag/same)")
    for (s, e), r in ((w, results[w]) for w in WINDOWS if w in results):
        marks = " ".join(f"{r[c]['netret']:13.2f}" for c in CONFIGS)
        print(f"  {s}->{e} {marks}   {r['exit-lagged']['defexits']}/{r['exit-sameday']['defexits']}")


if __name__ == "__main__":
    main()
