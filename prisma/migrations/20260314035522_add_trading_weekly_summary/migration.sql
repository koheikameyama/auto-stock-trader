-- CreateTable
CREATE TABLE "TradingWeeklySummary" (
    "id" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "weekEnd" DATE NOT NULL,
    "tradingDays" INTEGER NOT NULL,
    "totalTrades" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "totalPnl" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "portfolioValue" DECIMAL(12,0) NOT NULL,
    "cashBalance" DECIMAL(12,0) NOT NULL,
    "aiReview" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradingWeeklySummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TradingWeeklySummary_weekEnd_key" ON "TradingWeeklySummary"("weekEnd");

-- CreateIndex
CREATE INDEX "TradingWeeklySummary_weekEnd_idx" ON "TradingWeeklySummary"("weekEnd" DESC);
