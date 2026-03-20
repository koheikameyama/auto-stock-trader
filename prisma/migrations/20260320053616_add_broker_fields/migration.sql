-- AlterTable
ALTER TABLE "TradingConfig" ADD COLUMN     "brokerMode" TEXT NOT NULL DEFAULT 'simulation';

-- AlterTable
ALTER TABLE "TradingOrder" ADD COLUMN     "brokerBusinessDay" TEXT,
ADD COLUMN     "brokerOrderId" TEXT,
ADD COLUMN     "brokerStatus" TEXT;

-- CreateIndex
CREATE INDEX "TradingOrder_brokerOrderId_brokerBusinessDay_idx" ON "TradingOrder"("brokerOrderId", "brokerBusinessDay");
