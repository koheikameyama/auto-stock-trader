#!/usr/bin/env python3
"""
KOH-583: セクター集中上限を 16窓リセットで再測定（現エンジン）。

本番 SECTOR_RISK.MAX_SAME_SECTOR_POSITIONS=1（同一セクターグループ1件まで）が、
BTで「有害・不採用」と結論された制約（却下リスト#3, 2026-04-22, 旧エンジン）と乖離している。
却下#39 のエンジン修正後の現エンジンで測り直す。

アーム（combined-run の --compare-sector が単発窓の human-readable 表で出力）:
  制限なし  = maxPerSector 無し（BT本来の baseline / Calmar 最良候補）
  2件      = 同一セクター2件まで（旧エンジンでは「制限なしと同一＝無害な緩和」）
  1件      = 同一セクター1件まで（★現本番の実態）

判定は 1件（現本番）を基準に「制限なし / 2件」が有意に上回るかを対応のある t検定 / 符号検定で見る。
却下 #40/#42-48 と同じ手法（12ヶ月固定窓 × 6ヶ月スライド × 16窓、各窓 ¥500K リセット）。

★留保: BT の --compare-sector は生 Stock.sector（33業種）基準。本番は粗い getSectorGroup で1件なので
本番の縛りはこれ以上にキツい。この測定は「下限見積り（生業種でも1件が劣るか）」の位置づけ。
"""
import subprocess
import sys
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from math import comb

# 16窓: 2018-01 起点、12ヶ月固定、6ヶ月スライド（却下 #40/#42-48 と同一）
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

# 表の行ラベル → アーム名
ROW_LABELS = {
    "制限なし": "nolimit",
    "2件/セクター": "cap2",
    "1件/セクター": "cap1",
}
ARMS = ["nolimit", "cap2", "cap1"]


def parse_pct(s):
    return float(s.replace("%", "").strip())


def run_window(start, end):
    cmd = [
        "npx", "tsx", "src/backtest/combined-run.ts",
        "--compare-sector",
        "--start", start, "--end", end, "--budget", "500000",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    rows = {}
    in_table = False
    for line in out.stdout.splitlines():
        if "セクター分散上限比較" in line:
            in_table = True
            continue
        if in_table and line.startswith("=== レジーム"):
            break
        if not in_table or "|" not in line:
            continue
        cols = [c.strip() for c in line.split("|")]
        label = cols[0]
        arm = None
        for key, name in ROW_LABELS.items():
            if label.startswith(key):
                arm = name
                break
        if arm is None:
            continue
        # 上限 | Trades | WinR | PF | Expect | MaxDD | NetRet | Calmar | 稼働率
        try:
            rows[arm] = {
                "trades": int(cols[1]),
                "pf": float(cols[3]),
                "maxdd": parse_pct(cols[5]),
                "netret": parse_pct(cols[6]),
                "calmar": float(cols[7]),
            }
        except (ValueError, IndexError):
            continue
    if set(rows) != set(ARMS):
        sys.stderr.write(
            f"[WARN] {start}->{end}: 不完全な出力 {set(rows)}\n"
            f"{out.stdout[-1000:]}\n{out.stderr[-600:]}\n"
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
    se = sd / (n ** 0.5)
    return mean / se, mean


def sign_test_p(wins, losses):
    # 両側符号検定（同点除外）
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
    hdr = f"{'window':<20} {'nolimit':>10} {'cap2':>10} {'cap1(本番)':>12}"
    print("=== NetRet% by window ===")
    print(hdr)
    for start, end, rows in results:
        print(f"{start}->{end:<10} {rows['nolimit']['netret']:>10.1f} "
              f"{rows['cap2']['netret']:>10.1f} {rows['cap1']['netret']:>12.1f}")

    print("\n=== Calmar by window ===")
    print(hdr)
    for start, end, rows in results:
        print(f"{start}->{end:<10} {rows['nolimit']['calmar']:>10.2f} "
              f"{rows['cap2']['calmar']:>10.2f} {rows['cap1']['calmar']:>12.2f}")

    # 集計 + 検定（基準 = cap1 = 現本番）
    for metric in ["netret", "calmar"]:
        print(f"\n########## 判定: {metric.upper()} (基準 = cap1 / 現本番) ##########")
        base_sum = sum(r[2]["cap1"][metric] for r in results)
        print(f"cap1(本番) 合計: {base_sum:.2f}")
        for arm in ["nolimit", "cap2"]:
            arm_sum = sum(r[2][arm][metric] for r in results)
            diffs = [r[2][arm][metric] - r[2]["cap1"][metric] for r in results]
            t, mean = paired_t(diffs)
            wins = sum(1 for d in diffs if d > 1e-9)
            losses = sum(1 for d in diffs if d < -1e-9)
            ties = len(diffs) - wins - losses
            p = sign_test_p(wins, losses)
            print(f"  {arm:<8} 合計 {arm_sum:>10.2f} | 差 {arm_sum - base_sum:>+9.2f} "
                  f"| 平均差/窓 {mean:>+8.3f} t={t:>+6.2f} "
                  f"| {wins}勝{losses}敗{ties}分 符号検定p={p:.3f}")


if __name__ == "__main__":
    main()
