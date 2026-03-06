"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import dayjs from "dayjs"
import timezone from "dayjs/plugin/timezone"
import utc from "dayjs/plugin/utc"

dayjs.extend(utc)
dayjs.extend(timezone)
import TermTooltip from "@/app/components/TermTooltip"
import type {
  TechnicalIndicators,
  CandlestickPatternData,
  ChartPatternData,
  TrendlineAnalysisData,
  MAAlignmentData,
  SignalType,
} from "@/lib/stock-analysis-data"

interface TechnicalAnalysisData {
  technicalIndicators: TechnicalIndicators
  candlestickPattern: CandlestickPatternData | null
  chartPatterns: ChartPatternData[]
  weekChange: {
    rate: number
    label: string
    isWarning: boolean
  } | null
  trendlines: TrendlineAnalysisData | null
  maAlignment: MAAlignmentData | null
}

interface Props {
  stockId: string
  embedded?: boolean
  gapUpRate?: number | null
  volumeSpikeRate?: number | null
  turnoverValue?: number | null
  atr14?: number | null
  currentPrice?: number | null
}

function SignalBadge({ signal, size = "sm", t }: { signal: SignalType; size?: "sm" | "md"; t: (key: string) => string }) {
  const colors = {
    buy: "bg-green-100 text-green-700",
    sell: "bg-red-100 text-red-700",
    neutral: "bg-gray-100 text-gray-700",
  }
  const labelKeys = {
    buy: "signal.buy",
    sell: "signal.sell",
    neutral: "signal.neutral",
  }
  const sizeClass = size === "md" ? "px-2.5 py-1 text-sm" : "px-2 py-0.5 text-xs"

  return (
    <span className={`${colors[signal]} ${sizeClass} font-semibold rounded-full`}>
      {t(labelKeys[signal])}
    </span>
  )
}

function StrengthBar({ value, max = 100 }: { value: number; max?: number }) {
  const percent = Math.min((value / max) * 100, 100)
  const color =
    percent >= 70 ? "bg-green-500" :
    percent >= 40 ? "bg-yellow-500" :
    "bg-gray-400"

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full ${color} transition-all duration-300`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-xs text-gray-500 w-10 text-right">{value}%</span>
    </div>
  )
}

export default function TechnicalAnalysis({ stockId, embedded = false, gapUpRate, volumeSpikeRate, turnoverValue, atr14, currentPrice }: Props) {
  const tTooltip = useTranslations('stocks.tooltips')
  const t = useTranslations('stocks.technicalAnalysis')
  const [data, setData] = useState<TechnicalAnalysisData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isStaleData, setIsStaleData] = useState(false)

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        const response = await fetch(`/api/stocks/${stockId}/historical-prices?period=3m`)
        if (!response.ok) {
          throw new Error(t('errorFetch'))
        }
        const result = await response.json()
        setData(result.technicalAnalysis)

        // 最新データ日付と今日(JST)を比較して前場分析前かどうか判定
        const endDate = result.summary?.endDate
        if (endDate) {
          const todayJST = dayjs().tz("Asia/Tokyo").format("YYYY-MM-DD")
          const dayOfWeek = dayjs().tz("Asia/Tokyo").day()
          const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5
          setIsStaleData(endDate < todayJST && isWeekday)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('errorGeneral'))
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [stockId, t])

  if (loading) {
    return (
      <div className={embedded ? "" : "bg-white rounded-xl shadow-md p-4 sm:p-6"}>
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-gray-200 rounded w-1/3" />
          <div className="space-y-3">
            <div className="h-4 bg-gray-200 rounded w-full" />
            <div className="h-4 bg-gray-200 rounded w-3/4" />
            <div className="h-4 bg-gray-200 rounded w-1/2" />
          </div>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className={embedded ? "" : "bg-white rounded-xl shadow-md p-4 sm:p-6"}>
        <p className="text-sm text-gray-500">{t('errorNoData')}</p>
      </div>
    )
  }

  const { technicalIndicators, candlestickPattern, chartPatterns, weekChange, trendlines, maAlignment } = data

  const getDirectionLabel = (direction: string) => {
    if (direction === "up") return t('trendline.directionUp')
    if (direction === "down") return t('trendline.directionDown')
    return t('trendline.directionFlat')
  }

  return (
    <div className={embedded ? "" : "bg-white rounded-xl shadow-md p-4 sm:p-6"}>
      {!embedded && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-lg">📊</span>
          <h2 className="text-lg sm:text-xl font-bold text-gray-900 flex items-center">
            {t('title')}
          </h2>
        </div>
      )}

      {/* 前場分析前の注意バナー */}
      {isStaleData && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
          <span className="text-amber-500 mt-0.5 shrink-0">⚠️</span>
          <p className="text-xs text-amber-700">{t('staleDataWarning')}</p>
        </div>
      )}

      <div className="space-y-5">
        {/* サポート / レジスタンス価格 */}
        {trendlines && (trendlines.support || trendlines.resistance) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {trendlines.support && (
              <span className="text-green-700">
                {t('trendline.supportLine')} ¥{trendlines.support.currentProjectedPrice.toLocaleString()}
                <span className="ml-1 text-xs">
                  {trendlines.support.broken
                    ? t('trendline.supportBroken')
                    : t('trendline.supportHolding')}
                </span>
              </span>
            )}
            {trendlines.resistance && (
              <span className="text-red-700">
                {t('trendline.resistanceLine')} ¥{trendlines.resistance.currentProjectedPrice.toLocaleString()}
                <span className="ml-1 text-xs">
                  {trendlines.resistance.broken
                    ? t('trendline.resistanceBroken')
                    : t('trendline.resistanceHolding')}
                </span>
              </span>
            )}
          </div>
        )}

        {/* RSI */}
        {technicalIndicators.rsi && (
          <div className="border-b border-gray-100 pb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">RSI</span>
                <span className="text-xs text-gray-500">({t('rsi.subtitle')})</span>
                <TermTooltip id="ta-rsi" text={tTooltip('rsi')} />
              </div>
              <SignalBadge signal={technicalIndicators.rsi.signal} t={t} />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold text-gray-900">
                {technicalIndicators.rsi.value.toFixed(1)}
              </span>
              <div className="flex-1">
                <p className="text-sm text-gray-600">{technicalIndicators.rsi.label}</p>
                <p className="text-xs text-gray-500">{technicalIndicators.rsi.description}</p>
              </div>
            </div>
            {/* RSI ゲージ */}
            <div className="mt-2">
              <div className="relative h-2 bg-gradient-to-r from-green-400 via-gray-300 to-red-400 rounded-full">
                <div
                  className="absolute w-3 h-3 bg-gray-800 rounded-full -top-0.5 transform -translate-x-1/2 border-2 border-white shadow"
                  style={{ left: `${technicalIndicators.rsi.value}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>{t('rsi.oversold')}</span>
                <span>{t('rsi.overbought')}</span>
              </div>
            </div>
          </div>
        )}

        {/* MACD */}
        {technicalIndicators.macd && (
          <div className="border-b border-gray-100 pb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">MACD</span>
                <span className="text-xs text-gray-500">({t('macd.subtitle')})</span>
                <TermTooltip id="ta-macd" text={tTooltip('macd')} />
              </div>
              <span
                className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
                  technicalIndicators.macd.trend === "bullish"
                    ? "bg-green-100 text-green-700"
                    : technicalIndicators.macd.trend === "bearish"
                    ? "bg-red-100 text-red-700"
                    : "bg-gray-100 text-gray-700"
                }`}
              >
                {technicalIndicators.macd.trend === "bullish" ? t('macd.bullish') : technicalIndicators.macd.trend === "bearish" ? t('macd.bearish') : t('macd.sideways')}
              </span>
            </div>
            <p className="text-sm text-gray-600">{technicalIndicators.macd.label}</p>
            {technicalIndicators.macd.histogram !== null && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs text-gray-500">{t('macd.histogram')}</span>
                <span
                  className={`text-sm font-semibold ${
                    technicalIndicators.macd.histogram > 0 ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {technicalIndicators.macd.histogram > 0 ? "+" : ""}
                  {technicalIndicators.macd.histogram.toFixed(2)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* ローソク足パターン */}
        {candlestickPattern && (
          <div className="border-b border-gray-100 pb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">{t('candlestick.label')}</span>
                <TermTooltip id="ta-candlestick" text={tTooltip('candlestickPattern')} />
              </div>
              <SignalBadge signal={candlestickPattern.signal} t={t} />
            </div>
            <p className="text-sm text-gray-700 mb-2">{candlestickPattern.description}</p>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>{t('candlestick.strength')}</span>
              <div className="flex-1 max-w-32">
                <StrengthBar value={candlestickPattern.strength} />
              </div>
            </div>
            <div className="flex gap-4 mt-2 text-xs">
              <span className="text-green-600">
                {t('candlestick.recentBuySignals', { count: candlestickPattern.recentBuySignals })}
              </span>
              <span className="text-red-600">
                {t('candlestick.recentSellSignals', { count: candlestickPattern.recentSellSignals })}
              </span>
            </div>
          </div>
        )}

        {/* チャートパターン */}
        {chartPatterns.length > 0 && (
          <div className="border-b border-gray-100 pb-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm font-semibold text-gray-900">{t('chartPattern.label')}</span>
              <span className="text-xs text-gray-500">({t('chartPattern.subtitle')})</span>
              <TermTooltip id="ta-chart-pattern" text={tTooltip('chartPattern')} />
            </div>
            <div className="space-y-3">
              {chartPatterns.map((pattern, index) => (
                <div key={index} className="bg-gray-50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-gray-900">{pattern.name}</span>
                    <SignalBadge signal={pattern.signal} t={t} />
                  </div>
                  <p className="text-xs text-gray-600 mb-2">{pattern.description}</p>
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <span>{t('chartPattern.strength')}</span>
                    <div className="flex-1 max-w-24">
                      <StrengthBar value={pattern.reliability} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 移動平均線アライメント（パーフェクトオーダー） */}
        {maAlignment && (
          <div className="border-b border-gray-100 pb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">{t('maAlignment.label')}</span>
                <span className="text-xs text-gray-500">({t('maAlignment.subtitle')})</span>
              </div>
              <span
                className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
                  maAlignment.trend === "uptrend"
                    ? "bg-green-100 text-green-700"
                    : maAlignment.trend === "downtrend"
                    ? "bg-red-100 text-red-700"
                    : "bg-gray-100 text-gray-700"
                }`}
              >
                {maAlignment.trendLabel}
              </span>
            </div>
            <p className="text-sm text-gray-600 mb-2">{maAlignment.description}</p>
            {(maAlignment.sma5 !== null || maAlignment.sma25 !== null || maAlignment.sma75 !== null) && (
              <div className="flex gap-3 text-xs text-gray-500">
                {maAlignment.sma5 !== null && (
                  <span>{t('maAlignment.sma5')}: <span className="font-semibold text-gray-700">{maAlignment.sma5.toLocaleString()}</span></span>
                )}
                {maAlignment.sma25 !== null && (
                  <span>{t('maAlignment.sma25')}: <span className="font-semibold text-gray-700">{maAlignment.sma25.toLocaleString()}</span></span>
                )}
                {maAlignment.sma75 !== null && (
                  <span>{t('maAlignment.sma75')}: <span className="font-semibold text-gray-700">{maAlignment.sma75.toLocaleString()}</span></span>
                )}
              </div>
            )}
          </div>
        )}

        {/* トレンドライン */}
        {trendlines && (
          <div className="border-b border-gray-100 pb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">{t('trendline.label')}</span>
                <span className="text-xs text-gray-500">({t('trendline.subtitle')})</span>
                <TermTooltip id="ta-trendline" text={tTooltip('trendline')} />
              </div>
              <span
                className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
                  trendlines.overallTrend === "uptrend"
                    ? "bg-green-100 text-green-700"
                    : trendlines.overallTrend === "downtrend"
                    ? "bg-red-100 text-red-700"
                    : "bg-gray-100 text-gray-700"
                }`}
              >
                {trendlines.trendLabel}
              </span>
            </div>
            <div className="space-y-2">
              {trendlines.support && (
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-green-700 flex items-center">
                      {t('trendline.supportLine')}
                      <TermTooltip id="ta-support" text={tTooltip('supportLine')} />
                    </span>
                    {trendlines.support.broken && (
                      <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-red-100 text-red-700">
                        {t('trendline.broken')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-600 mb-1">
                    {t('trendline.supportDescription', {
                      direction: getDirectionLabel(trendlines.support.direction),
                      touches: trendlines.support.touches,
                    })}
                  </p>
                  <p className="text-xs text-gray-500">
                    {t('trendline.projectedPrice', { price: trendlines.support.currentProjectedPrice.toLocaleString() })}
                    {trendlines.support.broken
                      ? t('trendline.supportBroken')
                      : t('trendline.supportHolding')}
                  </p>
                </div>
              )}
              {trendlines.resistance && (
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-red-700 flex items-center">
                      {t('trendline.resistanceLine')}
                      <TermTooltip id="ta-resistance" text={tTooltip('resistanceLine')} />
                    </span>
                    {trendlines.resistance.broken && (
                      <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-700">
                        {t('trendline.breakout')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-600 mb-1">
                    {t('trendline.resistanceDescription', {
                      direction: getDirectionLabel(trendlines.resistance.direction),
                      touches: trendlines.resistance.touches,
                    })}
                  </p>
                  <p className="text-xs text-gray-500">
                    {t('trendline.projectedPrice', { price: trendlines.resistance.currentProjectedPrice.toLocaleString() })}
                    {trendlines.resistance.broken
                      ? t('trendline.resistanceBroken')
                      : t('trendline.resistanceHolding')}
                  </p>
                </div>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-2">
              {t('trendline.disclaimer')}
            </p>
          </div>
        )}

        {/* 週間変化率 */}
        {weekChange && (
          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-900 flex items-center">
                {t('weeklyChange.label')}
                <TermTooltip id="ta-weekly-change" text={tTooltip('weeklyChange')} />
              </span>
              {weekChange.isWarning && (
                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-700">
                  {t('weeklyChange.warning')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span
                className={`text-2xl font-bold ${
                  weekChange.rate >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                {weekChange.rate >= 0 ? "+" : ""}
                {weekChange.rate.toFixed(1)}%
              </span>
              <span className="text-sm text-gray-500">({weekChange.label})</span>
            </div>
          </div>
        )}

        {/* タイミング指標 */}
        {(gapUpRate !== null && gapUpRate !== undefined) ||
         (volumeSpikeRate !== null && volumeSpikeRate !== undefined) ||
         (turnoverValue !== null && turnoverValue !== undefined) ? (
          <div>
            <h3 className="text-sm font-semibold text-gray-900">
              {t('timingIndicators.label')}
            </h3>
            <div className="mt-2 space-y-2">
              {/* ギャップアップ率 */}
              {gapUpRate !== null && gapUpRate !== undefined && (
                <div className="bg-muted/50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      {t('timingIndicators.gapUpRate.label')}
                      <TermTooltip id="ta-gap-up-rate" text={tTooltip('gapUpRate')} />
                    </span>
                    <span className={`text-sm font-bold ${gapUpRate >= 0 ? "text-red-500" : "text-blue-500"}`}>
                      {gapUpRate >= 0 ? "+" : ""}{gapUpRate.toFixed(1)}%
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('timingIndicators.gapUpRate.desc')}
                  </p>
                </div>
              )}

              {/* 出来高急増率 */}
              {volumeSpikeRate !== null && volumeSpikeRate !== undefined && (
                <div className="bg-muted/50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      {t('timingIndicators.volumeSpikeRate.label')}
                      <TermTooltip id="ta-volume-spike-rate" text={tTooltip('volumeSpikeRate')} />
                    </span>
                    <span className={`text-sm font-bold ${volumeSpikeRate >= 2.0 ? "text-amber-500" : "text-foreground"}`}>
                      {volumeSpikeRate.toFixed(1)}倍
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('timingIndicators.volumeSpikeRate.desc')}
                  </p>
                </div>
              )}

              {/* 売買代金 */}
              {turnoverValue !== null && turnoverValue !== undefined && (
                <div className="bg-muted/50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      {t('timingIndicators.turnoverValue.label')}
                      <TermTooltip id="ta-turnover-value" text={tTooltip('turnoverValue')} />
                    </span>
                    <span className="text-sm font-bold text-foreground">
                      {turnoverValue >= 100_000_000
                        ? `${(turnoverValue / 100_000_000).toFixed(1)}億円`
                        : `${Math.round(turnoverValue / 10_000).toLocaleString()}万円`}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('timingIndicators.turnoverValue.desc')}
                  </p>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* 想定変動幅 */}
        {atr14 && currentPrice && currentPrice > 0 && (
          <div className="border-b border-gray-100 pb-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-semibold text-gray-900">
                {t('expectedRange.labelDaily')}
              </span>
              <TermTooltip id="ta-expected-range" text={tTooltip('expectedRange')} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold text-gray-900">
                {t('expectedRange.value', {
                  yen: currentPrice >= 1
                    ? Math.round(atr14).toLocaleString()
                    : atr14.toFixed(2),
                  percent: ((atr14 / currentPrice) * 100).toFixed(1),
                })}
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              {t('expectedRange.disclaimer')}
            </p>
          </div>
        )}

        {/* データがない場合 */}
        {!technicalIndicators.rsi && !technicalIndicators.macd && !candlestickPattern && chartPatterns.length === 0 && (
          <p className="text-sm text-gray-500">{t('insufficientData')}</p>
        )}
      </div>
    </div>
  )
}
