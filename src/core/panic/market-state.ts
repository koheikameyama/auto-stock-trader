/**
 * パニック底反発の判定入力を DB の確定バーから取得する (KOH-554)
 *
 * **すべて前営業日以前の確定終値**しか使わない。ライブ時価を一切叩かないので立花のAPI負荷はゼロ。
 *
 * ## なぜ「前営業日」なのか
 *
 * BT は breadth / N225連続下落を「その日の終値」で判定して当日引けで買う。しかし本番 15:24 時点で
 * 当日の breadth は取得不能（全3,000銘柄のライブ時価が必要 = 立花の負荷ルール「8:00-15:30 は
 * 大量取得を控える」に真っ向から反する）。よって live で再現できるのは
 * **「D-1 の終値で判定 → D の引けで買う」= BT の `--entry-lag 1`** のみ。
 *
 * この定義で combined BT を測り直し、3ゲート（fullcycle Calmar +24.6% / D期 -7.8% /
 * buyback joint +14.5%）を通過することを確認済み（KOH-554 Phase 1）。
 *
 * ## VIX の参照日に注意
 *
 * 判定日が D-1 なので、BT (`_gen-panic-events.ts` の `prevVix(day)`) が使う VIX は
 * **D-1 より前の最新 ^VIX バー = 通常 D-2 の US セッション**。`MarketAssessment.vix`
 * （= 当日8:02に取得した直近US終値 = D-1 のUSセッション）を使うと **BTより1日新しくなり乖離する**ので、
 * ここでは `StockDailyBar` の ^VIX を参照する。
 * 都合の良いことに ^VIX の DB 更新は 17:00 JST の GH Actions なので、15:24 on D の時点で
 * DB の最新 ^VIX はちょうど D-2 になっており、BT の情報集合と自然に一致する。
 *
 * ## breadth の母集団
 *
 * BT は `maxPrice<=2500` に絞ったユニバースで breadth を算出し、40% 閾値もその定義で較正されている。
 * 本番の `MarketAssessment.breadth` は **JP全銘柄**が母集団（かつ8:02時点＝D-1基準）なので流用できない。
 * ここでは `calculateMarketBreadth(asOfDate, { maxPrice })` で BT と同じ定義を再計算する。
 *
 * 厳密には BT のユニバースは「期間中どこかで <=2500 を付けた銘柄」（全期間を見る = 未来情報込み）で、
 * live で再現できるのは「その日の終値が <=2500」だけ。**両定義でイベント集合を突き合わせたところ
 * 22件中21件が一致し、残り1件も同一エピソード内で1営業日ずれるだけで、combined BT の結果は
 * 1桁まで完全一致した**（KOH-554 Phase 1 の `--breadth-universe daily` 検証）。
 */

import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { calculateMarketBreadth } from "../market-breadth";
import { getTodayForDB, getPreviousTradingDay } from "../../lib/market-date";
import { STRATEGY_UNIVERSE_MAX_PRICE } from "../../lib/constants/trading";
import { computeNikkeiDownStreak } from "./entry-conditions";

const NIKKEI_TICKER = "^N225";
const VIX_TICKER = "^VIX";

/** 連続下落を数えるのに読む ^N225 の本数。実運用の連続下落は長くても十数日 */
const NIKKEI_LOOKBACK_BARS = 40;

/** ^VIX が判定日からこれ以上古ければ stale とみなす（17:00 JST の GH Actions が数日落ちた状態） */
const VIX_MAX_STALE_DAYS = 5;

export interface PanicMarketState {
  /** 判定日（= 前営業日）。この日の確定終値で条件を評価する */
  conditionDate: Date;
  /** 判定日の breadth（BTと同じ maxPrice<=2500 ユニバース） */
  breadth: number;
  /** 参考: JP全銘柄の breadth。母集団差をフォワードで実測するために記録する */
  breadthAllJp: number;
  /** 判定日までの N225 連続下落営業日数 */
  nikkeiDownStreak: number;
  /** 判定日より前の最新 ^VIX 終値 */
  prevVixClose: number;
  /** その ^VIX バーの日付（監査用） */
  vixAsOf: Date;
  /** 前営業日（判定日の1つ前）でも3条件が揃っていたか = エピソード継続日の判定材料 */
  prevDayBreadth: number;
  prevDayNikkeiDownStreak: number;
  prevDayVixClose: number;
}

/** 鮮度不足・データ欠損でその日は判定できない場合 */
export interface PanicMarketStateUnavailable {
  unavailable: true;
  /** Slack/ログに出す理由 */
  reason: string;
}

/**
 * 判定入力を取得する。データが揃わなければ `{ unavailable: true }` を返す（フェイルクローズ）。
 *
 * 年1-2回のイベントを1回落とすコストより、stale な値で -12% を張るコストの方が高い
 * （却下リスト #25 で日経キルスイッチが stale 値で誤発火した前例）。
 */
export async function getPanicMarketState(
  today: Date = getTodayForDB(),
): Promise<PanicMarketState | PanicMarketStateUnavailable> {
  const conditionDate = getPreviousTradingDay(today);
  const prevConditionDate = getPreviousTradingDay(conditionDate);

  // --- breadth（BT と同じ maxPrice<=2500 ユニバース）---
  // asOfDate を明示指定するので、その日のバーが無ければ throw される（silent に古い値を返さない）
  let breadth: number;
  let breadthAllJp: number;
  let prevDayBreadth: number;
  try {
    const [bt, allJp, prev] = await Promise.all([
      calculateMarketBreadth(conditionDate, { maxPrice: STRATEGY_UNIVERSE_MAX_PRICE }),
      calculateMarketBreadth(conditionDate),
      calculateMarketBreadth(prevConditionDate, { maxPrice: STRATEGY_UNIVERSE_MAX_PRICE }),
    ]);
    breadth = bt.breadth;
    breadthAllJp = allJp.breadth;
    prevDayBreadth = prev.breadth;
  } catch (err) {
    return {
      unavailable: true,
      reason: `breadth を算出できない（StockDailyBar の日次backfill未反映の可能性）: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // --- N225 連続下落 ---
  const n225Bars = await prisma.stockDailyBar.findMany({
    where: { tickerCode: NIKKEI_TICKER, date: { lte: conditionDate } },
    orderBy: { date: "desc" },
    take: NIKKEI_LOOKBACK_BARS,
    select: { date: true, close: true },
  });
  if (n225Bars.length < 5) {
    return { unavailable: true, reason: `^N225 のバーが不足（${n225Bars.length}本）` };
  }
  const latestN225 = n225Bars[0];
  if (dayjs(latestN225.date).format("YYYY-MM-DD") !== dayjs(conditionDate).format("YYYY-MM-DD")) {
    return {
      unavailable: true,
      reason: `^N225 の最新バーが ${dayjs(latestN225.date).format("YYYY-MM-DD")} で判定日 ${dayjs(conditionDate).format("YYYY-MM-DD")} に届いていない（index-data backfill の失敗）`,
    };
  }
  // 昇順に直して連続下落を数える
  const closesAsc = [...n225Bars].reverse().map((b) => b.close);
  const nikkeiDownStreak = computeNikkeiDownStreak(closesAsc);
  // 前営業日時点の連続下落 = 最後の1本を落として数え直す
  const prevDayNikkeiDownStreak = computeNikkeiDownStreak(closesAsc.slice(0, -1));

  // --- VIX（判定日より前の最新バー）---
  const vixBar = await prisma.stockDailyBar.findFirst({
    where: { tickerCode: VIX_TICKER, date: { lt: conditionDate } },
    orderBy: { date: "desc" },
    select: { date: true, close: true },
  });
  if (!vixBar) {
    return { unavailable: true, reason: `^VIX のバーが無い（判定日 ${dayjs(conditionDate).format("YYYY-MM-DD")} より前）` };
  }
  const vixStaleDays = dayjs(conditionDate).diff(dayjs(vixBar.date), "day");
  if (vixStaleDays > VIX_MAX_STALE_DAYS) {
    return {
      unavailable: true,
      reason: `^VIX が stale（${dayjs(vixBar.date).format("YYYY-MM-DD")} = 判定日の${vixStaleDays}日前）。17:00 JST の index-data backfill が落ちている可能性`,
    };
  }
  const prevVixBar = await prisma.stockDailyBar.findFirst({
    where: { tickerCode: VIX_TICKER, date: { lt: prevConditionDate } },
    orderBy: { date: "desc" },
    select: { close: true },
  });

  return {
    conditionDate,
    breadth,
    breadthAllJp,
    nikkeiDownStreak,
    prevVixClose: vixBar.close,
    vixAsOf: vixBar.date,
    prevDayBreadth,
    prevDayNikkeiDownStreak,
    // 前営業日分が取れなければ「前日は条件を満たさなかった」側に倒す（= エピソード初日扱い）。
    // 発火を落とすのではなく拾う方向だが、VIX が2日連続で欠けるのは backfill 障害時のみで、
    // その場合は上の stale ガードで先に弾かれる。
    prevDayVixClose: prevVixBar?.close ?? 0,
  };
}
