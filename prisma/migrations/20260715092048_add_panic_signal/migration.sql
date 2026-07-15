-- CreateTable
CREATE TABLE "PanicSignal" (
    "id" TEXT NOT NULL,
    "detectedDate" DATE NOT NULL,
    "ticker" TEXT NOT NULL,
    "conditionDate" DATE,
    "prevVixClose" DECIMAL(8,2),
    "breadth" DECIMAL(5,4),
    "breadthAllJp" DECIMAL(5,4),
    "nikkeiDownStreak" INTEGER,
    "conditionsMet" BOOLEAN NOT NULL DEFAULT false,
    "isEpisodeFirstDay" BOOLEAN NOT NULL DEFAULT false,
    "entryPrice" DECIMAL(12,2),
    "slPrice" DECIMAL(12,2),
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "executedAt" TIMESTAMP(3),
    "brokerOrderNumber" TEXT,
    "positionId" TEXT,
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PanicSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PanicSignal_detectedDate_idx" ON "PanicSignal"("detectedDate" DESC);

-- CreateIndex
CREATE INDEX "PanicSignal_conditionsMet_idx" ON "PanicSignal"("conditionsMet");

-- CreateIndex
CREATE UNIQUE INDEX "PanicSignal_detectedDate_ticker_key" ON "PanicSignal"("detectedDate", "ticker");
