"use client"

import { useTranslations } from "next-intl"
import CopyableTicker, { copyTicker } from "./CopyableTicker"
import SectorTrendBadge from "./SectorTrendBadge"

interface StockHeaderProps {
  name: string
  tickerCode: string
  sector?: string | null
  sectorTrend?: { compositeScore: number; trendDirection: string }
  badge?: string
  badgeClassName?: string
}

export default function StockHeader({ name, tickerCode, sector, sectorTrend, badge, badgeClassName }: StockHeaderProps) {
  const t = useTranslations("stocks.stockHeader")
  const handleNameClick = () => {
    copyTicker(tickerCode)
  }

  return (
    <div className="mb-6 sm:mb-8">
      {badge && (
        <div className="flex items-center gap-2 mb-1">
          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${badgeClassName || "bg-gray-100 text-gray-600"}`}>
            {badge}
          </span>
        </div>
      )}
      <h1
        onClick={handleNameClick}
        className="text-2xl sm:text-3xl font-bold text-gray-900 cursor-pointer hover:text-blue-600 active:text-blue-700 transition-colors"
        title={t("tapToCopy")}
      >
        {name}
      </h1>
      <p className="text-sm text-gray-500 mt-1 flex items-center flex-wrap gap-y-0.5">
        <span>
          <CopyableTicker tickerCode={tickerCode} />
          {sector && ` • ${sector}`}
        </span>
        {sectorTrend && <SectorTrendBadge compositeScore={sectorTrend.compositeScore} trendDirection={sectorTrend.trendDirection} />}
      </p>
    </div>
  )
}
