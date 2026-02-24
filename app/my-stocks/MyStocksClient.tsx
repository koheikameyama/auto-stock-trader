"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import StockCard from "./StockCard";
import TrackedStockCard from "./TrackedStockCard";
import SoldStockCard from "./SoldStockCard";
import AddStockDialog from "./AddStockDialog";
import AdditionalPurchaseDialog from "./AdditionalPurchaseDialog";
import IndividualSettingsModal from "./IndividualSettingsModal";
import ImportCsvDialog from "./ImportCsvDialog";
import {
  UPDATE_SCHEDULES,
  MAX_PORTFOLIO_STOCKS,
  MAX_WATCHLIST_STOCKS,
} from "@/lib/constants";
import { useMarkPageSeen } from "@/app/hooks/useMarkPageSeen";
import { useAppStore } from "@/store/useAppStore";
import type {
  UserStock,
  TrackedStock,
  SoldStock,
  StockPrice,
} from "@/store/types";
import { MyStocksSkeleton } from "@/components/skeletons/my-stocks-skeleton";
import { useTranslations } from 'next-intl';

interface PurchaseRecommendation {
  recommendation: "buy" | "stay" | "avoid";
  confidence: number;
  reason: string;
  caution: string;
  analyzedAt?: string;
  buyTiming?: "market" | "dip" | null;
  sellTiming?: "market" | "rebound" | null;
}

type TabType = "portfolio" | "watchlist" | "tracked" | "sold";

export default function MyStocksClient() {
  const router = useRouter();
  useMarkPageSeen("my-stocks");
  const t = useTranslations('portfolio');

  // ストアから取得
  const {
    fetchUserStocks,
    fetchTrackedStocks,
    fetchSoldStocks,
    fetchStockPrices,
    staleTickers,
    updateUserStock,
    removeTrackedStock,
    invalidateUserStocks,
    invalidateSoldStocks,
    invalidatePortfolioSummary,
  } = useAppStore();

  // ローカル状態
  const [userStocks, setUserStocks] = useState<UserStock[]>([]);
  const [trackedStocks, setTrackedStocks] = useState<TrackedStock[]>([]);
  const [soldStocks, setSoldStocks] = useState<SoldStock[]>([]);
  const [prices, setPrices] = useState<Record<string, StockPrice>>({});
  const [pricesLoaded, setPricesLoaded] = useState(false);
  const [recommendations, setRecommendations] = useState<
    Record<string, PurchaseRecommendation>
  >({});
  const [trackedStaleTickers, setTrackedStaleTickers] = useState<Set<string>>(
    new Set(),
  );
  const [trackedPricesLoaded, setTrackedPricesLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showTransactionDialog, setShowTransactionDialog] = useState(false);
  const [selectedStock, setSelectedStock] = useState<UserStock | null>(null);
  const [transactionType, setTransactionType] = useState<"buy" | "sell">("buy");
  const [activeTab, setActiveTab] = useState<TabType>("portfolio");
  // ウォッチリストからの購入用
  const [purchaseFromWatchlist, setPurchaseFromWatchlist] =
    useState<UserStock | null>(null);
  // ウォッチリストからの追跡確認モーダル用
  const [showTrackingModal, setShowTrackingModal] = useState(false);
  const [trackingFromWatchlist, setTrackingFromWatchlist] =
    useState<UserStock | null>(null);
  const [trackingInProgress, setTrackingInProgress] = useState(false);
  // 追跡・過去の保有銘柄からの移動用
  const [stockToMove, setStockToMove] = useState<{
    stockId: string;
    tickerCode: string;
    name: string;
    market?: string;
    sector?: string | null;
  } | null>(null);
  // 個別設定価格モーダル用
  const [showIndividualSettingsModal, setShowIndividualSettingsModal] =
    useState(false);
  const [newlyAddedStock, setNewlyAddedStock] = useState<UserStock | null>(
    null,
  );
  // 全株売却後の選択モーダル用
  const [zeroStockTarget, setZeroStockTarget] = useState<UserStock | null>(
    null,
  );
  const [zeroStockActionInProgress, setZeroStockActionInProgress] =
    useState(false);
  // Fetch all data on initial load
  useEffect(() => {
    async function fetchData() {
      try {
        const [stocksData, trackedData, soldData] = await Promise.all([
          fetchUserStocks(),
          fetchTrackedStocks().catch(() => []),
          fetchSoldStocks().catch(() => []),
        ]);

        setUserStocks(stocksData);
        setTrackedStocks(trackedData);
        setSoldStocks(soldData);
      } catch (err) {
        console.error("Error fetching data:", err);
        setError("銘柄の取得に失敗しました");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [fetchUserStocks, fetchTrackedStocks, fetchSoldStocks]);

  // Fetch stock prices for active tab only
  useEffect(() => {
    async function fetchPricesFromStore() {
      let tickerCodes: string[] = [];

      if (activeTab === "portfolio") {
        tickerCodes = userStocks
          .filter((s) => s.type === "portfolio" && (s.quantity ?? 0) > 0)
          .map((s) => s.stock.tickerCode);
      } else if (activeTab === "watchlist") {
        tickerCodes = userStocks
          .filter((s) => s.type === "watchlist")
          .map((s) => s.stock.tickerCode);
      }

      if (tickerCodes.length === 0) return;

      try {
        const priceMap = await fetchStockPrices(tickerCodes);
        const priceRecord: Record<string, StockPrice> = {};
        priceMap.forEach((price, ticker) => {
          priceRecord[ticker] = price;
        });
        setPrices((prev) => ({ ...prev, ...priceRecord }));
      } catch (err) {
        console.error("Error fetching prices:", err);
      } finally {
        setPricesLoaded(true);
      }
    }

    if (
      userStocks.length > 0 &&
      (activeTab === "portfolio" || activeTab === "watchlist")
    ) {
      setPricesLoaded(false);
      fetchPricesFromStore();
      const interval = setInterval(fetchPricesFromStore, 5 * 60 * 1000);
      return () => clearInterval(interval);
    }
  }, [userStocks, activeTab, fetchStockPrices]);

  // Fetch stock prices for tracked stocks (only when tracked tab is active)
  useEffect(() => {
    async function fetchTrackedPrices() {
      const tickerCodes = trackedStocks.map((s) => s.stock.tickerCode);
      if (tickerCodes.length === 0) return;

      try {
        const response = await fetch(
          `/api/stocks/prices?tickers=${tickerCodes.join(",")}`,
        );
        if (!response.ok) return;

        const data = await response.json();
        const priceMap = new Map<string, StockPrice>();
        if (data.prices) {
          for (const price of data.prices as StockPrice[]) {
            priceMap.set(price.tickerCode, price);
            // .Tあり/なしの両方の可能性を考慮してマッピング
            const normalized = price.tickerCode.replace(/\.T$/i, "");
            priceMap.set(normalized, price);
          }
        }

        // staleティッカーを記録
        if (data.staleTickers?.length > 0) {
          setTrackedStaleTickers(new Set(data.staleTickers as string[]));
        }

        // 追跡銘柄の株価を更新
        setTrackedStocks((prev) =>
          prev.map((ts) => {
            const priceData = priceMap.get(ts.stock.tickerCode);
            return priceData
              ? {
                  ...ts,
                  currentPrice: priceData.currentPrice,
                  change: priceData.change,
                  changePercent: priceData.changePercent,
                  marketTime: priceData.marketTime,
                }
              : ts;
          }),
        );
        setTrackedPricesLoaded(true);
      } catch (err) {
        console.error("Error fetching tracked prices:", err);
        setTrackedPricesLoaded(true);
      }
    }

    if (activeTab === "tracked" && trackedStocks.length > 0) {
      fetchTrackedPrices();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, trackedStocks.length]);

  // Fetch purchase recommendations for watchlist stocks
  useEffect(() => {
    async function fetchRecommendations() {
      const watchlistStocks = userStocks.filter((s) => s.type === "watchlist");
      if (watchlistStocks.length === 0) return;

      try {
        // Fetch recommendations for each watchlist stock
        const results = await Promise.allSettled(
          watchlistStocks.map((stock) =>
            fetch(`/api/stocks/${stock.stockId}/purchase-recommendation`)
              .then((res) => (res.ok ? res.json() : null))
              .then((data) => ({ stockId: stock.stockId, data })),
          ),
        );

        const recommendationMap: Record<string, PurchaseRecommendation> = {};
        results.forEach((result) => {
          if (result.status === "fulfilled" && result.value.data) {
            recommendationMap[result.value.stockId] = {
              recommendation: result.value.data.recommendation,
              confidence: result.value.data.confidence,
              reason: result.value.data.reason,
              caution: result.value.data.caution,
              analyzedAt: result.value.data.analyzedAt,
              buyTiming: result.value.data.buyTiming,
              sellTiming: result.value.data.sellTiming,
            };
          }
        });
        setRecommendations(recommendationMap);
      } catch (err) {
        console.error("Error fetching recommendations:", err);
      }
    }

    if (userStocks.length > 0) {
      fetchRecommendations();
    }
  }, [userStocks]);

  // 追跡銘柄をウォッチリストに追加
  const handleTrackedToWatchlist = async (
    stockId: string,
    tickerCode: string,
    name: string,
  ) => {
    try {
      const response = await fetch("/api/user-stocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickerCode, type: "watchlist" }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to add to watchlist");
      }
      const newStock = await response.json();
      setUserStocks((prev) => [...prev, newStock]);
      // 追跡銘柄リストから削除
      setTrackedStocks((prev) => prev.filter((ts) => ts.stockId !== stockId));
      setActiveTab("watchlist");
      toast.success("気になるリストに追加しました");
    } catch (err) {
      console.error("Error adding to watchlist:", err);
      toast.error(err instanceof Error ? err.message : "追加に失敗しました");
    }
  };

  // 追跡銘柄をポートフォリオに追加（AddStockDialogを開く）
  const handleTrackedToPurchase = (
    stockId: string,
    tickerCode: string,
    name: string,
    market: string,
    sector: string | null,
  ) => {
    setStockToMove({ stockId, tickerCode, name, market, sector });
    setShowAddDialog(true);
  };

  // 過去の保有銘柄をウォッチリストに追加
  const handleSoldToWatchlist = async (
    stockId: string,
    tickerCode: string,
    name: string,
  ) => {
    try {
      const response = await fetch("/api/user-stocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickerCode, type: "watchlist" }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to add to watchlist");
      }
      const newStock = await response.json();
      setUserStocks((prev) => [...prev, newStock]);
      setActiveTab("watchlist");
      toast.success("気になるリストに追加しました");
    } catch (err) {
      console.error("Error adding to watchlist:", err);
      toast.error(err instanceof Error ? err.message : "追加に失敗しました");
    }
  };

  // 過去の保有銘柄を再購入（AddStockDialogを開く）
  const handleSoldToRepurchase = (
    stockId: string,
    tickerCode: string,
    name: string,
    market: string,
    sector: string | null,
  ) => {
    setStockToMove({ stockId, tickerCode, name, market, sector });
    setShowAddDialog(true);
  };

  // ユーザー銘柄（ポートフォリオ・ウォッチリスト）を削除
  const handleDeleteUserStock = async (stock: UserStock) => {
    if (!confirm(`${stock.stock.name}を削除しますか？`)) return;
    try {
      const response = await fetch(`/api/user-stocks/${stock.id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("削除に失敗しました");
      setUserStocks((prev) => prev.filter((s) => s.id !== stock.id));
      toast.success(`${stock.stock.name}を削除しました`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "削除に失敗しました");
    }
  };

  // 追跡銘柄を削除
  const handleDeleteTrackedStock = async (trackedStockId: string) => {
    const ts = trackedStocks.find((t) => t.id === trackedStockId);
    if (!confirm(`${ts?.stock.name ?? "この銘柄"}を削除しますか？`)) return;
    try {
      const response = await fetch(`/api/tracked-stocks/${trackedStockId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("削除に失敗しました");
      setTrackedStocks((prev) => prev.filter((t) => t.id !== trackedStockId));
      removeTrackedStock(trackedStockId);
      toast.success("追跡銘柄を削除しました");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "削除に失敗しました");
    }
  };

  const handleAddStock = () => {
    setShowAddDialog(true);
  };

  const handleAdditionalPurchase = (stock: UserStock) => {
    setSelectedStock(stock);
    setTransactionType("buy");
    setShowTransactionDialog(true);
  };

  const handleSell = (stock: UserStock) => {
    setSelectedStock(stock);
    setTransactionType("sell");
    setShowTransactionDialog(true);
  };

  const handlePurchaseFromWatchlist = (stock: UserStock) => {
    setPurchaseFromWatchlist(stock);
    setShowAddDialog(true);
  };

  const handleTrackClickFromWatchlist = (stock: UserStock) => {
    setTrackingFromWatchlist(stock);
    setShowTrackingModal(true);
  };

  const handleConfirmTracking = async () => {
    if (!trackingFromWatchlist) return;
    setTrackingInProgress(true);
    try {
      const response = await fetch("/api/tracked-stocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tickerCode: trackingFromWatchlist.stock.tickerCode,
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "追跡に失敗しました");
      }
      const newTracked = await response.json();
      // ウォッチリストから削除
      await fetch(`/api/user-stocks/${trackingFromWatchlist.id}`, {
        method: "DELETE",
      });
      setUserStocks((prev) =>
        prev.filter((s) => s.id !== trackingFromWatchlist.id),
      );
      setTrackedStocks((prev) => [
        ...prev,
        newTracked as unknown as TrackedStock,
      ]);
      setShowTrackingModal(false);
      setTrackingFromWatchlist(null);
      setActiveTab("tracked");
      toast.success("追跡に追加しました");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "追跡に失敗しました");
    } finally {
      setTrackingInProgress(false);
    }
  };

  // 全株売却後: ウォッチリストに追加
  const handleZeroStockToWatchlist = async () => {
    if (!zeroStockTarget) return;
    setZeroStockActionInProgress(true);
    try {
      const response = await fetch("/api/user-stocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tickerCode: zeroStockTarget.stock.tickerCode,
          type: "watchlist",
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to add to watchlist");
      }
      const newStock = await response.json();
      // 0株のポートフォリオ銘柄を除去し、ウォッチリストとして追加
      setUserStocks((prev) => [
        ...prev.filter((s) => s.id !== zeroStockTarget.id),
        newStock,
      ]);
      // 売却済みリストを更新
      invalidateSoldStocks();
      const updatedSoldStocks = await fetchSoldStocks().catch(() => []);
      setSoldStocks(updatedSoldStocks);
      invalidatePortfolioSummary();
      setZeroStockTarget(null);
      setActiveTab("watchlist");
      toast.success(t("zeroStockOptions.addedToWatchlist"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "追加に失敗しました");
    } finally {
      setZeroStockActionInProgress(false);
    }
  };

  // 全株売却後: 追跡に追加
  const handleZeroStockToTracked = async () => {
    if (!zeroStockTarget) return;
    setZeroStockActionInProgress(true);
    try {
      const response = await fetch("/api/tracked-stocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tickerCode: zeroStockTarget.stock.tickerCode,
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "追跡に失敗しました");
      }
      const newTracked = await response.json();
      // 0株のポートフォリオ銘柄を除去
      setUserStocks((prev) =>
        prev.filter((s) => s.id !== zeroStockTarget.id),
      );
      setTrackedStocks((prev) => [
        ...prev,
        newTracked as unknown as TrackedStock,
      ]);
      // 売却済みリストを更新
      invalidateSoldStocks();
      const updatedSoldStocks = await fetchSoldStocks().catch(() => []);
      setSoldStocks(updatedSoldStocks);
      invalidatePortfolioSummary();
      setZeroStockTarget(null);
      setActiveTab("tracked");
      toast.success(t("zeroStockOptions.addedToTracked"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "追跡に失敗しました");
    } finally {
      setZeroStockActionInProgress(false);
    }
  };

  // 全株売却後: 何もしない（過去の保有に移動）
  const handleZeroStockDismiss = async () => {
    // 0株のポートフォリオ銘柄をローカル状態から除去
    if (zeroStockTarget) {
      setUserStocks((prev) =>
        prev.filter((s) => s.id !== zeroStockTarget.id),
      );
    }
    // 売却済みリストを更新
    invalidateSoldStocks();
    const updatedSoldStocks = await fetchSoldStocks().catch(() => []);
    setSoldStocks(updatedSoldStocks);
    invalidatePortfolioSummary();
    setZeroStockTarget(null);
    toast.success(t("zeroStockOptions.movedToSold"));
  };

  const handleStockAdded = (newStock: UserStock) => {
    setUserStocks((prev) => [...prev, newStock]);
    setShowAddDialog(false);

    // ポートフォリオへの追加で、且つ利確・損切り価格が設定されていれば設定モーダルを表示
    if (
      newStock.type === "portfolio" &&
      (newStock.takeProfitPrice || newStock.stopLossPrice)
    ) {
      setNewlyAddedStock(newStock);
      // 少し遅延させてダイアログが閉じるのを待つ
      setTimeout(() => setShowIndividualSettingsModal(true), 300);
    }
  };

  const handleTransactionSuccess = (updatedStock: UserStock) => {
    setUserStocks((prev) =>
      prev.map((s) => (s.id === updatedStock.id ? updatedStock : s)),
    );
    setShowTransactionDialog(false);
    setSelectedStock(null);

    // ストアのキャッシュを無効化（次回ページ遷移時に最新データを取得するため）
    invalidateUserStocks();

    // 全株売却時は選択モーダルを表示
    if (
      updatedStock.type === "portfolio" &&
      (updatedStock.quantity ?? 0) === 0
    ) {
      invalidateSoldStocks();
      setZeroStockTarget(updatedStock);
      return;
    }

    // 購入の場合、利確・損切り価格が設定されていれば設定モーダルを表示
    if (
      updatedStock.type === "portfolio" &&
      (updatedStock.takeProfitPrice || updatedStock.stopLossPrice)
    ) {
      setNewlyAddedStock(updatedStock);
      setShowIndividualSettingsModal(true);
    }
  };

  // Filter stocks by type
  // quantity > 0 のものだけを保有中として表示（0株は「過去の保有」に表示される）
  // ポートフォリオを売り推奨順に並び替え
  // 1. 売り推奨の銘柄を上に
  // 2. 売り推奨同士は損益率の悪い順
  // 3. それ以外は保有金額の大きい順
  const portfolioStocks = useMemo(() => {
    const filtered = userStocks.filter(
      (s) => s.type === "portfolio" && (s.quantity ?? 0) > 0,
    );
    return filtered.sort((a, b) => {
      const isSellA = a.recommendation === "sell";
      const isSellB = b.recommendation === "sell";

      // 売り推奨を上に
      if (isSellA && !isSellB) return -1;
      if (!isSellA && isSellB) return 1;

      // 損益率を計算（現在価格がない場合は0）
      const priceA =
        prices[a.stock.tickerCode]?.currentPrice ?? a.averagePurchasePrice ?? 0;
      const priceB =
        prices[b.stock.tickerCode]?.currentPrice ?? b.averagePurchasePrice ?? 0;
      const profitRateA = a.averagePurchasePrice
        ? (priceA - a.averagePurchasePrice) / a.averagePurchasePrice
        : 0;
      const profitRateB = b.averagePurchasePrice
        ? (priceB - b.averagePurchasePrice) / b.averagePurchasePrice
        : 0;

      // 両方売り推奨の場合は損益率の悪い順（損失が大きい方が上）
      if (isSellA && isSellB) {
        return profitRateA - profitRateB;
      }

      // それ以外は保有金額の大きい順
      const holdingA = (a.quantity ?? 0) * priceA;
      const holdingB = (b.quantity ?? 0) * priceB;
      return holdingB - holdingA;
    });
  }, [userStocks, prices]);

  // ウォッチリストを買い推奨順に並び替え
  // 1. 買い推奨の銘柄を上に
  // 2. 買い推奨同士はconfidence（スコア）の高い順
  // 3. それ以外は追加日時の新しい順
  const watchlistStocks = useMemo(() => {
    const filtered = userStocks.filter((s) => s.type === "watchlist");
    return filtered.sort((a, b) => {
      const recA = recommendations[a.stockId];
      const recB = recommendations[b.stockId];

      const isBuyA = recA?.recommendation === "buy";
      const isBuyB = recB?.recommendation === "buy";

      // 買い推奨を上に
      if (isBuyA && !isBuyB) return -1;
      if (!isBuyA && isBuyB) return 1;

      // 両方買い推奨の場合はconfidenceで並べる
      if (isBuyA && isBuyB) {
        return (recB?.confidence ?? 0) - (recA?.confidence ?? 0);
      }

      // それ以外は追加日時の新しい順
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [userStocks, recommendations]);

  const displayStocks =
    activeTab === "portfolio" ? portfolioStocks : watchlistStocks;

  if (loading) {
    return <MyStocksSkeleton />;
  }

  return (
    <>
      {/* 戻るボタン */}
      <div className="mb-4 sm:mb-6">
        <button
          onClick={() => router.push("/dashboard")}
          className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
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
              d="M15 19l-7-7 7-7"
            />
          </svg>
          <span className="text-sm sm:text-base font-semibold">
            {t('backToDashboard')}
          </span>
        </button>
      </div>

      {/* Page Header */}
      <div className="mb-4 sm:mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-3xl font-bold text-gray-900">
              {t('myStocks')}
            </h1>
            <p className="text-xs sm:text-base text-gray-600 mt-1">
              {t('description')}
            </p>
          </div>
          <button
            onClick={() => router.push("/portfolio-analysis")}
            className="flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50 hover:border-blue-300 transition-all shadow-sm"
          >
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
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
            <span>{t('overallAnalysisButton')}</span>
          </button>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="mb-4 sm:mb-6 bg-red-50 border border-red-200 rounded-lg p-3 sm:p-4">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Tab Navigation */}
      <div className="relative mb-6">
        <div className="flex overflow-x-auto scrollbar-hide border-b border-gray-200 -mx-3 px-3 sm:mx-0 sm:px-0">
          <button
            onClick={() => setActiveTab("portfolio")}
            className={`flex-shrink-0 px-3 sm:px-6 py-3 font-semibold text-sm sm:text-base transition-colors whitespace-nowrap ${
              activeTab === "portfolio"
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t('tabs.holdings')} ({portfolioStocks.length})
          </button>
          <button
            onClick={() => setActiveTab("watchlist")}
            className={`flex-shrink-0 px-3 sm:px-6 py-3 font-semibold text-sm sm:text-base transition-colors whitespace-nowrap ${
              activeTab === "watchlist"
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t('tabs.watchlistAlt')} ({watchlistStocks.length})
          </button>
          <button
            onClick={() => setActiveTab("tracked")}
            className={`flex-shrink-0 px-3 sm:px-6 py-3 font-semibold text-sm sm:text-base transition-colors whitespace-nowrap ${
              activeTab === "tracked"
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t('tabs.trackedAlt')} ({trackedStocks.length})
          </button>
          <button
            onClick={() => setActiveTab("sold")}
            className={`flex-shrink-0 px-3 sm:px-6 py-3 font-semibold text-sm sm:text-base transition-colors whitespace-nowrap ${
              activeTab === "sold"
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t('tabs.soldAlt')} ({soldStocks.length})
          </button>
        </div>
        {/* スクロール可能インジケーター（スマホのみ） */}
        <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-blue-50 to-transparent pointer-events-none sm:hidden" />
      </div>

      {/* Stock List Section */}
      <section>
        {activeTab === "tracked" ? (
          // 追跡銘柄タブ
          <>
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 sm:gap-4 mb-4">
              <div>
                <p className="text-xs sm:text-sm text-gray-500">
                  {t('tracked.description')}
                </p>
              </div>
              <button
                onClick={() => setShowAddDialog(true)}
                className="w-full sm:w-auto px-4 py-2 sm:py-2.5 bg-blue-600 text-white rounded-lg text-sm sm:text-base font-semibold hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
              >
                <svg
                  className="w-4 h-4 sm:w-5 sm:h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                {t('tracked.addButton')}
              </button>
            </div>
            {trackedStocks.length === 0 ? (
              <div className="bg-white rounded-xl p-6 sm:p-12 text-center shadow-sm">
                <h3 className="text-base sm:text-lg font-semibold text-gray-900 mb-2">
                  {t('tracked.emptyTitle')}
                </h3>
                <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6">
                  {t('tracked.emptyDescription')}
                </p>
                <button
                  onClick={() => setShowAddDialog(true)}
                  className="px-5 sm:px-6 py-2.5 sm:py-3 bg-blue-600 text-white rounded-lg text-sm sm:text-base font-semibold hover:bg-blue-700 transition-colors"
                >
                  {t('tracked.addStockButton')}
                </button>
              </div>
            ) : (
              <div className="grid gap-3 sm:gap-6">
                {trackedStocks.map((ts) => (
                  <TrackedStockCard
                    key={ts.id}
                    trackedStock={ts}
                    isStale={trackedStaleTickers.has(ts.stock.tickerCode)}
                    priceLoaded={trackedPricesLoaded}
                    onMoveToWatchlist={handleTrackedToWatchlist}
                    onPurchase={handleTrackedToPurchase}
                    onDelete={handleDeleteTrackedStock}
                  />
                ))}
              </div>
            )}
          </>
        ) : activeTab === "sold" ? (
          // 保有してた銘柄タブ
          <>
            {soldStocks.length === 0 ? (
              <div className="bg-white rounded-xl p-6 sm:p-12 text-center shadow-sm">
                <h3 className="text-base sm:text-lg font-semibold text-gray-900 mb-2">
                  保有してた銘柄はありません
                </h3>
                <p className="text-sm sm:text-base text-gray-600">
                  全株売却した銘柄がここに表示されます
                </p>
              </div>
            ) : (
              <div className="grid gap-3 sm:gap-6">
                {soldStocks.map((ss) => (
                  <SoldStockCard
                    key={ss.id}
                    soldStock={ss}
                    onAddToWatchlist={handleSoldToWatchlist}
                    onRepurchase={handleSoldToRepurchase}
                    onTransactionUpdated={async () => {
                      invalidateSoldStocks();
                      invalidateUserStocks();
                      invalidatePortfolioSummary();
                      const [updatedStocks, updatedSoldStocks] =
                        await Promise.all([
                          fetchUserStocks().catch(() => []),
                          fetchSoldStocks().catch(() => []),
                        ]);
                      setUserStocks(updatedStocks);
                      setSoldStocks(updatedSoldStocks);
                    }}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          // 保有銘柄・気になる銘柄タブ
          <>
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 sm:gap-4 mb-4">
              <div>
                <p className="text-xs sm:text-sm text-gray-500">
                  現在 {displayStocks.length} 銘柄
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  AI分析更新 {UPDATE_SCHEDULES.STOCK_ANALYSIS}（平日）
                </p>
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                {activeTab === "portfolio" && (
                  <button
                    onClick={() => setShowImportDialog(true)}
                    className="px-3 py-2 sm:py-2.5 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors flex items-center justify-center gap-1.5 flex-shrink-0"
                    title={t("importCsv.buttonLabel")}
                  >
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
                        d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 11l3 3m0 0l3-3m-3 3V4"
                      />
                    </svg>
                    <span className="hidden sm:inline">{t("importCsv.buttonLabel")}</span>
                  </button>
                )}
                <button
                  onClick={handleAddStock}
                  disabled={
                    displayStocks.length >=
                    (activeTab === "portfolio"
                      ? MAX_PORTFOLIO_STOCKS
                      : MAX_WATCHLIST_STOCKS)
                  }
                  className="flex-1 sm:flex-none w-full sm:w-auto px-4 py-2 sm:py-2.5 bg-blue-600 text-white rounded-lg text-sm sm:text-base font-semibold hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  <svg
                    className="w-4 h-4 sm:w-5 sm:h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 4v16m8-8H4"
                    />
                  </svg>
                  {activeTab === "portfolio"
                    ? "保有銘柄を追加"
                    : "気になる銘柄を追加"}
                </button>
              </div>
            </div>

            {displayStocks.length === 0 ? (
              <div className="bg-white rounded-xl p-6 sm:p-12 text-center shadow-sm">
                <h3 className="text-base sm:text-lg font-semibold text-gray-900 mb-2">
                  {activeTab === "portfolio"
                    ? "保有銘柄がありません"
                    : "気になる銘柄がありません"}
                </h3>
                <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6">
                  銘柄を追加して投資を始めましょう
                </p>
                <button
                  onClick={handleAddStock}
                  className="px-5 sm:px-6 py-2.5 sm:py-3 bg-blue-600 text-white rounded-lg text-sm sm:text-base font-semibold hover:bg-blue-700 transition-colors"
                >
                  銘柄を追加する
                </button>
              </div>
            ) : (
              <div className="grid gap-3 sm:gap-6">
                {displayStocks.map((stock) => (
                  <StockCard
                    key={stock.id}
                    stock={stock}
                    price={prices[stock.stock.tickerCode]}
                    priceLoaded={pricesLoaded}
                    isStale={staleTickers.has(stock.stock.tickerCode)}
                    recommendation={recommendations[stock.stockId]}
                    portfolioRecommendation={
                      stock.type === "portfolio"
                        ? stock.recommendation
                        : undefined
                    }
                    analyzedAt={
                      stock.type === "watchlist"
                        ? recommendations[stock.stockId]?.analyzedAt
                        : stock.analyzedAt
                    }
                    onAdditionalPurchase={
                      stock.type === "portfolio"
                        ? () => handleAdditionalPurchase(stock)
                        : undefined
                    }
                    onSell={
                      stock.type === "portfolio"
                        ? () => handleSell(stock)
                        : undefined
                    }
                    onPurchase={
                      stock.type === "watchlist"
                        ? () => handlePurchaseFromWatchlist(stock)
                        : undefined
                    }
                    onTrackClick={
                      stock.type === "watchlist"
                        ? () => handleTrackClickFromWatchlist(stock)
                        : undefined
                    }
                    onDelete={() => handleDeleteUserStock(stock)}
                    onTransactionUpdated={async () => {
                      invalidateUserStocks();
                      invalidateSoldStocks();
                      invalidatePortfolioSummary();
                      const [updatedStocks, updatedSoldStocks] =
                        await Promise.all([
                          fetchUserStocks(),
                          fetchSoldStocks().catch(() => []),
                        ]);
                      setUserStocks(updatedStocks);
                      setSoldStocks(updatedSoldStocks);
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* Dialogs */}
      <AddStockDialog
        isOpen={showAddDialog}
        onClose={() => {
          setShowAddDialog(false);
          setPurchaseFromWatchlist(null);
          setStockToMove(null);
        }}
        onSuccess={(newStock) => {
          // 追跡タブからの直接追加の場合
          if (
            activeTab === "tracked" &&
            !purchaseFromWatchlist &&
            !stockToMove
          ) {
            setTrackedStocks((prev) => [
              ...prev,
              newStock as unknown as TrackedStock,
            ]);
          } else {
            handleStockAdded(newStock);
          }
          setPurchaseFromWatchlist(null);
          // 追跡銘柄からの移動の場合、追跡銘柄リストを更新
          if (stockToMove) {
            setTrackedStocks((prev) =>
              prev.filter((ts) => ts.stockId !== stockToMove.stockId),
            );
            setStockToMove(null);
            setActiveTab("portfolio");
          }
        }}
        defaultType={
          purchaseFromWatchlist || stockToMove
            ? "portfolio"
            : activeTab === "tracked"
              ? "tracked"
              : activeTab === "sold"
                ? "portfolio"
                : activeTab
        }
        initialStock={
          purchaseFromWatchlist
            ? {
                id: purchaseFromWatchlist.stock.id,
                tickerCode: purchaseFromWatchlist.stock.tickerCode,
                name: purchaseFromWatchlist.stock.name,
                market: purchaseFromWatchlist.stock.market,
                sector: purchaseFromWatchlist.stock.sector,
                latestPrice:
                  prices[purchaseFromWatchlist.stock.tickerCode]
                    ?.currentPrice ?? purchaseFromWatchlist.stock.currentPrice,
              }
            : stockToMove
              ? {
                  id: stockToMove.stockId,
                  tickerCode: stockToMove.tickerCode,
                  name: stockToMove.name,
                  market: stockToMove.market || "プライム",
                  sector: stockToMove.sector || null,
                  latestPrice: null,
                }
              : null
        }
      />

      <AdditionalPurchaseDialog
        isOpen={showTransactionDialog}
        onClose={() => {
          setShowTransactionDialog(false);
          setSelectedStock(null);
        }}
        stock={
          selectedStock
            ? {
                ...selectedStock,
                stock: {
                  ...selectedStock.stock,
                  currentPrice:
                    prices[selectedStock.stock.tickerCode]?.currentPrice ??
                    selectedStock.stock.currentPrice,
                },
              }
            : null
        }
        onSuccess={handleTransactionSuccess}
        transactionType={transactionType}
      />

      <ImportCsvDialog
        isOpen={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        onImportComplete={async () => {
          const [stocksData, soldData] = await Promise.all([
            fetchUserStocks().catch(() => []),
            fetchSoldStocks().catch(() => []),
          ]);
          setUserStocks(stocksData);
          setSoldStocks(soldData);
        }}
      />

      {/* Tracking Confirmation Modal */}
      {showTrackingModal && trackingFromWatchlist && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-bold text-gray-900">
                この銘柄を追跡しますか？
              </h3>
              <button
                onClick={() => {
                  setShowTrackingModal(false);
                  setTrackingFromWatchlist(null);
                }}
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
              <span className="font-semibold">
                {trackingFromWatchlist.stock.name}
              </span>
            </p>
            <p className="text-sm text-gray-500 mb-6">
              追跡すると、AI分析なしで株価だけを追いかけられます。気になるリストからは移動されます。
            </p>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  if (!trackingFromWatchlist) return;
                  setTrackingInProgress(true);
                  try {
                    await fetch(
                      `/api/user-stocks/${trackingFromWatchlist.id}`,
                      { method: "DELETE" },
                    );
                    setUserStocks((prev) =>
                      prev.filter((s) => s.id !== trackingFromWatchlist.id),
                    );
                    setShowTrackingModal(false);
                    setTrackingFromWatchlist(null);
                    toast.success("見送りました");
                  } catch (err) {
                    toast.error(
                      err instanceof Error ? err.message : "削除に失敗しました",
                    );
                  } finally {
                    setTrackingInProgress(false);
                  }
                }}
                disabled={trackingInProgress}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                {trackingInProgress ? "処理中..." : "見送る"}
              </button>
              <button
                onClick={handleConfirmTracking}
                disabled={trackingInProgress}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {trackingInProgress ? "処理中..." : "追跡する"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 全株売却後の選択モーダル */}
      {zeroStockTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-1">
              {t("zeroStockOptions.title")}
            </h3>
            <p className="text-sm text-gray-600 mb-2">
              <span className="font-semibold">
                {zeroStockTarget.stock.name}
              </span>
            </p>
            <p className="text-sm text-gray-500 mb-5">
              {t("zeroStockOptions.description")}
            </p>
            <div className="space-y-2">
              <button
                onClick={handleZeroStockToWatchlist}
                disabled={zeroStockActionInProgress}
                className="w-full flex items-center gap-3 px-4 py-3 border border-gray-200 rounded-lg hover:bg-blue-50 hover:border-blue-300 transition-colors disabled:opacity-50 text-left"
              >
                <svg
                  className="w-5 h-5 text-blue-600 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
                  />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-gray-900">
                    {t("zeroStockOptions.watchlist")}
                  </p>
                  <p className="text-xs text-gray-500">
                    {t("zeroStockOptions.watchlistDescription")}
                  </p>
                </div>
              </button>
              <button
                onClick={handleZeroStockToTracked}
                disabled={zeroStockActionInProgress}
                className="w-full flex items-center gap-3 px-4 py-3 border border-gray-200 rounded-lg hover:bg-green-50 hover:border-green-300 transition-colors disabled:opacity-50 text-left"
              >
                <svg
                  className="w-5 h-5 text-green-600 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                  />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-gray-900">
                    {t("zeroStockOptions.track")}
                  </p>
                  <p className="text-xs text-gray-500">
                    {t("zeroStockOptions.trackDescription")}
                  </p>
                </div>
              </button>
              <button
                onClick={handleZeroStockDismiss}
                disabled={zeroStockActionInProgress}
                className="w-full flex items-center gap-3 px-4 py-3 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 text-left"
              >
                <svg
                  className="w-5 h-5 text-gray-400 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-gray-900">
                    {t("zeroStockOptions.dismiss")}
                  </p>
                  <p className="text-xs text-gray-500">
                    {t("zeroStockOptions.dismissDescription")}
                  </p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 個別利益・損切り価格設定モーダル */}
      {newlyAddedStock && (
        <IndividualSettingsModal
          isOpen={showIndividualSettingsModal}
          onClose={() => {
            setShowIndividualSettingsModal(false);
            setNewlyAddedStock(null);
          }}
          stockId={newlyAddedStock.id}
          stockName={newlyAddedStock.stock.name}
          avgPurchasePrice={newlyAddedStock.averagePurchasePrice ?? 0}
          initialTpRate={newlyAddedStock.takeProfitRate ?? null}
          initialSlRate={newlyAddedStock.stopLossRate ?? null}
          onSuccess={(tp, sl) => {
            // 更新後の情報を反映
            setUserStocks((prev) =>
              prev.map((s) =>
                s.id === newlyAddedStock.id
                  ? { ...s, takeProfitPrice: tp, stopLossPrice: sl }
                  : s,
              ),
            );
          }}
          isNewAddition={true}
        />
      )}
    </>
  );
}
