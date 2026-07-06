/**
 * 自社株買いカタリスト エントリー監視 (KOH-504 / Phase A: 観察モード)
 *
 * worker.ts の node-cron から引け後(夕方)に呼ばれる。買いの適時開示は引け後に
 * 出ることが多いため、15:24 の entry-monitors とは別スケジュール。
 *
 * Phase A(観察モード, BUYBACK.OBSERVE_ONLY=true):
 *   やのしんTDnet から当日〜前日の「自己株式取得に係る事項の決定」を取得 →
 *   idle帯(breadth<54%)判定 → BuybackSignal に記録 + Slack通知。**発注はしない**。
 *   数週間フォワードで ①やのしん安定性 ②signalが想定通りか ③現局面挙動 を検証する。
 *
 * Phase B で BUYBACK.OBSERVE_ONLY=false にし、立花引け成行発注 + 20営業日タイムストップを足す
 * (us-etf-monitor.ts が雛形)。
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/market-date";
import { fetchBuybackDisclosures } from "../core/buyback/tdnet-fetcher";
import { BUYBACK } from "../lib/constants/buyback";
import { MARKET_BREADTH, TIMEZONE } from "../lib/constants";
import { notifySlack } from "../lib/slack";

dayjs.extend(utc);
dayjs.extend(timezone);

const tag = "[buyback-monitor]";

/** 開示timestamp → 想定エントリー営業日(15時以降=翌営業日、週末は翌月曜へ)。@db.Date 用 UTC 0時 */
function computeEntryDate(pubdateJst: string): Date {
  let d = dayjs.tz(pubdateJst, TIMEZONE);
  if (d.hour() >= BUYBACK.POST_CLOSE_HOUR) d = d.add(1, "day");
  // 週末は翌営業日へ(祝日は Phase B で厳密化。観察では近似で十分)
  while (d.day() === 0 || d.day() === 6) d = d.add(1, "day");
  return new Date(Date.UTC(d.year(), d.month(), d.date()));
}

/** 自社株買いモニターのメイン処理(worker.ts 夕方 node-cron から呼ばれる) */
export async function main(): Promise<void> {
  // 当日 breadth(idle帯判定)。検出時点の参照値として記録する
  const assessment = await prisma.marketAssessment.findUnique({
    where: { date: getTodayForDB() },
  });
  const breadth = assessment?.breadth != null ? Number(assessment.breadth) : null;
  const isIdleToday = breadth != null && breadth < MARKET_BREADTH.THRESHOLD;

  // 直近7日分の開示を取得(やのしん障害が連続しても後続ジョブで回収できる幅。tdnetId でべき等)
  const now = dayjs().tz(TIMEZONE);
  const disclosures = await fetchBuybackDisclosures(
    now.subtract(BUYBACK.FETCH_LOOKBACK_DAYS, "day").toDate(),
    now.toDate(),
  );

  // 既知の開示(前夜までに記録済み)は通知から除外する。7日窓では大半が既知になるため
  const known = new Set(
    (
      await prisma.buybackSignal.findMany({
        where: { tdnetId: { in: disclosures.map((d) => d.tdnetId) } },
        select: { tdnetId: true },
      })
    ).map((r) => r.tdnetId),
  );

  const todayDb = getTodayForDB();
  const recorded: { code: string; company: string; entryDate: string; idle: boolean; late: boolean }[] = [];
  for (const dsc of disclosures) {
    if (known.has(dsc.tdnetId)) continue;
    const entryDate = computeEntryDate(dsc.pubdate);
    // 障害キャッチアップ等で想定エントリー日を過ぎて検出した開示は記録のみ(発注対象外としてマーク)
    const isLate = entryDate.getTime() < todayDb.getTime();
    const tickerT = `${dsc.code}.T`;

    // 想定エントリー価格(best-effort: 直近終値)
    const lastBar = await prisma.stockDailyBar.findFirst({
      where: { tickerCode: tickerT },
      orderBy: { date: "desc" },
      select: { close: true },
    });
    const entryClose = lastBar?.close != null ? Number(lastBar.close) : null;
    const slPrice = entryClose != null ? entryClose * (1 - BUYBACK.SL_PCT) : null;

    await prisma.buybackSignal.upsert({
      where: { tdnetId: dsc.tdnetId },
      create: {
        tdnetId: dsc.tdnetId,
        disclosedAt: dayjs.tz(dsc.pubdate, TIMEZONE).toDate(),
        entryDate,
        ticker: dsc.code,
        title: dsc.title,
        entryClose,
        slPrice,
        japanBreadth: breadth,
        isIdle: isIdleToday,
        observeOnly: BUYBACK.OBSERVE_ONLY,
        skipReason: isLate
          ? "遅延検出(想定エントリー日超過・記録のみ)"
          : BUYBACK.OBSERVE_ONLY
            ? "観察モード(Phase A・発注禁止)"
            : null,
      },
      update: {}, // 既存は不変(初回検出時の breadth/価格を保持)
    });

    recorded.push({
      code: dsc.code,
      company: dsc.companyName,
      entryDate: dayjs(entryDate).format("YYYY-MM-DD"),
      idle: isIdleToday,
      late: isLate,
    });
  }

  const idleCount = recorded.filter((r) => r.idle).length;
  const breadthStr = breadth != null ? `${(breadth * 100).toFixed(1)}%` : "未確定";
  console.log(
    `${tag} 観察: 取得決定 ${recorded.length}件 (idle帯 ${idleCount}件) breadth=${breadthStr} observeOnly=${BUYBACK.OBSERVE_ONLY}`,
  );

  const lines: string[] = [];
  if (recorded.length === 0) {
    lines.push("本日の「自己株式取得に係る事項の決定」開示なし");
  } else {
    lines.push(
      isIdleToday
        ? `*🟢 idle帯(breadth ${breadthStr} < 54%) → 発注対象になる開示*`
        : `*⚪ band帯(breadth ${breadthStr} ≥ 54%) → GU/PSC稼働中につき見送り対象*`,
    );
    for (const r of recorded) {
      lines.push(
        `  ${r.code} ${r.company}（想定エントリー ${r.entryDate}${r.late ? "・遅延検出/記録のみ" : ""}）`,
      );
    }
    lines.push("");
    lines.push("※ 観察モード(Phase A): DB記録のみ、発注なし");
  }

  await notifySlack({
    title: `[BUYBACK/観察] 取得決定 ${recorded.length}件（idle ${idleCount}件）`,
    message: lines.join("\n"),
    color: idleCount > 0 ? "warning" : undefined,
  });
}
