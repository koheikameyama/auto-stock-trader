-- AlterTable
ALTER TABLE "TradingOrder" ADD COLUMN     "entrySnapshot" JSONB;

-- AlterTable
ALTER TABLE "TradingPosition" ADD COLUMN     "entrySnapshot" JSONB,
ADD COLUMN     "exitSnapshot" JSONB,
ADD COLUMN     "maxHighDuringHold" DECIMAL(10,2),
ADD COLUMN     "minLowDuringHold" DECIMAL(10,2),
ADD COLUMN     "reviewComments" TEXT;
