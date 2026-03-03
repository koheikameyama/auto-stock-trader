"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import {
  UPDATE_SCHEDULES,
  FETCH_FAIL_WARNING_THRESHOLD,
  PURCHASE_JUDGMENT_CONFIG,
  MARKET_SIGNAL_CONFIG,
  INVESTMENT_STYLE_CONFIG,
} from "@/lib/constants"
import { CARD_FOOTER_STYLES } from "@/lib/ui-config"
import StockActionButtons from "@/app/components/StockActionButtons"
import CopyableTicker from "@/app/components/CopyableTicker"
import StaleAnalysisBanner from "@/app/components/StaleAnalysisBanner"
import { useTranslations } from "next-intl"

interface TopStock {
  id: string
  stockId: string
  confidence: number
  reason: string
  caution: string
  advice: string
  marketSignal: string | null
  isOwned: boolean
  isRegistered: boolean
  isTracked: boolean
  userStockId: string | null
  stock: {
    id: string
    tickerCode: string
    name: string
    sector: string | null
    currentPrice: number | null
    marketTime: number | null
    isProfitable: boolean | null
    volatility: number | null
    weekChangeRate: number | null
    fetchFailCount?: number
    isDelisted?: boolean
    isStale?: boolean
  }
}

export default function TopStocksByStyle() {
  const t = useTranslations("dashboard.topStocks")
  const [stocks, setStocks] = useState<TopStock[]>([])
  const [investmentStyle, setInvestmentStyle] = useState<string | null>(null)
  const [pricesLoaded, setPricesLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [analysisDate, setAnalysisDate] = useState<string | null>(null)

  useEffect(() => {
    fetchTopStocks()
  }, [])

  const fetchPrices = async (topStocks: TopStock[]) => {
    if (topStocks.length === 0) return

    const tickerCodes = topStocks.map((s) => s.stock.tickerCode)
    try {
      const response = await fetch(
        `/api/stocks/prices?tickers=${tickerCodes.join(",")}`
      )
      if (!response.ok) return

      const data = await response.json()
      const priceMap = new Map<
        string,
        { currentPrice: number; marketTime: number | null }
      >(
        data.prices?.map(
          (p: {
            tickerCode: string
            currentPrice: number
            marketTime: number | null
          }) => [
            p.tickerCode,
            { currentPrice: p.currentPrice, marketTime: p.marketTime },
          ]
        ) || []
      )
      const staleTickers = new Set<string>(data.staleTickers || [])

      setStocks((prev) =>
        prev.map((s) => {
          const priceData = priceMap.get(s.stock.tickerCode)
          return {
            ...s,
            stock: {
              ...s.stock,
              currentPrice:
                priceData?.currentPrice ?? s.stock.currentPrice,
              marketTime:
                priceData?.marketTime ?? s.stock.marketTime,
              isStale: staleTickers.has(s.stock.tickerCode),
            },
          }
        })
      )
      setPricesLoaded(true)
    } catch (error) {
      console.error("Error fetching prices:", error)
      setPricesLoaded(true)
    }
  }

  const fetchTopStocks = async () => {
    try {
      setLoading(true)
      const response = await fetch("/api/top-stocks")
      const data = await response.json()

      if (response.ok) {
        const topStocks = (data.stocks || []).map((s: TopStock) => ({
          ...s,
          stock: { ...s.stock, marketTime: null, isStale: false },
        }))
        setStocks(topStocks)
        setInvestmentStyle(data.investmentStyle || null)
        setAnalysisDate(data.date || null)

        fetchPrices(topStocks)
      } else {
        console.error("Error fetching top stocks:", data.error)
      }
    } catch (error) {
      console.error("Error fetching top stocks:", error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="bg-white rounded-xl p-4 sm:p-6 shadow-md">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xl sm:text-2xl">🏆</span>
          <h3 className="text-lg sm:text-xl font-bold text-gray-900">
            {t("title")}
          </h3>
        </div>
        <p className="text-xs sm:text-sm text-gray-500">{t("loading")}</p>
      </div>
    )
  }

  // 投資スタイル未設定、またはデータなし
  if (!investmentStyle || stocks.length === 0) {
    return null
  }

  const styleConfig = INVESTMENT_STYLE_CONFIG[investmentStyle]

  const updateStockStatus = (
    stockId: string,
    type: "watchlist" | "tracked"
  ) => {
    setStocks((prev) =>
      prev.map((s) =>
        s.stockId === stockId
          ? {
              ...s,
              isRegistered: type === "watchlist",
              isTracked: type === "tracked",
            }
          : s
      )
    )
  }

  const renderStockCard = (stock: TopStock) => {
    const isDisabled =
      stock.stock.isDelisted === true || stock.stock.isStale === true
    const linkDisabled = isDisabled || !pricesLoaded

    return (
      <div
        key={stock.id}
        className={`relative flex-shrink-0 w-64 sm:w-72 bg-white rounded-lg p-3 sm:p-4 border-2 border-emerald-200 bg-emerald-50 transition-shadow ${isDisabled ? "opacity-60" : "hover:shadow-md"}`}
      >
        {/* バッジ - 右上 */}
        <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
          {stock.isOwned ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800">
              {t("owned")}
            </span>
          ) : stock.isRegistered ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">
              {t("interested")}
            </span>
          ) : stock.isTracked ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-800">
              {t("tracked")}
            </span>
          ) : null}
        </div>

        <div className="mb-2 sm:mb-3">
          <div className="flex items-start justify-between mb-1">
            <div className="flex-1 min-w-0 pr-14">
              <h4 className="text-sm sm:text-base font-bold text-gray-900 truncate mb-1">
                {stock.stock.name}
              </h4>
              <div className="flex items-center gap-1.5 sm:gap-2 text-xs text-gray-500">
                <CopyableTicker tickerCode={stock.stock.tickerCode} />
                {stock.stock.sector && (
                  <>
                    <span>•</span>
                    <span className="truncate">{stock.stock.sector}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="mt-1.5 sm:mt-2">
            <div className="text-base sm:text-lg font-bold text-gray-900">
              {stock.stock.currentPrice != null ? (
                `¥${stock.stock.currentPrice.toLocaleString()}`
              ) : stock.stock.isStale ? (
                <span className="text-amber-600 text-xs">
                  {t("priceUnavailable")}
                </span>
              ) : (
                <span className="text-gray-400 text-sm">
                  {t("priceFetching")}
                </span>
              )}
            </div>
            {stock.stock.marketTime && (
              <p className="text-[10px] text-gray-400">
                {new Date(stock.stock.marketTime * 1000).toLocaleString(
                  "ja-JP",
                  {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }
                )}
                {t("asOf")}
              </p>
            )}
          </div>
        </div>

        {/* 買い推奨バッジ + confidence */}
        {!isDisabled && (
          <div className="mb-1.5 flex items-center gap-1.5">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${PURCHASE_JUDGMENT_CONFIG["buy"].bg} ${PURCHASE_JUDGMENT_CONFIG["buy"].color}`}
            >
              {PURCHASE_JUDGMENT_CONFIG["buy"].text}
            </span>
            <span className="text-[11px] text-gray-500">
              {t("confidence", {
                value: Math.round(stock.confidence * 100),
              })}
            </span>
          </div>
        )}

        {/* 市場シグナル */}
        {!isDisabled &&
          stock.marketSignal &&
          MARKET_SIGNAL_CONFIG[stock.marketSignal] && (
            <div className="mb-1.5">
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${MARKET_SIGNAL_CONFIG[stock.marketSignal].bg} ${MARKET_SIGNAL_CONFIG[stock.marketSignal].color}`}
              >
                <span>{MARKET_SIGNAL_CONFIG[stock.marketSignal].icon}</span>
                {MARKET_SIGNAL_CONFIG[stock.marketSignal].text}
              </span>
            </div>
          )}

        {!isDisabled && stock.reason && (
          <div className="mb-2 sm:mb-3 p-2.5 rounded-lg bg-gray-50 border border-gray-200">
            <p className="text-xs text-gray-700 leading-relaxed line-clamp-3">
              {stock.reason}
            </p>
          </div>
        )}

        {/* 上場廃止警告 */}
        {(stock.stock.isDelisted ||
          (stock.stock.fetchFailCount ?? 0) >=
            FETCH_FAIL_WARNING_THRESHOLD) && (
          <div className="mb-2 sm:mb-3 p-2 rounded-lg bg-red-50 border border-red-200">
            <p className="text-xs text-red-700">
              {stock.stock.isDelisted
                ? t("delisted")
                : t("possiblyDelisted")}
            </p>
          </div>
        )}

        {/* リスク情報 */}
        {!isDisabled &&
          (stock.stock.isProfitable === false ||
            (stock.stock.volatility != null &&
              stock.stock.volatility > 50) ||
            (stock.stock.weekChangeRate != null &&
              stock.stock.weekChangeRate < -15)) && (
            <div className="mb-2 sm:mb-3 p-2 rounded-lg bg-amber-50 border border-amber-200">
              <div className="flex items-start gap-1.5">
                <span className="text-amber-500 text-xs mt-0.5">⚠️</span>
                <div className="text-xs text-amber-700 space-y-0.5">
                  {stock.stock.isProfitable === false && (
                    <p>{t("riskUnprofitable")}</p>
                  )}
                  {stock.stock.volatility != null &&
                    stock.stock.volatility > 50 && (
                      <p>
                        {t("riskHighVolatility", {
                          value: stock.stock.volatility.toFixed(1),
                        })}
                      </p>
                    )}
                  {stock.stock.weekChangeRate != null &&
                    stock.stock.weekChangeRate < -15 && (
                      <p>
                        {t("riskWeekDecline", {
                          value: stock.stock.weekChangeRate.toFixed(1),
                        })}
                      </p>
                    )}
                </div>
              </div>
            </div>
          )}

        <div className={CARD_FOOTER_STYLES.container}>
          {!stock.isOwned && !isDisabled && (
            <div className={CARD_FOOTER_STYLES.actionGroup}>
              <StockActionButtons
                tickerCode={stock.stock.tickerCode}
                showWatchlist={!stock.isRegistered && !stock.isTracked}
                showTracked={!stock.isRegistered && !stock.isTracked}
                isInWatchlist={stock.isRegistered}
                isTracked={stock.isTracked}
                onWatchlistSuccess={() =>
                  updateStockStatus(stock.stockId, "watchlist")
                }
                onTrackedSuccess={() =>
                  updateStockStatus(stock.stockId, "tracked")
                }
              />
            </div>
          )}
          {stock.isOwned && <div />}

          {linkDisabled ? (
            <div className="flex items-center text-gray-300 ml-auto">
              <span className="text-xs text-gray-300">{t("viewDetail")}</span>
              <svg
                className="w-4 h-4 ml-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </div>
          ) : (
            <Link
              href={
                stock.userStockId
                  ? `/my-stocks/${stock.userStockId}`
                  : `/stocks/${stock.stockId}`
              }
              className={CARD_FOOTER_STYLES.detailLink}
            >
              <span className={CARD_FOOTER_STYLES.detailLinkText}>
                {t("viewDetail")}
              </span>
              <svg
                className="w-4 h-4 ml-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </Link>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl p-4 sm:p-6 shadow-md">
      <div className="mb-4 sm:mb-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <span className="text-xl sm:text-2xl">🏆</span>
            <h3 className="text-lg sm:text-xl font-bold text-gray-900">
              {t("title")}
            </h3>
          </div>
          {styleConfig && (
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${styleConfig.bg} ${styleConfig.color}`}
            >
              {styleConfig.icon} {styleConfig.text}
            </span>
          )}
        </div>
        <p className="text-xs sm:text-sm text-gray-600">
          {t("subtitle")}
        </p>
        <span className="text-xs text-gray-400">
          {t("schedule", { schedule: UPDATE_SCHEDULES.STOCK_ANALYSIS })}
        </span>
      </div>
      <StaleAnalysisBanner
        analysisDate={analysisDate}
        schedule={UPDATE_SCHEDULES.STOCK_ANALYSIS}
      />
      <div className="overflow-x-auto pb-2 -mx-1 px-1">
        <div
          className="flex gap-3 sm:gap-4"
          style={{ minWidth: "min-content" }}
        >
          {stocks.map((stock) => renderStockCard(stock))}
        </div>
      </div>
    </div>
  )
}
