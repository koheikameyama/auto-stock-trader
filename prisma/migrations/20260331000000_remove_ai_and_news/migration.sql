-- AI機能・ニュース関連の削除マイグレーション

-- NewsArticle テーブル削除
DROP TABLE IF EXISTS "NewsArticle";

-- NewsAnalysis テーブル削除
DROP TABLE IF EXISTS "NewsAnalysis";

-- ScoringRecord から AI関連カラム削除
ALTER TABLE "ScoringRecord" DROP COLUMN IF EXISTS "aiDecision";
ALTER TABLE "ScoringRecord" DROP COLUMN IF EXISTS "aiReasoning";
ALTER TABLE "ScoringRecord" DROP COLUMN IF EXISTS "newsContext";

-- TradingDailySummary から decisionAudit カラム削除
ALTER TABLE "TradingDailySummary" DROP COLUMN IF EXISTS "decisionAudit";

-- MarketAssessment から midday関連カラム削除
ALTER TABLE "MarketAssessment" DROP COLUMN IF EXISTS "middaySentiment";
ALTER TABLE "MarketAssessment" DROP COLUMN IF EXISTS "middayReasoning";
ALTER TABLE "MarketAssessment" DROP COLUMN IF EXISTS "middayReassessedAt";
ALTER TABLE "MarketAssessment" DROP COLUMN IF EXISTS "middayNikkeiPrice";
ALTER TABLE "MarketAssessment" DROP COLUMN IF EXISTS "middayNikkeiChange";
ALTER TABLE "MarketAssessment" DROP COLUMN IF EXISTS "middayVix";
ALTER TABLE "MarketAssessment" DROP COLUMN IF EXISTS "middayNikkeiVi";

-- Stock から delistingNewsDetected カラム削除
ALTER TABLE "Stock" DROP COLUMN IF EXISTS "delistingNewsDetected";
