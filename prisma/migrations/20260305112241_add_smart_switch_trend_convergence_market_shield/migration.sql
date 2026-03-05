-- AlterTable
ALTER TABLE "StockAnalysis" ADD COLUMN     "trendConvergence" JSONB;

-- CreateTable
CREATE TABLE "SwitchProposal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "session" TEXT NOT NULL,
    "sellStockId" TEXT NOT NULL,
    "sellRecoveryScore" DOUBLE PRECISION NOT NULL,
    "buyStockId" TEXT NOT NULL,
    "buyOpportunityScore" DOUBLE PRECISION NOT NULL,
    "switchBenefit" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "userAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SwitchProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketShield" (
    "id" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL,
    "deactivatedAt" TIMESTAMP(3),
    "triggerType" TEXT NOT NULL,
    "triggerValue" DOUBLE PRECISION NOT NULL,
    "affectedUsers" INTEGER NOT NULL,
    "actionsApplied" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketShield_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SwitchProposal_userId_date_idx" ON "SwitchProposal"("userId", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SwitchProposal_userId_date_sellStockId_key" ON "SwitchProposal"("userId", "date", "sellStockId");

-- CreateIndex
CREATE INDEX "MarketShield_activatedAt_idx" ON "MarketShield"("activatedAt" DESC);
