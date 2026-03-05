"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  GAP_PREDICTION_DISPLAY,
} from "@/lib/constants";
import dayjs from "dayjs";
import utcPlugin from "dayjs/plugin/utc";
import timezonePlugin from "dayjs/plugin/timezone";
dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);
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
  userFitScore?: number | null;
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
  const [sectorScores, setSectorScores] = useState<Record<string, number>>({});
  const [trackedStaleTickers, setTrackedStaleTickers] = useState<Set<string>>(
    new Set(),
  );
  const [trackedPricesLoaded, setTrackedPricesLoaded] = useState(false);
  const [gapPredictions, setGapPredictions] = useState<
    Record<string, { estimatedGapRate: number; gapDirection: "up" | "down" | "flat"; previousClose: number | null; predictedOpenPrice: number | null; actualOpenPrice: number | null; actualGapRate: number | null }>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showTransactionDialog, setShowTransactionDialog] = useState(false);
  const [selectedStock, setSelectedStock] = useState<UserStock | null>(null);
  const [transactionType, setTransactionType] = useState<"buy" | "sell">("buy");
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab");
  const [activeTab, setActiveTab] = useState<TabType>(
    initialTab === "portfolio" || initialTab === "watchlist" || initialTab === "tracked" || initialTab === "sold"
      ? initialTab
      : "portfolio"
  );
  const switchTab = useCallback((tab: TabType) => {
    setActiveTab(tab);
    router.replace(`/my-stocks?tab=${tab}`, { scroll: false });
  }, [router]);
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
        setError(t("myStocksClient.fetchError"));
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
              userFitScore: result.value.data.userFitScore ?? null,
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

  // セクタートレンド取得（ウォッチリストのソート用）
  useEffect(() => {
    async function fetchSectorTrends() {
      try {
        const res = await fetch("/api/sector-trends");
        if (!res.ok) return;
        const data = await res.json();
        const scores: Record<string, number> = {};
        if (data.trends) {
          data.trends.forEach((t: { sector: string; compositeScore: number | null }) => {
            if (t.sector && t.compositeScore !== null) {
              scores[t.sector] = t.compositeScore;
            }
          });
        }
        setSectorScores(scores);
      } catch {
        // ignore
      }
    }
    fetchSectorTrends();
  }, []);

  // ギャップ予測データを取得（JST 7:00〜15:00のみ）
  useEffect(() => {
    const jstHour = dayjs().tz("Asia/Tokyo").hour();
    if (jstHour < GAP_PREDICTION_DISPLAY.START_HOUR || jstHour >= GAP_PREDICTION_DISPLAY.END_HOUR) return;

    async function fetchGapPredictions() {
      try {
        const res = await fetch("/api/gap-prediction?scope=all");
        if (!res.ok) return;
        const data = await res.json();
        if (!data?.stocks) return;
        const map: Record<string, typeof gapPredictions[string]> = {};
        for (const s of data.stocks) {
          map[s.stockId] = {
            estimatedGapRate: s.estimatedGapRate,
            gapDirection: s.gapDirection,
            previousClose: s.previousClose,
            predictedOpenPrice: s.predictedOpenPrice,
            actualOpenPrice: s.actualOpenPrice,
            actualGapRate: s.actualGapRate,
          };
        }
        setGapPredictions(map);
      } catch (err) {
        console.error("Error fetching gap predictions:", err);
      }
    }

    fetchGapPredictions();
  }, []);

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
      switchTab("watchlist");
      toast.success(t("myStocksClient.addedToWatchlist"));
    } catch (err) {
      console.error("Error adding to watchlist:", err);
      toast.error(err instanceof Error ? err.message : t("myStocksClient.addFailed"));
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
      switchTab("watchlist");
      toast.success(t("myStocksClient.addedToWatchlist"));
    } catch (err) {
      console.error("Error adding to watchlist:", err);
      toast.error(err instanceof Error ? err.message : t("myStocksClient.addFailed"));
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
    if (!confirm(t("myStocksClient.deleteConfirmName", { name: stock.stock.name }))) return;
    try {
      const response = await fetch(`/api/user-stocks/${stock.id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(t("myStocksClient.deleteFailed"));
      setUserStocks((prev) => prev.filter((s) => s.id !== stock.id));
      toast.success(t("myStocksClient.deleteSuccess", { name: stock.stock.name }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("myStocksClient.deleteFailed"));
    }
  };

  // 追跡銘柄を削除
  const handleDeleteTrackedStock = async (trackedStockId: string) => {
    const ts = trackedStocks.find((t) => t.id === trackedStockId);
    if (!confirm(t("myStocksClient.deleteConfirmName", { name: ts?.stock.name ?? t("myStocksClient.thisStock") }))) return;
    try {
      const response = await fetch(`/api/tracked-stocks/${trackedStockId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(t("myStocksClient.deleteFailed"));
      setTrackedStocks((prev) => prev.filter((t) => t.id !== trackedStockId));
      removeTrackedStock(trackedStockId);
      toast.success(t("myStocksClient.trackedDeleteSuccess"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("myStocksClient.deleteFailed"));
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
        throw new Error(data.error || t("myStocksClient.trackingFailed"));
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
      switchTab("tracked");
      toast.success(t("myStocksClient.addedToTracked"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("myStocksClient.trackingFailed"));
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
      switchTab("watchlist");
      toast.success(t("zeroStockOptions.addedToWatchlist"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("myStocksClient.addFailed"));
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
        throw new Error(data.error || t("myStocksClient.trackingFailed"));
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
      switchTab("tracked");
      toast.success(t("zeroStockOptions.addedToTracked"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("myStocksClient.trackingFailed"));
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

  // ウォッチリストを buyTiming × セクター順位で並び替え
  // 1. buy > stay > avoid の順
  // 2. buyTiming: market(成行OK) > dip(押し目) > null の順
  // 3. セクター compositeScore の高い順
  const watchlistStocks = useMemo(() => {
    const filtered = userStocks.filter((s) => s.type === "watchlist");

    const recOrder: Record<string, number> = { buy: 0, stay: 1, avoid: 2 };
    const timingOrder: Record<string, number> = { market: 0, dip: 1 };

    return filtered.sort((a, b) => {
      const recA = recommendations[a.stockId];
      const recB = recommendations[b.stockId];

      const orderA = recOrder[recA?.recommendation ?? "stay"] ?? 1;
      const orderB = recOrder[recB?.recommendation ?? "stay"] ?? 1;

      // ステータスが異なる場合はステータス順
      if (orderA !== orderB) return orderA - orderB;

      // buyTiming: market > dip > null
      const timingA = timingOrder[recA?.buyTiming ?? ""] ?? 2;
      const timingB = timingOrder[recB?.buyTiming ?? ""] ?? 2;
      if (timingA !== timingB) return timingA - timingB;

      // セクター compositeScore の高い順
      const sectorA = a.stock.sector ? (sectorScores[a.stock.sector] ?? -Infinity) : -Infinity;
      const sectorB = b.stock.sector ? (sectorScores[b.stock.sector] ?? -Infinity) : -Infinity;
      if (sectorA !== sectorB) return sectorB - sectorA;

      // 同じ場合は追加日時の新しい順
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [userStocks, recommendations, sectorScores]);

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
        <div>
          <h1 className="text-xl sm:text-3xl font-bold text-gray-900">
            {t('myStocks')}
          </h1>
          <p className="text-xs sm:text-base text-gray-600 mt-1">
            {t('description')}
          </p>
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
            onClick={() => switchTab("portfolio")}
            className={`flex-shrink-0 px-3 sm:px-6 py-3 font-semibold text-sm sm:text-base transition-colors whitespace-nowrap ${
              activeTab === "portfolio"
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t('tabs.holdings')} ({portfolioStocks.length})
          </button>
          <button
            onClick={() => switchTab("watchlist")}
            className={`flex-shrink-0 px-3 sm:px-6 py-3 font-semibold text-sm sm:text-base transition-colors whitespace-nowrap ${
              activeTab === "watchlist"
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t('tabs.watchlist')} ({watchlistStocks.length})
          </button>
          <button
            onClick={() => switchTab("tracked")}
            className={`flex-shrink-0 px-3 sm:px-6 py-3 font-semibold text-sm sm:text-base transition-colors whitespace-nowrap ${
              activeTab === "tracked"
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t('tabs.trackedAlt')} ({trackedStocks.length})
          </button>
          <button
            onClick={() => switchTab("sold")}
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
                  {t("myStocksClient.soldEmptyTitle")}
                </h3>
                <p className="text-sm sm:text-base text-gray-600">
                  {t("myStocksClient.soldEmptyDescription")}
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
                  {t("myStocksClient.currentCount", { count: displayStocks.length })}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {t("myStocksClient.analysisUpdate", { schedule: UPDATE_SCHEDULES.STOCK_ANALYSIS })}
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
                    ? t("myStocksClient.addPortfolioStock")
                    : t("myStocksClient.addWatchlistStock")}
                </button>
              </div>
            </div>

            {displayStocks.length === 0 ? (
              <div className="bg-white rounded-xl p-6 sm:p-12 text-center shadow-sm">
                <h3 className="text-base sm:text-lg font-semibold text-gray-900 mb-2">
                  {activeTab === "portfolio"
                    ? t("myStocksClient.emptyPortfolioTitle")
                    : t("myStocksClient.emptyWatchlistTitle")}
                </h3>
                <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6">
                  {t("myStocksClient.emptyDescription")}
                </p>
                <button
                  onClick={handleAddStock}
                  className="px-5 sm:px-6 py-2.5 sm:py-3 bg-blue-600 text-white rounded-lg text-sm sm:text-base font-semibold hover:bg-blue-700 transition-colors"
                >
                  {t("myStocksClient.addStockButton")}
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
                    gapPrediction={gapPredictions[stock.stockId]}
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
            switchTab("portfolio");
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
                {t("myStocksClient.trackConfirmTitle")}
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
              {t("myStocksClient.trackConfirmDescription")}
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
                    toast.success(t("myStocksClient.dismissed"));
                  } catch (err) {
                    toast.error(
                      err instanceof Error ? err.message : t("myStocksClient.deleteFailed"),
                    );
                  } finally {
                    setTrackingInProgress(false);
                  }
                }}
                disabled={trackingInProgress}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                {trackingInProgress ? t("myStocksClient.processing") : t("myStocksClient.passForNow")}
              </button>
              <button
                onClick={handleConfirmTracking}
                disabled={trackingInProgress}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {trackingInProgress ? t("myStocksClient.processing") : t("myStocksClient.trackAction")}
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
