/**
 * ポジション管理モジュール
 *
 * ポジションのオープン・クローズ・評価を行う
 */

import { prisma } from "../lib/prisma";
import type { TradingConfig, TradingPosition } from "@prisma/client";
import { getBuyingPower } from "./broker-orders";
import { isTachibanaProduction } from "../lib/constants/broker";

/**
 * ポジション単体の確定損益を算出する（粗損益）
 *
 * 手数料・税金はブローカー側で徴収されるため、プログラム側では計算しない。
 * exitPrice が null（void等）の場合は 0 を返す。
 */
export function getPositionPnl(pos: {
  entryPrice: { toNumber?: () => number } | number;
  exitPrice: { toNumber?: () => number } | number | null;
  quantity: number;
}): number {
  if (!pos.exitPrice) return 0;
  const entry = typeof pos.entryPrice === "number" ? pos.entryPrice : Number(pos.entryPrice);
  const exit = typeof pos.exitPrice === "number" ? pos.exitPrice : Number(pos.exitPrice);
  return Math.round((exit - entry) * pos.quantity);
}

/**
 * 全クローズ済みポジションの確定損益を合計する
 */
export async function computeRealizedPnl(): Promise<number> {
  const positions = await prisma.tradingPosition.findMany({
    where: { status: "closed", exitPrice: { not: null } },
    select: { entryPrice: true, exitPrice: true, quantity: true },
  });
  return positions.reduce((sum, pos) => sum + getPositionPnl(pos), 0);
}

/**
 * 実質資金を取得する
 *
 * TACHIBANA_ENV=production: ブローカーAPIの買余力 + 投資中金額 + 未約定買い注文の拘束額
 * それ以外: DBのtotalBudget + 累計確定損益
 *
 * production で pending 拘束額を足し戻す理由:
 * 立花は買い注文の受付時点で買付可能額(buyingPower)を即時拘束するが、投資中金額
 * (investedAmount) は open ポジションだけを数えるため、同一の 15:24 バッチ内で先行戦略
 * (GapUp→PSC→ETF の順) が pending 発注すると、その拘束分だけ effectiveCapital が過小評価
 * され、後続戦略の集中率上限(50%)チェックが誤って発火していた（2026-07-02: GapUp 4812.T の
 * 発注後に PSC 9304.T が「集中率上限」で棄却）。pending(=buyingPower から拘束済) を足し戻すと
 * 非production の「totalBudget = 現金 + open + pending」と同じ総額セマンティクスに揃う。
 */
export async function getEffectiveCapital(config?: TradingConfig | null): Promise<number> {
  if (isTachibanaProduction) {
    const apiBuyingPower = await getBuyingPower();
    if (apiBuyingPower == null) {
      throw new Error("証券APIから買余力を取得できませんでした");
    }
    const [investedAmount, pendingBuyAmount] = await Promise.all([
      getInvestedAmount(),
      getPendingBuyAmount(),
    ]);
    return apiBuyingPower + investedAmount + pendingBuyAmount;
  }

  const cfg = config ?? await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
  if (!cfg) throw new Error("TradingConfig が設定されていません");
  const realizedPnl = await computeRealizedPnl();
  return Number(cfg.totalBudget) + realizedPnl;
}

/**
 * 新規ポジションを建てる
 *
 * ポジションレコードを作成する。
 * 注文レコードはposition-monitorで元の注文にpositionIdを紐づけるため、ここでは作成しない。
 */
export interface RegimeInfo {
  vixAtEntry?: number | null;
  regimeLevel?: string | null;
  regimeScale?: number | null;
  appliedRiskPct?: number | null;
}

/**
 * entrySnapshot からVIXレジーム情報を抽出する
 *
 * entry-executor が書き込んだ `regimeInfo` ブロックを TradingPosition 用の
 * RegimeInfo 形式に変換する。古い注文（regimeInfo 未登録）では空オブジェクトを返す。
 */
export function extractRegimeInfoFromSnapshot(
  snapshot: unknown,
): RegimeInfo | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const regimeInfo = (snapshot as { regimeInfo?: unknown }).regimeInfo;
  if (!regimeInfo || typeof regimeInfo !== "object") return undefined;
  const r = regimeInfo as Record<string, unknown>;
  const toNum = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const toStr = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  return {
    vixAtEntry: toNum(r.vixAtEntry),
    regimeLevel: toStr(r.regimeLevel),
    regimeScale: toNum(r.regimeScale),
    appliedRiskPct: toNum(r.appliedRiskPct),
  };
}

export async function openPosition(
  stockId: string,
  strategy: string,
  entryPrice: number,
  quantity: number,
  takeProfitPrice: number,
  stopLossPrice: number,
  entrySnapshot?: object,
  entryAtr?: number | null,
  regimeInfo?: RegimeInfo,
): Promise<TradingPosition> {
  return prisma.tradingPosition.create({
    data: {
      stockId,
      strategy,
      entryPrice,
      quantity,
      takeProfitPrice,
      stopLossPrice,
      status: "open",
      entrySnapshot: entrySnapshot ?? undefined,
      maxHighDuringHold: entryPrice,
      minLowDuringHold: entryPrice,
      trailingStopPrice: null,
      entryAtr: entryAtr ?? null,
      vixAtEntry: regimeInfo?.vixAtEntry ?? null,
      regimeLevel: regimeInfo?.regimeLevel ?? null,
      regimeScale: regimeInfo?.regimeScale ?? null,
      appliedRiskPct: regimeInfo?.appliedRiskPct ?? null,
      updatedAt: new Date(),
    },
  });
}

/**
 * ポジションを決済する
 *
 * ポジションをクローズし、確定損益を計算して売り注文を作成する。
 */
export async function closePosition(
  positionId: string,
  exitPrice: number,
  exitSnapshot?: object,
  referencePrice?: number | null,
): Promise<TradingPosition> {
  const position = await prisma.tradingPosition.findUniqueOrThrow({
    where: { id: positionId },
  });

  const pnl = getPositionPnl({ entryPrice: position.entryPrice, exitPrice, quantity: position.quantity });

  // 売り側slippage: 想定決済価格(referencePrice)がある場合のみ記録
  // sell で (exitPrice - reference)/reference < 0 = 不利（想定より安く約定）
  const slippageBps =
    referencePrice && referencePrice > 0 && exitPrice > 0
      ? Math.round(((exitPrice - referencePrice) / referencePrice) * 10000)
      : null;

  return prisma.$transaction(async (tx) => {
    const closedPosition = await tx.tradingPosition.update({
      where: { id: positionId },
      data: {
        status: "closed",
        exitPrice,
        exitedAt: new Date(),
        exitSnapshot: exitSnapshot ?? undefined,
      },
    });

    // 売り注文を約定済みで作成（決済記録）
    // 決済は全経路が成行。position-monitor の executeExitSell は limitPrice=null の成行売りを出し、
    // ブローカーSLも逆指値・成行執行（broker-sl-manager: stopOrderPrice=undefined）。
    // 指値として記録すると取引履歴が実態と食い違う（KOH-549）。成行なので limitPrice は持たない。
    await tx.tradingOrder.create({
      data: {
        stockId: position.stockId,
        side: "sell",
        orderType: "market",
        strategy: position.strategy,
        limitPrice: null,
        quantity: position.quantity,
        status: "filled",
        filledPrice: exitPrice,
        filledAt: new Date(),
        reasoning: `ポジション決済（損益: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}円）`,
        positionId,
        referencePrice: referencePrice ?? null,
        slippageBps,
        updatedAt: new Date(),
      },
    });

    return closedPosition;
  });
}

/**
 * ポジションを無効化する（実取引が確認できない場合）
 *
 * ブローカーに保有が見つからず、約定も確認できないケースで使用する。
 * 損益は計上しない（exitPrice = null のまま）。
 */
export async function voidPosition(
  positionId: string,
  reason: string,
): Promise<TradingPosition> {
  return prisma.tradingPosition.update({
    where: { id: positionId },
    data: {
      status: "closed",
      exitedAt: new Date(),
      exitSnapshot: { exitReason: reason },
    },
  });
}

/**
 * オープン中の全ポジションを取得する
 */
export async function getOpenPositions() {
  return prisma.tradingPosition.findMany({
    where: { status: "open" },
    include: { stock: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * ポジションの含み損益を計算する
 */
export function getUnrealizedPnl(
  position: TradingPosition,
  currentPrice: number,
): number {
  const entryPrice = Number(position.entryPrice);
  return (currentPrice - entryPrice) * position.quantity;
}

/**
 * 全ポジションの時価評価額を合計する
 */
export async function getTotalPortfolioValue(
  currentPrices: Map<string, number>,
): Promise<number> {
  const positions = await getOpenPositions();

  let totalValue = 0;
  for (const position of positions) {
    const currentPrice = currentPrices.get(position.stockId);
    if (currentPrice !== undefined) {
      totalValue += currentPrice * position.quantity;
    } else {
      // 現在価格が不明な場合はエントリー価格で評価
      totalValue += Number(position.entryPrice) * position.quantity;
    }
  }

  return totalValue;
}

/**
 * 現金残高を取得する
 *
 * TACHIBANA_ENV=production: ブローカーAPIの買余力（現物買付可能額）を直接返す。
 * それ以外: 実質資金からオープンポジションの取得コスト合計を差し引く。
 */
export async function getCashBalance(): Promise<number> {
  if (isTachibanaProduction) {
    const apiBuyingPower = await getBuyingPower();
    if (apiBuyingPower == null) {
      throw new Error("証券APIから買余力を取得できませんでした");
    }
    return apiBuyingPower;
  }

  const [effectiveCapital, investedAmount, pendingAmount] = await Promise.all([
    getEffectiveCapital(),
    getInvestedAmount(),
    getPendingBuyAmount(),
  ]);

  return effectiveCapital - investedAmount - pendingAmount;
}

// ========================================
// 内部ヘルパー
// ========================================

/** オープンポジションの投資中金額を計算 */
async function getInvestedAmount(): Promise<number> {
  const openPositions = await prisma.tradingPosition.findMany({ where: { status: "open" } });
  return openPositions.reduce((sum, pos) => sum + Number(pos.entryPrice) * pos.quantity, 0);
}

/**
 * 未約定(pending)買い注文の拘束額を計算する
 *
 * GU/PSC/ETF は引け成行(limitPrice=null)のため、limitPrice が無い場合は
 * entrySnapshot のスナップショット価格で概算する。pending と open は排他状態
 * (約定時に fillOrder で pending→filled にした後に open ポジションを作成)なので、
 * getInvestedAmount と合算しても二重計上にならない。
 */
export async function getPendingBuyAmount(): Promise<number> {
  const pendingBuys = await prisma.tradingOrder.findMany({
    where: { side: "buy", status: "pending" },
    select: { quantity: true, limitPrice: true, entrySnapshot: true },
  });
  return pendingBuys.reduce((sum, order) => {
    const price =
      order.limitPrice != null
        ? Number(order.limitPrice)
        : extractSnapshotPrice(order.entrySnapshot);
    return sum + price * order.quantity;
  }, 0);
}

/** entrySnapshot.trigger.currentPrice を安全に取り出す（取れなければ 0） */
function extractSnapshotPrice(snapshot: unknown): number {
  if (!snapshot || typeof snapshot !== "object") return 0;
  const trigger = (snapshot as { trigger?: unknown }).trigger;
  if (!trigger || typeof trigger !== "object") return 0;
  const price = (trigger as { currentPrice?: unknown }).currentPrice;
  return typeof price === "number" && Number.isFinite(price) ? price : 0;
}

