-- AlterTable
ALTER TABLE "UserDailyRecommendation" ADD COLUMN IF NOT EXISTS "takeProfitRate" DOUBLE PRECISION;
ALTER TABLE "UserDailyRecommendation" ADD COLUMN IF NOT EXISTS "stopLossRate" DOUBLE PRECISION;
