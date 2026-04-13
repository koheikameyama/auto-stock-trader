-- AlterTable
ALTER TABLE "TradingConfig" ADD COLUMN     "loginLockReason" TEXT,
ADD COLUMN     "loginLockedUntil" TIMESTAMP(3);
