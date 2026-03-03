// store/types.ts

export interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

export interface UserStock {
  id: string;
  userId: string;
  stockId: string;
  type: "watchlist" | "portfolio";
  quantity?: number;
  averagePurchasePrice?: number;
  purchaseDate?: string;
  lastAnalysis?: string | null;
  shortTerm?: string | null;
  mediumTerm?: string | null;
  longTerm?: string | null;
  recommendation?: "buy" | "sell" | "hold" | null;
  confidence?: number | null;
  analyzedAt?: string | null;
  takeProfitPrice?: number | null; // 旧形式（価格）
  stopLossPrice?: number | null; // 旧形式（価格）
  takeProfitRate?: number | null; // 新形式（%）
  stopLossRate?: number | null; // 新形式（%）
  transactions?: {
    id: string;
    type: string;
    quantity: number;
    price: number;
    totalAmount: number;
    transactionDate: string;
  }[];
  stock: {
    id: string;
    tickerCode: string;
    name: string;
    sector: string | null;
    market: string;
    currentPrice: number | null;
    fetchFailCount?: number;
    isDelisted?: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface TrackedStock {
  id: string;
  stockId: string;
  stock: {
    id: string;
    tickerCode: string;
    name: string;
    sector: string | null;
    market: string;
    fetchFailCount?: number;
    isDelisted?: boolean;
  };
  currentPrice: number | null;
  change: number | null;
  changePercent: number | null;
  marketTime: number | null;
  createdAt: string;
}

export interface SoldStock {
  id: string;
  stockId: string;
  stock: {
    id: string;
    tickerCode: string;
    name: string;
    sector: string | null;
    market: string;
  };
  firstPurchaseDate: string;
  lastSellDate: string;
  totalBuyQuantity: number;
  totalBuyAmount: number;
  totalSellAmount: number;
  totalProfit: number;
  profitPercent: number;
  currentPrice: number | null;
  hypotheticalValue: number | null;
  hypotheticalProfit: number | null;
  hypotheticalProfitPercent: number | null;
  transactions: {
    id: string;
    type: string;
    quantity: number;
    price: number;
    totalAmount: number;
    transactionDate: string;
    note: string | null;
  }[];
}

export interface StockPrice {
  tickerCode: string;
  currentPrice: number;
  previousClose: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
  marketTime: number | null;
}

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  unrealizedGain: number;
  unrealizedGainPercent: number;
  // 運用成績
  realizedGain: number;
  totalGain: number;
  totalGainPercent: number;
  winCount: number;
  loseCount: number;
  winRate: number | null;
  averageReturn: number | null;
}

export interface NikkeiData {
  changePercent: number;
}
