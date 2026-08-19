/**
 * 見送り日のシグナル再現ジョブ（弾き分析の穴埋め）
 *
 * gapup-monitor / psc-monitor は `shouldTrade=false` の日はスキャン自体を行わずに return する。
 * そのため **idle 帯（breadth < 54%、期間の6割以上）に出たシグナルは1件も記録に残らない**。
 * 「シグナルは満たしていたが注文されなかった」候補を全部 RejectedSignal に載せるという方針
 * （docs/specs/batch-processing.md「弾かれたシグナル追跡」）から見て、ここが最後の穴だった。
 *
 * ⚠️ 場中に追加のスキャンはしない。立花APIは 8:00〜15:30 の高負荷リクエストを控える運用
 * （.claude/rules/tachibana-api.md）で、idle 日は年間の6割を占めるため、そこに毎日
 * 全銘柄バッチ時価取得を足すのは負荷ルールに反する。
 * 代わりに **backfill-stock-data で当日バーが入った後（17:05頃）に DB の確定終値だけで再現**する。
 * API 負荷ゼロで、判定が終値ベースになる分むしろ BT（終値エントリー）と定義が揃う。
 *
 * 実行対象は `shouldTrade !== true` の日のみ。取引日は monitor 側が既に記録しているので走らせない。
 */

import { pathToFileURL } from "node:url";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/market-date";
import { recordSkippedCandidates } from "../core/breakout/entry-executor";
import { isGapUpSignal } from "../core/gapup/entry-conditions";
import { isPostSurgeConsolidationSignal } from "../core/post-surge-consolidation/entry-conditions";
import { GAPUP } from "../lib/constants/gapup";
import { POST_SURGE_CONSOLIDATION } from "../lib/constants/post-surge-consolidation";
import { TIMEZONE } from "../lib/constants/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

/** PSC 判定に必要な営業日数（当日バーを除いた過去分） */
const PSC_LOOKBACK_DAYS = 25;

export async function main(): Promise<void> {
  const tag = "[signal-replay]";
  const today = getTodayForDB();

  const assessment = await prisma.marketAssessment.findUnique({ where: { date: today } });
  if (assessment?.shouldTrade === true) {
    // 取引日は gapup-monitor / psc-monitor が実際にスキャンし、
    // 発注できなかった候補を executeEntry / recordSkippedCandidates 経由で記録済み。
    console.log(`${tag} スキップ: 取引日（shouldTrade=true）は monitor 側が記録済み`);
    return;
  }

  const watchlist = await prisma.watchlistEntry.findMany({
    where: { date: today },
    select: { tickerCode: true, avgVolume25: true, latestClose: true, momentum5d: true },
  });
  if (watchlist.length === 0) {
    console.log(`${tag} スキップ: 当日のウォッチリストが空`);
    return;
  }

  const tickers = watchlist.map((e) => e.tickerCode);

  // 当日バー（判定対象）と PSC 用の過去バーをまとめて取得（銘柄ごとのクエリは張らない）
  const cutoff = dayjs(today).tz(TIMEZONE).subtract(50, "day").toDate();
  const bars = await prisma.stockDailyBar.findMany({
    where: { tickerCode: { in: tickers }, date: { gte: cutoff, lte: today } },
    select: { tickerCode: true, date: true, open: true, close: true, volume: true },
    orderBy: [{ tickerCode: "asc" }, { date: "asc" }],
  });

  const barsByTicker = new Map<string, typeof bars>();
  for (const bar of bars) {
    const arr = barsByTicker.get(bar.tickerCode);
    if (arr) arr.push(bar);
    else barsByTicker.set(bar.tickerCode, [bar]);
  }

  const todayKey = dayjs(today).format("YYYY-MM-DD");
  const guFired: { ticker: string; currentPrice: number }[] = [];
  const pscFired: { ticker: string; currentPrice: number }[] = [];
  let missingTodayBar = 0;

  for (const entry of watchlist) {
    const list = barsByTicker.get(entry.tickerCode);
    if (!list || list.length === 0) continue;

    const last = list[list.length - 1]!;
    if (dayjs(last.date).format("YYYY-MM-DD") !== todayKey) {
      // 当日バーが無い銘柄（売買停止等）は判定しない。全銘柄で欠けている場合は
      // backfill 未完了の疑いがあるため件数を出す
      missingTodayBar++;
      continue;
    }
    // volume は BigInt 列なので Number に落とす（出来高は 2^53 に遠く及ばない）
    const todayBar = { open: last.open, close: last.close, volume: Number(last.volume) };
    if (!(todayBar.open > 0) || !(todayBar.volume > 0)) continue;

    // GU: 前日終値は monitor と同じくウォッチリストの latestClose（＝前営業日終値）を使う。
    // momentum5d > 0 の絞りも getGuWatchlist と揃える。
    if (entry.momentum5d > 0) {
      const fired = isGapUpSignal({
        open: todayBar.open,
        close: todayBar.close,
        prevClose: entry.latestClose,
        volume: todayBar.volume,
        avgVolume25: entry.avgVolume25,
        gapMinPct: GAPUP.ENTRY.GAP_MIN_PCT,
        volSurgeRatio: GAPUP.ENTRY.VOL_SURGE_RATIO,
        gapRelaxVolThreshold: GAPUP.ENTRY.GAP_RELAX_VOL_THRESHOLD,
        gapMinPctRelaxed: GAPUP.ENTRY.GAP_MIN_PCT_RELAXED,
      });
      if (fired) guFired.push({ ticker: entry.tickerCode, currentPrice: todayBar.close });
    }

    // PSC: 当日バーを除いた直近25営業日から close20DaysAgo / high20 を作る。
    // psc-monitor は 15:24 に走るため当日バーが DB に無く、過去分だけで計算している。
    // ここで当日を含めると基準が1日ずれるので必ず除外する。
    const history = list.slice(0, -1);
    if (history.length >= PSC_LOOKBACK_DAYS) {
      const recent = history.slice(-PSC_LOOKBACK_DAYS);
      const close20DaysAgo = recent[recent.length - 20]!.close;
      const high20 = Math.max(...recent.slice(-20).map((b) => b.close));
      const fired = isPostSurgeConsolidationSignal({
        open: todayBar.open,
        close: todayBar.close,
        close20DaysAgo,
        high20,
        volume: todayBar.volume,
        avgVolume25: entry.avgVolume25,
        momentumMinReturn: POST_SURGE_CONSOLIDATION.ENTRY.MOMENTUM_MIN_RETURN,
        maxHighDistancePct: POST_SURGE_CONSOLIDATION.ENTRY.MAX_HIGH_DISTANCE_PCT,
        volSurgeRatio: POST_SURGE_CONSOLIDATION.ENTRY.VOL_SURGE_RATIO,
      });
      if (fired) pscFired.push({ ticker: entry.tickerCode, currentPrice: todayBar.close });
    }
  }

  if (missingTodayBar === watchlist.length) {
    // backfill-stock-data の後に実行する前提が崩れている（全銘柄で当日バーが無い）
    throw new Error(
      `${tag} 当日バーが1銘柄も無い（${todayKey}）。backfill-stock-data の完了後に実行すること`,
    );
  }

  const reason = `取引見送り日（shouldTrade=${assessment?.shouldTrade ?? "未作成"}）のためスキャンせず。当日終値で再現`;
  await recordSkippedCandidates(guFired, "gapup", reason, "相場停止");
  await recordSkippedCandidates(pscFired, "post-surge-consolidation", reason, "相場停止");

  console.log(
    `${tag} 完了 ${todayKey}: WL ${watchlist.length}銘柄 / GU ${guFired.length}件 / PSC ${pscFired.length}件` +
      (missingTodayBar > 0 ? ` / 当日バー無し ${missingTodayBar}銘柄` : ""),
  );
}

// CLI 実行時のみ走らせる（テストから import しても main が動かないようにする）
const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  main()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
      console.error("[signal-replay] エラー:", err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
