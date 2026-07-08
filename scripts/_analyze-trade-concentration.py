"""combined BT の --dump-trades JSON からトレード集中度を分析する。

「利益が少数の大勝ちトレードにどれだけ依存しているか」を定量化する診断スクリプト。
使い方:
    python scripts/_analyze-trade-concentration.py <trades.json>
"""

import json
import sys
from datetime import date

# 却下リスト #21 / レジーム別検証で確定した D期（大強気相場）ウィンドウ
D_PERIOD_START = date(2025, 5, 1)
D_PERIOD_END = date(2026, 2, 28)


def parse_date(s: str) -> date:
    return date.fromisoformat(s[:10])


def fmt_yen(v: float) -> str:
    sign = "+" if v >= 0 else ""
    return f"{sign}¥{round(v):,}"


def cumulative_share(sorted_pnls: list, total: float, n: int) -> float:
    if total == 0:
        return 0.0
    return sum(sorted_pnls[:n]) / total * 100


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/_analyze-trade-concentration.py <trades.json>")
        sys.exit(1)

    with open(sys.argv[1]) as f:
        data = json.load(f)

    rows = [r for r in data["rows"] if r.get("netPnl") is not None]
    if not rows:
        print("決済済みトレードがありません")
        sys.exit(1)

    total_net = sum(r["netPnl"] for r in rows)
    winners = sorted((r for r in rows if r["netPnl"] > 0), key=lambda r: -r["netPnl"])
    losers = [r for r in rows if r["netPnl"] <= 0]
    gross_win = sum(r["netPnl"] for r in winners)
    gross_loss = -sum(r["netPnl"] for r in losers)

    print("=" * 64)
    print("トレード集中度分析（少数の大勝ち依存度の定量化）")
    print("=" * 64)
    print(f"期間: {data['startDate']} → {data['endDate']}  初期資金: ¥{data['budget']:,}")
    print(
        f"決済トレード: {len(rows)}件（勝ち {len(winners)} / 負け {len(losers)}、"
        f"勝率 {len(winners) / len(rows) * 100:.1f}%）"
    )
    print(f"NetPnL 合計: {fmt_yen(total_net)}  勝ち総額: {fmt_yen(gross_win)}  負け総額: -¥{round(gross_loss):,}")

    # ── 上位トレード集中度 ──
    win_pnls = [r["netPnl"] for r in winners]
    print("\n── 上位勝ちトレードの寄与（NetPnL 合計比 / 勝ち総額比） ──")
    for n in (1, 3, 5, 10, 20):
        if n > len(winners):
            break
        share_net = cumulative_share(win_pnls, total_net, n)
        share_gross = cumulative_share(win_pnls, gross_win, n)
        print(f"  上位{n:>3}件: NetPnL比 {share_net:5.1f}%  勝ち総額比 {share_gross:5.1f}%")
    top_decile = max(1, len(rows) // 10)
    share_decile = cumulative_share(win_pnls, total_net, top_decile)
    print(f"  上位10%（{top_decile}件）: NetPnL比 {share_decile:.1f}%")

    # ── 上位を除外した反実仮想（ナイーブ：資金再配分は考慮しない） ──
    print("\n── 上位N件を除外した場合の NetPnL（ナイーブ反実仮想） ──")
    for n in (1, 5, 10, 20):
        if n > len(winners):
            break
        remainder = total_net - sum(win_pnls[:n])
        print(f"  上位{n:>3}件を除外: {fmt_yen(remainder)}")
    print("  ※実際は上位が空けた資金枠を別トレードが使うため過小評価バイアスあり")

    # ── 上位20件の明細 ──
    print("\n── 上位20件の明細 ──")
    print(f"  {'順':>3} {'戦略':<4} {'銘柄':<8} {'entry':<11} {'NetPnL':>12} {'pnl%':>8} {'保有':>4} {'exit理由':<16}")
    for i, r in enumerate(winners[:20], 1):
        print(
            f"  {i:>3} {r['strategy']:<4} {r['ticker']:<8} {r['entryDate']:<11}"
            f" {fmt_yen(r['netPnl']):>12} {r['pnlPct']:>7.1f}% {r['holdingDays']:>3}d {r['exitReason']:<16}"
        )

    # ── 銘柄レベル集中度 ──
    by_ticker: dict = {}
    for r in rows:
        agg = by_ticker.setdefault(r["ticker"], {"net": 0, "n": 0})
        agg["net"] += r["netPnl"]
        agg["n"] += 1
    ticker_sorted = sorted(by_ticker.items(), key=lambda kv: -kv[1]["net"])
    print(f"\n── 銘柄別 NetPnL 上位10（全 {len(by_ticker)} 銘柄） ──")
    for tk, agg in ticker_sorted[:10]:
        print(f"  {tk:<8} {fmt_yen(agg['net']):>12}（{agg['n']}トレード）")
    top5_ticker_share = (
        sum(a["net"] for _, a in ticker_sorted[:5]) / total_net * 100 if total_net else 0
    )
    print(f"  銘柄上位5の NetPnL比: {top5_ticker_share:.1f}%")

    # ── D期依存度（却下リスト #21 のトレード版） ──
    d_rows = [r for r in rows if D_PERIOD_START <= parse_date(r["entryDate"]) <= D_PERIOD_END]
    d_net = sum(r["netPnl"] for r in d_rows)
    print(f"\n── D期（{D_PERIOD_START}〜{D_PERIOD_END}）依存度 ──")
    print(
        f"  D期エントリー: {len(d_rows)}件 / NetPnL {fmt_yen(d_net)}"
        f"（全体の {d_net / total_net * 100:.1f}%）" if total_net else "  NetPnL合計が0"
    )
    d_winners_in_top10 = sum(
        1 for r in winners[:10] if D_PERIOD_START <= parse_date(r["entryDate"]) <= D_PERIOD_END
    )
    print(f"  上位10勝ちトレード中 D期発生: {d_winners_in_top10}件")

    # ── 勝ちトレードの分布形状 ──
    if winners:
        med = win_pnls[len(win_pnls) // 2]
        mean = gross_win / len(winners)
        print("\n── 勝ちトレード分布 ──")
        print(f"  最大勝ち: {fmt_yen(win_pnls[0])}  平均勝ち: {fmt_yen(mean)}  中央値勝ち: {fmt_yen(med)}")
        print(f"  平均/中央値比: {mean / med:.2f}（1超 = 右に歪んだ分布 = 少数大勝ち型）")

    # ── 戦略別 ──
    print("\n── 戦略別 ──")
    strategies = sorted({r["strategy"] for r in rows})
    for s in strategies:
        s_rows = [r for r in rows if r["strategy"] == s]
        s_net = sum(r["netPnl"] for r in s_rows)
        s_wins = sorted((r["netPnl"] for r in s_rows if r["netPnl"] > 0), reverse=True)
        top5 = cumulative_share(s_wins, s_net, min(5, len(s_wins))) if s_net else 0
        print(f"  {s:<4}: {len(s_rows)}件 NetPnL {fmt_yen(s_net)}  上位5件のNetPnL比 {top5:.1f}%")


if __name__ == "__main__":
    main()
