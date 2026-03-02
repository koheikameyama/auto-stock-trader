-- AI精度レポートの改善提案カラムを廃止
-- N=3の失敗事例から生成された提案は統計的に無意味なため削除

ALTER TABLE "WeeklyAIReport" DROP COLUMN IF EXISTS "dailyRecommendationImprovement";
ALTER TABLE "WeeklyAIReport" DROP COLUMN IF EXISTS "purchaseRecommendationImprovement";
ALTER TABLE "WeeklyAIReport" DROP COLUMN IF EXISTS "stockAnalysisImprovement";

ALTER TABLE "DailyAIReport" DROP COLUMN IF EXISTS "dailyRecommendationImprovement";
ALTER TABLE "DailyAIReport" DROP COLUMN IF EXISTS "purchaseRecommendationImprovement";
ALTER TABLE "DailyAIReport" DROP COLUMN IF EXISTS "stockAnalysisImprovement";
