-- CreateTable
CREATE TABLE "DefensiveExitFollowUp" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "tickerCode" TEXT NOT NULL,
    "exitDate" DATE NOT NULL,
    "exitPrice" DECIMAL(10,2) NOT NULL,
    "exitReason" TEXT NOT NULL,
    "day1Price" DECIMAL(10,2),
    "day3Price" DECIMAL(10,2),
    "day5Price" DECIMAL(10,2),
    "day1PnlPct" DECIMAL(8,4),
    "day3PnlPct" DECIMAL(8,4),
    "day5PnlPct" DECIMAL(8,4),
    "isComplete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DefensiveExitFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DefensiveExitFollowUp_positionId_key" ON "DefensiveExitFollowUp"("positionId");

-- CreateIndex
CREATE INDEX "DefensiveExitFollowUp_isComplete_idx" ON "DefensiveExitFollowUp"("isComplete");

-- CreateIndex
CREATE INDEX "DefensiveExitFollowUp_exitDate_idx" ON "DefensiveExitFollowUp"("exitDate" DESC);

-- AddForeignKey
ALTER TABLE "DefensiveExitFollowUp" ADD CONSTRAINT "DefensiveExitFollowUp_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "TradingPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
