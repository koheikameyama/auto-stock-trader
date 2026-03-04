"use client"

import { useState, useCallback, useEffect } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import CopyableTicker from "@/app/components/CopyableTicker"
import AddStockDialog from "@/app/my-stocks/AddStockDialog"
import { SECTORS, PURCHASE_JUDGMENT_CONFIG } from "@/lib/constants"
import { StocksListSkeleton } from "@/components/skeletons"

interface StockListItem {
  id: string
  tickerCode: string
  name: string
  sector: string | null
  market: string
  latestPrice: number | null
  dailyChangeRate: number | null
  weekChangeRate: number | null
  isProfitable: boolean | null
  buySignal: {
    isBuyCandidate: boolean
    chartSignals: string[]
    fundamentalSignals: string[]
  }
  latestRecommendation: {
    recommendation: string
    confidence: number
    userFitScore: number | null
    date: string
  } | null
  userStatus: "portfolio" | "watchlist" | "tracked" | null
}

interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

type Direction = "all" | "up" | "down"

const SORT_OPTIONS = [
  "dailyChangeRate_desc",
  "dailyChangeRate_asc",
  "latestPrice_desc",
  "latestPrice_asc",
  "marketCap_desc",
  "name_asc",
] as const

function formatPrice(price: number): string {
  return price.toLocaleString("ja-JP")
}

function formatChangeRate(rate: number | null): string {
  if (rate === null) return "-"
  const sign = rate > 0 ? "+" : ""
  return `${sign}${rate.toFixed(2)}%`
}

export default function StocksClient() {
  const t = useTranslations("stocks.list")

  const [stocks, setStocks] = useState<StockListItem[]>([])
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 30,
    total: 0,
    totalPages: 0,
  })
  const [loading, setLoading] = useState(true)

  // Filter state
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [sector, setSector] = useState("")
  const [direction, setDirection] = useState<Direction>("all")
  const [minPrice, setMinPrice] = useState("")
  const [maxPrice, setMaxPrice] = useState("")
  const [sortBy, setSortBy] = useState<string>("dailyChangeRate_desc")

  // Dialog state
  const [dialogType, setDialogType] = useState<"portfolio" | "watchlist" | null>(null)
  const [dialogStock, setDialogStock] = useState<{
    id: string
    tickerCode: string
    name: string
    market: string
    sector: string | null
    latestPrice: number | null
  } | null>(null)

  const fetchStocks = useCallback(
    async (page = 1) => {
      setLoading(true)
      try {
        const params = new URLSearchParams({
          page: String(page),
          limit: "30",
          sortBy,
        })
        if (search) params.set("search", search)
        if (sector) params.set("sector", sector)
        if (direction !== "all") params.set("direction", direction)
        if (minPrice) params.set("minPrice", minPrice)
        if (maxPrice) params.set("maxPrice", maxPrice)

        const response = await fetch(`/api/stocks/list?${params}`)
        if (!response.ok) throw new Error("Failed to fetch")

        const data = await response.json()
        setStocks(data.stocks)
        setPagination(data.pagination)
      } catch (error) {
        console.error("Error fetching stocks:", error)
      } finally {
        setLoading(false)
      }
    },
    [search, sector, direction, minPrice, maxPrice, sortBy]
  )

  useEffect(() => {
    fetchStocks()
  }, [fetchStocks])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setSearch(searchInput)
  }

  const handleDirectionChange = (dir: Direction) => {
    setDirection(dir)
  }

  const handleApplyPriceRange = () => {
    fetchStocks()
  }

  const handleAddStock = (
    type: "portfolio" | "watchlist",
    stock: StockListItem
  ) => {
    setDialogStock({
      id: stock.id,
      tickerCode: stock.tickerCode,
      name: stock.name,
      market: stock.market,
      sector: stock.sector,
      latestPrice: stock.latestPrice,
    })
    setDialogType(type)
  }

  if (loading && stocks.length === 0) {
    return <StocksListSkeleton />
  }

  const from = (pagination.page - 1) * pagination.limit + 1
  const to = Math.min(pagination.page * pagination.limit, pagination.total)

  return (
    <>
      <h1 className="text-2xl font-bold text-gray-900 mb-4">{t("title")}</h1>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-2 mb-3">
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors"
        >
          {t("search")}
        </button>
      </form>

      {/* Direction tabs */}
      <div className="flex gap-2 mb-3">
        {(["all", "up", "down"] as const).map((dir) => (
          <button
            key={dir}
            onClick={() => handleDirectionChange(dir)}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              direction === dir
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            {t(`direction${dir.charAt(0).toUpperCase() + dir.slice(1)}`)}
          </button>
        ))}
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap gap-2 mb-3">
        {/* Sector */}
        <select
          value={sector}
          onChange={(e) => setSector(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">{t("sectorAll")}</option>
          {SECTORS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        {/* Price range */}
        <input
          type="number"
          value={minPrice}
          onChange={(e) => setMinPrice(e.target.value)}
          placeholder={t("minPrice")}
          className="w-28 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <span className="self-center text-gray-500 text-sm">~</span>
        <input
          type="number"
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
          placeholder={t("maxPrice")}
          className="w-28 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleApplyPriceRange}
          className="px-3 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200 transition-colors"
        >
          {t("apply")}
        </button>
      </div>

      {/* Sort */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">{t("sortLabel")}</label>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {t(`sort.${opt}`)}
              </option>
            ))}
          </select>
        </div>
        {pagination.total > 0 && (
          <span className="text-sm text-gray-500">
            {t("showingRange", { total: pagination.total, from, to })}
          </span>
        )}
      </div>

      {/* Stock list */}
      {loading ? (
        <StocksListSkeleton />
      ) : stocks.length === 0 ? (
        <div className="text-center py-12 text-gray-500">{t("noStocks")}</div>
      ) : (
        <div className="space-y-3">
          {stocks.map((stock) => {
            const changeRate = stock.dailyChangeRate
            const isUp = changeRate !== null && changeRate > 0
            const isDown = changeRate !== null && changeRate < 0
            const rec = stock.latestRecommendation
            const recConfig = rec
              ? PURCHASE_JUDGMENT_CONFIG[rec.recommendation]
              : null

            return (
              <div
                key={stock.id}
                className="bg-white rounded-xl p-4 shadow-sm border border-gray-200 hover:shadow-md hover:border-blue-200 transition-all"
              >
                <Link href={`/stocks/${stock.id}`} className="block">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-900 truncate">
                          {stock.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <CopyableTicker
                          tickerCode={stock.tickerCode}
                          className="text-xs text-gray-500"
                        />
                        {stock.sector && (
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                            {stock.sector}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right ml-3">
                      <div className="font-bold text-gray-900">
                        {stock.latestPrice !== null
                          ? `¥${formatPrice(stock.latestPrice)}`
                          : "-"}
                      </div>
                      <div
                        className={`text-sm font-medium ${
                          isUp
                            ? "text-green-600"
                            : isDown
                              ? "text-red-600"
                              : "text-gray-500"
                        }`}
                      >
                        {isUp && "▲ "}
                        {isDown && "▼ "}
                        {formatChangeRate(changeRate)}
                      </div>
                    </div>
                  </div>

                  {/* AI recommendation + buy signal + score */}
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    {stock.buySignal.isBuyCandidate && (
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium text-amber-700 bg-amber-50">
                        {t("buySignal")}
                      </span>
                    )}
                    {recConfig && rec && (
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${recConfig.color} ${recConfig.bg}`}
                      >
                        {recConfig.text}
                      </span>
                    )}
                    {rec && rec.userFitScore !== null && (
                      <span className="text-xs text-gray-500">
                        {t("score", { score: rec.userFitScore })}
                      </span>
                    )}
                    {stock.weekChangeRate !== null && (
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          stock.weekChangeRate > 0
                            ? "bg-green-50 text-green-700"
                            : stock.weekChangeRate < 0
                              ? "bg-red-50 text-red-700"
                              : "bg-gray-50 text-gray-600"
                        }`}
                      >
                        {t("weekChange")} {formatChangeRate(stock.weekChangeRate)}
                      </span>
                    )}
                    {!rec && (
                      <span className="text-xs text-gray-400">
                        {t("noRecommendation")}
                      </span>
                    )}
                  </div>
                </Link>

                {/* Action buttons / Status */}
                <div className="mt-3 pt-3 border-t border-gray-100 flex gap-2">
                  {stock.userStatus === "portfolio" ? (
                    <span className="flex-1 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 rounded-lg text-center">
                      {t("statusPortfolio")}
                    </span>
                  ) : stock.userStatus === "watchlist" ? (
                    <span className="flex-1 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 rounded-lg text-center">
                      {t("statusWatchlist")}
                    </span>
                  ) : stock.userStatus === "tracked" ? (
                    <span className="flex-1 px-3 py-1.5 text-xs font-medium text-purple-700 bg-purple-50 rounded-lg text-center">
                      {t("statusTracked")}
                    </span>
                  ) : (
                    <>
                      <button
                        onClick={() => handleAddStock("portfolio", stock)}
                        className="flex-1 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 rounded-lg hover:bg-green-100 transition-colors"
                      >
                        {t("addPortfolio")}
                      </button>
                      <button
                        onClick={() => handleAddStock("watchlist", stock)}
                        className="flex-1 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
                      >
                        {t("addWatchlist")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 mt-6 mb-4">
          <button
            onClick={() => fetchStocks(pagination.page - 1)}
            disabled={pagination.page <= 1}
            className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t("pagination.prev")}
          </button>
          <span className="text-sm text-gray-600">
            {pagination.page} / {pagination.totalPages}
          </span>
          <button
            onClick={() => fetchStocks(pagination.page + 1)}
            disabled={pagination.page >= pagination.totalPages}
            className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t("pagination.next")}
          </button>
        </div>
      )}

      {/* AddStockDialog */}
      {dialogType && dialogStock && (
        <AddStockDialog
          isOpen={true}
          onClose={() => {
            setDialogType(null)
            setDialogStock(null)
          }}
          onSuccess={() => {
            const msg = dialogType === "portfolio"
              ? t("addedToPortfolio")
              : t("addedToWatchlist")
            setDialogType(null)
            setDialogStock(null)
            toast.success(msg)
            fetchStocks(pagination.page)
          }}
          defaultType={dialogType}
          initialStock={dialogStock}
        />
      )}
    </>
  )
}
