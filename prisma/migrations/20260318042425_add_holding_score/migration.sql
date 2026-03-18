-- AlterTable
ALTER TABLE "TradingPosition" ADD COLUMN     "holdingScoreTrailOverride" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "HoldingScoreRecord" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "positionId" TEXT NOT NULL,
    "tickerCode" TEXT NOT NULL,
    "totalScore" INTEGER NOT NULL,
    "holdingRank" TEXT NOT NULL,
    "trendQualityScore" INTEGER NOT NULL,
    "riskQualityScore" INTEGER NOT NULL,
    "sectorMomentumScore" INTEGER NOT NULL,
    "trendQualityBreakdown" JSONB NOT NULL,
    "riskQualityBreakdown" JSONB NOT NULL,
    "gateResult" JSONB NOT NULL,
    "alerts" JSONB,
    "currentPrice" DECIMAL(10,2) NOT NULL,
    "unrealizedPnlPct" DECIMAL(8,4) NOT NULL,
    "holdingDays" INTEGER NOT NULL,
    "actionTaken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HoldingScoreRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HoldingScoreRecord_positionId_idx" ON "HoldingScoreRecord"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "HoldingScoreRecord_date_positionId_key" ON "HoldingScoreRecord"("date", "positionId");

-- AddForeignKey
ALTER TABLE "HoldingScoreRecord" ADD CONSTRAINT "HoldingScoreRecord_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "TradingPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
