-- AlterTable
ALTER TABLE "Stock" ADD COLUMN "exDividendDate" DATE;
ALTER TABLE "Stock" ADD COLUMN "dividendPerShare" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "CorporateEventLog" (
    "id" TEXT NOT NULL,
    "tickerCode" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventDate" DATE NOT NULL,
    "detail" JSONB,
    "positionId" TEXT,
    "adjustmentType" TEXT,
    "beforeValue" JSONB,
    "afterValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorporateEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CorporateEventLog_tickerCode_idx" ON "CorporateEventLog"("tickerCode");
CREATE INDEX "CorporateEventLog_eventDate_idx" ON "CorporateEventLog"("eventDate" DESC);
CREATE INDEX "CorporateEventLog_eventType_idx" ON "CorporateEventLog"("eventType");
