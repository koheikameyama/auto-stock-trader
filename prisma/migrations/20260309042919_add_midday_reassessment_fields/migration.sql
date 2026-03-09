-- AlterTable
ALTER TABLE "MarketAssessment" ADD COLUMN     "middayNikkeiChange" DECIMAL(8,4),
ADD COLUMN     "middayNikkeiPrice" DECIMAL(10,2),
ADD COLUMN     "middayReasoning" TEXT,
ADD COLUMN     "middayReassessedAt" TIMESTAMP(3),
ADD COLUMN     "middaySentiment" TEXT,
ADD COLUMN     "middayVix" DECIMAL(8,2);
