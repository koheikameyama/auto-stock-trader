"use client"

import Link from "next/link"
import type { PortfolioSummary } from "@/store/types"
import { useTranslations } from "next-intl"

interface PerformanceSummaryProps {
  summary: PortfolioSummary
}

export default function PerformanceSummary({ summary }: PerformanceSummaryProps) {
  const t = useTranslations("dashboard.performanceSummary")
  const hasSoldStocks = summary.winCount + summary.loseCount > 0

  return (
    <div className="mt-4 sm:mt-6">
      <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
              <span className="text-lg">📈</span>
            </div>
            <span className="text-sm font-semibold text-gray-900">{t("title")}</span>
          </div>
          {hasSoldStocks && (
            <Link
              href="/my-stocks?tab=sold"
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-blue-500 transition-colors"
            >
              <span>{t("saleHistory")}</span>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          )}
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
          {/* トータル損益 */}
          <div className="text-center">
            <div className="text-xs text-gray-500 mb-1">{t("totalGain")}</div>
            <div
              className={`text-base sm:text-lg font-bold ${
                summary.totalGain >= 0 ? "text-green-600" : "text-red-600"
              }`}
            >
              {summary.totalGain >= 0 ? "+" : ""}
              ¥{Math.round(summary.totalGain).toLocaleString()}
            </div>
            <div className={`text-[10px] ${
              summary.totalGainPercent >= 0 ? "text-green-500" : "text-red-500"
            }`}>
              {summary.totalGainPercent >= 0 ? "+" : ""}
              {summary.totalGainPercent.toFixed(1)}%
            </div>
          </div>

          {/* 前日比 */}
          <div className="text-center">
            <div className="text-xs text-gray-500 mb-1">{t("dailyChange")}</div>
            <div
              className={`text-base sm:text-lg font-bold ${
                summary.dailyChange >= 0 ? "text-green-600" : "text-red-600"
              }`}
            >
              {summary.dailyChange >= 0 ? "+" : ""}
              ¥{Math.round(summary.dailyChange).toLocaleString()}
            </div>
            <div className={`text-[10px] ${
              summary.dailyChangePercent >= 0 ? "text-green-500" : "text-red-500"
            }`}>
              {summary.dailyChangePercent >= 0 ? "+" : ""}
              {summary.dailyChangePercent.toFixed(1)}%
            </div>
          </div>

          {/* 確定損益 */}
          <div className="text-center">
            <div className="text-xs text-gray-500 mb-1">{t("realizedGain")}</div>
            {hasSoldStocks ? (
              <div
                className={`text-base sm:text-lg font-bold ${
                  summary.realizedGain >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                {summary.realizedGain >= 0 ? "+" : ""}
                ¥{Math.round(summary.realizedGain).toLocaleString()}
              </div>
            ) : (
              <div className="text-base sm:text-lg font-bold text-gray-400">-</div>
            )}
          </div>

          {/* 勝率 */}
          <div className="text-center">
            <div className="text-xs text-gray-500 mb-1">{t("winRate")}</div>
            {hasSoldStocks ? (
              <>
                <div className="text-base sm:text-lg font-bold text-gray-900">
                  {summary.winRate !== null ? `${summary.winRate.toFixed(0)}%` : "-"}
                </div>
                <div className="text-[10px] text-gray-400">
                  {t("winLose", { win: summary.winCount, lose: summary.loseCount })}
                </div>
              </>
            ) : (
              <div className="text-base sm:text-lg font-bold text-gray-400">-</div>
            )}
          </div>

          {/* 平均リターン */}
          <div className="text-center">
            <div className="text-xs text-gray-500 mb-1">{t("averageReturn")}</div>
            {summary.averageReturn !== null ? (
              <div
                className={`text-base sm:text-lg font-bold ${
                  summary.averageReturn >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                {summary.averageReturn >= 0 ? "+" : ""}
                {summary.averageReturn.toFixed(1)}%
              </div>
            ) : (
              <div className="text-base sm:text-lg font-bold text-gray-400">-</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
