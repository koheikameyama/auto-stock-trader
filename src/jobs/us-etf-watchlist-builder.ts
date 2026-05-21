/**
 * 米株 ETF (1547, 1545) のエントリーシグナル検出 → Slack 通知
 *
 * 引け後 (breadth-notify と同タイミング) に実行する。
 * シグナル発火時は Slack に「翌営業日 寄付発注推奨」を通知。
 * MVP では立花API による発注はせず、通知のみ。
 */

import { calculateMarketBreadth } from "../core/market-breadth";
import {
  detectUSEtfSignal,
  US_ETF_RISK_PARAMS,
  US_ETF_SIGNAL_DEFAULTS,
} from "../core/us-etf/entry-conditions";
import { prisma } from "../lib/prisma";
import { notifySlack } from "../lib/slack";
import dayjs from "dayjs";

const TICKERS = US_ETF_RISK_PARAMS.tickers;
const VOL_LOOKBACK = 25;

async function main() {
  // 日本株 breadth (asOfDate 未指定 → 最新営業日に自動丸め、breadth-notify と整合)
  const breadth = await calculateMarketBreadth();
  const japanBreadth = breadth.breadth;
  const asOfDate = breadth.asOfDate;
  console.log(
    `[us-etf-watchlist] asOf ${dayjs(asOfDate).format("YYYY-MM-DD")}, 日本株 breadth: ${(japanBreadth * 100).toFixed(1)}%`,
  );

  // 各 ETF をチェック
  const signals: Array<{
    ticker: string;
    name: string;
    triggered: boolean;
    detail: string;
    todayClose: number;
    gap: number;
    volSurge: number;
    slPrice: number;
  }> = [];

  for (const ticker of TICKERS) {
    const bars = await prisma.stockDailyBar.findMany({
      where: {
        tickerCode: ticker,
        market: "JP",
        date: { lte: asOfDate },
      },
      orderBy: { date: "desc" },
      take: VOL_LOOKBACK + 1,
    });

    if (bars.length < VOL_LOOKBACK + 1) {
      console.log(`${ticker}: バー不足 (${bars.length} < ${VOL_LOOKBACK + 1})、スキップ`);
      continue;
    }

    const todayBar = bars[0];
    const prevBar = bars[1];
    const volumes = bars.slice(1, VOL_LOOKBACK + 1).map((b) => Number(b.volume));
    const avgVol25 = volumes.reduce((a, b) => a + b, 0) / VOL_LOOKBACK;

    const stock = await prisma.stock.findUnique({
      where: { tickerCode: ticker },
      select: { name: true },
    });

    const signal = detectUSEtfSignal(
      {
        ticker,
        todayOpen: todayBar.open,
        todayHigh: todayBar.high,
        todayLow: todayBar.low,
        todayClose: todayBar.close,
        todayVolume: Number(todayBar.volume),
        prevClose: prevBar.close,
        avgVolume25: avgVol25,
        japanBreadth,
      },
      US_ETF_SIGNAL_DEFAULTS,
    );

    const slPrice = todayBar.close * (1 - US_ETF_RISK_PARAMS.slPct);
    const detail = signal.triggered
      ? `gap +${(signal.gap * 100).toFixed(2)}%, vol ${signal.volSurge.toFixed(2)}x, breadth ${(japanBreadth * 100).toFixed(1)}%`
      : signal.rejectReasons.join(" / ");

    signals.push({
      ticker,
      name: stock?.name ?? ticker,
      triggered: signal.triggered,
      detail,
      todayClose: todayBar.close,
      gap: signal.gap,
      volSurge: signal.volSurge,
      slPrice,
    });

    console.log(
      `${ticker}: ${signal.triggered ? "🚀 発火" : "─ 不発"} | ${detail}`,
    );
  }

  // Slack 通知 (発火時のみ)
  const fired = signals.filter((s) => s.triggered);
  if (fired.length === 0) {
    console.log("シグナル発火なし → Slack 通知スキップ");
    return;
  }

  const lines = fired.map(
    (s) =>
      [
        `🚀 *${s.ticker}* ${s.name}`,
        `  終値 ¥${s.todayClose.toLocaleString()} / gap +${(s.gap * 100).toFixed(2)}% / vol ${s.volSurge.toFixed(2)}x`,
        `  SL推奨: ¥${s.slPrice.toFixed(0)} (-${US_ETF_RISK_PARAMS.slPct * 100}%)`,
        `  タイムストップ: ${US_ETF_RISK_PARAMS.timeStopDays}営業日`,
      ].join("\n"),
  );

  await notifySlack({
    title: `📈 米株ETFシグナル発火: ${fired.length}件`,
    message: [
      `日本株 breadth ${(japanBreadth * 100).toFixed(1)}% (< 54% = idle帯)`,
      "",
      lines.join("\n\n"),
      "",
      "💡 翌営業日の寄付で立花e支店から手動発注してください",
    ].join("\n"),
    color: "good",
  });
}

main().catch((e) => {
  console.error("us-etf-watchlist-builder failed:", e);
  process.exit(1);
});
