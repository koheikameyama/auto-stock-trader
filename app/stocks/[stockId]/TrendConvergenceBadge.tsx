"use client"

import { useTranslations } from "next-intl"

interface TrendConvergenceData {
  divergenceType: string
  estimatedConvergenceDays: number | null
  confidence: string
  waitSuggestion: string
  keyLevelToWatch: number | null
  triggerCondition: string
}

interface TrendConvergenceBadgeProps {
  trendConvergence: TrendConvergenceData | null | undefined
}

export default function TrendConvergenceBadge({
  trendConvergence,
}: TrendConvergenceBadgeProps) {
  const t = useTranslations("stocks.trendConvergence")

  if (!trendConvergence || trendConvergence.divergenceType === "aligned") {
    return null
  }

  const isShortDown = trendConvergence.divergenceType === "short_down_long_up"

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3 dark:border-blue-800 dark:bg-blue-950/20">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm">📊</span>
        <span className="text-xs font-bold text-blue-700 dark:text-blue-400">
          {t("title")}
        </span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            isShortDown
              ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
              : "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
          }`}
        >
          {isShortDown ? t("shortDownLongUp") : t("shortUpLongDown")}
        </span>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        {trendConvergence.estimatedConvergenceDays != null && (
          <div>
            {t("convergenceDays", {
              days: trendConvergence.estimatedConvergenceDays,
            })}
          </div>
        )}
        {trendConvergence.keyLevelToWatch != null && (
          <div>
            {t("keyLevel", {
              price: trendConvergence.keyLevelToWatch.toLocaleString(),
            })}
          </div>
        )}
        <div>{trendConvergence.waitSuggestion}</div>
        <div className="text-[10px] text-muted-foreground/60">
          {t("triggerLabel")}: {trendConvergence.triggerCondition}
        </div>
      </div>
    </div>
  )
}
