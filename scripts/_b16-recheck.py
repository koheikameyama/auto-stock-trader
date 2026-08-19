#!/usr/bin/env python3
"""
B分類パラメータの棚卸し (2026-08-08): 却下#42-49 で「維持」とした本番エントリー/ゲート系
パラメータを、新 baseline (GU3単独・総資産基準・KOH-600 再構築DB) の16窓で再検定する。

背景: KOH-600 の分類 B — breadth band / cooldown / maxPrice / VIX scale / risk% /
gap×vol / セクター上限は、すべて旧構成 (GU3+PSC2・cash基準) の16窓で判定されており、
baseline 変更で技術的には未検証に戻っていた。出口系 (atr/be/trail) は KOH-600 の
gapup WF (堅牢✓) が新基準で検証済みなので対象外。

手法: 各 --compare-* モードを16窓 (12ヶ月固定×6ヶ月スライド、各窓¥500K) で回し、
メインの比較テーブル (9〜10列) を汎用パースして「現状」行との対応のある t検定 +
同点除外の符号検定 (却下#42-49 と同一の判定手順)。判定は Calmar 主・NetRet 従。

新チェックサム (scripts/_baseline16-new-config.py, 2026-08-08):
  NetRet合計 1308.50% / Calmar合計 112.94 — 各モードの現状行合計がこれと一致することが
  測定系の健全性チェックになる。

実行: python3 scripts/_b16-recheck.py            # 全モード順次
      python3 scripts/_b16-recheck.py cooldown vix  # モード名指定
"""
import re
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

# name -> (flag, 現状行のラベル部分一致)
MODES = {
    "cooldown": ("--compare-cooldown", "3日 (現状)"),
    "vix": ("--compare-vix-risk", "規定(0.5/0.25)"),
    "sector": ("--compare-sector", "制限なし (現状)"),
    "risk": ("--compare-risk-pct", "★2% (現状)"),
    "maxprice": ("--compare-universe-max-price", "★≤¥2,500 (現状)"),
    "breadthband": ("--compare-breadth-band", "★現状 band"),
    "gapvol": ("--compare-gu-gapvol", "gap=3.0% vol=1.5 (現状)"),
}

NUM = re.compile(r"^[+\-]?[\d,]+\.?\d*%?$")


def parse_table(text):
    """メイン比較テーブルの行を {label: metrics} で返す (最初の出現を採用)。
    行の形式: label | ... | Trades | WinR% | PF | Expect% | MaxDD% | NetRet% | Calmar | util%
    右から8フィールドを固定で読む (maxprice の銘柄数列のような余剰列はラベル側に吸収)。"""
    rows = {}
    for line in text.splitlines():
        if "|" not in line or "レジーム" in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 9:
            continue
        tail = parts[-8:]
        try:
            trades = int(tail[0].replace(",", ""))
            winr = float(tail[1].rstrip("%"))
            pf = float("inf") if tail[2] == "∞" else float(tail[2])
            expect = float(tail[3].rstrip("%"))
            maxdd = float(tail[4].rstrip("%"))
            netret = float(tail[5].rstrip("%"))
            calmar = float(tail[6])
            util = float(tail[7].rstrip("%"))
        except ValueError:
            continue
        label = " | ".join(parts[: len(parts) - 8]).strip()
        # maxprice モードの「銘柄数」のような余剰数値列がラベル側に残ると
        # 窓ごとに値が変わり共通アームの積集合が空になる → 末尾の純数値セグメントを落とす
        label = re.sub(r"\s*\|\s*[\d,]+$", "", label)
        if not label or label in rows:
            continue
        rows[label] = dict(trades=trades, winr=winr, pf=pf, expect=expect,
                           maxdd=maxdd, netret=netret, calmar=calmar, util=util)
    return rows


def run_window(flag, start, end):
    cmd = ["npx", "tsx", "src/backtest/combined-run.ts", flag,
           "--start", start, "--end", end, "--budget", "500000"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=10800)
    rows = parse_table(p.stdout)
    if not rows:
        sys.stderr.write(f"[WARN] {flag} {start}: テーブルなし\n{p.stdout[-500:]}\n{p.stderr[-300:]}\n")
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
    n = wins + losses
    if n == 0:
        return 1.0
    k = max(wins, losses)
    p = sum(comb(n, i) for i in range(k, n + 1)) / (2 ** n)
    return min(1.0, 2 * p)


def t_to_p_approx(t, n):
    """粗い両側p近似 (正規近似)。判定の目安用 (従来ドライバと同様、厳密検定は不要)"""
    import math
    if t != t:
        return float("nan")
    z = abs(t)
    return 2 * (1 - 0.5 * (1 + math.erf(z / math.sqrt(2))))


def run_mode(name):
    flag, base_pat = MODES[name]
    print(f"\n{'#' * 70}\n# モード: {name} ({flag})\n{'#' * 70}", flush=True)
    results = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(run_window, flag, s, e): (s, e) for s, e in WINDOWS}
        for fut in as_completed(futs):
            r = fut.result()
            if r:
                results.append(r)
                sys.stderr.write(f"  [done] {name} {r[0]}\n")
    results.sort()
    print(f"完了窓: {len(results)}/16")
    if len(results) < 16:
        print("!!! 窓が欠けている。判定は不完全 !!!")
        if not results:
            return

    # 全窓に存在するラベルのみ集計対象
    labels = set(results[0][2])
    for _, _, rows in results[1:]:
        labels &= set(rows)
    base = next((l for l in labels if base_pat in l), None)
    if base is None:
        print(f"!!! 現状行 '{base_pat}' が見つからない。labels={sorted(labels)[:10]}")
        return
    print(f"共通アーム数: {len(labels)} / 基準: {base}")

    base_net = sum(r[2][base]["netret"] for r in results)
    base_cal = sum(r[2][base]["calmar"] for r in results)
    base_dd = sum(r[2][base]["maxdd"] for r in results)
    print(f"基準合計: NetRet {base_net:.2f}% / Calmar {base_cal:.2f} / MaxDD {base_dd:.2f}"
          f"  (チェックサム: NetRet 1308.50 / Calmar 112.94)")

    for metric in ("calmar", "netret", "maxdd"):
        print(f"\n=== 判定: {metric.upper()} (基準 = {base}) ===")
        arms = sorted(labels, key=lambda l: -sum(r[2][l]["calmar"] for r in results))
        for arm in arms:
            arm_sum = sum(r[2][arm][metric] for r in results)
            if arm == base:
                print(f"  {arm:<28} 合計 {arm_sum:>10.2f}  ★基準")
                continue
            diffs = [r[2][arm][metric] - r[2][base][metric] for r in results]
            t, mean = paired_t(diffs)
            wins = sum(1 for d in diffs if d > 1e-9)
            losses = sum(1 for d in diffs if d < -1e-9)
            ties = len(diffs) - wins - losses
            p = sign_test_p(wins, losses)
            tp = t_to_p_approx(t, len(diffs))
            print(f"  {arm:<28} 合計 {arm_sum:>10.2f} | 差 {arm_sum - sum(r[2][base][metric] for r in results):>+9.2f}"
                  f" | 平均差 {mean:>+8.3f} t={t:>+6.2f} (p≈{tp:.3f})"
                  f" | {wins}勝{losses}敗{ties}分 符号p={p:.3f}")

    # 窓別 Calmar (上位気配の検証・少数窓依存の検出用)
    print(f"\n=== 窓別 Calmar ===")
    show = sorted(labels, key=lambda l: -sum(r[2][l]["calmar"] for r in results))[:6]
    if base not in show:
        show = [base] + show[:5]
    print("window".ljust(12) + "".join(l[:16].rjust(18) for l in show))
    for start, end, rows in results:
        print(start[:7].ljust(12) + "".join(f"{rows[l]['calmar']:>18.2f}" for l in show))


def main():
    targets = sys.argv[1:] or list(MODES)
    for name in targets:
        if name not in MODES:
            print(f"unknown mode: {name} (choices: {list(MODES)})")
            continue
        run_mode(name)


if __name__ == "__main__":
    main()
