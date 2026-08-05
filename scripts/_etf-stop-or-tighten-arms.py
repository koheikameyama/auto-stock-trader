#!/usr/bin/env python3
"""
米株ETF を「止める / 現行のまま / 絞る」の三つ巴で判定する。

契機= 却下#58 (5) の副産物。ETF は 2026-05-21 から本番稼働しているが、GU3単独・総資産基準の
新 baseline で測ると **fullcycle MaxDD を 17.2% → 24.8% (+7.6pp) に膨らませている**一方、
トリガーを締めた版 (gap1.0/vol2.0, 16件) は **MaxDD を baseline 並みに戻しつつ Calmar +52%**
だった。KOH-600 (却下#57) は「ETF 現状維持」を era1 +10% / era2 +4% を根拠に決めたが、
**「絞る」という選択肢を一度も測っていない**。

★この検証で答えるべきは3つ:
  (a) 用量反応があるか — 現行→やや締める→締める→強く締める が単調に動くか。
      単調でなければ経路依存フリップを疑う（却下#56 で連休前ガードを落とした軸）。
  (b) 窓ずらしで生き残るか — era2/era3 を起点違いで3本ずつ測る。
      却下#57 が優待で使った手順。ただし**重複窓なので独立サンプルではない**点は同じ。
  (c) era2 (offseason主体) の劣化をどう読むか — 締めると era2 で -55% になる。
      ETF の存在意義は offseason の DD を埋めることなので、ここが壊れるなら
      「絞る」は目的に反する。fullcycle/era3 の改善は複利で era3 に加重された
      数字である可能性を常に疑う（却下#57 の中心的教訓）。

★注意: 全アームで n が薄い（締めた版は fullcycle 16件 / era2 3件）。WF は ETF 単独では
  実施済み (OOS PF 1.91) だが、それは資金無限の理想値であって共有プールの判定にはならない。
  本スクリプトの出力だけで本番を変えないこと。

Usage:
  python3 scripts/_etf-stop-or-tighten-arms.py
"""
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed

BUDGET = "500000"
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", "3"))

# (ラベル, start, end, 年数)
WINDOWS = [
    ("fullcycle", "2018-04-01", "2026-07-31", 8.33),
    ("era1", "2018-04-01", "2020-12-31", 2.75),
    ("era2", "2021-01-01", "2023-12-31", 3.00),
    ("era2-a", "2020-10-01", "2023-09-30", 3.00),
    ("era2-b", "2021-04-01", "2024-03-31", 3.00),
    ("era3", "2024-01-01", "2026-07-31", 2.58),
    ("era3-a", "2023-10-01", "2026-07-31", 2.83),
    ("era3-b", "2024-04-01", "2026-07-31", 2.33),
]

# 用量反応を見るため現行から単調に締める梯子にする
ARMS = [
    ("A 停止(GU3単独)", []),
    ("B 現行 g0.5/v1.5", ["--enable-etf"]),
    ("C g0.75/v1.75", ["--enable-etf", "--etf-gap", "0.0075", "--etf-vol", "1.75"]),
    ("D g1.0/v2.0", ["--enable-etf", "--etf-gap", "0.01", "--etf-vol", "2.0"]),
    ("E g1.5/v2.5", ["--enable-etf", "--etf-gap", "0.015", "--etf-vol", "2.5"]),
]
REF = "B 現行 g0.5/v1.5"  # 本番構成。超えるべき基準
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
    return blocks


def run(label, extra, win, start, end, years):
    cmd = ["npx", "tsx", "src/backtest/combined-run.ts",
           "--start", start, "--end", end, "--budget", BUDGET] + extra
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    if p.returncode != 0:
        return label, win, {"error": (p.stderr.strip().splitlines() or ["failed"])[-1]}
    blocks = parse(p.stdout)
    tot = blocks.get("全体", {})
    gu = blocks.get("GapUp", {})
    leg = next((v for k, v in blocks.items() if k.startswith("US ETF")), {})
    netret, maxdd = tot.get("netret"), tot.get("maxdd")
    return label, win, {
        "trades": tot.get("trades"), "maxdd": maxdd, "netret": netret,
        "calmar": (netret / years) / maxdd if netret is not None and maxdd else None,
        "leg_trades": leg.get("trades"), "leg_pf": leg.get("pf"),
        "gu_trades": gu.get("trades"), "gu_pf": gu.get("pf"),
    }


def pf(x):
    return "-" if x is None else ("∞" if x == float("inf") else f"{x:.2f}")


def table(title, cell):
    print("\n" + "=" * 118)
    print(title)
    print("=" * 118)
    print("アーム".ljust(20) + "".join(w[0].rjust(14) for w in WINDOWS))
    for lb, extra in ARMS:
        print(lb.ljust(18) + "".join(cell(lb, extra, w).rjust(14) for w in WINDOWS))


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
                  + (r["error"] if "error" in r else f"Calmar {r['calmar']:.2f}"), flush=True)

    def calmar_cell(lb, extra, w):
        r, ref = res.get((lb, w[0]), {}), res.get((REF, w[0]), {})
        if r.get("calmar") is None:
            return "-"
        if lb == REF or not ref.get("calmar"):
            return f"{r['calmar']:.2f}"
        return f"{r['calmar']:.2f}({(r['calmar']/ref['calmar']-1)*100:+.0f}%)"

    table("Calmar = (NetRet ÷ 年数) ÷ MaxDD ／ カッコ内は本番構成 B 比", calmar_cell)
    table("最大DD%", lambda lb, ex, w: f"{res.get((lb, w[0]), {}).get('maxdd', float('nan')):.1f}%")
    table("ETFレッグ 件数/PF",
          lambda lb, ex, w: "-" if not ex else
          f"{res.get((lb, w[0]), {}).get('leg_trades', '-')}件/{pf(res.get((lb, w[0]), {}).get('leg_pf'))}")
    table("GUレッグ 件数（押しのけ量の確認）",
          lambda lb, ex, w: f"{res.get((lb, w[0]), {}).get('gu_trades', '-')}")

    # 窓ずらしの一貫性: era2 系3窓 / era3 系3窓で B に勝った回数
    print("\n" + "=" * 118)
    print("窓ずらしの一貫性（本番構成 B に勝った窓数。★重複窓なので独立サンプルではない）")
    print("=" * 118)
    for group, wins in [("era2系", ["era2", "era2-a", "era2-b"]), ("era3系", ["era3", "era3-a", "era3-b"])]:
        for lb, _ in ARMS:
            if lb == REF:
                continue
            got = [res.get((lb, w), {}).get("calmar") for w in wins]
            ref = [res.get((REF, w), {}).get("calmar") for w in wins]
            n = sum(1 for a, b in zip(got, ref) if a is not None and b and a > b)
            deltas = "/".join("-" if a is None or not b else f"{(a/b-1)*100:+.0f}%"
                              for a, b in zip(got, ref))
            print(f"  {group} {lb.ljust(18)} {n}/3勝  ({deltas})")


if __name__ == "__main__":
    main()
