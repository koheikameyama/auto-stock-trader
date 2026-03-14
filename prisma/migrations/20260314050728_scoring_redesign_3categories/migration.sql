-- AlterTable: Drop old 4-category columns and add new 3-category columns
-- Handle existing data by adding columns with defaults first, then removing defaults

ALTER TABLE "ScoringRecord" DROP COLUMN IF EXISTS "fundamentalBreakdown",
DROP COLUMN IF EXISTS "fundamentalScore",
DROP COLUMN IF EXISTS "liquidityBreakdown",
DROP COLUMN IF EXISTS "liquidityScore",
DROP COLUMN IF EXISTS "patternBreakdown",
DROP COLUMN IF EXISTS "patternScore",
DROP COLUMN IF EXISTS "technicalBreakdown",
DROP COLUMN IF EXISTS "technicalScore";

ALTER TABLE "ScoringRecord"
ADD COLUMN "entryTimingBreakdown" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "entryTimingScore" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "riskQualityBreakdown" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "riskQualityScore" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "trendQualityBreakdown" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "trendQualityScore" INTEGER NOT NULL DEFAULT 0;

-- Remove defaults (schema expects no defaults, these were just for migration)
ALTER TABLE "ScoringRecord"
ALTER COLUMN "entryTimingBreakdown" DROP DEFAULT,
ALTER COLUMN "entryTimingScore" DROP DEFAULT,
ALTER COLUMN "riskQualityBreakdown" DROP DEFAULT,
ALTER COLUMN "riskQualityScore" DROP DEFAULT,
ALTER COLUMN "trendQualityBreakdown" DROP DEFAULT,
ALTER COLUMN "trendQualityScore" DROP DEFAULT;
