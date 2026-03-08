-- CreateTable
CREATE TABLE "BacktestDailyResult" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "budgetTier" TEXT NOT NULL,
    "initialBudget" INTEGER NOT NULL,
    "maxPrice" INTEGER NOT NULL,
    "maxPositions" INTEGER NOT NULL,
    "tickerCount" INTEGER NOT NULL,
    "totalTrades" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL,
    "losses" INTEGER NOT NULL,
    "winRate" DECIMAL(5,2) NOT NULL,
    "profitFactor" DECIMAL(8,2) NOT NULL,
    "maxDrawdown" DECIMAL(5,2) NOT NULL,
    "sharpeRatio" DECIMAL(8,2),
    "totalPnl" INTEGER NOT NULL,
    "totalReturnPct" DECIMAL(8,2) NOT NULL,
    "avgHoldingDays" DECIMAL(5,2) NOT NULL,
    "byRank" JSONB NOT NULL,
    "fullResult" JSONB,
    "periodStart" TEXT NOT NULL,
    "periodEnd" TEXT NOT NULL,
    "executionTimeMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacktestDailyResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BacktestDailyResult_date_idx" ON "BacktestDailyResult"("date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "BacktestDailyResult_date_budgetTier_key" ON "BacktestDailyResult"("date", "budgetTier");
