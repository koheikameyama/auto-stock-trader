-- CreateTable
CREATE TABLE "UnfilledOrderFollowUp" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tickerCode" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "orderDate" DATE NOT NULL,
    "limitPrice" DECIMAL(10,2) NOT NULL,
    "marketPrice" DECIMAL(10,2) NOT NULL,
    "gapPct" DECIMAL(8,4) NOT NULL,
    "cancelReason" TEXT NOT NULL,
    "day1Price" DECIMAL(10,2),
    "day3Price" DECIMAL(10,2),
    "day5Price" DECIMAL(10,2),
    "day1ReachedLimit" BOOLEAN,
    "day3ReachedLimit" BOOLEAN,
    "day5ReachedLimit" BOOLEAN,
    "day1PnlPct" DECIMAL(8,4),
    "day3PnlPct" DECIMAL(8,4),
    "day5PnlPct" DECIMAL(8,4),
    "isComplete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnfilledOrderFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UnfilledOrderFollowUp_orderId_key" ON "UnfilledOrderFollowUp"("orderId");

-- CreateIndex
CREATE INDEX "UnfilledOrderFollowUp_isComplete_idx" ON "UnfilledOrderFollowUp"("isComplete");

-- CreateIndex
CREATE INDEX "UnfilledOrderFollowUp_orderDate_idx" ON "UnfilledOrderFollowUp"("orderDate" DESC);

-- AddForeignKey
ALTER TABLE "UnfilledOrderFollowUp" ADD CONSTRAINT "UnfilledOrderFollowUp_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TradingOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
