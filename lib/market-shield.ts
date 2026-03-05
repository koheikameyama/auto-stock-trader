/**
 * マーケットシールド: 市場急変時の緊急防御モード
 *
 * 日経225/VIX/WTI/為替の急変を検知し、
 * ポートフォリオ全体の防御力を自動で引き上げる。
 */

import { prisma } from "@/lib/prisma"
import { MARKET_SHIELD } from "@/lib/constants"
import { getTodayForDB } from "@/lib/date-utils"

// ── 型定義 ──

export interface ShieldTriggerResult {
  triggered: boolean
  type: "nikkei_crash" | "vix_spike" | "wti_shock" | "fx_shock"
  value: number
  description: string
}

export interface ActiveShield {
  id: string
  activatedAt: Date
  triggerType: string
  triggerValue: number
  actionsApplied: unknown
}

// ── トリガーチェック ──

/**
 * 市場データからShield発動条件を確認
 * PreMarketData + 日経225の当日データを使用
 */
export async function checkMarketShieldTriggers(): Promise<ShieldTriggerResult | null> {
  const today = getTodayForDB()

  // 既にアクティブなShieldがあればスキップ
  const active = await getActiveShield()
  if (active) return null

  // PreMarketData（当日）を取得
  const preMarket = await prisma.preMarketData.findUnique({
    where: { date: today },
  })

  if (!preMarket) return null

  const triggers = MARKET_SHIELD.TRIGGERS

  // VIX絶対値チェック
  if (preMarket.vixClose) {
    const vix = Number(preMarket.vixClose)
    if (vix > triggers.VIX_ABSOLUTE) {
      return {
        triggered: true,
        type: "vix_spike",
        value: vix,
        description: `VIX（恐怖指数）が${vix.toFixed(1)}に急騰`,
      }
    }
  }

  // VIX急変動チェック
  if (preMarket.vixChangeRate) {
    const vixChange = Number(preMarket.vixChangeRate)
    if (vixChange >= triggers.VIX_SPIKE_RATE) {
      return {
        triggered: true,
        type: "vix_spike",
        value: vixChange,
        description: `VIX（恐怖指数）が前日比+${vixChange.toFixed(1)}%急騰`,
      }
    }
  }

  // WTIショック
  if (preMarket.wtiChangeRate) {
    const wtiChange = Number(preMarket.wtiChangeRate)
    if (Math.abs(wtiChange) >= triggers.WTI_SHOCK_RATE) {
      return {
        triggered: true,
        type: "wti_shock",
        value: wtiChange,
        description: `WTI原油が前日比${wtiChange > 0 ? "+" : ""}${wtiChange.toFixed(1)}%の急変動`,
      }
    }
  }

  // 為替ショック
  if (preMarket.usdjpyChangeRate) {
    const fxChange = Number(preMarket.usdjpyChangeRate)
    if (Math.abs(fxChange) >= triggers.FX_SHOCK_RATE) {
      return {
        triggered: true,
        type: "fx_shock",
        value: fxChange,
        description: `USD/JPYが前日比${fxChange > 0 ? "+" : ""}${fxChange.toFixed(1)}%の急変動`,
      }
    }
  }

  // 日経先物暴落チェック
  if (preMarket.nikkeiFuturesChangeRate) {
    const nikkeiChange = Number(preMarket.nikkeiFuturesChangeRate)
    if (nikkeiChange <= triggers.NIKKEI_CRASH_RATE) {
      return {
        triggered: true,
        type: "nikkei_crash",
        value: nikkeiChange,
        description: `日経225先物が前日比${nikkeiChange.toFixed(1)}%の暴落`,
      }
    }
  }

  return null
}

// ── Shield 操作 ──

/**
 * マーケットシールドを発動
 */
export async function activateMarketShield(
  triggerType: string,
  triggerValue: number,
): Promise<{ id: string }> {
  // アクティブユーザー数を取得
  const activeUserCount = await prisma.user.count({
    where: {
      portfolioStocks: { some: {} },
    },
  })

  const shield = await prisma.marketShield.create({
    data: {
      activatedAt: new Date(),
      triggerType,
      triggerValue,
      affectedUsers: activeUserCount,
      actionsApplied: {
        buyFreeze: true,
        exitLineRaised: true,
        atrMultiplier: MARKET_SHIELD.SHIELD_ATR_MULTIPLIER,
      },
    },
  })

  console.log(`⚠️ マーケットシールド発動: ${triggerType} = ${triggerValue} | 影響ユーザー: ${activeUserCount}`)

  return { id: shield.id }
}

/**
 * マーケットシールドを解除
 */
export async function deactivateMarketShield(shieldId: string): Promise<void> {
  await prisma.marketShield.update({
    where: { id: shieldId },
    data: { deactivatedAt: new Date() },
  })
  console.log(`✅ マーケットシールド解除: ${shieldId}`)
}

/**
 * アクティブなShieldを取得（未解除のもの）
 */
export async function getActiveShield(): Promise<ActiveShield | null> {
  const shield = await prisma.marketShield.findFirst({
    where: { deactivatedAt: null },
    orderBy: { activatedAt: "desc" },
  })
  if (!shield) return null

  return {
    id: shield.id,
    activatedAt: shield.activatedAt,
    triggerType: shield.triggerType,
    triggerValue: shield.triggerValue,
    actionsApplied: shield.actionsApplied,
  }
}

/**
 * マーケットシールドがアクティブかどうかを確認
 */
export async function isMarketShieldActive(): Promise<boolean> {
  const shield = await getActiveShield()
  return shield !== null
}

/**
 * morningセッション開始時の自動解除チェック
 * 前日以前にアクティブ化されたShieldを解除する
 */
export async function autoDeactivateExpiredShields(): Promise<void> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const expiredShields = await prisma.marketShield.findMany({
    where: {
      deactivatedAt: null,
      activatedAt: { lt: today },
    },
  })

  for (const shield of expiredShields) {
    await deactivateMarketShield(shield.id)
  }

  if (expiredShields.length > 0) {
    console.log(`✅ ${expiredShields.length}件の期限切れマーケットシールドを自動解除`)
  }
}
