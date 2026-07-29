#!/usr/bin/env python3
"""
KOH-594 イベントスタディ: 「日経が急落したが breadth は健全」な日の翌日以降のドリフト。

問い: 日経 ≤ -3% でも breadth が band 内(≥54%)なら、それは「指数が数銘柄/先物/マクロで
      叩かれただけで広範な相場は無事」= リスクでなく買い場ではないか。

既存の却下との関係:
- 却下#15: 日経 ≤ -N% の翌日リバウンドを breadth 無条件で測定 → コスト負けで却下
- 却下#48: キルスイッチ veto の時制を16窓比較 → 統計的に区別不能（エントリー可否の話）
- パニック底反発(本番): VIX>25 × breadth<40% × 連続下落≥3日 → 今日とは真逆の条件
→ 「N225急落 × breadth健全」を**買いシグナル**として測ったことは無い。

★live 再現可能な定義で測る: 判定は D の確定終値（breadth も D の終値）、
  エントリーは D+1 の引け。本番 15:24 に当日 breadth は存在しないため
  （却下#41 が buyback で踏んだ先読みの罠）。
"""
import os
import psycopg2
import statistics

DB = os.environ.get("BT_DB", "postgresql://kouheikameyama@localhost:5432/auto_stock_trader")
MAX_PRICE = 2500          # BT のユニバース定義に合わせる
BREADTH_HEALTHY = 0.54    # MARKET_BREADTH.THRESHOLD
DROP_THRESHOLDS = [-3.0, -2.0]
HORIZONS = [1, 3, 5, 10]


def fetch():
    conn = psycopg2.connect(DB)
    cur = conn.cursor()

    # 1) N225 日次終値
    cur.execute("""
        SELECT date, close FROM "StockDailyBar"
        WHERE "tickerCode" = '^N225' ORDER BY date
    """)
    n225 = cur.fetchall()

    # 2) breadth（BT定義: JP・close<=2500 の母集団で close > SMA25 の比率）
    cur.execute("""
        WITH windowed AS (
          SELECT "tickerCode", date, close,
                 AVG(close) OVER (PARTITION BY "tickerCode" ORDER BY date
                                  ROWS BETWEEN 24 PRECEDING AND CURRENT ROW) AS sma25,
                 COUNT(*)  OVER (PARTITION BY "tickerCode" ORDER BY date
                                  ROWS BETWEEN 24 PRECEDING AND CURRENT ROW) AS n
          FROM "StockDailyBar" WHERE market = 'JP'
        )
        SELECT date,
               SUM(CASE WHEN close > sma25 THEN 1 ELSE 0 END)::float / COUNT(*) AS breadth,
               COUNT(*) AS total
        FROM windowed
        WHERE n = 25 AND close <= %s
        GROUP BY date HAVING COUNT(*) >= 100
        ORDER BY date
    """, (MAX_PRICE,))
    breadth = {d: b for d, b, _ in cur.fetchall()}

    # 3) 小型株ユニバースの等加重日次リターン（戦略が実際に売買する対象）
    cur.execute("""
        WITH px AS (
          SELECT "tickerCode", date, close,
                 LAG(close) OVER (PARTITION BY "tickerCode" ORDER BY date) AS prev
          FROM "StockDailyBar" WHERE market = 'JP'
        )
        SELECT date, AVG((close - prev) / prev * 100) AS ret
        FROM px
        WHERE prev > 0 AND close <= %s
          AND ABS((close - prev) / prev) < 0.4   -- 分割等の異常値を中和
        GROUP BY date HAVING COUNT(*) >= 100
        ORDER BY date
    """, (MAX_PRICE,))
    smallcap = {d: r for d, r in cur.fetchall()}

    cur.close()
    conn.close()
    return n225, breadth, smallcap


def cum(series_by_date, dates, i, h):
    """dates[i] の翌営業日から h 日分の等加重累積リターン(%)"""
    tot = 0.0
    for k in range(i + 1, min(i + 1 + h, len(dates))):
        v = series_by_date.get(dates[k])
        if v is None:
            return None
        tot += v
    return tot if i + h < len(dates) else None


def tstat(xs):
    if len(xs) < 2:
        return float("nan")
    sd = statistics.stdev(xs)
    return statistics.mean(xs) / (sd / len(xs) ** 0.5) if sd > 0 else float("nan")


def main():
    n225, breadth, smallcap = fetch()
    dates = [d for d, _ in n225]
    close = {d: c for d, c in n225}

    # N225 の日次変化率
    n225_ret = {}
    for i in range(1, len(dates)):
        p, c = close[dates[i - 1]], close[dates[i]]
        if p > 0:
            n225_ret[dates[i]] = (c - p) / p * 100

    sc_dates = sorted(smallcap)
    sc_idx = {d: i for i, d in enumerate(sc_dates)}

    print(f"データ: N225 {len(dates)}日 ({dates[0]}〜{dates[-1]}), "
          f"breadth {len(breadth)}日, 小型株等加重 {len(smallcap)}日\n")

    # ベースライン（全日）
    print("=== ベースライン（全営業日）小型株等加重の先行リターン ===")
    for h in HORIZONS:
        vals = [cum(smallcap, sc_dates, i, h) for i in range(len(sc_dates))]
        vals = [v for v in vals if v is not None]
        print(f"  H{h:<3} n={len(vals):5d}  平均={statistics.mean(vals):+6.2f}%  "
              f"勝率={sum(1 for v in vals if v > 0)/len(vals)*100:4.1f}%")

    for th in DROP_THRESHOLDS:
        print(f"\n{'='*72}\n=== 日経 ≤ {th}% の日（判定は当日の確定終値、エントリーは翌営業日の引け） ===")
        sig = [d for d in dates if n225_ret.get(d, 0) <= th and d in breadth and d in sc_idx]
        healthy = [d for d in sig if breadth[d] >= BREADTH_HEALTHY]
        weak = [d for d in sig if breadth[d] < BREADTH_HEALTHY]
        print(f"  発火 {len(sig)}件 = breadth健全(≥54%) {len(healthy)}件 / 弱い(<54%) {len(weak)}件")

        for label, days in (("★breadth健全 ≥54%", healthy), ("breadth弱い <54%", weak), ("全体", sig)):
            if not days:
                continue
            print(f"\n  [{label}] n={len(days)}")
            for h in HORIZONS:
                vals = [cum(smallcap, sc_dates, sc_idx[d], h) for d in days]
                vals = [v for v in vals if v is not None]
                if len(vals) < 2:
                    continue
                base = [cum(smallcap, sc_dates, i, h) for i in range(len(sc_dates))]
                base = [v for v in base if v is not None]
                excess = statistics.mean(vals) - statistics.mean(base)
                print(f"    H{h:<3} n={len(vals):3d}  平均={statistics.mean(vals):+6.2f}%  "
                      f"t={tstat(vals):+5.2f}  勝率={sum(1 for v in vals if v>0)/len(vals)*100:4.1f}%  "
                      f"ベース差={excess:+6.2f}pp")

        # 年別（前後半の安定性チェック: 却下#26 の単一エピソード依存を防ぐ）
        if healthy:
            print(f"\n  [★breadth健全の年別 H5]")
            by_year = {}
            for d in healthy:
                v = cum(smallcap, sc_dates, sc_idx[d], 5)
                if v is not None:
                    by_year.setdefault(d.year, []).append(v)
            for y in sorted(by_year):
                vs = by_year[y]
                print(f"    {y}  n={len(vs):2d}  平均={statistics.mean(vs):+6.2f}%")


if __name__ == "__main__":
    main()
