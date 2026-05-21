-- CreateTable
CREATE TABLE "UsEtfSignal" (
    "id" TEXT NOT NULL,
    "detectedDate" DATE NOT NULL,
    "ticker" TEXT NOT NULL,
    "todayClose" DECIMAL(12,2) NOT NULL,
    "gap" DECIMAL(8,4) NOT NULL,
    "volSurge" DECIMAL(8,2) NOT NULL,
    "japanBreadth" DECIMAL(5,4) NOT NULL,
    "slPrice" DECIMAL(12,2) NOT NULL,
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "executedAt" TIMESTAMP(3),
    "brokerOrderNumber" TEXT,
    "positionId" TEXT,
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsEtfSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsEtfSignal_detectedDate_idx" ON "UsEtfSignal"("detectedDate" DESC);

-- CreateIndex
CREATE INDEX "UsEtfSignal_executed_idx" ON "UsEtfSignal"("executed");

-- CreateIndex
CREATE UNIQUE INDEX "UsEtfSignal_detectedDate_ticker_key" ON "UsEtfSignal"("detectedDate", "ticker");
