"use client"

import { useTranslations } from "next-intl"

interface MarketShieldBannerProps {
  triggerType: string
  triggerValue: number
}

const TRIGGER_LABELS: Record<string, string> = {
  nikkei_crash: "日経225急落",
  vix_spike: "VIX急騰",
  wti_shock: "WTI原油急変動",
  fx_shock: "為替急変動",
}

export default function MarketShieldBanner({
  triggerType,
  triggerValue,
}: MarketShieldBannerProps) {
  const t = useTranslations("dashboard.marketNavigator.marketShield")

  const triggerLabel = TRIGGER_LABELS[triggerType] || triggerType
  const valueDisplay =
    triggerType === "vix_spike" && triggerValue > 20
      ? `VIX: ${triggerValue.toFixed(1)}`
      : `${triggerValue > 0 ? "+" : ""}${triggerValue.toFixed(1)}%`

  return (
    <div className="rounded-lg border-2 border-red-300 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/30">
      <div className="flex items-center gap-2">
        <span className="text-lg">🛡️</span>
        <div className="flex-1">
          <div className="text-sm font-bold text-red-700 dark:text-red-400">
            {t("title")}
          </div>
          <div className="text-xs text-red-600 dark:text-red-400">
            {triggerLabel}: {valueDisplay} | {t("description")}
          </div>
        </div>
      </div>
    </div>
  )
}
