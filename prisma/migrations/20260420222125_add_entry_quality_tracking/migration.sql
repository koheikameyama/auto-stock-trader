-- AlterTable
ALTER TABLE "TradingPosition" ADD COLUMN     "minLowDuringHold" DECIMAL(10,2),
ADD COLUMN     "nextDayOpenGapPct" DOUBLE PRECISION,
ADD COLUMN     "nextDayOpenPrice" DOUBLE PRECISION;
