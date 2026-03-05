"use client"

import { useState, useEffect } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import type { MarketNavigatorResult, MarketTone, PortfolioStatus, EveningReview } from "@/lib/portfolio-overall-analysis"
import CopyableTicker from "@/app/components/CopyableTicker"
import MarketShieldBanner from "./MarketShieldBanner"
import SwitchProposalCard from "./SwitchProposalCard"

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


const evaluationStyles: Record<string, { bg: string; text: string }> = {
  excellent: { bg: "bg-green-100", text: "text-green-700" },
  good: { bg: "bg-blue-100", text: "text-blue-700" },
  neutral: { bg: "bg-gray-100", text: "text-gray-700" },
  questionable: { bg: "bg-orange-100", text: "text-orange-700" },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function EveningReviewSection({ review, t }: { review: EveningReview; t: any }) {
  const hasTradeReviewContent = review.tradeReview.trades.length > 0
  const hasMissedOpportunities = review.missedOpportunities.stocks.length > 0

  return (
    <div className="px-4 pb-4 space-y-3">
      {/* 売買判断の振り返り */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm">📋</span>
          <span className="text-xs font-semibold text-gray-500">
            {t("eveningReview.tradeReviewTitle")}
          </span>
        </div>
        <p className="text-sm text-gray-700 mb-2">{review.tradeReview.summary}</p>
        {hasTradeReviewContent && (
          <div className="space-y-2">
            {review.tradeReview.trades.map((trade) => {
              const evalStyle = evaluationStyles[trade.evaluation] || evaluationStyles.neutral
              return (
                <div key={`${trade.tickerCode}-${trade.action}`} className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-900">{trade.stockName}</span>
                    <span className="text-xs text-gray-400">(<CopyableTicker tickerCode={trade.tickerCode} />)</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                      trade.action === "buy" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                    }`}>
                      {t(`eveningReview.action.${trade.action}`)}
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${evalStyle.bg} ${evalStyle.text}`}>
                      {t(`eveningReview.evaluation.${trade.evaluation}`)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600">{trade.comment}</p>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 機会損失の指摘 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm">💡</span>
          <span className="text-xs font-semibold text-gray-500">
            {t("eveningReview.missedOpportunitiesTitle")}
          </span>
        </div>
        <p className="text-sm text-gray-700 mb-2">{review.missedOpportunities.summary}</p>
        {hasMissedOpportunities && (
          <div className="space-y-2">
            {review.missedOpportunities.stocks.map((stock) => {
              const change = formatChangeRate(stock.dailyChangeRate)
              return (
                <div key={stock.tickerCode} className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-900">{stock.stockName}</span>
                    <span className="text-xs text-gray-400">(<CopyableTicker tickerCode={stock.tickerCode} />)</span>
                    <span className={`text-sm font-bold ${change.color}`}>{change.text}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-yellow-100 text-yellow-700">
                      {t(`eveningReview.source${stock.source === "watchlist" ? "Watchlist" : "Recommendation"}`)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600">{stock.comment}</p>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 行動パターンの改善提案 */}
      <div className="bg-amber-50 rounded-lg p-3 border border-amber-100">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm">🎯</span>
          <span className="text-xs font-semibold text-gray-500">
            {t("eveningReview.improvementTitle")}
          </span>
        </div>
        <p className="text-sm text-gray-800 font-medium mb-1">{review.improvementSuggestion.pattern}</p>
        <p className="text-xs text-gray-700 mb-2">{review.improvementSuggestion.suggestion}</p>
        <p className="text-xs text-amber-700 italic">{review.improvementSuggestion.encouragement}</p>
      </div>
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
  const [data, setData] = useState<MarketNavigatorResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [showDetails, setShowDetails] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [shieldData, setShieldData] = useState<{ active: boolean; shield: any } | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [switchProposals, setSwitchProposals] = useState<any[]>([])

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true)
      try {
        const [analysisRes, shieldRes, switchRes] = await Promise.all([
          fetch("/api/portfolio/overall-analysis"),
          fetch("/api/market-shield"),
          fetch("/api/switch-proposals"),
        ])
        const result = await analysisRes.json()
        setData(result)
        if (shieldRes.ok) {
          const shield = await shieldRes.json()
          setShieldData(shield)
        }
        if (switchRes.ok) {
          const sw = await switchRes.json()
          setSwitchProposals(sw.proposals || [])
        }
      } catch (error) {
        console.error("Error fetching market navigator data:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  // Loading
  if (loading) {
    return <Skeleton />
  }

  const displaySession = data?.session ?? "morning"
  const sessionIcon = displaySession === "evening" ? "🌙" : displaySession === "pre-afternoon" ? "📊" : "🧭"
  const hasPortfolio = data?.hasPortfolio ?? (portfolioCount > 0)

  // No analysis yet
  if (!data?.hasAnalysis) {
    return (
      <div className="mb-6 bg-gradient-to-r from-gray-50 to-slate-50 rounded-xl p-4 border border-gray-200">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
            <span className="text-xl">{sessionIcon}</span>
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-gray-900 mb-1">
              {t("title")}
            </div>
            <p className="text-xs text-gray-600">
              {displaySession === "evening" ? t("noEveningAnalysis") : t("noAnalysis")}
            </p>
          </div>
        </div>
      </div>
    )
  }

  const tone = data.market?.tone || "neutral"
  const status = data.portfolio?.status || "caution"
  const toneStyle = toneStyles[tone] || toneStyles.neutral
  const statusStyle = hasPortfolio ? (statusStyles[status] || statusStyles.caution) : statusStyles.healthy

  const hasDetails = data.details && (
    data.details.stockHighlights.length > 0 ||
    data.details.sectorHighlights.length > 0
  )

  return (
    <div className="mb-6 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Market Shield Banner */}
      {shieldData?.active && shieldData.shield && (
        <div className="p-3 pb-0">
          <MarketShieldBanner
            triggerType={shieldData.shield.triggerType}
            triggerValue={shieldData.shield.triggerValue}
          />
        </div>
      )}

      {/* Section 1: Market */}
      <div className={`p-4 pt-0 ${toneStyle.bg} border-b ${toneStyle.border}`}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg">{sessionIcon}</span>
          <span className="text-xs font-semibold text-gray-500">
            {t(`session.${displaySession}`)}
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

      {/* Section 2: Portfolio / Investment Guide */}
      <div className={`p-4 border-l-4 ${statusStyle.border}`}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-semibold text-gray-500">
            {hasPortfolio ? t("portfolioSection") : t("investmentGuide")}
          </span>
          {hasPortfolio && (
            <span
              className={`px-2 py-0.5 rounded-full text-xs font-semibold ${statusStyle.bg} ${statusStyle.text}`}
            >
              {t(`status.${status}` as `status.${PortfolioStatus}`)}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-700 mb-2">
          {data.portfolio?.summary}
        </p>
        <div className="flex flex-col sm:flex-row sm:items-start gap-0.5 sm:gap-1.5 text-xs text-blue-700 bg-blue-50 rounded p-2">
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

      {/* Switch Proposals */}
      {switchProposals.length > 0 && (
        <div className="px-4 pb-3">
          <SwitchProposalCard proposals={switchProposals} />
        </div>
      )}

      {/* Section: Evening Review */}
      {displaySession === "evening" && data.eveningReview && (
        <EveningReviewSection review={data.eveningReview} t={t} />
      )}

      {/* Toggle details button */}
      {hasDetails && (
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
                  const linkHref = stock.userStockId
                    ? `/my-stocks/${stock.userStockId}`
                    : stock.stockId
                      ? `/stocks/${stock.stockId}`
                      : null
                  const CardWrapper = linkHref
                    ? ({ children, className }: { children: React.ReactNode; className: string }) => (
                        <Link href={linkHref} className={`${className} hover:bg-gray-100 transition-colors`}>
                          {children}
                        </Link>
                      )
                    : ({ children, className }: { children: React.ReactNode; className: string }) => (
                        <div className={className}>{children}</div>
                      )
                  return (
                    <CardWrapper key={stock.tickerCode} className="block bg-gray-50 rounded-lg p-3 border border-gray-100">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900">{stock.stockName}</span>
                          <span className="text-xs text-gray-400">(<CopyableTicker tickerCode={stock.tickerCode} />)</span>
                          {stock.source && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                              stock.source === "portfolio"
                                ? "bg-blue-100 text-blue-700"
                                : "bg-yellow-100 text-yellow-700"
                            }`}>
                              {stock.source === "portfolio" ? t("sourcePortfolio") : t("sourceWatchlist")}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-bold ${daily.color}`}>{daily.text}</span>
                          <span className={`text-xs ${weekly.color}`}>{t("weekChange")} {weekly.text}</span>
                        </div>
                      </div>
                      <p className="text-xs text-gray-600">{stock.analysis}</p>
                    </CardWrapper>
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
                      {sector.watchlistStocks && sector.watchlistStocks.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {sector.watchlistStocks.map(ws => (
                            <span key={ws.tickerCode} className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-50 text-yellow-700 border border-yellow-200">
                              {ws.stockName}
                            </span>
                          ))}
                        </div>
                      )}
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
