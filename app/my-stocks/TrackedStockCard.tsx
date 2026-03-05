"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { getActionButtonClass, ACTION_BUTTON_LABELS, CARD_FOOTER_STYLES } from "@/lib/ui-config"
import { FETCH_FAIL_WARNING_THRESHOLD, EARNINGS_DATE_BADGE } from "@/lib/constants"
import dayjs from "dayjs"
import timezone from "dayjs/plugin/timezone"
import utc from "dayjs/plugin/utc"

dayjs.extend(utc)
dayjs.extend(timezone)
import DelistedWarning from "@/app/components/DelistedWarning"
import CopyableTicker from "@/app/components/CopyableTicker"

interface TrackedStock {
  id: string
  stockId: string
  stock: {
    id: string
    tickerCode: string
    name: string
    sector: string | null
    market: string
    fetchFailCount?: number
    isDelisted?: boolean
    nextEarningsDate?: string | null
  }
  currentPrice: number | null
  change: number | null
  changePercent: number | null
  marketTime: number | null
  createdAt: string
}

interface Signal {
  signal: "buy" | "sell" | "neutral"
  strength: number
}

interface TrackedStockCardProps {
  trackedStock: TrackedStock
  isStale?: boolean
  priceLoaded?: boolean
  onMoveToWatchlist: (stockId: string, tickerCode: string, name: string) => void
  onPurchase: (stockId: string, tickerCode: string, name: string, market: string, sector: string | null) => void
  onDelete?: (trackedStockId: string) => void
}

export default function TrackedStockCard({ trackedStock, isStale = false, priceLoaded = false, onMoveToWatchlist, onPurchase, onDelete }: TrackedStockCardProps) {
  const { stock, currentPrice, changePercent } = trackedStock
  const t = useTranslations("portfolio.trackedStockCard")
  const [signal, setSignal] = useState<Signal | null>(null)

  // Fetch signal asynchronously
  useEffect(() => {
    async function fetchSignal() {
      try {
        const response = await fetch(`/api/stocks/${trackedStock.stockId}/historical-prices?period=1m`)
        if (!response.ok) return
        const data = await response.json()
        if (data.patterns?.combined) {
          setSignal({
            signal: data.patterns.combined.signal,
            strength: data.patterns.combined.strength,
          })
        }
      } catch (err) {
        console.error("Error fetching signal:", err)
      }
    }

    fetchSignal()
  }, [trackedStock.stockId])

  // 決算発表日バッジを計算
  const getEarningsBadge = (nextEarningsDate: string | null | undefined) => {
    if (!nextEarningsDate) return null
    const today = dayjs().tz("Asia/Tokyo").startOf("day")
    const earningsDay = dayjs(nextEarningsDate).tz("Asia/Tokyo").startOf("day")
    const daysUntil = earningsDay.diff(today, "day")
    if (daysUntil < 0 || daysUntil > EARNINGS_DATE_BADGE.INFO_DAYS) return null
    if (daysUntil <= EARNINGS_DATE_BADGE.URGENT_DAYS) {
      return { text: daysUntil === 0 ? t("earningsToday") : t("earningsDaysAway", { days: daysUntil }), color: "text-red-700", bg: "bg-red-100", border: "border-red-200" }
    }
    if (daysUntil <= EARNINGS_DATE_BADGE.WARNING_DAYS) {
      return { text: t("earningsDaysAway", { days: daysUntil }), color: "text-yellow-700", bg: "bg-yellow-100", border: "border-yellow-200" }
    }
    return { text: t("earningsDaysAway", { days: daysUntil }), color: "text-gray-600", bg: "bg-gray-100", border: "border-gray-200" }
  }

  // staleまたはデータ取得不可の銘柄は詳細遷移・バッジを無効化
  const isDisabled = isStale || stock.isDelisted === true
  // 価格未取得時もリンクを無効化（stale判定が終わるまで遷移させない）
  const linkDisabled = isDisabled || !priceLoaded

  return (
    <div
      className={`relative bg-white rounded-xl shadow-md transition-all p-4 sm:p-6 ${isDisabled ? "opacity-60" : "hover:shadow-lg hover:bg-gray-50"}`}
    >
      {/* シグナルバッジ - 右上（無効化時は非表示） */}
      {signal && !isDisabled && (
        <span
          className={`absolute top-3 right-3 sm:top-4 sm:right-4 px-2 py-0.5 rounded-full text-xs font-semibold ${
            signal.signal === "buy"
              ? "bg-green-100 text-green-700"
              : signal.signal === "sell"
                ? "bg-red-100 text-red-700"
                : "bg-gray-100 text-gray-700"
          }`}
        >
          {signal.signal === "buy" && t("buySignal")}
          {signal.signal === "sell" && t("sellSignal")}
          {signal.signal === "neutral" && t("neutral")}
        </span>
      )}

      {/* 決算発表日バッジ（無効化時は非表示） */}
      {!isDisabled && (() => {
        const badge = getEarningsBadge(stock.nextEarningsDate)
        if (!badge) return null
        return (
          <div className="mb-2">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${badge.bg} ${badge.color} ${badge.border}`}>
              📅 {badge.text}
            </span>
          </div>
        )
      })()}

      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="pr-24">
          <h3 className="text-lg sm:text-xl font-bold text-gray-900">
            {stock.name}
          </h3>
          <p className="text-xs sm:text-sm text-gray-500">
            <CopyableTicker tickerCode={stock.tickerCode} />
            {stock.sector && ` • ${stock.sector}`}
          </p>
        </div>
      </div>

      {/* Delisted Warning */}
      {(stock.isDelisted || stock.delistingNewsDetectedAt || (stock.fetchFailCount ?? 0) >= FETCH_FAIL_WARNING_THRESHOLD) && (
        <div className="mb-3">
          <DelistedWarning
            isDelisted={stock.isDelisted ?? false}
            fetchFailCount={stock.fetchFailCount ?? 0}
            delistingNewsDetectedAt={stock.delistingNewsDetectedAt}
            delistingNewsReason={stock.delistingNewsReason}
            compact
          />
        </div>
      )}

      {/* Price Info */}
      <div className="mb-4">
        {stock.isDelisted && (
          <span className="text-xs text-gray-500 mb-1 block">{t("lastPrice")}</span>
        )}
        {currentPrice ? (
          <div>
            <div className="flex items-baseline gap-3">
              <span className={`text-2xl font-bold ${stock.isDelisted ? "text-gray-400" : "text-gray-900"}`}>
                ¥{currentPrice.toLocaleString()}
              </span>
              {!stock.isDelisted && changePercent !== null && (
                <span className={`text-sm font-semibold ${changePercent >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {changePercent >= 0 ? "+" : ""}{changePercent.toFixed(2)}%
                </span>
              )}
            </div>
            {trackedStock.marketTime && (
              <p className="text-[10px] text-gray-400 mt-0.5">
                {new Date(trackedStock.marketTime * 1000).toLocaleString("ja-JP", {
                  month: "numeric",
                  day: "numeric",
                })}
                {t("asOf")}
              </p>
            )}
          </div>
        ) : isStale ? (
          <span className="text-xs text-amber-600">{t("priceUnavailable")}<br />{t("priceUnavailableDetail")}</span>
        ) : (
          <span className="text-sm text-gray-400">{t("loadingPrice")}</span>
        )}
      </div>

      {/* Footer: Actions + Detail Link */}
      <div className={CARD_FOOTER_STYLES.containerLarge}>
        {/* Action Buttons */}
        <div className={CARD_FOOTER_STYLES.actionGroup}>
          {!isDisabled && (
            <>
              <button
                onClick={() => onMoveToWatchlist(stock.id, stock.tickerCode, stock.name)}
                className={getActionButtonClass("watchlist")}
              >
                {ACTION_BUTTON_LABELS.watchlist}
              </button>
              <button
                onClick={() => onPurchase(stock.id, stock.tickerCode, stock.name, stock.market, stock.sector)}
                className={getActionButtonClass("purchase")}
              >
                {ACTION_BUTTON_LABELS.purchase}
              </button>
            </>
          )}
          {isDisabled && onDelete && (
            <button
              onClick={() => onDelete(trackedStock.id)}
              className="px-2 py-1 text-xs font-medium rounded transition-colors text-red-600 hover:bg-red-50"
            >
              {t("delete")}
            </button>
          )}
        </div>

        {/* Detail Link */}
        {linkDisabled ? (
          <div className="flex items-center text-gray-300 ml-auto">
            <span className="text-xs text-gray-300">{t("viewDetails")}</span>
            <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        ) : (
          <Link href={`/stocks/${trackedStock.stockId}`} className={CARD_FOOTER_STYLES.detailLink}>
            <span className={CARD_FOOTER_STYLES.detailLinkText}>{t("viewDetails")}</span>
            <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        )}
      </div>
    </div>
  )
}
