"use client"

import { useState, useEffect } from "react"
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from "recharts"

type ViewMode = "stock" | "sector"

interface StockItem {
  stockId: string
  tickerCode: string
  name: string
  sector: string
  value: number
  percent: number
  color: string
}

interface SectorItem {
  sector: string
  value: number
  percent: number
  stockCount: number
  color: string
}

interface CompositionData {
  byStock: StockItem[]
  bySector: SectorItem[]
  totalValue: number
  stockCount: number
}

interface SectorDiversificationAnalysis {
  value: string
  explanation: string
  evaluation: string
  evaluationType: "good" | "neutral" | "warning"
  action: string
}

export default function PortfolioCompositionChart() {
  const [data, setData] = useState<CompositionData | null>(null)
  const [sectorAnalysis, setSectorAnalysis] = useState<SectorDiversificationAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>("sector")

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [compositionRes, analysisRes] = await Promise.all([
          fetch("/api/portfolio/composition"),
          fetch("/api/portfolio/overall-analysis"),
        ])

        if (compositionRes.ok) {
          const json = await compositionRes.json()
          setData(json)
        }

        if (analysisRes.ok) {
          const analysisJson = await analysisRes.json()
          if (analysisJson.hasAnalysis && analysisJson.metricsAnalysis?.sectorDiversification) {
            setSectorAnalysis(analysisJson.metricsAnalysis.sectorDiversification)
          }
        }
      } catch (error) {
        console.error("Failed to fetch composition:", error)
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  if (loading) {
    return (
      <div className="bg-white rounded-lg border p-4">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-lg">📊</span>
          <h3 className="font-semibold">ポートフォリオ構成</h3>
        </div>
        <div className="flex items-center justify-center h-64">
          <div className="w-48 h-48 rounded-full bg-gray-100 animate-pulse" />
        </div>
      </div>
    )
  }

  if (!data || data.stockCount === 0) {
    return null
  }

  const chartData = viewMode === "stock" ? data.byStock : data.bySector
  const otherThreshold = 5 // 5%未満は「その他」にまとめる

  // 小さい項目を「その他」にまとめる
  const mainItems = chartData.filter((item) => item.percent >= otherThreshold)
  const otherItems = chartData.filter((item) => item.percent < otherThreshold)

  let displayData = mainItems
  if (otherItems.length > 0) {
    const otherValue = otherItems.reduce((sum, item) => sum + item.value, 0)
    const otherPercent = otherItems.reduce((sum, item) => sum + item.percent, 0)
    displayData = [
      ...mainItems,
      {
        name: "その他",
        sector: "その他",
        value: otherValue,
        percent: Math.round(otherPercent * 10) / 10,
        color: "#94a3b8",
        stockCount: otherItems.length,
      } as StockItem & SectorItem,
    ]
  }

  const formatValue = (value: number) => {
    if (value >= 10000) {
      return `${(value / 10000).toFixed(1)}万円`
    }
    return `${value.toLocaleString()}円`
  }

  return (
    <div className="bg-white rounded-lg border p-4">
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">📊</span>
          <h3 className="font-semibold">ポートフォリオ構成</h3>
        </div>
        <div className="flex bg-gray-100 rounded-lg p-0.5 mt-2 w-fit">
          <button
            onClick={() => setViewMode("sector")}
            className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
              viewMode === "sector"
                ? "bg-white shadow text-gray-900"
                : "text-gray-500"
            }`}
          >
            セクター別
          </button>
          <button
            onClick={() => setViewMode("stock")}
            className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
              viewMode === "stock"
                ? "bg-white shadow text-gray-900"
                : "text-gray-500"
            }`}
          >
            銘柄別
          </button>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row items-center gap-4">
        <div className="w-full lg:w-1/2 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={displayData}
                dataKey="value"
                nameKey={viewMode === "stock" ? "name" : "sector"}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={90}
                paddingAngle={2}
              >
                {displayData.map((entry, index) => (
                  <Cell key={index} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                content={({ active, payload }) => {
                  if (active && payload && payload.length > 0) {
                    const item = payload[0].payload
                    return (
                      <div className="bg-white border rounded-lg shadow-lg p-3 text-sm">
                        <p className="font-semibold">
                          {viewMode === "stock" ? item.name : item.sector}
                        </p>
                        <p className="text-gray-600">
                          {formatValue(item.value)} ({item.percent}%)
                        </p>
                        {viewMode === "sector" && item.stockCount && (
                          <p className="text-gray-500 text-xs">
                            {item.stockCount}銘柄
                          </p>
                        )}
                      </div>
                    )
                  }
                  return null
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="w-full lg:w-1/2">
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {displayData.map((item, index) => (
              <div
                key={index}
                className="flex items-center justify-between text-sm"
              >
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="truncate max-w-[140px]">
                    {viewMode === "stock"
                      ? (item as StockItem).name
                      : (item as SectorItem).sector}
                  </span>
                </div>
                <div className="text-right">
                  <span className="font-medium">{item.percent}%</span>
                  <span className="text-gray-500 text-xs ml-2">
                    {formatValue(item.value)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t flex justify-between text-sm text-gray-600">
        <span>総資産額</span>
        <span className="font-semibold text-gray-900">
          {formatValue(data.totalValue)}
        </span>
      </div>

      {/* セクター分散度のアドバイス */}
      {sectorAnalysis && (
        <div className="mt-4 pt-4 border-t">
          <div className="flex items-start gap-2">
            <span
              className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${
                sectorAnalysis.evaluationType === "good"
                  ? "bg-green-100 text-green-700"
                  : sectorAnalysis.evaluationType === "warning"
                  ? "bg-yellow-100 text-yellow-700"
                  : "bg-gray-100 text-gray-700"
              }`}
            >
              {sectorAnalysis.evaluation}
            </span>
            <p className="text-sm text-gray-700">{sectorAnalysis.action}</p>
          </div>
        </div>
      )}
    </div>
  )
}
