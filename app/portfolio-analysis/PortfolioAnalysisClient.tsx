"use client"

import Link from "next/link"
import DailyMarketNavigator from "@/app/dashboard/DailyMarketNavigator"
import { useMarkPageSeen } from "@/app/hooks/useMarkPageSeen"
import { useTranslations } from "next-intl"

interface Props {
  portfolioCount: number
  watchlistCount: number
}

export default function PortfolioAnalysisClient({
  portfolioCount,
  watchlistCount,
}: Props) {
  const t = useTranslations("dashboard.marketNavigator")
  // ページ訪問時に閲覧済みをマーク
  useMarkPageSeen("portfolio-analysis")

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard"
          className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <svg
            className="w-5 h-5 text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </Link>
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            {t("title")}
          </h1>
          <p className="text-sm text-gray-500">
            {t("subtitle")}
          </p>
        </div>
      </div>

      {/* 総評コンテンツ */}
      <DailyMarketNavigator
        portfolioCount={portfolioCount}
        watchlistCount={watchlistCount}
      />
    </div>
  )
}
