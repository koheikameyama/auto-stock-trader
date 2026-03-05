import { FETCH_FAIL_WARNING_THRESHOLD } from "@/lib/constants"
import { useTranslations } from "next-intl"

interface DelistedWarningProps {
  isDelisted: boolean
  fetchFailCount: number
  delistingNewsDetectedAt?: string | null
  delistingNewsReason?: string | null
  compact?: boolean
}

export default function DelistedWarning({ isDelisted, fetchFailCount, delistingNewsDetectedAt, delistingNewsReason, compact = false }: DelistedWarningProps) {
  const t = useTranslations('stocks.delistedWarning')

  if (delistingNewsDetectedAt) {
    if (compact) {
      return (
        <p className="text-xs text-red-700">
          {t('delistingNewsCompact')}
        </p>
      )
    }
    return (
      <div className="bg-red-50 border-l-4 border-red-400 p-3 mb-4">
        <p className="text-xs font-medium text-red-800">
          {t('delistingNewsTitle')}
        </p>
        {delistingNewsReason && (
          <p className="text-xs text-red-700 mt-1">
            {delistingNewsReason}
          </p>
        )}
      </div>
    )
  }

  if (isDelisted) {
    if (compact) {
      return (
        <p className="text-xs text-red-700">
          {t('dataUnavailableCompact')}
        </p>
      )
    }
    return (
      <div className="bg-red-50 border-l-4 border-red-400 p-3 mb-4">
        <p className="text-xs text-red-800">
          {t('dataUnavailable')}
        </p>
      </div>
    )
  }

  if (fetchFailCount >= FETCH_FAIL_WARNING_THRESHOLD) {
    if (compact) {
      return (
        <p className="text-xs text-amber-700">
          {t('fetchFailCompact')}
        </p>
      )
    }
    return (
      <div className="bg-amber-50 border-l-4 border-amber-400 p-3 mb-4">
        <p className="text-xs text-amber-800">
          {t('fetchFail')}
        </p>
      </div>
    )
  }

  return null
}
