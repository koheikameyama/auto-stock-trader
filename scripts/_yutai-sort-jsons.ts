/**
 * 使い捨て: 優待イベントJSON を「枠割り当て順」3通りにソートして書き出す。
 *
 * 却下#41 の核心テスト: 同日に複数の優待シグナルが出て枠が足りない時、
 * どの銘柄から買うか(=並び順)で combined の結果がどれだけ振れるかを測るため、
 * 3つの決定論的な並び順で別JSONを作る。combined-run.ts の precomputeBuybackSignals は
 * 入力JSONの並び順のまま arr.push するので、配列を並べ替えれば枠取得順を制御できる
 * (BTエンジン無変更)。
 *
 *   mcap   : 時価総額 小さい順 (前方需要は小型株ほど強い仮説)
 *   mom20  : entrydate時点の20日騰落率 高い順 (GUと同じ「上げている銘柄優先」)
 *   ticker : (ticker,date) 辞書順 (却下#41 が任意性を消すのに使った中立順)
 *
 * ⚠️ eventMap は ticker→Set<date> に畳むので、同一tickerが複数優待日を持つと
 *    挿入順はその ticker の「最初の出現位置」で固定される。mom20 は date依存だが
 *    優待の再開示は稀なので最初の日の値で近似する(件数を stderr に出す)。
 *
 * 実行: npx tsx scripts/_yutai-sort-jsons.ts /tmp/yutai_lag1.json /tmp/yutai
 *   → /tmp/yutai_mcap.json /tmp/yutai_mom20.json /tmp/yutai_ticker.json
 */
import fs from "fs";
import { prisma } from "../src/lib/prisma";
import { fetchHistoricalFromDB } from "../src/backtest/data-fetcher";
import dayjs from "dayjs";

async function main() {
  const inPath = process.argv[2] ?? "/tmp/yutai_lag1.json";
  const outPrefix = process.argv[3] ?? "/tmp/yutai";
  const raw = JSON.parse(fs.readFileSync(inPath, "utf-8")) as {
    events: { ticker: string; date: string }[];
  };
  const events = raw.events;
  console.log(`[in] ${events.length}件`);

  const tickers = [...new Set(events.map((e) => e.ticker))];

  // 時価総額 (Stock.marketCap)。tickerCode は DB 上どうなっているか両対応
  const stocks = await prisma.stock.findMany({
    where: { tickerCode: { in: tickers } },
    select: { tickerCode: true, marketCap: true },
  });
  const mcapMap = new Map<string, number>();
  for (const s of stocks) {
    if (s.marketCap != null) mcapMap.set(s.tickerCode, Number(s.marketCap));
  }
  console.log(`[mcap] ${mcapMap.size}/${tickers.length} 銘柄に marketCap あり`);

  // 20日騰落率: bars から entrydate時点で計算
  const bars = await fetchHistoricalFromDB(tickers, "2018-01-01", "2026-07-31");
  const barIdx = new Map<string, Map<string, number>>();
  for (const [t, bs] of bars) {
    const m = new Map<string, number>();
    bs.forEach((b, i) => m.set(dayjs(b.date).format("YYYY-MM-DD"), i));
    barIdx.set(t, m);
  }
  function mom20(ticker: string, date: string): number | null {
    const bs = bars.get(ticker);
    const i = barIdx.get(ticker)?.get(date);
    if (!bs || i == null || i < 20) return null;
    const now = bs[i].close;
    const prev = bs[i - 20].close;
    if (!(prev > 0)) return null;
    return (now - prev) / prev;
  }

  // 各イベントに mom20 を付与 (最初に必要なだけ計算)
  let momMissing = 0;
  const withMom = events.map((e) => {
    const m = mom20(e.ticker, e.date);
    if (m == null) momMissing++;
    return { ...e, mom20: m };
  });
  console.log(`[mom20] 計算不能 ${momMissing}件 (=最後尾に回す)`);

  // ソート: 安定のため (primaryKey, ticker, date) の複合。
  // eventMap 挿入順を制御するため、配列を primaryKey 順に並べる。
  function sortBy(key: "mcap" | "mom20" | "ticker") {
    const arr = [...withMom];
    arr.sort((a, b) => {
      if (key === "ticker") {
        return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : a.date < b.date ? -1 : 1;
      }
      if (key === "mcap") {
        // 小さい順。marketCap 欠損は最後尾 (Infinity 扱い)
        const va = mcapMap.get(a.ticker) ?? Infinity;
        const vb = mcapMap.get(b.ticker) ?? Infinity;
        if (va !== vb) return va - vb;
      } else {
        // mom20 高い順。欠損は最後尾
        const va = a.mom20 ?? -Infinity;
        const vb = b.mom20 ?? -Infinity;
        if (va !== vb) return vb - va;
      }
      // タイブレーク: ticker,date 辞書順で決定論的に
      return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : a.date < b.date ? -1 : 1;
    });
    return arr.map((e) => ({ ticker: e.ticker, date: e.date }));
  }

  for (const key of ["mcap", "mom20", "ticker"] as const) {
    const sorted = sortBy(key);
    const out = `${outPrefix}_${key}.json`;
    fs.writeFileSync(out, JSON.stringify({ events: sorted }, null, 1));
    console.log(`→ ${out} (${sorted.length}件)`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
