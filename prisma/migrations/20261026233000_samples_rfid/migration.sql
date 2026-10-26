-- CreateEnum
CREATE TYPE "StockCodeType" AS ENUM ('BARCODE', 'QR', 'RFID');

-- CreateEnum
CREATE TYPE "SampleStatus" AS ENUM ('IN_HAND', 'ISSUED', 'RETURNED', 'MELTED');

-- AlterTable
ALTER TABLE "StockItem" ADD COLUMN     "codeType" "StockCodeType" NOT NULL DEFAULT 'BARCODE',
ADD COLUMN     "epcCode" TEXT;

-- CreateTable
CREATE TABLE "Sample" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "sampleNo" INTEGER NOT NULL,
    "partyId" INTEGER,
    "karigarId" INTEGER,
    "metal" "MetalKind" NOT NULL,
    "grossWt" DECIMAL(14,3) NOT NULL,
    "tounchPercent" DECIMAL(6,3) NOT NULL,
    "fine" DECIMAL(14,3) NOT NULL,
    "status" "SampleStatus" NOT NULL DEFAULT 'IN_HAND',
    "note" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SampleMovement" (
    "id" SERIAL NOT NULL,
    "sampleId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "partyId" INTEGER,
    "karigarId" INTEGER,
    "note" TEXT,
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SampleMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Sample_businessId_branchId_status_idx" ON "Sample"("businessId", "branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Sample_businessId_branchId_sampleNo_key" ON "Sample"("businessId", "branchId", "sampleNo");

-- CreateIndex
CREATE INDEX "SampleMovement_sampleId_idx" ON "SampleMovement"("sampleId");

-- CreateIndex
CREATE UNIQUE INDEX "StockItem_businessId_epcCode_key" ON "StockItem"("businessId", "epcCode");

-- AddForeignKey
ALTER TABLE "SampleMovement" ADD CONSTRAINT "SampleMovement_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "Sample"("id") ON DELETE CASCADE ON UPDATE CASCADE;

