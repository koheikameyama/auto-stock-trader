"use client"

import { ReactNode, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import BackButton from "./BackButton"
import StockHeader from "./StockHeader"
import { copyTicker } from "./CopyableTicker"

interface StockDetailLayoutProps {
  name: string
  tickerCode: string
  sector?: string | null
  sectorTrend?: { compositeScore: number; trendDirection: string }
  badge?: string
  badgeClassName?: string
  backHref?: string
  children: ReactNode
}

export default function StockDetailLayout({
  name,
  tickerCode,
  sector,
  sectorTrend,
  badge,
  badgeClassName,
  backHref,
  children,
}: StockDetailLayoutProps) {
  const t = useTranslations("stocks.detailLayout")
  const [showStickyHeader, setShowStickyHeader] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      // 100px以上スクロールしたらstickyヘッダーを表示
      setShowStickyHeader(window.scrollY > 100)
    }

    window.addEventListener("scroll", handleScroll, { passive: true })
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  const handleCopy = () => {
    copyTicker(tickerCode)
  }

  return (
    <>
      {/* Sticky Header */}
      <div
        className={`fixed top-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-sm border-b border-gray-200 shadow-sm transition-transform duration-200 ${
          showStickyHeader ? "translate-y-0" : "-translate-y-full"
        }`}
      >
        <div className="max-w-2xl mx-auto px-4 py-2 flex items-center gap-3">
          <button
            onClick={() => window.history.back()}
            className="p-1 -ml-1 text-gray-600 hover:text-gray-900"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div
            onClick={handleCopy}
            className="flex-1 min-w-0 cursor-pointer hover:text-blue-600 transition-colors"
            title={t("tapToCopy")}
          >
            <p className="text-sm font-bold text-gray-900 truncate">{name}</p>
            <p className="text-xs text-gray-500">{tickerCode}</p>
          </div>
        </div>
      </div>

      <BackButton href={backHref} />
      <StockHeader
        name={name}
        tickerCode={tickerCode}
        sector={sector}
        sectorTrend={sectorTrend}
        badge={badge}
        badgeClassName={badgeClassName}
      />
      {children}
    </>
  )
}
