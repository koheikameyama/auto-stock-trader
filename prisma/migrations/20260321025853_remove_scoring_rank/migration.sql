/*
  Warnings:

  - You are about to drop the column `rank` on the `ScoringRecord` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "ScoringRecord_rank_idx";

-- AlterTable
ALTER TABLE "ScoringRecord" DROP COLUMN "rank";
