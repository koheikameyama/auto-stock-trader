"use client"

import { useState, useEffect, useCallback } from "react"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts"
import { useTranslations } from "next-intl"
import { BENCHMARK_METRICS } from "@/lib/constants"

type Period = "1m" | "3m" | "1y"

interface NikkeiData {
  currentPrice: number
  previousClose: number
  change: number
  changePercent: number
  timestamp: string
}

interface NikkeiHistoricalPoint {
  date: string
  close: number
}

interface PortfolioHistoryItem {
  date: string
  totalValue: number
}

interface ChartDataPoint {
  date: string
  nikkeiPercent: number
  portfolioPercent: number | null
}

interface BenchmarkMetrics {
  hasMetrics: boolean
  reason?: string
  dataPoints?: number
  required?: number
  portfolioReturn?: number
  nikkeiReturn?: number
  excessReturn?: number
  beta?: number | null
  sharpeRatio?: number | null
}

export default function NikkeiSummary() {
  const t = useTranslations("dashboard.nikkei")
  const [nikkei, setNikkei] = useState<NikkeiData | null>(null)
  const [chartData, setChartData] = useState<ChartDataPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [chartLoading, setChartLoading] = useState(false)
  const [period, setPeriod] = useState<Period>("1m")
  const [showChart, setShowChart] = useState(false)
  const [metrics, setMetrics] = useState<BenchmarkMetrics | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(false)
  const [expandedMetric, setExpandedMetric] = useState<string | null>(null)

  useEffect(() => {
    const fetchNikkei = async () => {
      try {
        const response = await fetch("/api/market/nikkei")
        const data = await response.json()
        if (response.ok) {
          setNikkei(data)
        }
      } catch (error) {
        console.error("Error fetching Nikkei 225:", error)
      } finally {
        setLoading(false)
      }
    }
    fetchNikkei()
  }, [])

  const fetchChartData = useCallback(async (p: Period) => {
    setChartLoading(true)
    try {
      const [nikkeiRes, portfolioRes] = await Promise.all([
        fetch(`/api/market/nikkei/historical?period=${p}`),
        fetch(`/api/portfolio/history?period=${p}`),
      ])

      const nikkeiJson = nikkeiRes.ok ? await nikkeiRes.json() : null
      const portfolioJson = portfolioRes.ok ? await portfolioRes.json() : null

      const nikkeiPrices: NikkeiHistoricalPoint[] = nikkeiJson?.prices || []
      const portfolioHistory: PortfolioHistoryItem[] =
        portfolioJson?.history || []

      if (nikkeiPrices.length === 0) {
        setChartData([])
        return
      }

      const nikkeiBase = nikkeiPrices[0].close

      // Build portfolio lookup by date
      const portfolioMap = new Map<string, number>()
      if (portfolioHistory.length > 0) {
        const portfolioBase = portfolioHistory[0].totalValue
        for (const item of portfolioHistory) {
          const dateKey = item.date.slice(0, 10)
          const pct =
            portfolioBase > 0
              ? ((item.totalValue - portfolioBase) / portfolioBase) * 100
              : 0
          portfolioMap.set(dateKey, pct)
        }
      }

      const data: ChartDataPoint[] = nikkeiPrices.map((point) => {
        const dateKey = point.date.slice(0, 10)
        return {
          date: dateKey,
          nikkeiPercent:
            ((point.close - nikkeiBase) / nikkeiBase) * 100,
          portfolioPercent: portfolioMap.get(dateKey) ?? null,
        }
      })

      setChartData(data)
    } catch (error) {
      console.error("Error fetching chart data:", error)
    } finally {
      setChartLoading(false)
    }
  }, [])

  const fetchMetrics = useCallback(async (p: Period) => {
    setMetricsLoading(true)
    try {
      const res = await fetch(`/api/portfolio/benchmark-metrics?period=${p}`)
      if (res.ok) {
        const data = await res.json()
        setMetrics(data)
      }
    } catch (error) {
      console.error("Error fetching benchmark metrics:", error)
    } finally {
      setMetricsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (showChart) {
      fetchChartData(period)
      fetchMetrics(period)
    }
  }, [showChart, period, fetchChartData, fetchMetrics])

  const handleToggleChart = () => {
    setShowChart((prev) => !prev)
  }

  const handlePeriodChange = (p: Period) => {
    setPeriod(p)
  }

  const getExcessReturnEval = (value: number) => {
    if (value >= BENCHMARK_METRICS.EXCESS_RETURN_GOOD)
      return { label: t("evalGood"), color: "text-green-600" }
    if (value <= BENCHMARK_METRICS.EXCESS_RETURN_BAD)
      return { label: t("evalCaution"), color: "text-red-600" }
    return { label: t("evalNormal"), color: "text-gray-600" }
  }

  const getBetaEval = (value: number) => {
    if (value < BENCHMARK_METRICS.BETA_STABLE)
      return { label: t("betaStable"), color: "text-blue-600" }
    if (value < BENCHMARK_METRICS.BETA_BALANCED)
      return { label: t("betaBalanced"), color: "text-gray-600" }
    if (value < BENCHMARK_METRICS.BETA_AGGRESSIVE)
      return { label: t("betaAggressive"), color: "text-orange-600" }
    return { label: t("betaHighRisk"), color: "text-red-600" }
  }

  const getSharpeEval = (value: number) => {
    if (value >= BENCHMARK_METRICS.SHARPE_EXCELLENT)
      return { label: t("evalExcellent"), color: "text-green-600" }
    if (value >= BENCHMARK_METRICS.SHARPE_FAIR)
      return { label: t("evalNormal"), color: "text-gray-600" }
    return { label: t("evalNeedsImprovement"), color: "text-red-600" }
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return `${date.getMonth() + 1}/${date.getDate()}`
  }

  const formatFullDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
  }

  const hasPortfolioData = chartData.some((d) => d.portfolioPercent !== null)

  // Calculate outperformance
  const lastPoint = chartData[chartData.length - 1]
  const outperformance =
    lastPoint && lastPoint.portfolioPercent !== null
      ? lastPoint.portfolioPercent - lastPoint.nikkeiPercent
      : null

  if (loading) {
    return (
      <div className="mb-4 sm:mb-6 bg-white rounded-xl p-3 sm:p-4 shadow-sm border border-gray-200">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-orange-50 flex items-center justify-center shrink-0">
            <span className="text-lg sm:text-xl">📈</span>
          </div>
          <div className="flex-1">
            <div className="text-xs text-gray-500 mb-1">{t("title")}</div>
            <div className="flex items-baseline gap-2">
              <div className="h-6 w-24 bg-gray-200 rounded animate-pulse"></div>
              <div className="h-4 w-16 bg-gray-200 rounded animate-pulse"></div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!nikkei) {
    return null
  }

  const isPositive = nikkei.change >= 0
  const periods: Period[] = ["1m", "3m", "1y"]
  const periodLabels: Record<Period, string> = {
    "1m": t("period1m"),
    "3m": t("period3m"),
    "1y": t("period1y"),
  }

  return (
    <div className="mb-4 sm:mb-6 bg-white rounded-xl p-3 sm:p-4 shadow-sm border border-gray-200">
      {/* Header */}
      <button
        onClick={handleToggleChart}
        className="w-full flex items-center gap-2 sm:gap-3 text-left"
      >
        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-orange-50 flex items-center justify-center shrink-0">
          <span className="text-lg sm:text-xl">📈</span>
        </div>
        <div className="flex-1">
          <div className="text-xs text-gray-500 mb-0.5">{t("title")}</div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-base sm:text-lg font-bold text-gray-900">
              ¥{Math.round(nikkei.currentPrice).toLocaleString()}
            </span>
            <span
              className={`text-xs sm:text-sm font-semibold ${
                isPositive ? "text-green-600" : "text-red-600"
              }`}
            >
              {isPositive ? "+" : ""}
              {Math.round(nikkei.change).toLocaleString()}
              <span className="ml-1">
                ({isPositive ? "+" : ""}
                {nikkei.changePercent.toFixed(2)}%)
              </span>
            </span>
          </div>
        </div>
        <span
          className={`text-gray-400 text-sm transition-transform ${
            showChart ? "rotate-180" : ""
          }`}
        >
          ▼
        </span>
      </button>

      {/* Chart area */}
      {showChart && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          {/* Period selector */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex bg-gray-100 rounded-lg p-0.5">
              {periods.map((p) => (
                <button
                  key={p}
                  onClick={() => handlePeriodChange(p)}
                  className={`px-2.5 py-0.5 text-[10px] rounded transition-colors ${
                    period === p
                      ? "bg-white shadow text-gray-900"
                      : "text-gray-500"
                  }`}
                >
                  {periodLabels[p]}
                </button>
              ))}
            </div>
            {/* Legend */}
            <div className="flex items-center gap-3 text-[10px] text-gray-500">
              <span className="flex items-center gap-1">
                <span className="w-3 h-0.5 bg-orange-500 inline-block rounded"></span>
                {t("nikkei225")}
              </span>
              {hasPortfolioData && (
                <span className="flex items-center gap-1">
                  <span className="w-3 h-0.5 bg-blue-500 inline-block rounded"></span>
                  {t("portfolio")}
                </span>
              )}
            </div>
          </div>

          {chartLoading ? (
            <div className="h-40 bg-gray-50 rounded-lg animate-pulse" />
          ) : chartData.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-gray-400 text-sm">
              {t("noData")}
            </div>
          ) : (
            <>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={chartData}
                    margin={{ top: 5, right: 5, left: 0, bottom: 5 }}
                  >
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatDate}
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tickFormatter={(v: number) =>
                        `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`
                      }
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                      width={48}
                    />
                    <ReferenceLine
                      y={0}
                      stroke="#d1d5db"
                      strokeDasharray="3 3"
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload || payload.length === 0)
                          return null
                        const item = payload[0]
                          .payload as ChartDataPoint
                        return (
                          <div className="bg-white border rounded-lg shadow-lg p-2 text-xs">
                            <p className="text-gray-500 mb-1">
                              {formatFullDate(item.date)}
                            </p>
                            <p className="text-orange-600 font-medium">
                              {t("nikkei225")}:{" "}
                              {item.nikkeiPercent >= 0 ? "+" : ""}
                              {item.nikkeiPercent.toFixed(2)}%
                            </p>
                            {item.portfolioPercent !== null && (
                              <>
                                <p className="text-blue-600 font-medium">
                                  {t("portfolio")}:{" "}
                                  {item.portfolioPercent >= 0 ? "+" : ""}
                                  {item.portfolioPercent.toFixed(2)}%
                                </p>
                                <p
                                  className={`mt-1 pt-1 border-t ${
                                    item.portfolioPercent -
                                      item.nikkeiPercent >=
                                    0
                                      ? "text-green-600"
                                      : "text-red-600"
                                  }`}
                                >
                                  {t("vsNikkei", {
                                    value: `${
                                      item.portfolioPercent -
                                        item.nikkeiPercent >=
                                      0
                                        ? "+"
                                        : ""
                                    }${(
                                      item.portfolioPercent -
                                      item.nikkeiPercent
                                    ).toFixed(2)}%`,
                                  })}
                                </p>
                              </>
                            )}
                          </div>
                        )
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="nikkeiPercent"
                      stroke="#f97316"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 3, fill: "#f97316" }}
                    />
                    {hasPortfolioData && (
                      <Line
                        type="monotone"
                        dataKey="portfolioPercent"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 3, fill: "#3b82f6" }}
                        connectNulls
                      />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Outperformance summary */}
              {outperformance !== null && (
                <div className="mt-2 text-center">
                  <span
                    className={`text-xs font-medium ${
                      outperformance >= 0
                        ? "text-green-600"
                        : "text-red-600"
                    }`}
                  >
                    {t("outperformance", {
                      value: `${outperformance >= 0 ? "+" : ""}${outperformance.toFixed(2)}%`,
                    })}
                  </span>
                </div>
              )}

              {/* Benchmark Metrics */}
              {metrics && metrics.hasMetrics && !metricsLoading && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="text-[10px] text-gray-500 mb-2">{t("benchmarkTitle")}</p>
                  <div className="grid grid-cols-3 gap-2">
                    {/* Excess Return */}
                    <button
                      onClick={() => setExpandedMetric(expandedMetric === "excess" ? null : "excess")}
                      className="text-left bg-gray-50 rounded-lg p-2"
                    >
                      <p className="text-[10px] text-gray-500">{t("excessReturn")}</p>
                      <p className="text-sm font-bold text-gray-900">
                        {metrics.excessReturn! >= 0 ? "+" : ""}{metrics.excessReturn}%
                      </p>
                      <p className={`text-[10px] font-medium ${getExcessReturnEval(metrics.excessReturn!).color}`}>
                        {getExcessReturnEval(metrics.excessReturn!).label}
                      </p>
                    </button>

                    {/* Beta */}
                    <button
                      onClick={() => setExpandedMetric(expandedMetric === "beta" ? null : "beta")}
                      className="text-left bg-gray-50 rounded-lg p-2"
                    >
                      <p className="text-[10px] text-gray-500">{t("beta")}</p>
                      <p className="text-sm font-bold text-gray-900">
                        {metrics.beta !== null ? metrics.beta!.toFixed(2) : "-"}
                      </p>
                      {metrics.beta !== null && (
                        <p className={`text-[10px] font-medium ${getBetaEval(metrics.beta!).color}`}>
                          {getBetaEval(metrics.beta!).label}
                        </p>
                      )}
                    </button>

                    {/* Sharpe Ratio */}
                    <button
                      onClick={() => setExpandedMetric(expandedMetric === "sharpe" ? null : "sharpe")}
                      className="text-left bg-gray-50 rounded-lg p-2"
                    >
                      <p className="text-[10px] text-gray-500">{t("sharpeRatio")}</p>
                      <p className="text-sm font-bold text-gray-900">
                        {metrics.sharpeRatio !== null ? metrics.sharpeRatio!.toFixed(2) : "-"}
                      </p>
                      {metrics.sharpeRatio !== null && (
                        <p className={`text-[10px] font-medium ${getSharpeEval(metrics.sharpeRatio!).color}`}>
                          {getSharpeEval(metrics.sharpeRatio!).label}
                        </p>
                      )}
                    </button>
                  </div>

                  {/* Expanded description */}
                  {expandedMetric === "excess" && (
                    <div className="mt-2 p-2 bg-blue-50 rounded-lg text-[11px] text-gray-700">
                      {t("excessReturnDesc")}
                    </div>
                  )}
                  {expandedMetric === "beta" && (
                    <div className="mt-2 p-2 bg-blue-50 rounded-lg text-[11px] text-gray-700">
                      {t("betaDesc")}
                    </div>
                  )}
                  {expandedMetric === "sharpe" && (
                    <div className="mt-2 p-2 bg-blue-50 rounded-lg text-[11px] text-gray-700">
                      {t("sharpeRatioDesc")}
                    </div>
                  )}
                </div>
              )}

              {/* Insufficient data message */}
              {metrics && !metrics.hasMetrics && metrics.reason === "insufficient_data" && !metricsLoading && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="text-[10px] text-gray-400 text-center">
                    {t("insufficientData", { count: metrics.dataPoints ?? 0, required: metrics.required ?? 0 })}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
