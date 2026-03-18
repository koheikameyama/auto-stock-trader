-- AlterTable
ALTER TABLE "TradingConfig" ADD COLUMN     "realizedPnl" DECIMAL(12,0) NOT NULL DEFAULT 0;

-- DataMigration: 既存のtotalBudgetから入金額(500000)を引いた差分をrealizedPnlに移行
UPDATE "TradingConfig" SET "realizedPnl" = "totalBudget" - 500000, "totalBudget" = 500000;
