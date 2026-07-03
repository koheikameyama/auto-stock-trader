-- CreateTable
CREATE TABLE "BuybackSignal" (
    "id" TEXT NOT NULL,
    "tdnetId" TEXT NOT NULL,
    "disclosedAt" TIMESTAMP(3) NOT NULL,
    "entryDate" DATE NOT NULL,
    "ticker" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "entryClose" DECIMAL(12,2),
    "slPrice" DECIMAL(12,2),
    "japanBreadth" DECIMAL(5,4),
    "isIdle" BOOLEAN NOT NULL DEFAULT false,
    "observeOnly" BOOLEAN NOT NULL DEFAULT true,
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "executedAt" TIMESTAMP(3),
    "brokerOrderNumber" TEXT,
    "positionId" TEXT,
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuybackSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuybackSignal_tdnetId_key" ON "BuybackSignal"("tdnetId");

-- CreateIndex
CREATE INDEX "BuybackSignal_entryDate_idx" ON "BuybackSignal"("entryDate" DESC);

-- CreateIndex
CREATE INDEX "BuybackSignal_isIdle_idx" ON "BuybackSignal"("isIdle");
