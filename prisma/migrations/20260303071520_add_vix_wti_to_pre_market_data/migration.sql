-- AlterTable
ALTER TABLE "PreMarketData" ADD COLUMN     "vixChangeRate" DECIMAL(8,2),
ADD COLUMN     "vixClose" DECIMAL(10,2),
ADD COLUMN     "wtiChangeRate" DECIMAL(8,2),
ADD COLUMN     "wtiClose" DECIMAL(10,2);
