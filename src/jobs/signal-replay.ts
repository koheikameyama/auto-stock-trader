/**
 * monitor がスキャンしなかった日のシグナル再現ジョブ（弾き分析の穴埋め）
 *
 * gapup-monitor / psc-monitor は次の2ケースでスキャン自体を行わずに return する。
 *   (a) `shouldTrade=false` の日（相場停止）
 *   (b) 戦略の `ENTRY_ENABLED=false`（戦略停止。2026-08-03 以降の PSC が該当）
 * どちらも「シグナルは満たしていたが注文されなかった」候補が1件も記録に残らない。
 * 候補は全部 RejectedSignal に載せるという方針
 * （docs/specs/batch-processing.md「弾かれたシグナル追跡」）から見て、ここが穴だった。
 *
 * ⚠️ 場中に追加のスキャンはしない。立花APIは 8:00〜15:30 の高負荷リクエストを控える運用
 * （.claude/rules/tachibana-api.md）で、idle 日は年間の6割を占めるため、そこに毎日
 * 全銘柄バッチ時価取得を足すのは負荷ルールに反する。停止中の戦略のために取引日にも
 * 15:24 のバッチを1本増やすのは、撃たない戦略のための負荷なので論外。
 * 代わりに **backfill-stock-data で当日バーが入った後（17:05頃）に DB の確定終値だけで再現**する。
 * API 負荷ゼロで、判定が終値ベースになる分むしろ BT（終値エントリー）と定義が揃う。
 *
 * 再現するのは「その日 monitor がスキャンしなかった戦略」だけ。取引日に稼働中の戦略は
 * monitor が既に記録しているので再現しない（同じ候補を二重計上しない）。
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

/**
 * GU には戦略単位の停止フラグが無い（gapup-monitor は shouldTrade だけで判定する）。
 * 将来 GAPUP.ENTRY_ENABLED を足したらここを差し替える。
 */
const GAPUP_ENTRY_ENABLED = true;

/** 当日その戦略を再現するか、するならどのラベルで記録するか */
export type ReplayPlan = { label: string; reason: string };

/**
 * 再現計画を立てる。
 *
 * 「戦略停止」と「相場停止」が同時に成立する日（停止中の戦略 × 見送り日）は
 * **戦略停止を優先**する。相場が許しても撃たないので、拘束している条件はそちらだから。
 * 逆に戦略を再開すれば同じ日は自動的に「相場停止」に戻り、ラベルが現状を語り続ける。
 */
export function planReplay(params: {
  entryEnabled: boolean;
  shouldTrade: boolean;
  /** ログ・reason 文面用の生値（未作成なら undefined） */
  shouldTradeValue: boolean | undefined;
}): ReplayPlan | null {
  if (params.entryEnabled && params.shouldTrade) {
    // monitor が実際にスキャンし、発注できなかった候補は
    // executeEntry / recordSkippedCandidates / recordSkippedByHolding 経由で記録済み
    return null;
  }
  if (!params.entryEnabled) {
    return {
      label: "戦略停止",
      reason: "新規エントリー停止中（ENTRY_ENABLED=false）のためスキャンせず。当日終値で再現",
    };
  }
  return {
    label: "相場停止",
    reason: `取引見送り日（shouldTrade=${params.shouldTradeValue ?? "未作成"}）のためスキャンせず。当日終値で再現`,
  };
}

export async function main(): Promise<void> {
  const tag = "[signal-replay]";
  const today = getTodayForDB();

  const assessment = await prisma.marketAssessment.findUnique({ where: { date: today } });
  const shouldTrade = assessment?.shouldTrade === true;
  const shouldTradeValue = assessment?.shouldTrade;

  const guPlan = planReplay({
    entryEnabled: GAPUP_ENTRY_ENABLED,
    shouldTrade,
    shouldTradeValue,
  });
  const pscPlan = planReplay({
    entryEnabled: POST_SURGE_CONSOLIDATION.ENTRY_ENABLED,
    shouldTrade,
    shouldTradeValue,
  });

  if (!guPlan && !pscPlan) {
    console.log(`${tag} スキップ: 全戦略とも monitor がスキャン済み（shouldTrade=true）`);
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
    if (guPlan && entry.momentum5d > 0) {
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
    if (pscPlan && history.length >= PSC_LOOKBACK_DAYS) {
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

  if (guPlan) await recordSkippedCandidates(guFired, "gapup", guPlan.reason, guPlan.label);
  if (pscPlan) {
    await recordSkippedCandidates(
      pscFired,
      "post-surge-consolidation",
      pscPlan.reason,
      pscPlan.label,
    );
  }

  const parts = [
    guPlan ? `GU ${guFired.length}件[${guPlan.label}]` : "GU 再現せず(monitor記録済み)",
    pscPlan ? `PSC ${pscFired.length}件[${pscPlan.label}]` : "PSC 再現せず(monitor記録済み)",
  ];
  console.log(
    `${tag} 完了 ${todayKey}: WL ${watchlist.length}銘柄 / ${parts.join(" / ")}` +
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
