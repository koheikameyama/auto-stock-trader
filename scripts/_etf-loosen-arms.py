#!/usr/bin/env python3
"""
米株ETF (1547/1545) の発火条件を緩めて「offseason の弾を増やせるか」を測る（探索的）。

却下#58 の続き。①GU候補0ゲート（17件・PF 0.39）②panic 緩和（質が桁で劣化）が塞がり、
未検証で残っていた最後の一手が **ETF自身のトリガー緩和** だった。

  現行: gap>=0.5% + vol>=1.5x + 陽線 + idle帯(breadth<54%)
  → idle帯 1,082日に対し 8.5年で 82件しか撃っていない（却下#58 の計測）

★idle帯ゲート (breadthMax) は動かさない。却下#17-24 が7回確認した
  「breadth filter は弱気相場ノイズ除去として本質的に機能・代替不可」を崩さないため、
  緩めるのは戦略自身のトリガーだけに限る。

★事前確率は低い: 却下#27（金ETF）が「ETFは期待値が薄いので往復コストで急速に減衰する」
  （gross PF 1.85 → コスト0.2%で 1.48 → 0.3%で 1.32）と測っており、
  限界トレードほどコスト負けしやすい。panic と同じ「緩めると質が落ちる」形が出る想定。

判定は却下#57/#58 と同じく **年代別**（fullcycle 単発は複利で era3 に加重される）。
基準は2つ置く: baseline(GU3単独) と **etf現行(=本番構成)**。超えるべきは後者。

Usage:
  python3 scripts/_etf-loosen-arms.py
"""
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed

BUDGET = "500000"
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", "3"))
PANIC_JSON = os.environ.get("PANIC_JSON")  # 指定時のみ panic 検算アームを足す

WINDOWS = [
    ("fullcycle", "2018-04-01", "2026-07-31", 8.33),
    ("era1 2018-20", "2018-04-01", "2020-12-31", 2.75),
    ("era2 2021-23", "2021-01-01", "2023-12-31", 3.0),
    ("era3 2024-26", "2024-01-01", "2026-07-31", 2.58),
]

# (ラベル, 追加argv)
ARMS = [
    ("baseline(GU3単独)", []),
    ("etf gap0.5/vol1.5★現行", ["--enable-etf"]),
    ("etf gap0.5/vol1.2", ["--enable-etf", "--etf-vol", "1.2"]),
    ("etf gap0.5/vol1.0", ["--enable-etf", "--etf-vol", "1.0"]),
    ("etf gap0.0/vol1.5", ["--enable-etf", "--etf-gap", "0"]),
    ("etf gap0.0/vol1.2", ["--enable-etf", "--etf-gap", "0", "--etf-vol", "1.2"]),
    ("etf gap0.0/vol1.0", ["--enable-etf", "--etf-gap", "0", "--etf-vol", "1.0"]),
    # 締める方向も1点だけ置く: panic では「締めるほどレッグPFが上がる」単調性が
    # 一番頑健な発見だった（却下#58）。同じ形が出るかを見るための対照。
    ("etf gap1.0/vol2.0", ["--enable-etf", "--etf-gap", "0.01", "--etf-vol", "2.0"]),
]

# 却下#58 の検算: panic を `--entry-lag 1` のイベントで測る時は KOH-554 の指示どおり
# `--panic-breadth-max 1` を渡して「エントリー日当日 breadth<54%」の先読みを外すべきだった。
# 渡さずに測っていたので、結果が変わらないことを確認する（breadth<40% の翌日なので
# 非拘束のはずだが、仮定せず実測する）。
if PANIC_JSON:
    ARMS += [
        ("panic v25/d3(記録どおり)", ["--enable-panic", "--panic-json", PANIC_JSON]),
        ("panic v25/d3+先読み無効", ["--enable-panic", "--panic-json", PANIC_JSON, "--panic-breadth-max", "1"]),
    ]

BASE = ARMS[0][0]
REF = ARMS[1][0]  # 本番構成（超えるべき基準）
BLOCK_RE = re.compile(r"^\[(.+?)\]$")


def parse(stdout: str):
    blocks, cur = {}, None
    for line in stdout.splitlines():
        s = line.strip()
        m = BLOCK_RE.match(s)
        if m:
            cur = m.group(1)
            blocks[cur] = {}
            continue
        if cur is None:
            continue
        if s.startswith("トレード数:"):
            blocks[cur]["trades"] = int(re.search(r"トレード数: (\d+)", s).group(1))
        elif s.startswith("PF:"):
            v = s.split(":", 1)[1].strip()
            blocks[cur]["pf"] = float("inf") if v == "∞" else float(v)
        elif s.startswith("最大DD:"):
            blocks[cur]["maxdd"] = float(re.search(r"([\d.]+)%", s).group(1))
        elif s.startswith("純損益:"):
            blocks[cur]["netret"] = float(re.search(r"\(([-\d.]+)%\)", s).group(1))
    sig = re.search(r"(?:US ETF|パニック底反発) シグナル: (\d+)件", stdout)
    return blocks, int(sig.group(1)) if sig else 0


def run(label, extra, win_label, start, end, years):
    cmd = ["npx", "tsx", "src/backtest/combined-run.ts",
           "--start", start, "--end", end, "--budget", BUDGET] + extra
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    if p.returncode != 0:
        return label, win_label, {"error": (p.stderr.strip().splitlines() or ["failed"])[-1]}
    blocks, sig = parse(p.stdout)
    tot = blocks.get("全体", {})
    leg = next((v for k, v in blocks.items()
                if k.startswith("US ETF") or k.startswith("パニック底反発")), {})
    netret, maxdd = tot.get("netret"), tot.get("maxdd")
    return label, win_label, {
        "trades": tot.get("trades"), "maxdd": maxdd, "netret": netret,
        "calmar": (netret / years) / maxdd if netret is not None and maxdd else None,
        "sig": sig, "leg_trades": leg.get("trades"), "leg_pf": leg.get("pf"),
    }


def fmt_pf(pf):
    if pf is None:
        return "-"
    return "∞" if pf == float("inf") else f"{pf:.2f}"


def main():
    jobs = [(lb, ex, w[0], w[1], w[2], w[3]) for lb, ex in ARMS for w in WINDOWS]
    print(f"{len(jobs)} ジョブを並列度 {MAX_WORKERS} で実行...")
    res, done = {}, 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        for f in as_completed([ex.submit(run, *j) for j in jobs]):
            lb, w, r = f.result()
            res[(lb, w)] = r
            done += 1
            print(f"  [{done}/{len(jobs)}] {lb} / {w}: "
                  + (r["error"] if "error" in r else
                     f"Calmar {r['calmar']:.2f} (leg {r['leg_trades']}件)"), flush=True)

    print("\n" + "=" * 108)
    print(f"Calmar = (NetRet ÷ 年数) ÷ MaxDD ／ カッコ内は「{REF}」比（本番構成を超えるかが判定軸）")
    print("=" * 108)
    print("アーム".ljust(24) + "".join(w[0].rjust(21) for w in WINDOWS))
    for lb, _ in ARMS:
        row = lb.ljust(22)
        for w in WINDOWS:
            r, ref = res.get((lb, w[0]), {}), res.get((REF, w[0]), {})
            if r.get("calmar") is None:
                row += "-".rjust(21)
            elif lb in (BASE, REF) or not ref.get("calmar"):
                row += f"{r['calmar']:.2f}".rjust(21)
            else:
                row += f"{r['calmar']:.2f} ({(r['calmar']/ref['calmar']-1)*100:+.0f}%)".rjust(21)
        print(row)

    print("\n" + "=" * 108)
    print("レッグ発火件数 / レッグPF / 全体MaxDD")
    print("=" * 108)
    print("アーム".ljust(24) + "".join(w[0].rjust(21) for w in WINDOWS))
    for lb, extra in ARMS:
        if not extra:
            continue
        row = lb.ljust(22)
        for w in WINDOWS:
            r = res.get((lb, w[0]), {})
            if r.get("leg_trades") is None:
                row += "-".rjust(21)
            else:
                row += f"{r['leg_trades']}件 PF{fmt_pf(r['leg_pf'])} DD{r['maxdd']:.1f}%".rjust(21)
        print(row)

    print("\nbaseline: " + ", ".join(
        f"{w[0]} Calmar {res.get((BASE, w[0]), {}).get('calmar', float('nan')):.2f}"
        f" / DD {res.get((BASE, w[0]), {}).get('maxdd', float('nan')):.1f}%" for w in WINDOWS))


if __name__ == "__main__":
    main()
