-- AlterTable: Add session column with default value
ALTER TABLE "PortfolioOverallAnalysis" ADD COLUMN IF NOT EXISTS "session" TEXT NOT NULL DEFAULT 'morning';

-- Drop old unique constraint on userId only
ALTER TABLE "PortfolioOverallAnalysis" DROP CONSTRAINT IF EXISTS "PortfolioOverallAnalysis_userId_key";

-- Add new composite unique constraint on (userId, session)
ALTER TABLE "PortfolioOverallAnalysis" ADD CONSTRAINT "PortfolioOverallAnalysis_userId_session_key" UNIQUE ("userId", "session");
