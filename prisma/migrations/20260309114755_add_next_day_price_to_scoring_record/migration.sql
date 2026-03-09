-- AlterTable
ALTER TABLE "ScoringRecord" ADD COLUMN     "nextDayClosingPrice" DECIMAL(10,2),
ADD COLUMN     "nextDayProfitPct" DECIMAL(8,4);
