-- CreateTable
CREATE TABLE "WatchlistEntry" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "tickerCode" TEXT NOT NULL,
    "avgVolume25" DOUBLE PRECISION NOT NULL,
    "atr14" DOUBLE PRECISION NOT NULL,
    "latestClose" DOUBLE PRECISION NOT NULL,
    "momentum5d" DOUBLE PRECISION NOT NULL,
    "weeklyHigh13" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WatchlistEntry_date_idx" ON "WatchlistEntry"("date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistEntry_date_tickerCode_key" ON "WatchlistEntry"("date", "tickerCode");
