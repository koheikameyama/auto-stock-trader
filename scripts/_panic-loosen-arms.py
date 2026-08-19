#!/usr/bin/env python3
"""
パニック底反発の発火条件を緩めて「offseason の弾を増やせるか」を測る（探索的）。

契機= ユーザーの問い「GUの候補が0のときに offseason 戦略でエントリーするのはどうか」。
まず「GU候補0」をゲートにする案を測ったが、新規に開くのは 8.5年で17件・うち14件が
過熱帯(既に PF 0.14 と測定済みの最悪バケット)で足切り。
そこで「弾を増やす」を **稼働率を上げる** ではなく **GUが沈む局面のDDを埋める** と読み替え、
唯一それが効いている panic (fullcycle 15件で Calmar +28% / MaxDD -2.2pp) の
発火条件そのものを緩める方向を測る。

★重要な前提:
  - 現行 VIX>25 / breadth<40% / N225連続下落>=3日 は **旧エンジン・cash基準・GU+PSC構成**
    で決めた値。baseline が二重に変わった今(GU3単独 / 総資産基準)、そもそも再測定対象。
  - 却下#531: VIX条件を外した2cond版は fullcycle +7% だが **D期 -35%**。
    緩めると D期の浅い押しに発火して GU と食い合う。**判定は必ず年代別**、
    とくに era3(2024-26) の劣化幅を見る（fullcycle 単発は複利で era3 に加重される＝2026-08-04 の教訓）。
  - トレード数が2桁の戦略に 12点グリッドを掛けるのは「磨き上げでノイズを拾う」形。
    本スクリプトは **採用判定ではなく探索**。勝った条件があっても、そのまま本番には入れない。

イベントJSONは `scripts/_gen-panic-events.ts --vix .. --breadth .. --down-days ..` で生成
（live 再現定義 = --entry-lag 1 --breadth-universe daily）。

Usage:
  python3 scripts/_panic-loosen-arms.py <events_dir>
"""
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

EVENTS_DIR = sys.argv[1] if len(sys.argv) > 1 else "/tmp/panic"
BUDGET = "500000"
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", "4"))

WINDOWS = [
    ("fullcycle", "2018-04-01", "2026-07-31", 8.33),
    ("era1 2018-20", "2018-04-01", "2020-12-31", 2.75),
    ("era2 2021-23", "2021-01-01", "2023-12-31", 3.0),
    ("era3 2024-26", "2024-01-01", "2026-07-31", 2.58),
]

# breadth 40→45% はイベント数を +2〜9% しか動かさない（生成ログで確認済み）ので軸から落とした。
# 自由度を減らすほどノイズを拾いにくい。
VIX_GRID = [22, 25, 28]
BREADTH_GRID = [40]
DOWN_GRID = [2, 3]

ARMS = [("baseline(GU3単独)", None)]
for v in VIX_GRID:
    for b in BREADTH_GRID:
        for d in DOWN_GRID:
            label = f"v{v}/b{b}/d{d}"
            if (v, b, d) == (25, 40, 3):
                label += "★現行"
            ARMS.append((label, os.path.join(EVENTS_DIR, f"ev_v{v}_b{b}_d{d}.json")))

BLOCK_RE = re.compile(r"^\[(.+?)\]$")


def parse(stdout: str):
    """printMetrics のブロックを {ラベル: {指標: 値}} に落とす"""
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
    sig = re.search(r"パニック底反発 シグナル: (\d+)件", stdout)
    return blocks, int(sig.group(1)) if sig else 0


def run(arm_label, json_path, win_label, start, end, years):
    cmd = ["npx", "tsx", "src/backtest/combined-run.ts",
           "--start", start, "--end", end, "--budget", BUDGET]
    if json_path:
        cmd += ["--enable-panic", "--panic-json", json_path]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    if p.returncode != 0:
        return arm_label, win_label, {"error": p.stderr.strip().splitlines()[-1] if p.stderr else "failed"}
    blocks, sig = parse(p.stdout)
    tot = blocks.get("全体", {})
    leg = next((v for k, v in blocks.items() if k.startswith("パニック底反発")), {})
    netret, maxdd = tot.get("netret"), tot.get("maxdd")
    calmar = (netret / years) / maxdd if netret is not None and maxdd else None
    return arm_label, win_label, {
        "trades": tot.get("trades"), "pf": tot.get("pf"), "maxdd": maxdd,
        "netret": netret, "calmar": calmar,
        "sig": sig, "leg_trades": leg.get("trades"), "leg_pf": leg.get("pf"),
    }


def main():
    jobs = []
    for arm_label, jp in ARMS:
        if jp and not os.path.exists(jp):
            print(f"⚠️ イベントJSONが無い: {jp} (このアームはスキップ)")
            continue
        for win_label, s, e, y in WINDOWS:
            jobs.append((arm_label, jp, win_label, s, e, y))

    print(f"{len(jobs)} ジョブを並列度 {MAX_WORKERS} で実行...")
    res = {}
    done = 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = [ex.submit(run, *j) for j in jobs]
        for f in as_completed(futs):
            arm, win, r = f.result()
            res[(arm, win)] = r
            done += 1
            print(f"  [{done}/{len(jobs)}] {arm} / {win}: "
                  + (r["error"] if "error" in r else
                     f"Calmar {r['calmar']:.2f} (panic {r['leg_trades']}件)"), flush=True)

    base_key = ARMS[0][0]
    print("\n" + "=" * 100)
    print("Calmar = (NetRet ÷ 年数) ÷ MaxDD  ／ カッコ内は baseline 比")
    print("=" * 100)
    header = "アーム".ljust(18) + "".join(w[0].rjust(21) for w in WINDOWS)
    print(header)
    for arm_label, _ in ARMS:
        if (arm_label, WINDOWS[0][0]) not in res:
            continue
        row = arm_label.ljust(16)
        for win_label, *_ in WINDOWS:
            r = res.get((arm_label, win_label), {})
            b = res.get((base_key, win_label), {})
            if r.get("calmar") is None:
                row += "-".rjust(21)
                continue
            if arm_label == base_key or not b.get("calmar"):
                row += f"{r['calmar']:.2f}".rjust(21)
            else:
                d = (r["calmar"] / b["calmar"] - 1) * 100
                row += f"{r['calmar']:.2f} ({d:+.0f}%)".rjust(21)
        print(row)

    print("\n" + "=" * 100)
    print("panic レッグの発火件数 / レッグPF / 全体MaxDD")
    print("=" * 100)
    print("アーム".ljust(18) + "".join(w[0].rjust(21) for w in WINDOWS))
    for arm_label, jp in ARMS:
        if not jp or (arm_label, WINDOWS[0][0]) not in res:
            continue
        row = arm_label.ljust(16)
        for win_label, *_ in WINDOWS:
            r = res.get((arm_label, win_label), {})
            if r.get("leg_trades") is None:
                row += "-".rjust(21)
                continue
            pf = r["leg_pf"]
            pfs = "∞" if pf == float("inf") else (f"{pf:.2f}" if pf is not None else "-")
            row += f"{r['leg_trades']}件 PF{pfs} DD{r['maxdd']:.1f}%".rjust(21)
        print(row)

    print("\nbaseline MaxDD:", ", ".join(
        f"{w[0]} {res.get((base_key, w[0]), {}).get('maxdd', float('nan')):.1f}%" for w in WINDOWS))


if __name__ == "__main__":
    main()
