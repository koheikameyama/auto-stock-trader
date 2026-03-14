/*
  Warnings:

  - You are about to drop the column `fundamentalBreakdown` on the `ScoringRecord` table. All the data in the column will be lost.
  - You are about to drop the column `fundamentalScore` on the `ScoringRecord` table. All the data in the column will be lost.
  - You are about to drop the column `liquidityBreakdown` on the `ScoringRecord` table. All the data in the column will be lost.
  - You are about to drop the column `liquidityScore` on the `ScoringRecord` table. All the data in the column will be lost.
  - You are about to drop the column `patternBreakdown` on the `ScoringRecord` table. All the data in the column will be lost.
  - You are about to drop the column `patternScore` on the `ScoringRecord` table. All the data in the column will be lost.
  - You are about to drop the column `technicalBreakdown` on the `ScoringRecord` table. All the data in the column will be lost.
  - You are about to drop the column `technicalScore` on the `ScoringRecord` table. All the data in the column will be lost.
  - Added the required column `entryTimingBreakdown` to the `ScoringRecord` table without a default value. This is not possible if the table is not empty.
  - Added the required column `entryTimingScore` to the `ScoringRecord` table without a default value. This is not possible if the table is not empty.
  - Added the required column `riskQualityBreakdown` to the `ScoringRecord` table without a default value. This is not possible if the table is not empty.
  - Added the required column `riskQualityScore` to the `ScoringRecord` table without a default value. This is not possible if the table is not empty.
  - Added the required column `trendQualityBreakdown` to the `ScoringRecord` table without a default value. This is not possible if the table is not empty.
  - Added the required column `trendQualityScore` to the `ScoringRecord` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ScoringRecord" DROP COLUMN "fundamentalBreakdown",
DROP COLUMN "fundamentalScore",
DROP COLUMN "liquidityBreakdown",
DROP COLUMN "liquidityScore",
DROP COLUMN "patternBreakdown",
DROP COLUMN "patternScore",
DROP COLUMN "technicalBreakdown",
DROP COLUMN "technicalScore",
ADD COLUMN     "entryTimingBreakdown" JSONB NOT NULL,
ADD COLUMN     "entryTimingScore" INTEGER NOT NULL,
ADD COLUMN     "riskQualityBreakdown" JSONB NOT NULL,
ADD COLUMN     "riskQualityScore" INTEGER NOT NULL,
ADD COLUMN     "trendQualityBreakdown" JSONB NOT NULL,
ADD COLUMN     "trendQualityScore" INTEGER NOT NULL;
