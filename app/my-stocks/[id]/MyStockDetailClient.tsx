"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import PurchaseRecommendation from "@/app/components/PurchaseRecommendation";
import StockAnalysisCard from "@/app/components/StockAnalysisCard";
import FinancialMetrics from "@/app/components/FinancialMetrics";
import EarningsInfo from "@/app/components/EarningsInfo";
import StockChart from "@/app/components/StockChart";
import PriceHistory from "@/app/components/PriceHistory";
import RelatedNews from "@/app/components/RelatedNews";
import StockDetailLayout from "@/app/components/StockDetailLayout";
import DelistedWarning from "@/app/components/DelistedWarning";
import StaleAnalysisBanner from "@/app/components/StaleAnalysisBanner";
import CurrentPriceCard from "@/app/components/CurrentPriceCard";
import DeleteButton from "@/app/components/DeleteButton";
import Tabs from "@/app/components/Tabs";
import TechnicalAnalysis from "@/app/components/TechnicalAnalysis";
import EditTransactionDialog from "../EditTransactionDialog";
import AdditionalPurchaseDialog from "../AdditionalPurchaseDialog";
import AddStockDialog from "../AddStockDialog";
import { toast } from "sonner";
import { useChatContext } from "@/app/contexts/ChatContext";
import { useStockPrice } from "@/app/hooks/useStockPrice";
import IndividualSettingsModal from "../IndividualSettingsModal";
import PurchaseSimulation from "@/app/components/PurchaseSimulation";

interface Transaction {
  id: string;
  type: string;
  quantity: number;
  price: number;
  totalAmount: number;
  transactionDate: string;
}

interface Stock {
  id: string;
  stockId: string;
  type: "portfolio" | "watchlist";
  quantity?: number;
  averagePurchasePrice?: number;
  purchaseDate?: string;
  suggestedSellPrice?: number | null;
  sellCondition?: string | null;
  // Individual TP/SL settings (rates in %)
  takeProfitRate?: number | null;
  stopLossRate?: number | null;
  // Watchlist fields
  targetBuyPrice?: number | null;
  limitPrice?: number | null; // AI suggested limit price (fallback for buy alert)
  transactions?: Transaction[];
  stock: {
    id: string;
    tickerCode: string;
    name: string;
    sector: string | null;
    market: string;
    currentPrice: number | null;
    fiftyTwoWeekHigh: number | null;
    fiftyTwoWeekLow: number | null;
    pbr: number | null;
    per: number | null;
    roe: number | null;
    operatingCF: number | null;
    freeCF: number | null;
    // Earnings data
    isProfitable?: boolean | null;
    profitTrend?: string | null;
    revenueGrowth?: number | null;
    netIncomeGrowth?: number | null;
    eps?: number | null;
    latestRevenue?: number | null;
    latestNetIncome?: number | null;
    fetchFailCount?: number;
    isDelisted?: boolean;
  };
}

interface PurchaseSimulationData {
  holdingsWithGains: {
    stockId: string;
    tickerCode: string;
    name: string;
    sector: string;
    quantity: number;
    averagePrice: number;
    currentPrice: number;
    unrealizedGain: number;
    unrealizedGainPercent: number;
  }[];
  currentSectors: { sector: string; value: number; percent: number }[];
  totalPortfolioValue: number;
  remainingBudget: number | null;
}

interface Props {
  stock: Stock;
  portfolioDetails?: {
    quantity: number;
    averagePurchasePrice: number;
    profit: number;
    profitPercent: number;
  };
  purchaseSimulationData?: PurchaseSimulationData;
}

export default function MyStockDetailClient({
  stock,
  portfolioDetails,
  purchaseSimulationData,
}: Props) {
  const router = useRouter();
  const t = useTranslations("stocks.detail");
  const tTabs = useTranslations("stocks.tabs");
  const { setStockContext } = useChatContext();
  const { price, loading, isStale } = useStockPrice(stock.stock.tickerCode);
  const [selectedTransaction, setSelectedTransaction] =
    useState<Transaction | null>(null);
  const [openMenuTransactionId, setOpenMenuTransactionId] = useState<
    string | null
  >(null);
  const [showTransactionDialog, setShowTransactionDialog] = useState(false);
  const [transactionType, setTransactionType] = useState<"buy" | "sell">("buy");
  const [showPurchaseDialog, setShowPurchaseDialog] = useState(false);
  const [trackingStock, setTrackingStock] = useState(false);
  const [targetBuyPrice, setTargetBuyPrice] = useState<string>(
    stock.targetBuyPrice ? String(stock.targetBuyPrice) : "",
  );
  const [savingTargetPrice, setSavingTargetPrice] = useState(false);
  const [showBuyAlertModal, setShowBuyAlertModal] = useState(false);
  const [currentTargetBuyPrice, setCurrentTargetBuyPrice] = useState<
    number | null
  >(stock.targetBuyPrice ?? null);
  const [showTrackingModal, setShowTrackingModal] = useState(false);
  const [analysisDate, setAnalysisDate] = useState<string | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [watchlistTab, setWatchlistTab] = useState("ai-judgment");

  // Individual TP/SL state (rates in %)
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [currentTpRate, setCurrentTpRate] = useState<number | null>(
    stock.takeProfitRate ?? null,
  );
  const [currentSlRate, setCurrentSlRate] = useState<number | null>(
    stock.stopLossRate ?? null,
  );

  const isPortfolio = stock.type === "portfolio";
  const currentPrice = price?.currentPrice || stock.stock.currentPrice || 0;
  const quantity = isPortfolio
    ? (portfolioDetails?.quantity ?? stock.quantity ?? 0)
    : 0;
  const averagePrice = isPortfolio
    ? (portfolioDetails?.averagePurchasePrice ??
      stock.averagePurchasePrice ??
      0)
    : 0;

  const totalCost = averagePrice * quantity;
  const currentValue = currentPrice * quantity;
  const profit = currentValue - totalCost;
  const profitPercent = totalCost > 0 ? (profit / totalCost) * 100 : 0;

  useEffect(() => {
    setStockContext({
      stockId: stock.stockId,
      tickerCode: stock.stock.tickerCode,
      name: stock.stock.name,
      sector: stock.stock.sector,
      currentPrice: currentPrice,
      type: stock.type,
      quantity: isPortfolio ? quantity : undefined,
      averagePurchasePrice: isPortfolio ? averagePrice : undefined,
      profit: isPortfolio ? profit : undefined,
      profitPercent: isPortfolio ? profitPercent : undefined,
    });

    return () => {
      setStockContext(null);
    };
  }, [
    stock,
    currentPrice,
    quantity,
    averagePrice,
    profit,
    profitPercent,
    isPortfolio,
    setStockContext,
  ]);

  const handleDelete = async () => {
    if (!confirm(t("confirmDelete", { name: stock.stock.name }))) {
      return;
    }

    try {
      const response = await fetch(`/api/user-stocks/${stock.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "削除に失敗しました");
      }

      toast.success("削除しました");
      router.push("/my-stocks");
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "削除に失敗しました");
    }
  };

  const handleDeleteTransaction = async (transactionId: string) => {
    if (!confirm(t("confirmDeleteTransaction"))) {
      return;
    }

    try {
      const response = await fetch(`/api/transactions/${transactionId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "削除に失敗しました");
      }

      toast.success("取引履歴を削除しました");
      router.refresh();
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "削除に失敗しました");
    }
  };

  const handleSetDipBuyAlert = async (price: number) => {
    try {
      const response = await fetch(`/api/user-stocks/${stock.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetBuyPrice: price }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || t("dipBuyAlertError"));
      }

      setCurrentTargetBuyPrice(price);
      setTargetBuyPrice(String(price));
      toast.success(t("dipBuyAlertSet", { price: price.toLocaleString() }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("dipBuyAlertError");
      toast.error(message);
    }
  };

  return (
    <StockDetailLayout
      name={stock.stock.name}
      tickerCode={stock.stock.tickerCode}
      sector={stock.stock.sector}
    >
      {/* Delisted Warning */}
      <DelistedWarning
        isDelisted={stock.stock.isDelisted ?? false}
        fetchFailCount={stock.stock.fetchFailCount ?? 0}
      />

      {/* Stale Analysis Banner */}
      <StaleAnalysisBanner analysisDate={analysisDate} />

      {/* Portfolio Stock Details */}
      {isPortfolio && (
        <>
          {/* Current Status Section */}
          <section className="bg-white rounded-xl shadow-md p-4 sm:p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg sm:text-xl font-bold text-gray-900">
                {t("currentStatus")}
              </h2>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setTransactionType("buy");
                    setShowTransactionDialog(true);
                  }}
                  className="px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded transition-colors"
                >
                  {t("addPurchase")}
                </button>
                <button
                  onClick={() => {
                    setTransactionType("sell");
                    setShowTransactionDialog(true);
                  }}
                  disabled={quantity === 0}
                  className="px-2 py-1 text-xs font-medium text-orange-600 hover:bg-orange-50 rounded transition-colors disabled:text-gray-400 disabled:hover:bg-transparent"
                >
                  {t("sell")}
                </button>
              </div>
            </div>

            <div className="space-y-4">
              {/* Current Price */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">
                  {stock.stock.isDelisted ? t("finalPrice") : t("currentPrice")}
                </span>
                {loading ? (
                  <span className="text-sm text-gray-400">{t("loading")}</span>
                ) : price ? (
                  <div className="text-right">
                    <p
                      className={`text-xl font-bold ${stock.stock.isDelisted ? "text-gray-400" : "text-gray-900"}`}
                    >
                      ¥{price.currentPrice.toLocaleString()}
                    </p>
                    {!stock.stock.isDelisted && (
                      <p
                        className={`text-sm font-semibold ${
                          price.change >= 0 ? "text-green-600" : "text-red-600"
                        }`}
                      >
                        {price.change >= 0 ? "+" : ""}
                        {price.changePercent.toFixed(2)}%
                      </p>
                    )}
                    {price.marketTime && (
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        {new Date(price.marketTime * 1000).toLocaleString(
                          "ja-JP",
                          {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          },
                        )}
                        {t("asOf")}
                      </p>
                    )}
                  </div>
                ) : isStale ? (
                  <span className="text-xs text-amber-600">
                    {t("priceDataUnavailable")}
                    <br />
                    {t("delistedOrSuspendedWarning")}
                  </span>
                ) : (
                  <span className="text-sm text-gray-400">
                    {t("noPriceInfo")}
                  </span>
                )}
              </div>

              {/* Holdings Info */}
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">{t("quantity")}</span>
                <span className="font-semibold text-gray-900">
                  {quantity}
                  {t("shares")}
                </span>
              </div>

              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">{t("averagePrice")}</span>
                <span className="font-semibold text-gray-900">
                  ¥{averagePrice.toLocaleString()}
                </span>
              </div>

              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">{t("currentValue")}</span>
                <span className="font-semibold text-gray-900">
                  ¥{currentValue.toLocaleString()}
                </span>
              </div>

              {/* Profit/Loss (Highlighted) */}
              {!loading && price && (
                <div
                  className={`rounded-lg p-4 mt-4 ${
                    profit >= 0
                      ? "bg-gradient-to-r from-green-50 to-emerald-50 border-2 border-green-200"
                      : "bg-gradient-to-r from-red-50 to-rose-50 border-2 border-red-200"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">
                      {t("unrealizedPL")}
                    </span>
                    <div className="text-right">
                      <p
                        className={`text-2xl font-bold ${
                          profit >= 0 ? "text-green-600" : "text-red-600"
                        }`}
                      >
                        {profit >= 0 ? "+" : ""}¥{profit.toLocaleString()}
                      </p>
                      <p
                        className={`text-sm font-semibold ${
                          profit >= 0 ? "text-green-600" : "text-red-600"
                        }`}
                      >
                        ({profitPercent >= 0 ? "+" : ""}
                        {profitPercent.toFixed(2)}%)
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Individual TP/SL Targets */}
              <div className="mt-4 pt-4 border-t border-gray-100">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-bold text-gray-700">
                    {t("individualSettings")}
                  </h3>
                  <button
                    onClick={() => setShowSettingsModal(true)}
                    className="text-xs text-blue-600 font-semibold hover:underline"
                  >
                    {t("changeSettings")}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-green-50 rounded-lg p-2.5 border border-green-100">
                    <p className="text-[10px] text-green-700 font-bold mb-0.5">
                      {t("sellTargetLine")}
                    </p>
                    <p className="text-sm font-bold text-green-800">
                      {currentTpRate != null && averagePrice
                        ? `¥${Math.round(averagePrice * (1 + currentTpRate / 100)).toLocaleString()}`
                        : t("notSet")}
                    </p>
                  </div>
                  <div className="bg-red-50 rounded-lg p-2.5 border border-red-100">
                    <p className="text-[10px] text-red-700 font-bold mb-0.5">
                      {t("exitLine")}
                    </p>
                    <p className="text-sm font-bold text-red-800">
                      {currentSlRate != null && averagePrice
                        ? `¥${Math.round(averagePrice * (1 + currentSlRate / 100)).toLocaleString()}`
                        : t("notSet")}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* AI Analysis Section */}
          <section className="bg-white rounded-xl shadow-md p-4 sm:p-6 mb-6">
            <StockAnalysisCard
              stockId={stock.stockId}
              quantity={quantity}
              onAnalysisDateLoaded={setAnalysisDate}
              onApplyAIPrices={async ({
                takeProfitPrice,
                stopLossPrice,
                averagePurchasePrice: avgPrice,
              }) => {
                const updates: {
                  takeProfitRate?: number | null;
                  stopLossRate?: number | null;
                } = {};

                if (takeProfitPrice != null && avgPrice > 0) {
                  updates.takeProfitRate =
                    Math.round(
                      ((takeProfitPrice - avgPrice) / avgPrice) * 1000,
                    ) / 10;
                }
                if (stopLossPrice != null && avgPrice > 0) {
                  updates.stopLossRate =
                    Math.round(((stopLossPrice - avgPrice) / avgPrice) * 1000) /
                    10;
                }

                if (
                  updates.takeProfitRate === undefined &&
                  updates.stopLossRate === undefined
                )
                  return;

                try {
                  const response = await fetch(`/api/user-stocks/${stock.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(updates),
                  });

                  if (!response.ok) throw new Error();

                  if (updates.takeProfitRate !== undefined)
                    setCurrentTpRate(updates.takeProfitRate);
                  if (updates.stopLossRate !== undefined)
                    setCurrentSlRate(updates.stopLossRate);
                  toast.success(t("aiPriceApplied"));
                  router.refresh();
                } catch {
                  toast.error(t("aiPriceApplyFailed"));
                }
              }}
            />
          </section>

          {/* Tabbed Content Section */}
          <section className="bg-white rounded-xl shadow-md p-4 sm:p-6 mb-6">
            <Tabs
              tabs={[
                { id: "chart", label: tTabs("chart") },
                { id: "analysis", label: tTabs("technical") },
                { id: "news", label: tTabs("news") },
                { id: "details", label: tTabs("details") },
              ]}
              defaultTab="chart"
            >
              {(activeTab) => (
                <>
                  {activeTab === "chart" && (
                    <>
                      <StockChart stockId={stock.stockId} embedded />
                      <PriceHistory stockId={stock.stockId} embedded />
                    </>
                  )}
                  {activeTab === "analysis" && (
                    <TechnicalAnalysis stockId={stock.stockId} embedded />
                  )}
                  {activeTab === "news" && (
                    <RelatedNews stockId={stock.stockId} embedded />
                  )}
                  {activeTab === "details" && (
                    <>
                      <FinancialMetrics stock={stock.stock} embedded />
                      <EarningsInfo earnings={stock.stock} embedded />
                    </>
                  )}
                </>
              )}
            </Tabs>
          </section>

          {/* Transaction History Section - Always at bottom */}
          {stock.transactions && stock.transactions.length > 0 && (
            <section className="bg-white rounded-xl shadow-md p-4 sm:p-6 mb-6">
              <h2 className="text-lg sm:text-xl font-bold text-gray-900 mb-4">
                {t("transactionHistory")}
              </h2>

              <div className="space-y-3">
                {stock.transactions.map((transaction) => (
                  <div
                    key={transaction.id}
                    className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 text-xs font-semibold rounded ${
                          transaction.type === "buy"
                            ? "bg-blue-100 text-blue-700"
                            : "bg-orange-100 text-orange-700"
                        }`}
                      >
                        {transaction.type === "buy"
                          ? t("buy")
                          : t("sellButton")}
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-gray-900">
                          {new Date(
                            transaction.transactionDate,
                          ).toLocaleDateString("ja-JP")}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <p className="text-sm font-semibold text-gray-900">
                          {transaction.quantity}
                          {t("shares")} @ ¥{transaction.price.toLocaleString()}
                        </p>
                        <p className="text-xs text-gray-500">
                          ¥{transaction.totalAmount.toLocaleString()}
                        </p>
                      </div>
                      <div className="relative">
                        <button
                          onClick={() =>
                            setOpenMenuTransactionId(
                              openMenuTransactionId === transaction.id
                                ? null
                                : transaction.id,
                            )
                          }
                          className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                          title={t("menu")}
                        >
                          <svg
                            className="w-4 h-4"
                            fill="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <circle cx="12" cy="5" r="1.5" />
                            <circle cx="12" cy="12" r="1.5" />
                            <circle cx="12" cy="19" r="1.5" />
                          </svg>
                        </button>
                        {openMenuTransactionId === transaction.id && (
                          <>
                            <div
                              className="fixed inset-0 z-10"
                              onClick={() => setOpenMenuTransactionId(null)}
                            />
                            <div className="absolute right-0 top-8 z-20 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[100px]">
                              <button
                                onClick={() => {
                                  setSelectedTransaction(transaction);
                                  setOpenMenuTransactionId(null);
                                }}
                                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                              >
                                {t("edit")}
                              </button>
                              <button
                                onClick={() => {
                                  setOpenMenuTransactionId(null);
                                  handleDeleteTransaction(transaction.id);
                                }}
                                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                              >
                                {t("delete")}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Watchlist Stock Details */}
      {!isPortfolio && (
        <>
          {/* Current Price Section */}
          <CurrentPriceCard
            price={price}
            loading={loading}
            fiftyTwoWeekHigh={stock.stock.fiftyTwoWeekHigh}
            fiftyTwoWeekLow={stock.stock.fiftyTwoWeekLow}
            isDelisted={stock.stock.isDelisted ?? false}
            isStale={isStale}
            actions={
              <>
                <button
                  onClick={() => setShowPurchaseDialog(true)}
                  className="px-2 py-1 text-xs font-medium text-green-600 hover:bg-green-50 rounded transition-colors"
                >
                  {t("purchase")}
                </button>
                <button
                  onClick={() => setShowTrackingModal(true)}
                  disabled={trackingStock}
                  className="px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded transition-colors disabled:opacity-50"
                >
                  {t("skip")}
                </button>
              </>
            }
            bottomActions={
              <button
                onClick={() => {
                  setTargetBuyPrice(
                    currentTargetBuyPrice ? String(currentTargetBuyPrice) : "",
                  );
                  setShowBuyAlertModal(true);
                }}
                className={`text-xs font-medium rounded-full px-3 py-1 transition-colors ${
                  currentTargetBuyPrice
                    ? "text-amber-700 bg-amber-100 hover:bg-amber-200"
                    : "text-amber-600 bg-amber-50 hover:bg-amber-100"
                }`}
              >
                {currentTargetBuyPrice
                  ? t("alertSet", {
                      price: currentTargetBuyPrice.toLocaleString(),
                    })
                  : t("setBuyAlert")}
              </button>
            }
          />

          <div className="flex justify-end mb-2">
            <button
              onClick={() => setIsSimulating(true)}
              className="text-xs bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 px-3 py-1.5 rounded-full font-bold flex items-center gap-1.5 transition-colors"
            >
              {t("postPurchaseSimulation")}
            </button>
          </div>

          {/* AI Purchase Judgment & Purchase Simulation Tabs */}
          <section className="bg-white rounded-xl shadow-md mb-6">
            {/* Tab Headers */}
            <div className="flex border-b border-gray-200">
              {[
                {
                  id: "ai-judgment",
                  label: t("watchlistTabs.aiPurchaseJudgment"),
                },
                ...(purchaseSimulationData && currentPrice > 0
                  ? [{ id: "how-to-buy", label: t("watchlistTabs.howToBuy") }]
                  : []),
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setWatchlistTab(tab.id)}
                  className={`flex-1 px-4 py-3 text-sm font-semibold transition-colors ${
                    watchlistTab === tab.id
                      ? "text-blue-600 border-b-2 border-blue-600"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="p-4 sm:p-6">
              {watchlistTab === "ai-judgment" && (
                <>
                  <PurchaseRecommendation
                    stockId={stock.stockId}
                    onAnalysisDateLoaded={setAnalysisDate}
                    onSetBuyAlert={handleSetDipBuyAlert}
                    currentTargetBuyPrice={currentTargetBuyPrice}
                  />
                </>
              )}
              {watchlistTab === "how-to-buy" &&
                purchaseSimulationData &&
                currentPrice > 0 && (
                  <PurchaseSimulation
                    currentPrice={currentPrice}
                    stockSector={stock.stock.sector}
                    holdingsWithGains={purchaseSimulationData.holdingsWithGains}
                    currentSectors={purchaseSimulationData.currentSectors}
                    totalPortfolioValue={
                      purchaseSimulationData.totalPortfolioValue
                    }
                    remainingBudget={purchaseSimulationData.remainingBudget}
                  />
                )}
            </div>
          </section>

          {/* Simulation Result Modal */}
          {isSimulating && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
              <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col relative overflow-hidden">
                {/* Fixed Close Button */}
                <button
                  onClick={() => setIsSimulating(false)}
                  className="absolute right-4 top-4 text-gray-400 hover:text-gray-600 transition-colors z-20 bg-white/80 rounded-full p-1 shadow-sm"
                >
                  <svg
                    className="w-6 h-6"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>

                {/* Scrollable Content */}
                <div className="overflow-y-auto p-6 pt-12">
                  <div className="text-left">
                    <StockAnalysisCard
                      stockId={stock.stockId}
                      isSimulation={true}
                      autoGenerate={true}
                      onBuyAlertClick={(limitPrice) => {
                        setCurrentTargetBuyPrice(limitPrice);
                        setShowBuyAlertModal(true);
                        setIsSimulating(false); // モーダルを閉じて通知設定を開く
                      }}
                      currentTargetBuyPrice={currentTargetBuyPrice}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tabbed Content Section */}
          <section className="bg-white rounded-xl shadow-md p-4 sm:p-6 mb-6">
            <Tabs
              tabs={[
                { id: "chart", label: tTabs("chart") },
                { id: "analysis", label: tTabs("technical") },
                { id: "news", label: tTabs("news") },
                { id: "details", label: tTabs("details") },
              ]}
              defaultTab="chart"
            >
              {(activeTab) => (
                <>
                  {activeTab === "chart" && (
                    <>
                      <StockChart stockId={stock.stockId} embedded />
                      <PriceHistory stockId={stock.stockId} embedded />
                    </>
                  )}
                  {activeTab === "analysis" && (
                    <TechnicalAnalysis stockId={stock.stockId} embedded />
                  )}
                  {activeTab === "news" && (
                    <RelatedNews stockId={stock.stockId} embedded />
                  )}
                  {activeTab === "details" && (
                    <>
                      <FinancialMetrics stock={stock.stock} embedded />
                      <EarningsInfo earnings={stock.stock} embedded />
                    </>
                  )}
                </>
              )}
            </Tabs>
          </section>
        </>
      )}

      {/* Delete Button */}
      <DeleteButton label="削除" onClick={handleDelete} />

      {/* Edit Transaction Dialog */}
      {selectedTransaction && (
        <EditTransactionDialog
          isOpen={true}
          onClose={() => setSelectedTransaction(null)}
          onSuccess={() => {
            setSelectedTransaction(null);
            router.refresh();
          }}
          transaction={selectedTransaction}
          stockName={stock.stock.name}
        />
      )}

      {/* Additional Purchase / Sell Dialog */}
      <AdditionalPurchaseDialog
        isOpen={showTransactionDialog}
        onClose={() => setShowTransactionDialog(false)}
        stock={{
          id: stock.id,
          userId: "",
          stockId: stock.stockId,
          type: stock.type,
          quantity: stock.quantity,
          averagePurchasePrice: stock.averagePurchasePrice,
          purchaseDate: stock.purchaseDate,
          stock: {
            ...stock.stock,
            currentPrice: price?.currentPrice ?? stock.stock.currentPrice,
          },
          createdAt: "",
          updatedAt: "",
        }}
        onSuccess={() => {
          setShowTransactionDialog(false);
          router.refresh();
        }}
        transactionType={transactionType}
      />

      {/* Tracking Confirmation Modal */}
      {showTrackingModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-bold text-gray-900">
                {t("trackThisStock")}
              </h3>
              <button
                onClick={() => setShowTrackingModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-2">
              <span className="font-semibold">{stock.stock.name}</span>
            </p>
            <p className="text-sm text-gray-500 mb-6">
              {t("trackingDescription")}
            </p>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  setTrackingStock(true);
                  try {
                    await fetch(`/api/user-stocks/${stock.id}`, {
                      method: "DELETE",
                    });
                    toast.success("見送りました");
                    router.push("/my-stocks");
                  } catch (err: any) {
                    toast.error(err.message || "削除に失敗しました");
                  } finally {
                    setTrackingStock(false);
                    setShowTrackingModal(false);
                  }
                }}
                disabled={trackingStock}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                {trackingStock ? t("processing") : t("passForNow")}
              </button>
              <button
                onClick={async () => {
                  setTrackingStock(true);
                  try {
                    const response = await fetch("/api/tracked-stocks", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        tickerCode: stock.stock.tickerCode,
                      }),
                    });
                    if (!response.ok) {
                      const data = await response.json();
                      throw new Error(data.error || "追跡に失敗しました");
                    }
                    await fetch(`/api/user-stocks/${stock.id}`, {
                      method: "DELETE",
                    });
                    toast.success("追跡に追加しました");
                    router.push("/my-stocks");
                  } catch (err: any) {
                    toast.error(err.message || "追跡に失敗しました");
                  } finally {
                    setTrackingStock(false);
                    setShowTrackingModal(false);
                  }
                }}
                disabled={trackingStock}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {trackingStock ? t("processing") : t("track")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Buy Alert Modal */}
      {showBuyAlertModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-bold text-gray-900">
                {t("buyAlertTitle")}
              </h3>
              <button
                onClick={() => setShowBuyAlertModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              {t("buyAlertDescription")}
            </p>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("targetBuyPrice")}
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
                  ¥
                </span>
                <input
                  type="number"
                  value={targetBuyPrice}
                  onChange={(e) => setTargetBuyPrice(e.target.value)}
                  placeholder={
                    stock.limitPrice ? stock.limitPrice.toLocaleString() : ""
                  }
                  className="w-full pl-8 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setShowBuyAlertModal(false)}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                {t("cancel")}
              </button>
              <button
                onClick={async () => {
                  setSavingTargetPrice(true);
                  try {
                    const priceValue = targetBuyPrice
                      ? Number(targetBuyPrice)
                      : null;
                    const response = await fetch(
                      `/api/user-stocks/${stock.id}`,
                      {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ targetBuyPrice: priceValue }),
                      },
                    );
                    if (!response.ok) {
                      throw new Error("保存に失敗しました");
                    }
                    setCurrentTargetBuyPrice(priceValue);
                    setShowBuyAlertModal(false);
                    toast.success("通知設定を保存しました");
                  } catch (err) {
                    console.error(err);
                    toast.error("保存に失敗しました");
                  } finally {
                    setSavingTargetPrice(false);
                  }
                }}
                disabled={savingTargetPrice}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {savingTargetPrice ? t("saving") : t("save")}
              </button>
            </div>

            <p className="text-xs text-gray-500 mt-3">{t("buyAlertNote")}</p>
          </div>
        </div>
      )}

      {/* Purchase Dialog for Watchlist */}
      <AddStockDialog
        isOpen={showPurchaseDialog}
        onClose={() => setShowPurchaseDialog(false)}
        onSuccess={() => {
          setShowPurchaseDialog(false);
          router.push("/my-stocks");
        }}
        defaultType="portfolio"
        initialStock={{
          id: stock.stock.id,
          tickerCode: stock.stock.tickerCode,
          name: stock.stock.name,
          market: stock.stock.market,
          sector: stock.stock.sector,
          latestPrice: currentPrice || null,
        }}
      />

      {/* Individual Settings Modal */}
      <IndividualSettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        stockId={stock.id}
        stockName={stock.stock.name}
        avgPurchasePrice={stock.averagePurchasePrice ?? 0}
        initialTpRate={currentTpRate}
        initialSlRate={currentSlRate}
        onSuccess={(tpRate, slRate) => {
          setCurrentTpRate(tpRate);
          setCurrentSlRate(slRate);
        }}
      />
    </StockDetailLayout>
  );
}
