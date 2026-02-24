"use client";

import { useTranslations } from "next-intl";
import { UNIT_SHARES } from "@/lib/constants";

interface HoldingWithGain {
  stockId: string;
  tickerCode: string;
  name: string;
  sector: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  unrealizedGain: number;
  unrealizedGainPercent: number;
}

interface SectorData {
  sector: string;
  value: number;
  percent: number;
}

interface PurchaseSimulationProps {
  currentPrice: number;
  stockSector: string | null;
  holdingsWithGains: HoldingWithGain[];
  currentSectors: SectorData[];
  totalPortfolioValue: number;
  remainingBudget: number | null;
}

export default function PurchaseSimulation({
  currentPrice,
  stockSector,
  holdingsWithGains,
  currentSectors,
  totalPortfolioValue,
  remainingBudget,
}: PurchaseSimulationProps) {
  const t = useTranslations("stocks.detail.purchaseSimulation");

  const estimatedCost = currentPrice * UNIT_SHARES;
  const canAfford =
    remainingBudget !== null ? remainingBudget >= estimatedCost : null;
  const shortage =
    remainingBudget !== null && !canAfford
      ? Math.round(estimatedCost - remainingBudget)
      : 0;

  // Show profitable holdings only when budget is insufficient or not set
  const showProfitableHoldings =
    holdingsWithGains.length > 0 && (canAfford === null || !canAfford);

  // Calculate after-purchase sector balance
  const watchlistSector = stockSector || "その他";
  const afterTotalValue = totalPortfolioValue + estimatedCost;
  const afterSectors = currentSectors.map((s) => ({ ...s }));
  const existingSector = afterSectors.find(
    (s) => s.sector === watchlistSector
  );
  let isNewSectorAdded = false;
  if (existingSector) {
    existingSector.value += estimatedCost;
  } else {
    afterSectors.push({
      sector: watchlistSector,
      value: estimatedCost,
      percent: 0,
    });
    isNewSectorAdded = true;
  }
  for (const s of afterSectors) {
    s.percent =
      afterTotalValue > 0
        ? Math.round((s.value / afterTotalValue) * 1000) / 10
        : 0;
  }
  afterSectors.sort((a, b) => b.value - a.value);

  return (
    <div>
      <h2 className="text-lg sm:text-xl font-bold text-gray-900">
        {t("title")}
      </h2>
      <p className="text-sm text-gray-500 mt-1 mb-4">{t("subtitle")}</p>

      {/* A: Purchase Estimate */}
      <div className="bg-blue-50 rounded-lg p-4 mb-4 border border-blue-100">
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-semibold text-blue-800">
            {t("estimatedCost")}
          </p>
          <p className="text-xs text-blue-600">{t("unitShares")}</p>
        </div>
        <p className="text-2xl font-bold text-blue-900">
          ¥{estimatedCost.toLocaleString()}
        </p>

        {/* Budget status */}
        {remainingBudget !== null ? (
          <div className="mt-3 pt-3 border-t border-blue-200">
            <div className="flex items-center justify-between text-sm">
              <span className="text-blue-700">{t("remainingBudget")}</span>
              <span className="font-semibold text-blue-800">
                ¥{Math.round(remainingBudget).toLocaleString()}
              </span>
            </div>
            <p
              className={`text-xs mt-1 ${canAfford ? "text-green-600" : "text-red-600"}`}
            >
              {canAfford
                ? t("budgetSufficient")
                : t("budgetInsufficient", {
                    shortage: shortage.toLocaleString(),
                  })}
            </p>
          </div>
        ) : (
          <p className="text-xs text-blue-500 mt-2">{t("budgetNotSet")}</p>
        )}
      </div>

      {/* B: Profitable Holdings (only when budget insufficient or not set) */}
      {showProfitableHoldings && (
        <div className="mb-4">
          <h3 className="text-sm font-bold text-gray-700 mb-1">
            {t("profitableHoldings")}
          </h3>
          <p className="text-xs text-gray-500 mb-3">
            {t("profitableHoldingsHint")}
          </p>
          <div className="space-y-2">
            {holdingsWithGains.map((h) => (
              <div
                key={h.stockId}
                className="bg-gray-50 rounded-lg p-3 flex items-center justify-between"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-900 truncate">
                    {h.name}
                  </p>
                  <p className="text-xs text-gray-500">
                    {h.tickerCode} ・ {h.quantity}
                    {t("shares")}
                  </p>
                </div>
                <div className="text-right ml-3 flex-shrink-0">
                  <p className="text-sm font-bold text-green-600">
                    +¥{Math.round(h.unrealizedGain).toLocaleString()}
                  </p>
                  <p className="text-xs text-green-600">
                    (+{h.unrealizedGainPercent.toFixed(1)}%)
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* C: Sector Balance */}
      <div>
        <h3 className="text-sm font-bold text-gray-700 mb-1">
          {t("sectorBalance")}
        </h3>
        <p className="text-xs text-gray-500 mb-3">
          {t("sectorBalanceHint")}
        </p>
        <div className="grid grid-cols-2 gap-3">
          {/* Current */}
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs font-bold text-gray-600 mb-2">
              {t("currentPortfolio")}
            </p>
            <div className="space-y-1">
              {currentSectors.map((s) => (
                <div
                  key={s.sector}
                  className="flex justify-between text-xs text-gray-700"
                >
                  <span className="truncate mr-1">{s.sector}</span>
                  <span className="flex-shrink-0 font-medium">
                    {s.percent}%
                  </span>
                </div>
              ))}
            </div>
          </div>
          {/* After purchase */}
          <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
            <p className="text-xs font-bold text-blue-700 mb-2">
              {t("afterPurchase")}
            </p>
            <div className="space-y-1">
              {afterSectors.map((s) => (
                <div
                  key={s.sector}
                  className="flex justify-between text-xs text-gray-700"
                >
                  <span className="truncate mr-1">
                    {s.sector}
                    {isNewSectorAdded && s.sector === watchlistSector && (
                      <span className="ml-1 text-[10px] bg-blue-200 text-blue-800 px-1 rounded font-bold">
                        {t("newSector")}
                      </span>
                    )}
                  </span>
                  <span className="flex-shrink-0 font-medium">
                    {s.percent}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
