-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "totalTrades" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL,
    "losses" INTEGER NOT NULL,
    "winRate" DOUBLE PRECISION NOT NULL,
    "profitFactor" DOUBLE PRECISION NOT NULL,
    "maxDrawdown" DOUBLE PRECISION NOT NULL,
    "sharpeRatio" DOUBLE PRECISION,
    "expectancy" DOUBLE PRECISION NOT NULL,
    "riskRewardRatio" DOUBLE PRECISION NOT NULL,
    "netReturnPct" DOUBLE PRECISION NOT NULL,
    "totalNetPnl" DOUBLE PRECISION NOT NULL,
    "avgHoldingDays" DOUBLE PRECISION NOT NULL,
    "metricsJson" JSONB NOT NULL,
    "equityCurveJson" JSONB NOT NULL,
    "tradesJson" JSONB NOT NULL,
    "configJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BacktestRun_runAt_idx" ON "BacktestRun"("runAt" DESC);
