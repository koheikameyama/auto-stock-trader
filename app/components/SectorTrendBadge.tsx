"use client"

import { useTranslations } from "next-intl"

interface SectorTrendBadgeProps {
  compositeScore: number
  trendDirection: string
}

function getTrendStyle(score: number): { bg: string; icon: string; key: string } {
  if (score >= 40) return { bg: "bg-green-200 text-green-800", icon: "▲", key: "strongTailwind" }
  if (score >= 20) return { bg: "bg-green-100 text-green-700", icon: "▲", key: "tailwind" }
  if (score <= -40) return { bg: "bg-red-200 text-red-800", icon: "▼", key: "strongHeadwind" }
  if (score <= -20) return { bg: "bg-red-100 text-red-700", icon: "▼", key: "headwind" }
  return { bg: "bg-gray-100 text-gray-500", icon: "ー", key: "neutral" }
}

export default function SectorTrendBadge({ compositeScore }: SectorTrendBadgeProps) {
  const t = useTranslations("stocks.sectorTrend")
  const style = getTrendStyle(compositeScore)

  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${style.bg} ml-1.5`}>
      {style.icon} {t(style.key)}
    </span>
  )
}
