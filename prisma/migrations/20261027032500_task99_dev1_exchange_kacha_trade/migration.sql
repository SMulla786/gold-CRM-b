-- TASK-99 (developer1): exchange weighing/diff/round-off/given metal, kacha PROCESS stage + self difference,
-- inline udhar + bhav cut on exchange / buy-sell, buy-sell delivered against several bhav bookings. Additive only.

-- AlterEnum
ALTER TYPE "KachaProcessType" ADD VALUE 'PROCESS';

-- AlterTable
ALTER TABLE "Exchange" ADD COLUMN     "bhavCut" JSONB,
ADD COLUMN     "diffGmMinus" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "diffGmPlus" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "diffMinusBy" TEXT,
ADD COLUMN     "diffPctMinus" DECIMAL(6,3) NOT NULL DEFAULT 0,
ADD COLUMN     "diffPctPlus" DECIMAL(6,3) NOT NULL DEFAULT 0,
ADD COLUMN     "diffPlusBy" TEXT,
ADD COLUMN     "exactFine" DECIMAL(14,3),
ADD COLUMN     "givenFine" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "inlineUdhar" JSONB;

-- AlterTable
ALTER TABLE "ExchangeLine" ADD COLUMN     "grossWeight" DECIMAL(14,3),
ADD COLUMN     "lessWeight" DECIMAL(14,3),
ADD COLUMN     "meltWeight" DECIMAL(14,3),
ADD COLUMN     "sampleId" INTEGER,
ADD COLUMN     "sampleWeight" DECIMAL(14,3);

-- AlterTable
ALTER TABLE "KachaProcess" ADD COLUMN     "exchangeIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "kachaWeight" DECIMAL(14,3),
ADD COLUMN     "parentId" INTEGER,
ADD COLUMN     "selfDiff" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "BuySell" ADD COLUMN     "bhavCut" JSONB,
ADD COLUMN     "inlineUdhar" JSONB;

-- CreateTable
CREATE TABLE "BuySellBhavDelivery" (
    "id" SERIAL NOT NULL,
    "buySellId" INTEGER NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "weight" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "BuySellBhavDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuySellBhavDelivery_buySellId_idx" ON "BuySellBhavDelivery"("buySellId");

-- CreateIndex
CREATE INDEX "BuySellBhavDelivery_bookingId_idx" ON "BuySellBhavDelivery"("bookingId");

-- CreateIndex
CREATE INDEX "KachaProcess_parentId_idx" ON "KachaProcess"("parentId");

-- AddForeignKey
ALTER TABLE "BuySellBhavDelivery" ADD CONSTRAINT "BuySellBhavDelivery_buySellId_fkey" FOREIGN KEY ("buySellId") REFERENCES "BuySell"("id") ON DELETE CASCADE ON UPDATE CASCADE;
