-- CreateEnum
CREATE TYPE "BhavEntryType" AS ENUM ('LEDGER', 'ONLY_ENTRY');

-- CreateEnum
CREATE TYPE "ItcEligibility" AS ENUM ('ELIGIBLE', 'BLOCKED_17_5', 'INELIGIBLE');

-- CreateEnum
CREATE TYPE "GstSupplyCategory" AS ENUM ('TAXABLE', 'ZERO_RATED', 'NIL_EXEMPT', 'NON_GST');

-- AlterTable
ALTER TABLE "BhavBooking" ADD COLUMN     "entryType" "BhavEntryType" NOT NULL DEFAULT 'LEDGER',
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedById" INTEGER;

-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "itcBlockReason" TEXT,
ADD COLUMN     "itcEligibility" "ItcEligibility" NOT NULL DEFAULT 'ELIGIBLE',
ADD COLUMN     "reverseCharge" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supplierInvoiceNo" TEXT,
ADD COLUMN     "supplyCategory" "GstSupplyCategory" NOT NULL DEFAULT 'TAXABLE';

-- AlterTable
ALTER TABLE "KarigarIssue" ADD COLUMN     "wastageGm" DECIMAL(14,3),
ADD COLUMN     "wastagePercent" DECIMAL(6,3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "miscCharges" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "jewelleryTypeId" INTEGER,
ADD COLUMN     "labour" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "wastageGm" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RepairTicket" ADD COLUMN     "addedKaratCode" TEXT,
ADD COLUMN     "purity" DECIMAL(5,2),
ADD COLUMN     "subCategory" TEXT;

-- CreateTable
CREATE TABLE "BhavBookingLine" (
    "id" SERIAL NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "weight" DECIMAL(14,3) NOT NULL,
    "rate" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "BhavBookingLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradePayment" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "docType" TEXT NOT NULL,
    "docId" INTEGER NOT NULL,
    "mode" "BillPaymentMode" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "bankAccountId" INTEGER,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TagTemplate" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "widthMm" DECIMAL(6,2) NOT NULL,
    "heightMm" DECIMAL(6,2) NOT NULL,
    "shape" TEXT NOT NULL DEFAULT 'RECT',
    "direction" TEXT NOT NULL DEFAULT 'HORIZONTAL',
    "neckWidthMm" DECIMAL(6,2),
    "elements" JSONB NOT NULL,
    "appliesTo" "StockClass"[],
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TagTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SetStockLog" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "card" TEXT NOT NULL,
    "oldBalance" DECIMAL(16,3) NOT NULL,
    "newBalance" DECIMAL(16,3) NOT NULL,
    "remarks" TEXT,
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SetStockLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairConsumable" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "currentStock" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "minLevel" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepairConsumable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BhavBookingLine_bookingId_idx" ON "BhavBookingLine"("bookingId");

-- CreateIndex
CREATE INDEX "TradePayment_businessId_docType_docId_idx" ON "TradePayment"("businessId", "docType", "docId");

-- CreateIndex
CREATE INDEX "TagTemplate_businessId_idx" ON "TagTemplate"("businessId");

-- CreateIndex
CREATE INDEX "SetStockLog_businessId_createdAt_idx" ON "SetStockLog"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "RepairConsumable_businessId_branchId_idx" ON "RepairConsumable"("businessId", "branchId");

-- AddForeignKey
ALTER TABLE "BhavBookingLine" ADD CONSTRAINT "BhavBookingLine_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BhavBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
