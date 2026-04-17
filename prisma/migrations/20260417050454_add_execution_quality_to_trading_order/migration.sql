-- AlterTable
ALTER TABLE "TradingOrder" ADD COLUMN     "referencePrice" DECIMAL(10,2),
ADD COLUMN     "slippageBps" INTEGER;
