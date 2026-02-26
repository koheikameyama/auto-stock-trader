"use client"

import { useState, useEffect } from "react"
import { useTranslations } from "next-intl"
import type { MarketNavigatorResult, MarketTone, PortfolioStatus, NavigatorSession } from "@/lib/portfolio-overall-analysis"
import { DAILY_MARKET_NAVIGATOR } from "@/lib/constants"
import CopyableTicker from "@/app/components/CopyableTicker"

interface Props {
  portfolioCount: number
  watchlistCount: number
}

const toneStyles: Record<string, { bg: string; text: string; border: string }> = {
  bullish: { bg: "bg-green-50", text: "text-green-700", border: "border-green-200" },
  bearish: { bg: "bg-red-50", text: "text-red-700", border: "border-red-200" },
  neutral: { bg: "bg-gray-50", text: "text-gray-700", border: "border-gray-200" },
  sector_rotation: { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" },
}

const statusStyles: Record<string, { bg: string; text: string; border: string }> = {
  healthy: { bg: "bg-green-100", text: "text-green-800", border: "border-l-green-500" },
  caution: { bg: "bg-amber-100", text: "text-amber-800", border: "border-l-amber-500" },
  warning: { bg: "bg-orange-100", text: "text-orange-800", border: "border-l-orange-500" },
  critical: { bg: "bg-red-100", text: "text-red-800", border: "border-l-red-500" },
}

function formatChangeRate(rate: number): { text: string; color: string } {
  const sign = rate >= 0 ? "+" : ""
  return {
    text: `${sign}${rate.toFixed(1)}%`,
    color: rate > 0 ? "text-green-600" : rate < 0 ? "text-red-600" : "text-gray-600",
  }
}

function getCurrentSessionFromTime(): NavigatorSession {
  const jstHour = parseInt(
    new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Tokyo" })
  )
  return jstHour >= DAILY_MARKET_NAVIGATOR.EVENING_SESSION_START_HOUR ? "evening" : "morning"
}

function SessionTabs({
  activeSession,
  onSessionChange,
  t,
}: {
  activeSession: NavigatorSession
  onSessionChange: (session: NavigatorSession) => void
  t: (key: string) => string
}) {
  return (
    <div className="flex gap-1 p-1 bg-gray-100 rounded-lg mb-3">
      <button
        onClick={() => onSessionChange("morning")}
        className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
          activeSession === "morning"
            ? "bg-white text-blue-700 shadow-sm"
            : "text-gray-500 hover:text-gray-700"
        }`}
      >
        🧭 {t("session.morning")}
      </button>
      <button
        onClick={() => onSessionChange("evening")}
        className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
          activeSession === "evening"
            ? "bg-white text-indigo-700 shadow-sm"
            : "text-gray-500 hover:text-gray-700"
        }`}
      >
        🌙 {t("session.evening")}
      </button>
    </div>
  )
}

function Skeleton() {
  return (
    <div className="mb-6 bg-white rounded-xl p-4 shadow-sm border border-gray-200">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-6 h-6 rounded bg-gray-200 animate-pulse" />
        <div className="h-5 w-48 bg-gray-200 rounded animate-pulse" />
      </div>
      <div className="space-y-3">
        <div className="h-20 bg-gray-200 rounded-lg animate-pulse" />
        <div className="h-16 bg-gray-200 rounded-lg animate-pulse" />
        <div className="h-14 bg-gray-200 rounded-lg animate-pulse" />
      </div>
    </div>
  )
}

export default function DailyMarketNavigator({
  portfolioCount,
  watchlistCount,
}: Props) {
  const t = useTranslations("dashboard.marketNavigator")
  const [activeSession, setActiveSession] = useState<NavigatorSession>(getCurrentSessionFromTime)
  const [data, setData] = useState<MarketNavigatorResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [showDetails, setShowDetails] = useState(false)

  const totalCount = portfolioCount + watchlistCount

  useEffect(() => {
    if (totalCount < DAILY_MARKET_NAVIGATOR.MIN_STOCKS) {
      setLoading(false)
      return
    }

    const fetchData = async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/portfolio/overall-analysis?session=${activeSession}`)
        const result = await res.json()
        setData(result)
      } catch (error) {
        console.error("Error fetching market navigator data:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [totalCount, activeSession])

  // Not enough stocks
  if (totalCount < DAILY_MARKET_NAVIGATOR.MIN_STOCKS) {
    return (
      <div className="mb-6 bg-gradient-to-r from-gray-50 to-slate-50 rounded-xl p-4 border border-gray-200">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
            <span className="text-xl">🧭</span>
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-gray-900 mb-1">
              {t("title")}
            </div>
            <p className="text-xs text-gray-600">
              {t("minStocksRequired")}
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Loading
  if (loading) {
    return <Skeleton />
  }

  const sessionIcon = activeSession === "evening" ? "🌙" : "🧭"

  // No analysis yet
  if (!data?.hasAnalysis) {
    return (
      <div className="mb-6 bg-gradient-to-r from-gray-50 to-slate-50 rounded-xl p-4 border border-gray-200">
        <SessionTabs activeSession={activeSession} onSessionChange={setActiveSession} t={t} />
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
            <span className="text-xl">{sessionIcon}</span>
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-gray-900 mb-1">
              {t("title")}
            </div>
            <p className="text-xs text-gray-600">
              {activeSession === "evening" ? t("noEveningAnalysis") : t("noAnalysis")}
            </p>
          </div>
        </div>
      </div>
    )
  }

  const tone = data.market?.tone || "neutral"
  const status = data.portfolio?.status || "caution"
  const toneStyle = toneStyles[tone] || toneStyles.neutral
  const statusStyle = statusStyles[status] || statusStyles.caution

  return (
    <div className="mb-6 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Session tabs */}
      <div className="p-4 pb-3">
        <SessionTabs activeSession={activeSession} onSessionChange={setActiveSession} t={t} />
      </div>

      {/* Section 1: Market */}
      <div className={`p-4 pt-0 ${toneStyle.bg} border-b ${toneStyle.border}`}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg">{sessionIcon}</span>
          <span className="text-xs font-semibold text-gray-500">
            {t(`session.${activeSession}`)}
          </span>
          <span
            className={`ml-auto px-2 py-0.5 rounded-full text-xs font-semibold ${toneStyle.bg} ${toneStyle.text} border ${toneStyle.border}`}
          >
            {t(`tone.${tone}` as `tone.${MarketTone}`)}
          </span>
        </div>
        <p className="text-sm sm:text-base font-bold text-gray-900 mb-1">
          {data.market?.headline}
        </p>
        <p className="text-xs text-gray-600">
          {data.market?.keyFactor}
        </p>
      </div>

      {/* Section 2: Portfolio */}
      <div className={`p-4 border-l-4 ${statusStyle.border}`}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-semibold text-gray-500">
            {t("portfolioSection")}
          </span>
          <span
            className={`px-2 py-0.5 rounded-full text-xs font-semibold ${statusStyle.bg} ${statusStyle.text}`}
          >
            {t(`status.${status}` as `status.${PortfolioStatus}`)}
          </span>
        </div>
        <p className="text-sm text-gray-700 mb-2">
          {data.portfolio?.summary}
        </p>
        <div className="flex items-start gap-1.5 text-xs text-blue-700 bg-blue-50 rounded p-2">
          <span className="shrink-0 font-semibold">{t("actionPlanLabel")}:</span>
          <span>{data.portfolio?.actionPlan}</span>
        </div>
      </div>

      {/* Section 3: Buddy Message */}
      {data.buddyMessage && (
        <div className="px-4 pb-4">
          <div className="bg-purple-50 rounded-2xl p-3 mt-1">
            <div className="flex items-start gap-2">
              <span className="text-base shrink-0 mt-0.5">💬</span>
              <p className="text-sm text-gray-700">
                {data.buddyMessage}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Toggle details button */}
      {data.details && (data.details.stockHighlights.length > 0 || data.details.sectorHighlights.length > 0) && (
        <div className="px-4 pb-3">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
          >
            <svg
              className={`w-3.5 h-3.5 transition-transform ${showDetails ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            {showDetails ? t("hideDetails") : t("showDetails")}
          </button>
        </div>
      )}

      {/* Section 4: Details (collapsible) */}
      {showDetails && data.details && (
        <div className="px-4 pb-4 space-y-4">
          {/* Stock highlights */}
          {data.details.stockHighlights.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-500 mb-2">
                {t("stockHighlights")}
              </div>
              <div className="space-y-2">
                {data.details.stockHighlights.map((stock) => {
                  const daily = formatChangeRate(stock.dailyChangeRate)
                  const weekly = formatChangeRate(stock.weekChangeRate)
                  return (
                    <div key={stock.tickerCode} className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900">{stock.stockName}</span>
                          <span className="text-xs text-gray-400">(<CopyableTicker tickerCode={stock.tickerCode} />)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-bold ${daily.color}`}>{daily.text}</span>
                          <span className={`text-xs ${weekly.color}`}>{t("weekChange")} {weekly.text}</span>
                        </div>
                      </div>
                      <p className="text-xs text-gray-600">{stock.analysis}</p>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Sector highlights */}
          {data.details.sectorHighlights.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-500 mb-2">
                {t("sectorHighlights")}
              </div>
              <div className="flex flex-wrap gap-2">
                {data.details.sectorHighlights.map((sector) => {
                  const change = formatChangeRate(sector.avgDailyChange)
                  const arrow = sector.trendDirection === "up" ? "▲" : sector.trendDirection === "down" ? "▼" : "▶"
                  return (
                    <div key={sector.sector} className="bg-gray-50 rounded-lg px-3 py-2 border border-gray-100 flex-1 min-w-[140px]">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-gray-900">{sector.sector}</span>
                        <span className={`text-xs font-bold ${change.color}`}>{arrow} {change.text}</span>
                      </div>
                      <p className="text-[10px] text-gray-500">{sector.commentary}</p>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer: analyzed at */}
      {data.analyzedAt && (
        <div className="px-4 pb-3 pt-1 border-t border-gray-100">
          <div className="text-[10px] text-gray-400">
            {new Date(data.analyzedAt).toLocaleString("ja-JP", {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        </div>
      )}
    </div>
  )
}
