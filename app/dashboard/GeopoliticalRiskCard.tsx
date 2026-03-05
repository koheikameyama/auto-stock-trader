"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"

interface GeopoliticalNewsItem {
  id: string
  title: string
  sentiment: string | null
  category: string
  impactSectors: string | null
  impactDirection: string | null
  impactSummary: string | null
  publishedAt: string
  market: string
}

type RiskLevel = "stable" | "caution" | "alert"

const RISK_COLORS: Record<RiskLevel, string> = {
  stable: "bg-green-100 text-green-800",
  caution: "bg-amber-100 text-amber-800",
  alert: "bg-red-100 text-red-800",
}

const RISK_BORDER_COLORS: Record<RiskLevel, string> = {
  stable: "border-gray-200",
  caution: "border-amber-300",
  alert: "border-red-300",
}

export default function GeopoliticalRiskCard() {
  const t = useTranslations("dashboard.geopoliticalRisk")
  const router = useRouter()
  const [news, setNews] = useState<GeopoliticalNewsItem[]>([])
  const [riskLevel, setRiskLevel] = useState<RiskLevel>("stable")
  const [riskScore, setRiskScore] = useState<number>(0)
  const [riskFactors, setRiskFactors] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchNews() {
      try {
        const res = await fetch("/api/news/geopolitical")
        if (!res.ok) return
        const data = await res.json()
        setNews(data.news ?? [])
        setRiskLevel(data.riskLevel ?? "stable")
        setRiskScore(data.riskScore ?? 0)
        setRiskFactors(data.riskFactors ?? [])
      } catch {
        // エラー時は空表示
      } finally {
        setLoading(false)
      }
    }
    fetchNews()
  }, [])

  if (loading) return null

  const displayNews = news.slice(0, 3)
  const isDefenseActive = riskLevel !== "stable"

  return (
    <div className={`mt-4 sm:mt-6 bg-white rounded-xl p-4 shadow-sm border ${RISK_BORDER_COLORS[riskLevel]}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm sm:text-base font-bold text-gray-900 flex items-center gap-2">
          <span>🌍</span> {t("title")}
        </h3>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${RISK_COLORS[riskLevel]}`}
        >
          {t(`riskLevel.${riskLevel}`)}
        </span>
      </div>

      {isDefenseActive && (
        <div className={`mb-3 p-3 rounded-lg ${riskLevel === "alert" ? "bg-red-50" : "bg-amber-50"}`}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold text-gray-700">
              {t("defenseModeActive")}
            </span>
            <span className="text-xs text-gray-500">
              {t("riskScore")}: {riskScore}
            </span>
          </div>
          <p className={`text-xs ${riskLevel === "alert" ? "text-red-700" : "text-amber-700"}`}>
            {t(`actionAdvice.${riskLevel}`)}
          </p>
          {riskFactors.length > 0 && (
            <p className="text-xs text-gray-500 mt-1">
              {t("factors")}: {riskFactors.join("、")}
            </p>
          )}
        </div>
      )}

      {displayNews.length === 0 && !isDefenseActive ? (
        <p className="text-sm text-gray-500">{t("noRisk")}</p>
      ) : (
        <div className="space-y-2">
          {displayNews.map((item) => {
            let sectors: string[] = []
            try {
              sectors = item.impactSectors
                ? JSON.parse(item.impactSectors)
                : []
            } catch {
              /* ignore */
            }
            const directionKey =
              item.impactDirection === "positive"
                ? "impactPositive"
                : item.impactDirection === "negative"
                  ? "impactNegative"
                  : "impactMixed"
            return (
              <div key={item.id} className="text-sm">
                <span className="font-medium">
                  {item.title.length > 25
                    ? item.title.slice(0, 25) + "..."
                    : item.title}
                </span>
                {sectors.length > 0 && (
                  <span className="text-gray-500">
                    {" → "}
                    {sectors.join(", ")}
                    {t(directionKey)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
      {news.length > 0 && (
        <button
          onClick={() => router.push("/news?filter=IMPACT")}
          className="mt-3 text-xs text-blue-600 hover:underline"
        >
          {t("viewMore")}
        </button>
      )}
    </div>
  )
}
