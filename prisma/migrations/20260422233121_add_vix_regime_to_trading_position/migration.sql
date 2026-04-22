-- AlterTable
ALTER TABLE "TradingPosition" ADD COLUMN     "appliedRiskPct" DECIMAL(6,3),
ADD COLUMN     "regimeLevel" TEXT,
ADD COLUMN     "regimeScale" DECIMAL(4,3),
ADD COLUMN     "vixAtEntry" DECIMAL(6,2);
