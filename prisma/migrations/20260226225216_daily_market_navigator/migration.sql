-- 旧カラム削除
ALTER TABLE "PortfolioOverallAnalysis" DROP COLUMN IF EXISTS "overallSummary";
ALTER TABLE "PortfolioOverallAnalysis" DROP COLUMN IF EXISTS "overallStatus";
ALTER TABLE "PortfolioOverallAnalysis" DROP COLUMN IF EXISTS "overallStatusType";
ALTER TABLE "PortfolioOverallAnalysis" DROP COLUMN IF EXISTS "metricsAnalysis";
ALTER TABLE "PortfolioOverallAnalysis" DROP COLUMN IF EXISTS "actionSuggestions";
ALTER TABLE "PortfolioOverallAnalysis" DROP COLUMN IF EXISTS "watchlistSimulation";
ALTER TABLE "PortfolioOverallAnalysis" DROP COLUMN IF EXISTS "dailyCommentary";

-- 新カラム追加
ALTER TABLE "PortfolioOverallAnalysis" ADD COLUMN IF NOT EXISTS "marketHeadline" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PortfolioOverallAnalysis" ADD COLUMN IF NOT EXISTS "marketTone" TEXT NOT NULL DEFAULT 'neutral';
ALTER TABLE "PortfolioOverallAnalysis" ADD COLUMN IF NOT EXISTS "marketKeyFactor" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PortfolioOverallAnalysis" ADD COLUMN IF NOT EXISTS "portfolioStatus" TEXT NOT NULL DEFAULT 'caution';
ALTER TABLE "PortfolioOverallAnalysis" ADD COLUMN IF NOT EXISTS "portfolioSummary" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PortfolioOverallAnalysis" ADD COLUMN IF NOT EXISTS "actionPlan" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PortfolioOverallAnalysis" ADD COLUMN IF NOT EXISTS "buddyMessage" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PortfolioOverallAnalysis" ADD COLUMN IF NOT EXISTS "stockHighlights" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "PortfolioOverallAnalysis" ADD COLUMN IF NOT EXISTS "sectorHighlights" JSONB NOT NULL DEFAULT '[]';
