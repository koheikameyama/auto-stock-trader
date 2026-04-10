-- CreateTable
CREATE TABLE "EarningsDate" (
    "id" TEXT NOT NULL,
    "tickerCode" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EarningsDate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EarningsDate_tickerCode_date_idx" ON "EarningsDate"("tickerCode", "date" DESC);

-- CreateIndex
CREATE INDEX "EarningsDate_date_idx" ON "EarningsDate"("date");

-- CreateIndex
CREATE UNIQUE INDEX "EarningsDate_tickerCode_date_key" ON "EarningsDate"("tickerCode", "date");
