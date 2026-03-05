"use client";

import { useEffect, useState } from "react";
import AnalysisTimestamp from "./AnalysisTimestamp";
import {
  UPDATE_SCHEDULES,
  HEALTH_RANK_CONFIG,
  MARKET_SIGNAL_CONFIG,
} from "@/lib/constants";
import { useTranslations } from "next-intl";

interface StockReportProps {
  stockId: string;
  onAnalysisDateLoaded?: (date: string | null) => void;
}

interface ReportData {
  stockId: string;
  stockName: string;
  tickerCode: string;
  currentPrice: number | null;
  marketSignal: string | null;
  technicalScore: number;
  fundamentalScore: number;
  healthRank: string;
  alerts: Array<{ type: string; message: string }>;
  reason: string;
  caution: string;
  positives: string | null;
  concerns: string | null;
  suitableFor: string | null;
  keyCondition: string | null;
  supportLevel: number | null;
  resistanceLevel: number | null;
  analyzedAt: string;
  healthScore: number | null;
  riskLevel: string | null;
  riskFlags: string[] | null;
  shortTermTrend: string | null;
  shortTermText: string | null;
  midTermTrend: string | null;
  midTermText: string | null;
  longTermTrend: string | null;
  longTermText: string | null;
  advice: string | null;
}

function ScoreBar({
  label,
  score,
}: {
  label: string;
  score: number;
}) {
  const clampedScore = Math.max(0, Math.min(100, score));
  const barColor =
    clampedScore >= 70
      ? "bg-green-500"
      : clampedScore >= 40
        ? "bg-yellow-500"
        : "bg-red-500";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">{label}</span>
        <span className="text-sm font-bold text-gray-900">
          {clampedScore}/100
        </span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2.5">
        <div
          className={`h-2.5 rounded-full ${barColor} transition-all duration-500`}
          style={{ width: `${clampedScore}%` }}
        />
      </div>
    </div>
  );
}

export default function StockReport({
  stockId,
  onAnalysisDateLoaded,
}: StockReportProps) {
  const t = useTranslations("stocks.stockReport");
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [noData, setNoData] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchReport() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/stocks/${stockId}/report`);

      if (response.status === 404) {
        setNoData(true);
        onAnalysisDateLoaded?.(null);
        return;
      }

      if (!response.ok) {
        throw new Error("レポートの取得に失敗しました");
      }

      const result = await response.json();
      setData(result);
      setNoData(false);
      onAnalysisDateLoaded?.(result.analyzedAt || null);
    } catch (err) {
      console.error("Error fetching stock report:", err);
      setError("レポートの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function generateReport() {
    setGenerating(true);
    setError(null);
    try {
      const response = await fetch(`/api/stocks/${stockId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "レポートの生成に失敗しました");
      }

      const result = await response.json();
      setData(result);
      setNoData(false);
    } catch (err) {
      console.error("Error generating stock report:", err);
      setError(
        err instanceof Error ? err.message : "分析中にエラーが発生しました",
      );
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => {
    fetchReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockId]);

  // Loading state
  if (loading) {
    return (
      <div>
        <div className="flex items-center justify-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <p className="ml-3 text-sm text-gray-600">
            レポートを読み込み中...
          </p>
        </div>
      </div>
    );
  }

  // Generating state
  if (generating) {
    return (
      <div>
        <div className="bg-gray-50 rounded-lg p-6 text-center">
          <div className="text-4xl mb-3">📊</div>
          <p className="text-sm text-gray-600 mb-4">
            AIがデータを分析しています...
          </p>
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-blue-400 text-white text-sm font-medium rounded-lg cursor-not-allowed">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
            分析中...
          </div>
        </div>
      </div>
    );
  }

  // No data state
  if (noData && !data) {
    return (
      <div>
        <div className="bg-gray-50 rounded-lg p-6 text-center">
          <div className="text-4xl mb-3">📊</div>
          <p className="text-sm text-gray-600 mb-4">
            まだレポートがありません
          </p>
          <button
            onClick={generateReport}
            disabled={generating}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed transition-colors"
          >
            {generating ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                分析中...
              </>
            ) : (
              <>
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                  />
                </svg>
                今すぐ分析
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  // Error state
  if (error || !data) {
    return (
      <div>
        <div className="bg-gray-50 rounded-lg p-6 text-center">
          <div className="text-4xl mb-3">📊</div>
          <p className="text-sm text-gray-600">
            {error || "レポートデータがありません"}
          </p>
        </div>
      </div>
    );
  }

  const getTrendIcon = (trend: string | null | undefined) => {
    switch (trend) {
      case "up":
        return "📈";
      case "down":
        return "📉";
      default:
        return "📊";
    }
  };

  const getTrendText = (trend: string | null | undefined) => {
    switch (trend) {
      case "up":
        return "上昇傾向";
      case "down":
        return "下落傾向";
      default:
        return "横ばい";
    }
  };

  const formatPrice = (price: number) => {
    return price.toLocaleString("ja-JP", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
  };

  const healthConfig = HEALTH_RANK_CONFIG[data.healthRank] ?? HEALTH_RANK_CONFIG["C"];
  const signalConfig = data.marketSignal
    ? MARKET_SIGNAL_CONFIG[data.marketSignal]
    : null;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-bold text-gray-800">AI銘柄レポート</h3>
        <button
          onClick={generateReport}
          disabled={generating}
          className="text-sm text-blue-600 hover:text-blue-800 disabled:text-gray-400 disabled:cursor-not-allowed flex items-center gap-1"
        >
          {generating ? (
            <>
              <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-600"></div>
              分析中...
            </>
          ) : (
            <>
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              再分析
            </>
          )}
        </button>
      </div>

      {/* Health Rank Badge */}
      <div className="flex flex-col items-center mb-4">
        <span
          className={`inline-flex items-center px-4 py-2 rounded-full text-lg font-bold ${healthConfig.color} ${healthConfig.bg}`}
        >
          {healthConfig.text}
          {data.healthScore != null && (
            <span className="ml-2 text-sm font-medium opacity-75">
              ({data.healthScore}点)
            </span>
          )}
        </span>
        <p className="mt-2 text-sm text-gray-600">
          {t(`healthRank.desc${data.healthRank}`)}
        </p>
        <details className="mt-2 w-full max-w-sm">
          <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600 text-center">
            {t("healthRank.legendTitle")}
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-gray-500">
            {(["A", "B", "C", "D", "E"] as const).map((rank) => {
              const cfg = HEALTH_RANK_CONFIG[rank];
              return (
                <li key={rank} className={`flex gap-2 ${rank === data.healthRank ? "font-semibold text-gray-700" : ""}`}>
                  <span className={`${cfg.color} font-bold w-8 shrink-0`}>{rank}</span>
                  <span>{t(`healthRank.desc${rank}`)}</span>
                </li>
              );
            })}
          </ul>
        </details>
      </div>

      {/* Score Bars */}
      <div className="space-y-3 mb-4">
        <ScoreBar
          label="テクニカルスコア"
          score={data.technicalScore}
        />
        <ScoreBar
          label="ファンダメンタルスコア"
          score={data.fundamentalScore}
        />
      </div>

      {/* Alerts */}
      {data.alerts && data.alerts.length > 0 && (
        <div className="space-y-2 mb-4">
          {data.alerts.map((alert, index) => (
            <div
              key={index}
              className="bg-orange-50 border border-orange-200 rounded-lg p-3 flex items-start gap-2"
            >
              <span className="text-orange-500 flex-shrink-0 mt-0.5">
                <svg
                  className="w-4 h-4"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
              </span>
              <div>
                <p className="text-xs font-semibold text-orange-700">
                  {alert.type}
                </p>
                <p className="text-sm text-orange-800">{alert.message}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reason */}
      <div className="bg-white border border-gray-200 rounded-lg p-3 mb-4">
        <p className="text-xs font-semibold text-gray-600 mb-1">
          分析サマリー
        </p>
        <p className="text-sm text-gray-700">{data.reason}</p>
      </div>

      {/* Positives / Concerns */}
      {(data.positives || data.concerns) && (
        <div className="space-y-3 mb-4">
          {data.positives && (
            <div className="bg-green-50 border-l-4 border-green-400 p-3">
              <p className="text-xs font-semibold text-green-700 mb-2">
                ポジティブ要因
              </p>
              <div className="text-sm text-green-800 whitespace-pre-line">
                {data.positives}
              </div>
            </div>
          )}

          {data.concerns && (
            <div className="bg-yellow-50 border-l-4 border-yellow-400 p-3">
              <p className="text-xs font-semibold text-yellow-700 mb-2">
                注意点
              </p>
              <div className="text-sm text-yellow-800 whitespace-pre-line">
                {data.concerns}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Suitable For */}
      {data.suitableFor && (
        <div className="bg-blue-50 border-l-4 border-blue-400 p-3 mb-4">
          <p className="text-xs font-semibold text-blue-700 mb-2">
            こんな人向け
          </p>
          <p className="text-sm text-blue-800">{data.suitableFor}</p>
        </div>
      )}

      {/* Key Condition */}
      {data.keyCondition && (
        <div className="bg-emerald-50 border-l-4 border-emerald-400 p-3 mb-4">
          <p className="text-xs font-semibold text-emerald-700 mb-2">
            注目ポイント
          </p>
          <p className="text-sm text-emerald-800">{data.keyCondition}</p>
        </div>
      )}

      {/* Support / Resistance Levels */}
      {(data.supportLevel != null || data.resistanceLevel != null) && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          {data.supportLevel != null && (
            <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
              <p className="text-[10px] text-blue-700 font-bold mb-0.5">
                サポートライン
              </p>
              <p className="text-sm font-bold text-blue-800">
                ¥{formatPrice(data.supportLevel)}
              </p>
            </div>
          )}
          {data.resistanceLevel != null && (
            <div className="bg-red-50 rounded-lg p-3 border border-red-100">
              <p className="text-[10px] text-red-700 font-bold mb-0.5">
                レジスタンスライン
              </p>
              <p className="text-sm font-bold text-red-800">
                ¥{formatPrice(data.resistanceLevel)}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Trend Analysis */}
      {(data.shortTermTrend || data.midTermTrend || data.longTermTrend) && (
        <div className="space-y-3 mb-4">
          {/* Short Term */}
          {data.shortTermTrend && (
            <div className="bg-gradient-to-br from-purple-50 to-indigo-50 rounded-lg p-3 sm:p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">
                  {getTrendIcon(data.shortTermTrend)}
                </span>
                <div className="flex-1">
                  <p className="text-sm font-bold text-purple-800">
                    短期トレンド
                  </p>
                  <p className="text-xs text-purple-600">
                    {getTrendText(data.shortTermTrend)}
                  </p>
                </div>
              </div>
              {data.shortTermText && (
                <p className="text-sm text-gray-700">{data.shortTermText}</p>
              )}
            </div>
          )}

          {/* Mid Term */}
          {data.midTermTrend && (
            <div className="bg-gradient-to-br from-blue-50 to-cyan-50 rounded-lg p-3 sm:p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">
                  {getTrendIcon(data.midTermTrend)}
                </span>
                <div className="flex-1">
                  <p className="text-sm font-bold text-blue-800">
                    中期トレンド
                  </p>
                  <p className="text-xs text-blue-600">
                    {getTrendText(data.midTermTrend)}
                  </p>
                </div>
              </div>
              {data.midTermText && (
                <p className="text-sm text-gray-700">{data.midTermText}</p>
              )}
            </div>
          )}

          {/* Long Term */}
          {data.longTermTrend && (
            <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-lg p-3 sm:p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">
                  {getTrendIcon(data.longTermTrend)}
                </span>
                <div className="flex-1">
                  <p className="text-sm font-bold text-emerald-800">
                    長期トレンド
                  </p>
                  <p className="text-xs text-emerald-600">
                    {getTrendText(data.longTermTrend)}
                  </p>
                </div>
              </div>
              {data.longTermText && (
                <p className="text-sm text-gray-700">{data.longTermText}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Advice */}
      {data.advice && (
        <div className="bg-white border border-gray-200 rounded-lg p-3 mb-4">
          <p className="text-xs font-semibold text-gray-600 mb-1">
            総合アドバイス
          </p>
          <p className="text-sm text-gray-700">{data.advice}</p>
        </div>
      )}

      {/* Caution */}
      <div className="bg-amber-50 border-l-4 border-amber-400 p-3 mb-4">
        <p className="text-xs text-amber-800">{data.caution}</p>
      </div>

      {/* Market Signal Badge */}
      {signalConfig && (
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs text-gray-500">市場シグナル</span>
          <span
            className={`inline-flex items-center gap-0.5 px-2 py-0.5 ${signalConfig.bg} ${signalConfig.color} rounded-full text-xs font-medium`}
          >
            <span>{signalConfig.icon}</span>
            <span>{signalConfig.text}</span>
          </span>
        </div>
      )}

      {/* Timestamp */}
      <div className="text-center space-y-1">
        <AnalysisTimestamp dateString={data.analyzedAt} />
        <p className="text-xs text-gray-400">
          更新スケジュール: {UPDATE_SCHEDULES.STOCK_ANALYSIS}
        </p>
      </div>
    </div>
  );
}
