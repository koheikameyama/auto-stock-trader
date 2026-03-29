-- AlterTable
ALTER TABLE "BacktestRun" ADD COLUMN "strategy" TEXT NOT NULL DEFAULT 'breakout';

-- CreateIndex
CREATE INDEX "BacktestRun_strategy_runAt_idx" ON "BacktestRun"("strategy", "runAt" DESC);
