-- AlterTable
ALTER TABLE "Stock" ADD COLUMN "delistingNewsDetectedAt" TIMESTAMP(3),
ADD COLUMN "delistingNewsReason" TEXT;
