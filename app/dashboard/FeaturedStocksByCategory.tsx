"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { UPDATE_SCHEDULES, FETCH_FAIL_WARNING_THRESHOLD, INVESTMENT_THEME_CONFIG, PURCHASE_JUDGMENT_CONFIG } from "@/lib/constants"
import { CARD_FOOTER_STYLES } from "@/lib/ui-config"
import StockActionButtons from "@/app/components/StockActionButtons"
import CopyableTicker from "@/app/components/CopyableTicker"
import StaleAnalysisBanner from "@/app/components/StaleAnalysisBanner"
import { useTranslations } from "next-intl"

interface FeaturedStock {
  id: string
  stockId: string
  category: string | null
  investmentTheme: string | null
  reason: string | null
  purchaseJudgment: string | null
  isOwned: boolean // ポートフォリオにある場合
  isRegistered: boolean // ウォッチリストにある場合
  isTracked: boolean // 追跡中の場合
  userStockId: string | null // ポートフォリオまたはウォッチリストのID
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

export default function FeaturedStocksByCategory() {
  const tRec = useTranslations("dashboard.recommendation")
  const [personalRecommendations, setPersonalRecommendations] = useState<FeaturedStock[]>([])
  const [pricesLoaded, setPricesLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [regenerating, setRegenerating] = useState(false)
  const [recommendationDate, setRecommendationDate] = useState<string | null>(null)

  useEffect(() => {
    fetchFeaturedStocks()
  }, [])

  // 株価を非同期で取得
  const fetchPrices = async (stocks: FeaturedStock[]) => {
    if (stocks.length === 0) return

    const tickerCodes = stocks.map((s) => s.stock.tickerCode)
    try {
      const response = await fetch(`/api/stocks/prices?tickers=${tickerCodes.join(",")}`)
      if (!response.ok) return

      const data = await response.json()
      const priceMap = new Map<string, { currentPrice: number; marketTime: number | null }>(
        data.prices?.map((p: { tickerCode: string; currentPrice: number; marketTime: number | null }) => [p.tickerCode, { currentPrice: p.currentPrice, marketTime: p.marketTime }]) || []
      )
      const staleTickers = new Set<string>(data.staleTickers || [])

      // 株価を更新（stale情報も反映）
      setPersonalRecommendations((prev) =>
        prev.map((s) => {
          const priceData = priceMap.get(s.stock.tickerCode)
          return {
            ...s,
            stock: {
              ...s.stock,
              currentPrice: priceData?.currentPrice ?? s.stock.currentPrice,
              marketTime: priceData?.marketTime ?? s.stock.marketTime,
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

  const fetchFeaturedStocks = async () => {
    try {
      setLoading(true)
      const response = await fetch("/api/featured-stocks")
      const data = await response.json()

      if (response.ok) {
        const personal = data.personalRecommendations || []
        setPersonalRecommendations(personal)
        setRecommendationDate(data.date || null)

        // 株価を非同期で取得（表示後にバックグラウンドで）
        fetchPrices(personal)
      } else {
        console.error("Error fetching featured stocks:", data.error)
      }
    } catch (error) {
      console.error("Error fetching featured stocks:", error)
    } finally {
      setLoading(false)
    }
  }

  const handleRegenerate = async () => {
    try {
      setRegenerating(true)
      setPricesLoaded(false)
      const response = await fetch("/api/recommendations/regenerate", {
        method: "POST",
      })

      if (!response.ok) {
        console.error("Error regenerating recommendations:", response.status)
        return
      }

      // 再生成後にデータを再取得
      await fetchFeaturedStocks()
    } catch (error) {
      console.error("Error regenerating recommendations:", error)
    } finally {
      setRegenerating(false)
    }
  }

  if (loading) {
    return (
      <div className="bg-white rounded-xl p-4 sm:p-6 shadow-md">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xl sm:text-2xl">⭐</span>
          <h3 className="text-lg sm:text-xl font-bold text-gray-900">今日の注目銘柄</h3>
        </div>
        <p className="text-xs sm:text-sm text-gray-500">読み込み中...</p>
      </div>
    )
  }

  if (personalRecommendations.length === 0) {
    return (
      <div className="bg-white rounded-xl p-4 sm:p-6 shadow-md">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xl sm:text-2xl">⭐</span>
          <h3 className="text-lg sm:text-xl font-bold text-gray-900">今日の注目銘柄</h3>
        </div>
        <div className="text-center py-6 sm:py-8">
          <div className="text-4xl sm:text-5xl mb-3 sm:mb-4">🔍</div>
          <h3 className="text-base sm:text-lg font-semibold text-gray-900 mb-2">
            おすすめ銘柄がまだありません
          </h3>
          <p className="text-xs sm:text-sm text-gray-600">
            AIが毎日あなたに合った銘柄をおすすめします
          </p>
        </div>
      </div>
    )
  }

  // 銘柄のステータスを更新するハンドラー
  const updateStockStatus = (stockId: string, type: "watchlist" | "tracked") => {
    const updateFn = (stocks: FeaturedStock[]) =>
      stocks.map((s) =>
        s.stockId === stockId
          ? { ...s, isRegistered: type === "watchlist", isTracked: type === "tracked" }
          : s
      )
    setPersonalRecommendations(updateFn)
  }

  const renderStockCard = (stock: FeaturedStock) => {
    const isDisabled = stock.stock.isDelisted === true || stock.stock.isStale === true
    // 価格未取得時もリンクを無効化（stale判定が終わるまで遷移させない）
    const linkDisabled = isDisabled || !pricesLoaded

    return (
      <div
        key={stock.id}
        className={`relative flex-shrink-0 w-64 sm:w-72 bg-white rounded-lg p-3 sm:p-4 border-2 border-blue-200 bg-blue-50 transition-shadow ${isDisabled ? "opacity-60" : "hover:shadow-md"}`}
      >
        {/* バッジ - 右上 */}
        <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
          {stock.isOwned ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">
              {tRec("owned")}
            </span>
          ) : stock.isRegistered ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
              {tRec("interested")}
            </span>
          ) : stock.isTracked ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-800">
              {tRec("tracked")}
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
                <span className="text-amber-600 text-xs">株価データが取得できませんでした。<br />上場廃止、取引停止の銘柄の可能性があります。</span>
              ) : (
                <span className="text-gray-400 text-sm">取得中...</span>
              )}
            </div>
            {stock.stock.marketTime && (
              <p className="text-[10px] text-gray-400">
                {new Date(stock.stock.marketTime * 1000).toLocaleString("ja-JP", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                時点
              </p>
            )}
          </div>
        </div>

        {/* 投資テーマバッジ（無効化時は非表示） */}
        {!isDisabled && stock.investmentTheme && INVESTMENT_THEME_CONFIG[stock.investmentTheme] && (
          <div className="mb-1.5">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${INVESTMENT_THEME_CONFIG[stock.investmentTheme].bg} ${INVESTMENT_THEME_CONFIG[stock.investmentTheme].color}`}>
              <span>{INVESTMENT_THEME_CONFIG[stock.investmentTheme].icon}</span>
              {INVESTMENT_THEME_CONFIG[stock.investmentTheme].text}
            </span>
          </div>
        )}

        {/* おすすめ時点での評価バッジ */}
        {!isDisabled && stock.purchaseJudgment && PURCHASE_JUDGMENT_CONFIG[stock.purchaseJudgment] && (
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="text-[11px] text-gray-500">
              {tRec("purchaseJudgmentLabel")}
            </span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${PURCHASE_JUDGMENT_CONFIG[stock.purchaseJudgment].bg} ${PURCHASE_JUDGMENT_CONFIG[stock.purchaseJudgment].color}`}>
              {PURCHASE_JUDGMENT_CONFIG[stock.purchaseJudgment].text}
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
        {(stock.stock.isDelisted || (stock.stock.fetchFailCount ?? 0) >= FETCH_FAIL_WARNING_THRESHOLD) && (
          <div className="mb-2 sm:mb-3 p-2 rounded-lg bg-red-50 border border-red-200">
            <p className="text-xs text-red-700">
              {stock.stock.isDelisted
                ? "この銘柄は上場廃止されています"
                : "上場廃止の可能性があります"}
            </p>
          </div>
        )}

        {/* リスク情報（無効化時は非表示） */}
        {!isDisabled && (stock.stock.isProfitable === false ||
          (stock.stock.volatility != null && stock.stock.volatility > 50) ||
          (stock.stock.weekChangeRate != null && stock.stock.weekChangeRate < -15)) && (
          <div className="mb-2 sm:mb-3 p-2 rounded-lg bg-amber-50 border border-amber-200">
            <div className="flex items-start gap-1.5">
              <span className="text-amber-500 text-xs mt-0.5">⚠️</span>
              <div className="text-xs text-amber-700 space-y-0.5">
                {stock.stock.isProfitable === false && <p>赤字銘柄</p>}
                {stock.stock.volatility != null && stock.stock.volatility > 50 && (
                  <p>高ボラティリティ（{stock.stock.volatility.toFixed(1)}%）</p>
                )}
                {stock.stock.weekChangeRate != null && stock.stock.weekChangeRate < -15 && (
                  <p>直近1週間で{stock.stock.weekChangeRate.toFixed(1)}%下落</p>
                )}
              </div>
            </div>
          </div>
        )}

        <div className={CARD_FOOTER_STYLES.container}>
          {/* アクションボタン（保有中・無効化時は非表示） */}
          {!stock.isOwned && !isDisabled && (
            <div className={CARD_FOOTER_STYLES.actionGroup}>
              <StockActionButtons
                tickerCode={stock.stock.tickerCode}
                showWatchlist={!stock.isRegistered && !stock.isTracked}
                showTracked={!stock.isRegistered && !stock.isTracked}
                isInWatchlist={stock.isRegistered}
                isTracked={stock.isTracked}
                investmentTheme={stock.investmentTheme}
                recommendationReason={stock.reason}
                onWatchlistSuccess={() => updateStockStatus(stock.stockId, "watchlist")}
                onTrackedSuccess={() => updateStockStatus(stock.stockId, "tracked")}
              />
            </div>
          )}
          {stock.isOwned && <div />}

          {linkDisabled ? (
            <div className="flex items-center text-gray-300 ml-auto">
              <span className="text-xs text-gray-300">詳細を見る</span>
              <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          ) : (
            <Link
              href={stock.userStockId ? `/my-stocks/${stock.userStockId}` : `/stocks/${stock.stockId}`}
              className={CARD_FOOTER_STYLES.detailLink}
            >
              <span className={CARD_FOOTER_STYLES.detailLinkText}>詳細を見る</span>
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
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xl sm:text-2xl">⭐</span>
          <h3 className="text-lg sm:text-xl font-bold text-gray-900">あなたへのおすすめ</h3>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <p className="text-xs sm:text-sm text-gray-600">
            {tRec("subtitle")}
          </p>
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg
                className={`w-3.5 h-3.5 ${regenerating ? "animate-spin" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              {regenerating ? tRec("regenerating") : tRec("regenerate")}
            </button>
            <span>{tRec("schedule", { schedule: UPDATE_SCHEDULES.PERSONAL_RECOMMENDATIONS })}</span>
          </div>
        </div>
      </div>
      <StaleAnalysisBanner analysisDate={recommendationDate} schedule={UPDATE_SCHEDULES.PERSONAL_RECOMMENDATIONS} />
      {regenerating ? (
        <div className="text-center py-8 sm:py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent mb-3" />
          <p className="text-sm text-gray-600">{tRec("regeneratingMessage")}</p>
        </div>
      ) : (
        <div className="overflow-x-auto pb-2 -mx-1 px-1">
          <div className="flex gap-3 sm:gap-4" style={{ minWidth: "min-content" }}>
            {personalRecommendations.map((stock) => renderStockCard(stock))}
          </div>
        </div>
      )}
    </div>
  )
}
