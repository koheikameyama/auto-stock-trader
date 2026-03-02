"use client"

import { useState, useEffect } from "react"
import { useTranslations } from "next-intl"

interface ConfidenceData {
  bucket: string
  count: number
  successRate: number
  avgReturn: number
}

interface SectorData {
  sector: string
  count: number
  successRate: number
  avgReturn: number
  excessReturn: number | null
}

interface PredictionData {
  prediction: string
  count: number
  successRate: number
  avgReturn: number
}

interface TimeHorizonData {
  horizon: string
  count: number
  successRate: number | null
  avgReturn: number | null
}

interface BenchmarkData {
  period: string
  aiReturn: number | null
  benchmarkReturn: number | null
  excess: number | null
}

interface MarketConditionData {
  condition: string
  label: string
  count: number
  successRate: number
  avgReturn: number
}

interface StockCharacteristicItem {
  category: string
  label: string
  count: number
  successRate: number
  avgReturn: number
}

interface AnalysisResponse {
  byConfidence: ConfidenceData[]
  bySector: SectorData[]
  byPrediction: PredictionData[]
  byTimeHorizon: TimeHorizonData[]
  benchmark: BenchmarkData[]
  byMarketCondition: MarketConditionData[]
  byStockCharacteristics: {
    byMarketCap: StockCharacteristicItem[]
    byVolatility: StockCharacteristicItem[]
  }
  message?: string
}

function formatPercent(value: number | null): string {
  if (value === null) return "---"
  const sign = value >= 0 ? "+" : ""
  return `${sign}${value.toFixed(1)}%`
}

export default function AnalysisTab() {
  const t = useTranslations('analysis.analysisTab')
  const tPredictions = useTranslations('analysis.outcomesTab.predictions')
  const tErrors = useTranslations('analysis.aiReport')
  const tConfidence = useTranslations('analysis.analysisTab.confidenceCalibration')
  const tSector = useTranslations('analysis.analysisTab.sectorPerformance')
  const tPredictionPerf = useTranslations('analysis.analysisTab.predictionPerformance')
  const tTimeHorizon = useTranslations('analysis.analysisTab.timeHorizon')
  const tBenchmark = useTranslations('analysis.analysisTab.benchmark')
  const tMarketCondition = useTranslations('analysis.analysisTab.marketCondition')
  const tStockChara = useTranslations('analysis.analysisTab.stockCharacteristics')
  const [data, setData] = useState<AnalysisResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const formatPrediction = (prediction: string): string => {
    const labels: Record<string, string> = {
      buy: tPredictions('buy'),
      stay: tPredictions('stay'),
      remove: tPredictions('remove'),
      up: tPredictions('up'),
      down: tPredictions('down'),
      neutral: tPredictions('neutral'),
    }
    return labels[prediction] || prediction
  }

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch("/api/reports/recommendation-outcomes/analysis?days=30")
        if (!response.ok) throw new Error(tErrors('fetchError'))
        const result = await response.json()
        setData(result)
      } catch (err) {
        console.error("Error fetching analysis:", err)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [tErrors])

  if (loading) {
    return (
      <div className="space-y-6">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-40 bg-gray-100 rounded-lg animate-pulse" />
        ))}
      </div>
    )
  }

  if (!data || data.message) {
    return (
      <div className="text-center py-12 text-gray-500">
        <span className="text-4xl mb-4 block">📈</span>
        <p>{data?.message || t('noData')}</p>
        <p className="text-sm mt-2">{t('noDataDescription')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 信頼度キャリブレーション */}
      {data.byConfidence.length > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-4">{tConfidence('title')}</h3>
          <p className="text-sm text-gray-500 mb-4">
            {tConfidence('description')}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-2 text-gray-600">{tConfidence('confidence')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tConfidence('count')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tConfidence('successRate7Days')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tConfidence('avgReturn')}</th>
                </tr>
              </thead>
              <tbody>
                {data.byConfidence.map((row) => (
                  <tr key={row.bucket} className="border-b border-gray-100">
                    <td className="py-2 px-2 text-gray-900 font-medium">{row.bucket}</td>
                    <td className="py-2 px-2 text-right text-gray-700">{row.count}</td>
                    <td className="py-2 px-2 text-right">
                      <span className={`font-medium ${row.successRate >= 70 ? "text-green-600" : row.successRate >= 50 ? "text-yellow-600" : "text-red-600"}`}>
                        {row.successRate}%
                      </span>
                    </td>
                    <td className={`py-2 px-2 text-right font-medium ${row.avgReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {formatPercent(row.avgReturn)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* セクター別 */}
      {data.bySector.length > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-4">{tSector('title')}</h3>
          <p className="text-sm text-gray-500 mb-4">
            {tSector('description')}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-2 text-gray-600">{tSector('sector')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tSector('count')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tSector('successRate7Days')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tSector('avgReturn')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tSector('vsNikkei')}</th>
                </tr>
              </thead>
              <tbody>
                {data.bySector.slice(0, 10).map((row) => (
                  <tr key={row.sector} className="border-b border-gray-100">
                    <td className="py-2 px-2 text-gray-900">{row.sector}</td>
                    <td className="py-2 px-2 text-right text-gray-700">{row.count}</td>
                    <td className="py-2 px-2 text-right">
                      <span className={`font-medium ${row.successRate >= 70 ? "text-green-600" : row.successRate >= 50 ? "text-yellow-600" : "text-red-600"}`}>
                        {row.successRate}%
                      </span>
                    </td>
                    <td className={`py-2 px-2 text-right font-medium ${row.avgReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {formatPercent(row.avgReturn)}
                    </td>
                    <td className={`py-2 px-2 text-right font-medium ${
                      row.excessReturn !== null
                        ? row.excessReturn >= 0 ? "text-green-600" : "text-red-600"
                        : "text-gray-400"
                    }`}>
                      {formatPercent(row.excessReturn)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 予測種類別 */}
      {data.byPrediction.length > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-4">{tPredictionPerf('title')}</h3>
          <p className="text-sm text-gray-500 mb-4">
            {tPredictionPerf('description')}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-2 text-gray-600">{tPredictionPerf('prediction')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tPredictionPerf('count')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tPredictionPerf('successRate7Days')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tPredictionPerf('avgReturn')}</th>
                </tr>
              </thead>
              <tbody>
                {data.byPrediction.map((row) => (
                  <tr key={row.prediction} className="border-b border-gray-100">
                    <td className="py-2 px-2 text-gray-900 font-medium">{formatPrediction(row.prediction)}</td>
                    <td className="py-2 px-2 text-right text-gray-700">{row.count}</td>
                    <td className="py-2 px-2 text-right">
                      <span className={`font-medium ${row.successRate >= 70 ? "text-green-600" : row.successRate >= 50 ? "text-yellow-600" : "text-red-600"}`}>
                        {row.successRate}%
                      </span>
                    </td>
                    <td className={`py-2 px-2 text-right font-medium ${row.avgReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {formatPercent(row.avgReturn)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 時間枠別 */}
      {data.byTimeHorizon.length > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-4">{tTimeHorizon('title')}</h3>
          <p className="text-sm text-gray-500 mb-4">
            {tTimeHorizon('description')}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-2 text-gray-600">{tTimeHorizon('horizon')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tTimeHorizon('evaluatedCount')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tTimeHorizon('successRate')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tTimeHorizon('avgReturn')}</th>
                </tr>
              </thead>
              <tbody>
                {data.byTimeHorizon.map((row) => (
                  <tr key={row.horizon} className="border-b border-gray-100">
                    <td className="py-2 px-2 text-gray-900 font-medium">{row.horizon}</td>
                    <td className="py-2 px-2 text-right text-gray-700">{row.count}</td>
                    <td className="py-2 px-2 text-right">
                      {row.successRate !== null ? (
                        <span className={`font-medium ${row.successRate >= 70 ? "text-green-600" : row.successRate >= 50 ? "text-yellow-600" : "text-red-600"}`}>
                          {row.successRate}%
                        </span>
                      ) : "---"}
                    </td>
                    <td className={`py-2 px-2 text-right font-medium ${
                      row.avgReturn !== null
                        ? row.avgReturn >= 0 ? "text-green-600" : "text-red-600"
                        : "text-gray-400"
                    }`}>
                      {formatPercent(row.avgReturn)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ベンチマーク比較 */}
      {data.benchmark.length > 0 && data.benchmark.some(b => b.aiReturn !== null) && (
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-4">{tBenchmark('title')}</h3>
          <p className="text-sm text-gray-500 mb-4">
            {tBenchmark('description')}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-2 text-gray-600">{tBenchmark('period')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tBenchmark('aiAverage')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tBenchmark('nikkei225')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tBenchmark('excessReturn')}</th>
                </tr>
              </thead>
              <tbody>
                {data.benchmark.map((row) => (
                  <tr key={row.period} className="border-b border-gray-100">
                    <td className="py-2 px-2 text-gray-900 font-medium">{row.period}</td>
                    <td className={`py-2 px-2 text-right font-medium ${
                      row.aiReturn !== null
                        ? row.aiReturn >= 0 ? "text-green-600" : "text-red-600"
                        : "text-gray-400"
                    }`}>
                      {formatPercent(row.aiReturn)}
                    </td>
                    <td className={`py-2 px-2 text-right font-medium ${
                      row.benchmarkReturn !== null
                        ? row.benchmarkReturn >= 0 ? "text-green-600" : "text-red-600"
                        : "text-gray-400"
                    }`}>
                      {formatPercent(row.benchmarkReturn)}
                    </td>
                    <td className={`py-2 px-2 text-right font-bold ${
                      row.excess !== null
                        ? row.excess >= 0 ? "text-green-600" : "text-red-600"
                        : "text-gray-400"
                    }`}>
                      {formatPercent(row.excess)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 市況別パフォーマンス */}
      {data.byMarketCondition.length > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-4">{tMarketCondition('title')}</h3>
          <p className="text-sm text-gray-500 mb-4">
            {tMarketCondition('description')}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-2 text-gray-600">{tMarketCondition('condition')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tMarketCondition('count')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tMarketCondition('successRate7Days')}</th>
                  <th className="text-right py-2 px-2 text-gray-600">{tMarketCondition('avgReturn')}</th>
                </tr>
              </thead>
              <tbody>
                {data.byMarketCondition.map((row) => (
                  <tr key={row.condition} className="border-b border-gray-100">
                    <td className="py-2 px-2 text-gray-900 font-medium">{row.label}</td>
                    <td className="py-2 px-2 text-right text-gray-700">{row.count}</td>
                    <td className="py-2 px-2 text-right">
                      <span className={`font-medium ${row.successRate >= 70 ? "text-green-600" : row.successRate >= 50 ? "text-yellow-600" : "text-red-600"}`}>
                        {row.successRate}%
                      </span>
                    </td>
                    <td className={`py-2 px-2 text-right font-medium ${row.avgReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {formatPercent(row.avgReturn)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 銘柄特性別パフォーマンス */}
      {(data.byStockCharacteristics.byMarketCap.length > 0 || data.byStockCharacteristics.byVolatility.length > 0) && (
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <h3 className="text-lg font-bold text-gray-900 mb-4">{tStockChara('title')}</h3>
          <p className="text-sm text-gray-500 mb-4">
            {tStockChara('description')}
          </p>

          {data.byStockCharacteristics.byMarketCap.length > 0 && (
            <div className="mb-6">
              <h4 className="text-sm font-semibold text-gray-700 mb-3">{tStockChara('marketCap')}</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-2 px-2 text-gray-600">{tStockChara('category')}</th>
                      <th className="text-right py-2 px-2 text-gray-600">{tStockChara('count')}</th>
                      <th className="text-right py-2 px-2 text-gray-600">{tStockChara('successRate7Days')}</th>
                      <th className="text-right py-2 px-2 text-gray-600">{tStockChara('avgReturn')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byStockCharacteristics.byMarketCap.map((row) => (
                      <tr key={row.category} className="border-b border-gray-100">
                        <td className="py-2 px-2 text-gray-900">{row.label}</td>
                        <td className="py-2 px-2 text-right text-gray-700">{row.count}</td>
                        <td className="py-2 px-2 text-right">
                          <span className={`font-medium ${row.successRate >= 70 ? "text-green-600" : row.successRate >= 50 ? "text-yellow-600" : "text-red-600"}`}>
                            {row.successRate}%
                          </span>
                        </td>
                        <td className={`py-2 px-2 text-right font-medium ${row.avgReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                          {formatPercent(row.avgReturn)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.byStockCharacteristics.byVolatility.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-3">{tStockChara('volatility')}</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-2 px-2 text-gray-600">{tStockChara('category')}</th>
                      <th className="text-right py-2 px-2 text-gray-600">{tStockChara('count')}</th>
                      <th className="text-right py-2 px-2 text-gray-600">{tStockChara('successRate7Days')}</th>
                      <th className="text-right py-2 px-2 text-gray-600">{tStockChara('avgReturn')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byStockCharacteristics.byVolatility.map((row) => (
                      <tr key={row.category} className="border-b border-gray-100">
                        <td className="py-2 px-2 text-gray-900">{row.label}</td>
                        <td className="py-2 px-2 text-right text-gray-700">{row.count}</td>
                        <td className="py-2 px-2 text-right">
                          <span className={`font-medium ${row.successRate >= 70 ? "text-green-600" : row.successRate >= 50 ? "text-yellow-600" : "text-red-600"}`}>
                            {row.successRate}%
                          </span>
                        </td>
                        <td className={`py-2 px-2 text-right font-medium ${row.avgReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                          {formatPercent(row.avgReturn)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
