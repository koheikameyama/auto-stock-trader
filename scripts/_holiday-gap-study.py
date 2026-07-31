#!/usr/bin/env python3
"""
「連休を跨ぐオーバーナイトは普通の日より荒いのか」を生データで測る（KOH-なし / 却下リスト #56 用）。

BT（scripts/_holiday-windows.py）は出口と資金制約を乗せた portfolio 判定を出すが、
「危ないのか」という問いの本体は**分布の裾**なので、こちらは素のバー統計で測る。

判定日 D の引け → 次セッション D+1 を、D と D+1 の暦日差で層別する:
  nonTrading=0 … 平日→翌平日（普通の日）
  nonTrading=2 … 通常の週末（金→月）
  nonTrading>=3 … 連休（3連休以上）★本番の WEEKEND_RISK 閾値と同じ

計測: gap(D+1始値/D終値-1) / intraday(D+1終値/D+1始値-1) / net(D+1終値/D終値-1)
      平均・中央値・標準偏差・5%点・1%点・最悪値（= テールが太るかどうか）

母集団は BT ユニバースに寄せる（D終値 ≤ ¥2,500・出来高あり）。
分割・併合由来の外れ値は ±40% で中和（却下 #55 と同じ扱い）。
サブセット「GU類似日」= D が gap≥3% × 出来高≥25日平均の1.5倍 × 陽線（本番のGUトリガー相当）。
先読みなし（すべて D までの確定情報で層別、暦は事前に既知）。
"""
import os
import statistics
import psycopg2
from collections import defaultdict

DSN = os.environ.get("DATABASE_URL") or "postgresql://kouheikameyama@localhost:5432/auto_stock_trader"
MAX_PRICE = 2500
CLIP = 0.40  # |日次| がこれを超えるバーは分割等とみなし除外


def pct(vals, q):
    if not vals:
        return float("nan")
    s = sorted(vals)
    i = max(0, min(len(s) - 1, int(round(q * (len(s) - 1)))))
    return s[i]


def describe(vals):
    if not vals:
        return "n=0"
    return (
        f"n={len(vals):>7} 平均{statistics.mean(vals) * 100:>+7.3f}% "
        f"中央{statistics.median(vals) * 100:>+7.3f}% "
        f"SD{statistics.pstdev(vals) * 100:>6.2f}% "
        f"5%点{pct(vals, 0.05) * 100:>+7.2f}% 1%点{pct(vals, 0.01) * 100:>+7.2f}% "
        f"最悪{min(vals) * 100:>+7.2f}% 勝率{sum(1 for v in vals if v > 0) / len(vals) * 100:>5.1f}%"
    )


def main():
    conn = psycopg2.connect(DSN)
    cur = conn.cursor()
    print("[data] バー取得中...")
    cur.execute(
        """
        SELECT b."tickerCode", b.date, b.open, b.high, b.low, b.close, b.volume
        FROM "StockDailyBar" b
        WHERE b.market = 'JP' AND b."tickerCode" LIKE '%.T'
          AND b.date >= DATE '2016-05-01'
        ORDER BY b."tickerCode", b.date
        """
    )
    rows = cur.fetchall()
    conn.close()
    print(f"[data] {len(rows):,} バー")

    by_ticker = defaultdict(list)
    for t, d, o, h, low, c, v in rows:
        by_ticker[t].append((d, float(o), float(h), float(low), float(c), int(v)))

    # 市場カレンダー = バーが十分ある日付（個別銘柄の欠損日を連休と誤認しないため）
    day_count = defaultdict(int)
    for bars in by_ticker.values():
        for b in bars:
            day_count[b[0]] += 1
    market_days = sorted(d for d, n in day_count.items() if n >= 500)
    next_day = {market_days[i]: market_days[i + 1] for i in range(len(market_days) - 1)}
    print(f"[data] 営業日 {len(market_days):,} 日 ({market_days[0]} 〜 {market_days[-1]})")

    # 層別キー: D の翌営業日までの非営業日数
    nontrading = {d: (next_day[d] - d).days - 1 for d in next_day}

    buckets = defaultdict(lambda: {"gap": [], "intra": [], "net": []})
    gu_buckets = defaultdict(lambda: {"gap": [], "intra": [], "net": []})

    for t, bars in by_ticker.items():
        for i in range(len(bars) - 1):
            d, o, h, low, c, v = bars[i]
            nd, no, nh, nlow, nc, nv = bars[i + 1]
            if d not in next_day or next_day[d] != nd:
                continue  # 個別銘柄の欠損日を跨ぐケースは除外
            if c <= 0 or c > MAX_PRICE or o <= 0 or no <= 0 or v <= 0:
                continue
            gap = no / c - 1
            intra = nc / no - 1
            net = nc / c - 1
            if max(abs(gap), abs(intra), abs(net)) > CLIP:
                continue  # 分割・併合の疑い
            nt = nontrading[d]
            key = "0(平日→平日)" if nt == 0 else ("2(通常の週末)" if nt == 2 else (f">=3(連休)" if nt >= 3 else f"{nt}"))
            b = buckets[key]
            b["gap"].append(gap)
            b["intra"].append(intra)
            b["net"].append(net)

            # GU類似日（本番トリガー相当: gap≥3% × vol≥1.5x × 陽線）
            if i >= 25:
                prev_close = bars[i - 1][4]
                avg_vol = statistics.mean(bars[j][5] for j in range(i - 25, i))
                if (
                    prev_close > 0
                    and o / prev_close - 1 >= 0.03
                    and avg_vol > 0
                    and v / avg_vol >= 1.5
                    and c > o
                ):
                    g = gu_buckets[key]
                    g["gap"].append(gap)
                    g["intra"].append(intra)
                    g["net"].append(net)

    order = ["0(平日→平日)", "2(通常の週末)", ">=3(連休)"]
    for title, data in [("全ユニバース (≤¥2,500)", buckets), ("GU類似日 (gap≥3%×vol≥1.5x×陽線)", gu_buckets)]:
        print(f"\n{'=' * 110}\n{title}\n{'=' * 110}")
        for metric, label in [("gap", "翌寄り (D終値→D+1始値)"), ("intra", "翌日中 (D+1始値→D+1終値)"), ("net", "翌引け (D終値→D+1終値)")]:
            print(f"\n--- {label} ---")
            for key in order:
                if key in data:
                    print(f"  {key:<14} {describe(data[key][metric])}")
            other = [k for k in data if k not in order]
            for k in sorted(other):
                print(f"  {k:<14} {describe(data[k][metric])}")


if __name__ == "__main__":
    main()
