/*
  Warnings:

  - You are about to alter the column `takeProfitRate` on the `PortfolioStock` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(8,2)`.
  - You are about to alter the column `stopLossRate` on the `PortfolioStock` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(8,2)`.
  - You are about to drop the column `stopLossRate` on the `UserDailyRecommendation` table. All the data in the column will be lost.
  - You are about to drop the column `takeProfitRate` on the `UserDailyRecommendation` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "PortfolioOverallAnalysis" ALTER COLUMN "marketHeadline" DROP DEFAULT,
ALTER COLUMN "marketTone" DROP DEFAULT,
ALTER COLUMN "marketKeyFactor" DROP DEFAULT,
ALTER COLUMN "portfolioStatus" DROP DEFAULT,
ALTER COLUMN "portfolioSummary" DROP DEFAULT,
ALTER COLUMN "actionPlan" DROP DEFAULT,
ALTER COLUMN "buddyMessage" DROP DEFAULT,
ALTER COLUMN "stockHighlights" DROP DEFAULT,
ALTER COLUMN "sectorHighlights" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PortfolioStock" ALTER COLUMN "takeProfitRate" SET DATA TYPE DECIMAL(8,2),
ALTER COLUMN "stopLossRate" SET DATA TYPE DECIMAL(8,2);

-- AlterTable
ALTER TABLE "UserDailyRecommendation" DROP COLUMN IF EXISTS "stopLossRate",
DROP COLUMN IF EXISTS "takeProfitRate";

-- CreateTable
CREATE TABLE "PreMarketData" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "nikkeiFuturesClose" DECIMAL(10,2),
    "nikkeiFuturesChangeRate" DECIMAL(8,2),
    "usdjpyClose" DECIMAL(10,4),
    "usdjpyChangeRate" DECIMAL(8,2),
    "sp500Close" DECIMAL(10,2),
    "sp500ChangeRate" DECIMAL(8,2),
    "nasdaqClose" DECIMAL(10,2),
    "nasdaqChangeRate" DECIMAL(8,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreMarketData_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PreMarketData_date_idx" ON "PreMarketData"("date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PreMarketData_date_key" ON "PreMarketData"("date");
