"use client"

import { useState, useEffect } from "react"
import { useTranslations } from "next-intl"
import { DAILY_MARKET_NAVIGATOR } from "@/lib/constants"
import type { GapDirection, GapSeverity } from "@/lib/gap-prediction"

interface PreMarketIndicator {
  close: number
  changeRate: number
}

interface MarketGapData {
  nikkeiFutures: PreMarketIndicator | null
  usdjpy: PreMarketIndicator | null
  sp500: PreMarketIndicator | null
  nasdaq: PreMarketIndicator | null
  vix: PreMarketIndicator | null
  wti: PreMarketIndicator | null
  estimatedGapRate: number
  gapDirection: GapDirection
  severity: GapSeverity
}

interface StockGapData {
  stockId: string
  tickerCode: string
  name: string
  sector: string | null
  latestPrice: number | null
  betaFactor: number
  estimatedGapRate: number
  gapDirection: GapDirection
  severity: GapSeverity
}

interface GapPredictionResponse {
  date: string
  market: MarketGapData
  stocks: StockGapData[]
}

function formatChangeRate(rate: number): { text: string; color: string } {
  const sign = rate >= 0 ? "+" : ""
  return {
    text: `${sign}${rate.toFixed(2)}%`,
    color: rate > 0 ? "text-green-600" : rate < 0 ? "text-red-600" : "text-gray-600",
  }
}

function isMorningSession(): boolean {
  const now = new Date()
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }))
  const hour = jst.getHours()
  return hour >= 7 && hour < DAILY_MARKET_NAVIGATOR.EVENING_SESSION_START_HOUR
}

function Skeleton() {
  return (
    <div className="mb-4 sm:mb-6 bg-white rounded-xl p-4 shadow-sm border border-gray-200">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-6 h-6 rounded bg-gray-200 animate-pulse" />
        <div className="h-5 w-48 bg-gray-200 rounded animate-pulse" />
      </div>
      <div className="space-y-3">
        <div className="h-16 bg-gray-200 rounded-lg animate-pulse" />
        <div className="h-12 bg-gray-200 rounded-lg animate-pulse" />
      </div>
    </div>
  )
}

function IndicatorRow({
  label,
  description,
  indicator,
  invertColor = false,
}: {
  label: string
  description: string
  indicator: PreMarketIndicator | null
  invertColor?: boolean
}) {
  if (!indicator) return null
  const change = formatChangeRate(indicator.changeRate)
  const color = invertColor
    ? (indicator.changeRate > 0 ? "text-red-600" : indicator.changeRate < 0 ? "text-green-600" : "text-gray-600")
    : change.color

  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-800">{label}</div>
        <div className="text-xs text-gray-500 truncate">{description}</div>
      </div>
      <div className="text-right shrink-0 ml-3">
        <div className="text-sm font-mono text-gray-700">
          {indicator.close.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </div>
        <div className={`text-xs font-semibold ${color}`}>{change.text}</div>
      </div>
    </div>
  )
}

function SeverityBadge({ severity, t }: { severity: GapSeverity; t: (key: string) => string }) {
  const config: Record<GapSeverity, { bg: string; text: string; label: string }> = {
    high: { bg: "bg-red-100", text: "text-red-700", label: t("severityHigh") },
    medium: { bg: "bg-amber-100", text: "text-amber-700", label: t("severityMedium") },
    low: { bg: "bg-gray-100", text: "text-gray-600", label: t("severityLow") },
  }
  const c = config[severity]
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${c.bg} ${c.text}`}>
      {c.label}
    </span>
  )
}

function GapDirectionDisplay({
  direction,
  rate,
  t,
}: {
  direction: GapDirection
  rate: number
  t: (key: string) => string
}) {
  const config: Record<GapDirection, { icon: string; bg: string; border: string; text: string; labelKey: string; descKey: string }> = {
    up: { icon: "↑", bg: "bg-green-50", border: "border-green-200", text: "text-green-700", labelKey: "gapUp", descKey: "gapUpDesc" },
    down: { icon: "↓", bg: "bg-red-50", border: "border-red-200", text: "text-red-700", labelKey: "gapDown", descKey: "gapDownDesc" },
    flat: { icon: "→", bg: "bg-gray-50", border: "border-gray-200", text: "text-gray-700", labelKey: "flat", descKey: "flatDesc" },
  }
  const c = config[direction]
  const change = formatChangeRate(rate)

  return (
    <div className={`rounded-lg ${c.bg} border ${c.border} p-3`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-lg ${c.text}`}>{c.icon}</span>
          <span className={`text-sm font-semibold ${c.text}`}>{t(c.labelKey)}</span>
        </div>
        <span className={`text-lg font-bold font-mono ${change.color}`}>{change.text}</span>
      </div>
      <p className="text-xs text-gray-500 mt-1">{t(c.descKey)}</p>
    </div>
  )
}

export default function GapPredictionCard() {
  const t = useTranslations("dashboard.gapPrediction")
  const [data, setData] = useState<GapPredictionResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // morningセッション時のみ表示
    if (!isMorningSession()) {
      setLoading(false)
      setVisible(false)
      return
    }
    setVisible(true)

    const fetchData = async () => {
      try {
        const res = await fetch("/api/gap-prediction")
        if (!res.ok) throw new Error("Failed to fetch")
        const json = await res.json()
        setData(json.data !== null ? json : null)
      } catch (e) {
        console.error("Gap prediction fetch error:", e)
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  if (!visible) return null
  if (loading) return <Skeleton />
  if (!data || !data.market) return null

  const { market, stocks } = data

  return (
    <div className="mb-4 sm:mb-6 bg-white rounded-xl p-4 shadow-sm border border-gray-200">
      {/* ヘッダー */}
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">📊</span>
        <h2 className="text-base font-bold text-gray-900">{t("title")}</h2>
        <SeverityBadge severity={market.severity} t={t} />
      </div>
      <p className="text-xs text-gray-500 mb-3">{t("subtitle")}</p>

      {/* 海外市場データ */}
      <div className="mb-3">
        <div className="text-xs font-semibold text-gray-600 mb-1">{t("marketOverview")}</div>
        <div className="bg-gray-50 rounded-lg px-3 py-1">
          <IndicatorRow
            label={t("nikkeiFutures")}
            description={t("nikkeiFuturesDesc")}
            indicator={market.nikkeiFutures}
          />
          <IndicatorRow
            label={t("usdjpy")}
            description={t("usdjpyDesc")}
            indicator={market.usdjpy}
          />
          <IndicatorRow
            label={t("sp500")}
            description={t("sp500Desc")}
            indicator={market.sp500}
          />
          <IndicatorRow
            label={t("nasdaq")}
            description={t("nasdaqDesc")}
            indicator={market.nasdaq}
          />
          <IndicatorRow
            label={t("vix")}
            description={t("vixDesc")}
            indicator={market.vix}
            invertColor
          />
          <IndicatorRow
            label={t("wti")}
            description={t("wtiDesc")}
            indicator={market.wti}
          />
        </div>
      </div>

      {/* 市場全体のギャップ推定 */}
      <div className="mb-3">
        <div className="text-xs font-semibold text-gray-600 mb-1">{t("marketEstimate")}</div>
        <GapDirectionDisplay
          direction={market.gapDirection}
          rate={market.estimatedGapRate}
          t={t}
        />
      </div>

      {/* 要注意の保有銘柄 */}
      {stocks.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-600 mb-1">{t("attentionStocks")}</div>
          <p className="text-xs text-gray-500 mb-2">{t("attentionStocksDesc")}</p>
          <div className="space-y-2">
            {stocks.map((stock) => {
              const change = formatChangeRate(stock.estimatedGapRate)
              return (
                <div
                  key={stock.stockId}
                  className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-500 font-mono">{stock.tickerCode}</span>
                      <span className="text-sm font-medium text-gray-800 truncate">{stock.name}</span>
                      <SeverityBadge severity={stock.severity} t={t} />
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {stock.latestPrice && (
                        <span className="text-xs text-gray-500">
                          {stock.latestPrice.toLocaleString()}{t("estimatedGap")}
                        </span>
                      )}
                      <span className="text-xs text-gray-400">
                        {t("beta")}: {stock.betaFactor.toFixed(1)}x
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0 ml-3">
                    <span className={`text-sm font-bold font-mono ${change.color}`}>
                      {change.text}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
