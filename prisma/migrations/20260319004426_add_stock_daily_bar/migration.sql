-- CreateTable
CREATE TABLE "StockDailyBar" (
    "id" TEXT NOT NULL,
    "tickerCode" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT NOT NULL,

    CONSTRAINT "StockDailyBar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockDailyBar_tickerCode_date_idx" ON "StockDailyBar"("tickerCode", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "StockDailyBar_tickerCode_date_key" ON "StockDailyBar"("tickerCode", "date");
