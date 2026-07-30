/**
 * ブレイクアウト戦略のエントリーエグゼキューター
 *
 * ブレイクアウトトリガーを受け取り、以下のフローを実行する:
 * 1. 今日のMarketAssessmentでshouldTradeを確認
 * 2. 買い余力チェック（ローカル計算）
 * 3. SL価格 = currentPrice - ATR(14) × 1.0（最大3%）
 * 4. ポジションサイズ = リスク金額（資金のRISK_PER_TRADE_PCT%） / (currentPrice - SL)��100株単位切捨て
 * 5. TradingOrderをDBに作成
 * 6. submitBrokerOrder()でブローカー発注
 * 7. Slack通知
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { prisma } from "../../lib/prisma";
import { getTodayForDB, adjustToTradingDay, getStartOfDayJST } from "../../lib/market-date";
import { getCashBalance, getEffectiveCapital } from "../position-manager";
import { canOpenPosition, getDynamicMaxPositionPct } from "../risk-manager";
import { submitOrder as submitBrokerOrder } from "../broker-orders";
import { notifyOrderPlaced, notifySlack } from "../../lib/slack";
import { STOP_LOSS, UNIT_SHARES, POSITION_SIZING, LOSING_STREAK } from "../../lib/constants";
import { getLosingStreak } from "../drawdown-manager";
import { checkLiquidity } from "../market-data";
import { determineMarketRegime, getRegimeRiskScale } from "../market-regime";
import { TIMEZONE } from "../../lib/constants/timezone";
import { GAPUP } from "../../lib/constants/gapup";
import { WEEKLY_BREAK } from "../../lib/constants/weekly-break";
import { POST_SURGE_CONSOLIDATION } from "../../lib/constants/post-surge-consolidation";
import { TACHIBANA_ORDER } from "../../lib/constants/broker";
import { ORDER_EXPIRY } from "../../lib/constants/jobs";
import type { GapUpTrigger } from "../gapup/gapup-scanner";
import type { WeeklyBreakTrigger } from "../weekly-break/weekly-break-scanner";
import type { PostSurgeConsolidationTrigger } from "../post-surge-consolidation/psc-scanner";

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * スキップ理由を追跡ラベルに変換する。
 *
 * ★「候補として挙がったのに注文に乗らなかった」ものは全て弾き分析（RejectedSignal）に載せる。
 * 以前は未知の理由を null = 追跡しない としていたため、shouldTrade=false / SLクランプ /
 * 二重建て防止 / VIXレジーム / 日次損失制限 / ドローダウン停止 / 発注失敗 / 枠上限 が
 * 記録から丸ごと落ちていた（Slack か console にしか出ず、後から数えられなかった）。
 * 分類できない理由は「その他」に落として**必ず1行残す**。
 *
 * ⚠️ 判定順に依存する。より具体的なパターンを先に置くこと
 * （例: 「連敗クールダウン」は「連敗停止」より前）。
 */
function getRejectedLabel(reason: string): string {
  if (/予算不足|残高不足|現金残高不足/.test(reason)) return "残高不足";
  if (/集中率上限|投資比率上限/.test(reason)) return "集中率上限";
  if (/最大同時保有数/.test(reason)) return "ポジション数上限";
  if (/流動性/.test(reason)) return "流動性不足";
  if (/マクロファクター/.test(reason)) return "マクロ集中";
  if (/セクター/.test(reason)) return "セクター集中";
  if (/連敗クールダウン/.test(reason)) return "連敗クールダウン";
  // 以下は「候補が注文に乗らなかった全経路を弾き分析に載せる」対応で追加（従来は null = 記録なし）
  if (/枠上限|枠を使い切/.test(reason)) return "枠上限";
  if (/二重建て/.test(reason)) return "二重建て防止";
  if (/クランプ/.test(reason)) return "SLクランプ";
  if (/SLがエントリー価格以上/.test(reason)) return "SL計算不可";
  if (/VIXレジーム/.test(reason)) return "VIXレジーム";
  if (/日次損失制限/.test(reason)) return "日次損失制限";
  if (/ドローダウン停止/.test(reason)) return "ドローダウン停止";
  if (/連敗/.test(reason)) return "連敗停止";
  if (/shouldTrade|MarketAssessment|取引が無効化|TradingConfig/.test(reason)) return "相場停止";
  if (/銘柄マスタ/.test(reason)) return "銘柄マスタ欠落";
  return "その他";
}

/**
 * Slack 通知する棄却ラベル（「取り逃し」系のうち、monitor が通知しないもの）。
 *
 * ルールで良いセットアップを弾いた棄却だけ通知する。資金切れ（残高不足）・連敗クールダウンは
 * 日常的に頻発しノイズになるため除外。
 *
 * 「集中率上限」は非リトライ系のため monitor 側（gapup / post-surge-consolidation）が
 * 既に `[GU/PSC] エントリー失敗` を通知しており、ここで通知すると二重になるため除外する。
 * セクター集中 / マクロ集中 / 流動性不足 はリトライ系で monitor が console.log のみ、
 * ポジション数上限は monitor が当日打ち止めで break（Slack 無し）だったため、ここで拾う。
 */
const NOTIFY_REJECT_LABELS = new Set<string>([
  "セクター集中",
  "マクロ集中",
  "ポジション数上限",
  "流動性不足",
]);

/** RejectedSignal を非同期で保存（エラーは握りつぶしてメイン処理を止めない） */
async function saveRejectedSignal(params: {
  ticker: string;
  strategy: string;
  reason: string;
  reasonLabel: string;
  entryPrice: number;
  /** false で Slack 通知を抑止（枠上限などの一括記録用） */
  notify?: boolean;
}): Promise<void> {
  let firstToday = false;
  try {
    // 同一銘柄×同一ラベルが当日既に記録済みかを先に確認。
    // 15:24:00/20/40 のリトライ tick で同じ銘柄が3回弾かれるため、行を毎回作ると
    // 弾き分析の件数・平均フォワードリターンが tick 数で膨らんで歪む。
    // 「その日その銘柄をこの理由で弾いた」= 1行に集約する（Slack も従来どおり当日1回）。
    const alreadyToday = await prisma.rejectedSignal.findFirst({
      where: {
        ticker: params.ticker,
        strategy: params.strategy,
        reasonLabel: params.reasonLabel,
        rejectedAt: { gte: getStartOfDayJST() },
      },
      select: { id: true },
    });
    firstToday = !alreadyToday;
    if (!firstToday) return; // 当日同一ラベルは記録済み → 行も通知も増やさない

    await prisma.rejectedSignal.create({
      data: {
        ticker: params.ticker,
        strategy: params.strategy,
        rejectedAt: new Date(),
        reason: params.reason,
        reasonLabel: params.reasonLabel,
        entryPrice: params.entryPrice,
      },
    });
  } catch (err) {
    console.error("[entry-executor] RejectedSignal 保存失敗:", err);
    return; // 保存失敗時は通知しない
  }

  // 当日初回かつ「取り逃し」系ラベルのみ Slack 通知（通知失敗はメイン処理を止めない）
  if (params.notify !== false && firstToday && NOTIFY_REJECT_LABELS.has(params.reasonLabel)) {
    await notifySlack({
      title: `⛔ エントリー棄却: ${params.ticker} [${params.strategy}]`,
      message: `理由: ${params.reason}`,
      color: "warning",
      fields: [
        { title: "ラベル", value: params.reasonLabel, short: true },
        {
          title: "想定エントリー価格",
          value: `¥${params.entryPrice.toLocaleString()}`,
          short: true,
        },
      ],
    }).catch((err) =>
      console.error("[entry-executor] 棄却Slack通知失敗:", err),
    );
  }
}

/**
 * executeEntry に渡されないまま見送られた候補を弾き分析に一括記録する。
 *
 * 枠を使い切った後の残りトリガーや、当日打ち止め（資金切れ等）以降の候補は
 * executeEntry を通らないため、これを呼ばないと「候補はあったのに注文に乗らなかった」
 * 事実が DB に残らない（従来は console.log のみで後から数えられなかった）。
 *
 * Slack は抑止する（打ち止めの原因になった当の候補は executeEntry 側で通知済みで、
 * 残り候補まで通知すると銘柄数だけ通知が増えてノイズになる）。
 */
export async function recordSkippedCandidates(
  candidates: { ticker: string; currentPrice: number }[],
  strategy: "gapup" | "weekly-break" | "post-surge-consolidation",
  reason: string,
  /** ラベルを明示指定する（reason の文面から推定させない場合） */
  label?: string,
): Promise<void> {
  if (candidates.length === 0) return;
  const reasonLabel = label ?? getRejectedLabel(reason);
  for (const c of candidates) {
    await saveRejectedSignal({
      ticker: c.ticker,
      strategy,
      reason,
      reasonLabel,
      entryPrice: c.currentPrice,
      notify: false,
    });
  }
  console.log(
    `[entry-executor] 未評価候補を弾き分析に記録: ${candidates.length}件 [${strategy}] ${reasonLabel}`,
  );
}

/**
 * スキャナーが「シグナルは満たしたが保有中/当日発注済み/決済後cooldown」で外した候補を
 * 除外理由別のラベルで弾き分析に記録する。
 *
 * スキャナーは3つの集合をマージした holdingTickers しか受け取らないため、理由の切り分けは
 * 呼び出し側（monitor）が持つ元の集合で行う。同一銘柄が複数に該当する場合は
 * 保有中 > 当日発注済み > 決済後cooldown の優先順で1つに寄せる。
 */
export async function recordSkippedByHolding(
  skipped: { ticker: string; currentPrice: number }[],
  strategy: "gapup" | "weekly-break" | "post-surge-consolidation",
  held: Set<string>,
  pending: Set<string>,
  cooldown: Set<string>,
): Promise<void> {
  for (const c of skipped) {
    const [reason, label] = held.has(c.ticker)
      ? ["保有中の銘柄のためシグナルを見送り（1銘柄1ポジション）", "保有中"]
      : pending.has(c.ticker)
        ? ["当日発注済み（未約定）の銘柄のためシグナルを見送り", "当日発注済み"]
        : cooldown.has(c.ticker)
          ? ["決済後3営業日の再エントリーcooldown中のためシグナルを見送り", "決済後cooldown"]
          : ["除外集合に含まれるためシグナルを見送り", "その他"];
    await saveRejectedSignal({
      ticker: c.ticker,
      strategy,
      reason,
      reasonLabel: label,
      entryPrice: c.currentPrice,
      notify: false,
    });
  }
  if (skipped.length > 0) {
    console.log(
      `[entry-executor] シグナル成立だが除外された候補を弾き分析に記録: ${skipped.length}件 [${strategy}]`,
    );
  }
}

export interface ExecutionResult {
  success: boolean;
  orderId?: string;
  reason?: string;
  /** true の場合、同じ銘柄の再トリガーを許可する（一時的な理由での却下） */
  retryable?: boolean;
  /** 弾き分析のラベルを明示指定する（reason の文面から推定できない発注失敗系で使う） */
  rejectLabel?: string;
}

/**
 * トリガーのエントリー実行（gapup / weekly-break / PSC）。
 *
 * ★注文に乗らなかった候補は必ず弾き分析（RejectedSignal）に1行残す。
 * 判定本体は executeEntryInner で、記録はこのラッパーに集約している
 * （早期 return が10箇所以上あり、各所に保存を書くと必ず漏れるため）。
 */
export async function executeEntry(
  trigger: GapUpTrigger | WeeklyBreakTrigger | PostSurgeConsolidationTrigger,
  strategy: "gapup" | "weekly-break" | "post-surge-consolidation" = "gapup",
): Promise<ExecutionResult> {
  const result = await executeEntryInner(trigger, strategy);
  if (!result.success) {
    const reason = result.reason ?? "不明";
    await saveRejectedSignal({
      ticker: trigger.ticker,
      strategy,
      reason,
      reasonLabel: result.rejectLabel ?? getRejectedLabel(reason),
      entryPrice: trigger.currentPrice,
    });
  }
  return result;
}

/**
 * エントリー判定・発注の本体（呼び出しは executeEntry 経由のみ）。
 *
 * @param trigger トリガーイベント
 * @param strategy 戦略種別
 */
async function executeEntryInner(
  trigger: GapUpTrigger | WeeklyBreakTrigger | PostSurgeConsolidationTrigger,
  strategy: "gapup" | "weekly-break" | "post-surge-consolidation" = "gapup",
): Promise<ExecutionResult> {
  const { ticker, currentPrice, atr14 } = trigger;

  // 0. 共有データを並列で一括取得（重複クエリ削減）
  const [todayAssessment, stock, cashBalance, effectiveCapital, config, openPositions, losingStreak] =
    await Promise.all([
      prisma.marketAssessment.findUnique({ where: { date: getTodayForDB() } }),
      prisma.stock.findUnique({ where: { tickerCode: ticker } }),
      getCashBalance(),
      getEffectiveCapital(),
      prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } }),
      prisma.tradingPosition.findMany({
        where: { status: "open" },
        include: { stock: { select: { id: true, jpxSectorName: true, tickerCode: true } } },
      }),
      getLosingStreak(),
    ]);

  // 1. shouldTrade確認
  if (!todayAssessment || !todayAssessment.shouldTrade) {
    const reason = !todayAssessment
      ? "今日のMarketAssessmentがありません"
      : "今日は取引見送り（shouldTrade=false）";
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    return { success: false, reason, retryable: false };
  }

  // 2. 銘柄マスタ確認
  if (!stock) {
    const reason = `銘柄マスタに存在しません: ${ticker}`;
    console.log(`[entry-executor] ${reason}`);
    return { success: false, reason, retryable: false };
  }

  // 2.5 戦略横断の二重建て防止（最終防衛線）
  // 約定前は TradingPosition が無く、monitor の holdingTickers 除外をすり抜けて
  // 同一バッチ内で GU と PSC が同じ銘柄に二重発注しうる（Issue #322: 2026-06-30 3989.T）。
  // 当日の未約定（pending）買い注文が同一銘柄に既にあればスキップし、BT の
  // allOpenTickers（1銘柄1ポジション）挙動に一致させる。
  const existingPendingBuy = await prisma.tradingOrder.findFirst({
    where: {
      stockId: stock.id,
      side: "buy",
      status: "pending",
      createdAt: { gte: getStartOfDayJST() },
    },
    select: { strategy: true },
  });
  if (existingPendingBuy) {
    const reason = `同一銘柄に当日の未約定買い注文が既に存在（戦略横断の二重建て防止, 既存戦略=${existingPendingBuy.strategy}）`;
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    return { success: false, reason, retryable: false };
  }

  // 3. SL価格 = currentPrice - ATR × multiplier（最大3%に制限）
  const slAtrMultiplier =
    strategy === "gapup" ? GAPUP.STOP_LOSS.ATR_MULTIPLIER
    : strategy === "weekly-break" ? WEEKLY_BREAK.STOP_LOSS.ATR_MULTIPLIER
    : POST_SURGE_CONSOLIDATION.STOP_LOSS.ATR_MULTIPLIER;
  const rawStopLoss = currentPrice - atr14 * slAtrMultiplier;
  const maxStopLoss = currentPrice * (1 - STOP_LOSS.MAX_LOSS_PCT);
  const stopLossPrice = Math.round(Math.max(rawStopLoss, maxStopLoss));

  const isSLClamped = rawStopLoss < maxStopLoss;
  if (isSLClamped) {
    const reason = `SLがATRベース（¥${Math.round(rawStopLoss)}）より3%上限（¥${stopLossPrice}）でクランプされました — ノイズに狩られるリスクが高いためスキップ`;
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    return { success: false, reason, retryable: false };
  }

  // 4. ポジションサイズ計算（RRに応じたリスク%傾斜）
  const riskPerShare = currentPrice - stopLossPrice;

  if (riskPerShare <= 0) {
    const reason = `SLがエントリー価格以上のため数量計算不可（SL: ¥${stopLossPrice}, entry: ¥${currentPrice}）`;
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    return { success: false, reason, retryable: false };
  }

  // 利確参考値: ATR × 5.0（トレーリングストップが実際の利確を担う、サイジングには使わない）
  const takeProfitPrice = Math.round(currentPrice + atr14 * 5.0);

  // リスク%: フラット2%（SL/TPが共にATRベースのためRR傾斜は常に固定値になり無意味）
  // 連敗時はスケールダウンして損失を抑える
  const baseRiskPct = POSITION_SIZING.RISK_PER_TRADE_PCT;
  const streakAdjustedPct = losingStreak >= LOSING_STREAK.SCALE_TRIGGER
    ? baseRiskPct * LOSING_STREAK.SCALE_FACTOR
    : baseRiskPct;
  // VIXレジーム別スケーリング（BT側と同じロジック: elevated=0.5, high=0.25, crisis=0）
  const vixValue = todayAssessment.vix != null ? Number(todayAssessment.vix) : null;
  const regime = vixValue != null ? determineMarketRegime(vixValue) : null;
  const regimeScale = regime ? getRegimeRiskScale(regime.level) : 1.0;
  const riskPct = streakAdjustedPct * regimeScale;
  if (regimeScale < 1.0) {
    const msg = `[entry-executor] ${ticker} VIXレジーム(${regime?.level} VIX=${vixValue?.toFixed(1)})でリスク%縮小: ${streakAdjustedPct}% → ${riskPct.toFixed(3)}%`;
    console.log(msg);
    // 発動は稀(2年で数回レベル)なので発動時は必ず通知して観測性を確保
    await notifySlack({
      title: `🟡 VIXレジーム縮小発動: ${ticker}`,
      message:
        `戦略: ${strategy}\n` +
        `銘柄: ${stock.name}（${ticker}）\n` +
        `VIX: ${vixValue?.toFixed(1)} (${regime?.level})\n` +
        `リスク%: ${streakAdjustedPct.toFixed(2)}% → ${riskPct.toFixed(3)}% (×${regimeScale})\n` +
        `理由: ${regime?.reason ?? "-"}`,
      color: "warning",
    });
  }
  if (riskPct <= 0) {
    const reason = `VIXレジーム ${regime?.level} でサイズ=0（crisis停止）`;
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    await notifySlack({
      title: `🔴 VIXレジーム crisis でエントリー停止: ${ticker}`,
      message:
        `戦略: ${strategy}\n銘柄: ${stock.name}（${ticker}）\n` +
        `VIX: ${vixValue?.toFixed(1)} (${regime?.level})\n` +
        `理由: ${regime?.reason ?? "-"}`,
      color: "danger",
    });
    return { success: false, reason, retryable: false };
  }
  const riskAmount = effectiveCapital * (riskPct / 100);

  const rawQuantity = Math.floor(riskAmount / riskPerShare);
  let quantity = Math.floor(rawQuantity / UNIT_SHARES) * UNIT_SHARES;

  if (quantity === 0) {
    const reason = `予算不足でポジションサイズが0（余力: ¥${cashBalance.toLocaleString()}, リスク額: ¥${riskAmount.toLocaleString()}, リスク%: ${riskPct}%）`;
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    return { success: false, reason, retryable: true };
  }

  // 残高上限で切り下げ: 買える最大100株単位に縮小
  // 買余力に BUYING_POWER_BUFFER(0.80) を掛けるのは、立花が日計り取引の規制対象銘柄で買付可能額に
  // 掛目を効かせて算出するため（一般買余力で組んだ数量が発注時に [sub:11430] で弾かれる。KOH-580）。
  // 掛目 1/0.80 = 1.25倍まで吸収する。16窓BTで Calmar への有意コストなしを確認済。
  const buyingPower = cashBalance * POSITION_SIZING.BUYING_POWER_BUFFER;
  const maxByBalance = Math.floor(buyingPower / currentPrice / UNIT_SHARES) * UNIT_SHARES;
  if (quantity > maxByBalance) {
    if (maxByBalance === 0) {
      const reason = `残高不足（必要: ¥${(currentPrice * quantity).toLocaleString()}, 買余力×${POSITION_SIZING.BUYING_POWER_BUFFER}: ¥${Math.floor(buyingPower).toLocaleString()}, 残高: ¥${cashBalance.toLocaleString()}）`;
      console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
      return { success: false, reason, retryable: true };
    }
    console.log(`[entry-executor] ${ticker} 残高上限で縮小: ${quantity}株 → ${maxByBalance}株（買余力×${POSITION_SIZING.BUYING_POWER_BUFFER}: ¥${Math.floor(buyingPower).toLocaleString()}, 残高: ¥${cashBalance.toLocaleString()}）`);
    quantity = maxByBalance;
  }

  // 集中率上限で切り下げ: maxPositionPct 以内に収まる最大100株単位に縮小
  const maxPositionPct = getDynamicMaxPositionPct(effectiveCapital, currentPrice);
  const existingAmountForStock = openPositions
    .filter((pos) => pos.stockId === stock.id)
    .reduce((sum, pos) => sum + Number(pos.entryPrice) * pos.quantity, 0);
  const maxAmountByConcentration = (effectiveCapital * maxPositionPct) / 100 - existingAmountForStock;
  const maxByConcentration = Math.floor(maxAmountByConcentration / currentPrice / UNIT_SHARES) * UNIT_SHARES;
  if (quantity > maxByConcentration) {
    if (maxByConcentration <= 0) {
      const reason = `集中率上限（${maxPositionPct}%）を超えるためスキップ（既存投資額: ¥${existingAmountForStock.toLocaleString()}）`;
      console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
      return { success: false, reason, retryable: false };
    }
    console.log(`[entry-executor] ${ticker} 集中率上限で縮小: ${quantity}株 → ${maxByConcentration}株（上限: ${maxPositionPct}%）`);
    quantity = maxByConcentration;
  }

  // 5. canOpenPosition でセクター集中・ドローダウン・ポジション数を確認（プリフェッチデータを渡す）
  const riskCheck = await canOpenPosition(
    stock.id,
    quantity,
    currentPrice,
    {
      config: config ?? undefined,
      openPositions,
      effectiveCapital,
      losingStreak,
    },
    strategy,
  );
  if (!riskCheck.allowed) {
    console.log(`[entry-executor] ${ticker} リスクチェック不可: ${riskCheck.reason}`);
    return { success: false, reason: riskCheck.reason, retryable: riskCheck.retryable ?? false };
  }

  // 5.5 流動性チェック（板情報フィルター）
  // monitor がバッチ取得済みの板情報をトリガー経由で受け取り、追加API呼び出しなしで検証する
  const liquidityCheck = checkLiquidity(
    { price: currentPrice, askPrice: trigger.askPrice, bidPrice: trigger.bidPrice, askSize: trigger.askSize, bidSize: trigger.bidSize },
    quantity,
  );
  if (!liquidityCheck.isLiquid) {
    const liquidityReason = liquidityCheck.reason ?? "流動性不足";
    console.log(`[entry-executor] ${ticker} 流動性不足: ${liquidityReason}`);
    return { success: false, reason: liquidityReason, retryable: true };
  }
  if (liquidityCheck.riskFlags.length > 0) {
    console.log(
      `[entry-executor] ${ticker} 流動性リスクフラグ: ${liquidityCheck.riskFlags.join(", ")}（スプレッド: ${liquidityCheck.spreadPct?.toFixed(2) ?? "-"}%）`,
    );
  }

  // 6. 変数の準備
  const isGapUp = strategy === "gapup";
  const isWeeklyBreak = strategy === "weekly-break";
  const isPSC = strategy === "post-surge-consolidation";
  const isCloseOrder = isGapUp || isWeeklyBreak || isPSC;
  const expiresAt = isCloseOrder
    ? dayjs().tz(TIMEZONE).hour(15).minute(30).second(0).toDate()
    : dayjs().tz(TIMEZONE).add(ORDER_EXPIRY.SWING_DAYS, "day").hour(15).minute(0).second(0).toDate();
  const reasoning = isWeeklyBreak
    ? `週足ブレイクトリガー: ${'weeklyHigh' in trigger ? trigger.weeklyHigh : 0}円を上抜け, 出来高サージ ${trigger.volumeSurgeRatio.toFixed(2)}x`
    : isPSC
    ? `PSCトリガー: モメンタム ${(('momentumReturn' in trigger ? trigger.momentumReturn : 0) * 100).toFixed(1)}%, 出来高サージ ${trigger.volumeSurgeRatio.toFixed(2)}x`
    : `GUトリガー: 出来高サージ比率 ${trigger.volumeSurgeRatio.toFixed(2)}x, ギャップ3%以上`;

  // 7. ブローカー発注（DB保存前に実行）
  let brokerResult;
  try {
    brokerResult = await submitBrokerOrder({
      ticker,
      side: "buy",
      quantity,
      limitPrice: isCloseOrder ? null : currentPrice,
      condition: isCloseOrder ? TACHIBANA_ORDER.CONDITION.CLOSE : undefined,
      expireDay: isCloseOrder ? undefined : dayjs(adjustToTradingDay(expiresAt)).tz(TIMEZONE).format("YYYYMMDD"),
    });
  } catch (brokerErr) {
    console.error(`[entry-executor] ブローカーエラー ${ticker}:`, brokerErr);
    const errorMsg = brokerErr instanceof Error ? brokerErr.message : String(brokerErr);
    await notifySlack({
      title: `ブローカー発注失敗: ${ticker}（リトライ待機）`,
      message: errorMsg,
      color: "warning",
    });
    // 例外（ネットワーク/セッション障害など）はリトライ可能とする
    return { success: false, reason: errorMsg, retryable: true, rejectLabel: "発注失敗" };
  }

  if (!brokerResult.success || !brokerResult.orderNumber) {
    const errorMsg = brokerResult.success
      ? "注文番号が取得できませんでした"
      : (brokerResult.error ?? "Unknown error");
    // サブコード（"[sub:"プレフィックス）は業務ロジック上のリジェクト（資金不足、口座種別不一致など） → 非リトライ
    // それ以外（sResultCode エラー、注文番号未返却）はトランスポート/セッション起因 → リトライ可能
    const isBusinessRejection = errorMsg.startsWith("[sub:");
    const retryable = !isBusinessRejection;
    console.warn(
      `[entry-executor] ブローカー発注失敗: ${ticker}: ${errorMsg} (retryable=${retryable})`,
    );
    await notifySlack({
      title: `ブローカー発注失敗: ${ticker}${retryable ? "（リトライ待機）" : ""}`,
      message: errorMsg,
      color: retryable ? "warning" : "danger",
    });
    return { success: false, reason: errorMsg, retryable, rejectLabel: "発注失敗" };
  }

  console.log(
    `[entry-executor] ${ticker} ブローカー発注成功: orderNumber=${brokerResult.orderNumber}`,
  );

  // 6. TradingOrderをDBに作成（発注成功後）
  const newOrder = await prisma.tradingOrder.create({
    data: {
      updatedAt: new Date(),
      stockId: stock.id,
      side: "buy",
      orderType: isCloseOrder ? "market" : "limit",
      strategy,
      // 引け成行はlimitPriceを持たない。スナップショット価格はentrySnapshot.trigger.currentPriceで参照可能。
      limitPrice: isCloseOrder ? null : currentPrice,
      takeProfitPrice,
      stopLossPrice,
      quantity,
      status: "pending",
      expiresAt,
      reasoning,
      brokerOrderId: brokerResult.orderNumber,
      brokerBusinessDay: brokerResult.businessDay,
      entrySnapshot: {
        trigger: {
          ticker: trigger.ticker,
          currentPrice: trigger.currentPrice,
          volumeSurgeRatio: trigger.volumeSurgeRatio,
          ...('weeklyHigh' in trigger ? { weeklyHigh: (trigger as WeeklyBreakTrigger).weeklyHigh } : {}),
          ...('momentumReturn' in trigger ? { momentumReturn: (trigger as PostSurgeConsolidationTrigger).momentumReturn } : {}),
          atr14: trigger.atr14,
          triggeredAt: trigger.triggeredAt.toISOString(),
        },
        slClamped: isSLClamped,
        riskPct,
        ...(losingStreak > 0 ? { losingStreak } : {}),
        regimeInfo: {
          vixAtEntry: vixValue,
          regimeLevel: regime?.level ?? null,
          regimeScale,
          appliedRiskPct: riskPct,
        },
        ...(trigger.askPrice ? {
          liquidity: {
            askPrice: trigger.askPrice,
            bidPrice: trigger.bidPrice,
            askSize: trigger.askSize,
            bidSize: trigger.bidSize,
            spreadPct: liquidityCheck.spreadPct,
          },
        } : {}),
      },
    },
  });

  console.log(
    `[entry-executor] ${ticker} 注文作成: id=${newOrder.id}, 指値=¥${currentPrice}, SL=¥${stopLossPrice}, TP=¥${takeProfitPrice}, 数量=${quantity}株, リスク%=${riskPct}%${losingStreak >= LOSING_STREAK.SCALE_TRIGGER ? `, 連敗${losingStreak}（縮小中）` : ""}`,
  );

  // 8. Slack通知
  const slackReasoning = isWeeklyBreak
    ? `週足ブレイクトリガー: ${'weeklyHigh' in trigger ? trigger.weeklyHigh : 0}円上抜け / 出来高サージ ${trigger.volumeSurgeRatio.toFixed(2)}x`
    : isPSC
    ? `PSCトリガー: モメンタム ${(('momentumReturn' in trigger ? trigger.momentumReturn : 0) * 100).toFixed(1)}% / 出来高サージ ${trigger.volumeSurgeRatio.toFixed(2)}x`
    : `GUトリガー: 出来高サージ ${trigger.volumeSurgeRatio.toFixed(2)}x / ギャップ3%以上`;
  await notifyOrderPlaced({
    tickerCode: ticker,
    name: stock.name,
    side: "buy",
    strategy,
    limitPrice: currentPrice,
    takeProfitPrice,
    stopLossPrice,
    quantity,
    reasoning: slackReasoning,
  });

  return { success: true, orderId: newOrder.id };
}
