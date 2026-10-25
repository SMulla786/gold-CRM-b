-- CreateEnum
CREATE TYPE "QtyUnit" AS ENUM ('GRAM', 'PCS');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'BILLED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "JustBill" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "billNo" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "partyId" INTEGER,
    "customerName" TEXT NOT NULL,
    "mobile" TEXT,
    "billDate" DATE NOT NULL,
    "interState" BOOLEAN NOT NULL DEFAULT false,
    "sub" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountUnit" "DiscountUnit" NOT NULL DEFAULT 'FIXED',
    "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "gstPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxable" DECIMAL(14,2) NOT NULL,
    "cgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "round" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "final" DECIMAL(14,2) NOT NULL,
    "paid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "remark" TEXT,
    "status" "BillStatus" NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" TIMESTAMP(3),
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JustBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JustBillItem" (
    "id" SERIAL NOT NULL,
    "justBillId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "karat" TEXT,
    "purity" DECIMAL(6,3),
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" "QtyUnit" NOT NULL DEFAULT 'GRAM',
    "rate" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "making" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "makingUnit" "ChargeUnit" NOT NULL DEFAULT 'PER_GRAM',
    "other" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "JustBillItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JustBillPayment" (
    "id" SERIAL NOT NULL,
    "justBillId" INTEGER NOT NULL,
    "mode" "BillPaymentMode" NOT NULL,
    "bankAccountId" INTEGER,
    "metal" "MetalKind",
    "metalForm" "MetalForm",
    "gross" DECIMAL(14,3),
    "net" DECIMAL(14,3),
    "tunch" DECIMAL(6,3),
    "fine" DECIMAL(14,3),
    "rate" DECIMAL(14,2),
    "amount" DECIMAL(14,2) NOT NULL,
    "remark" TEXT,
    "txnDate" DATE NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JustBillPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDraft" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "draftNo" INTEGER NOT NULL,
    "createdById" INTEGER NOT NULL,
    "partyId" INTEGER,
    "customerName" TEXT NOT NULL,
    "mobile" TEXT,
    "estTotal" DECIMAL(14,2) NOT NULL,
    "requestedDiscount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "requestedDiscountUnit" "DiscountUnit" NOT NULL DEFAULT 'FIXED',
    "note" TEXT,
    "status" "DraftStatus" NOT NULL DEFAULT 'PENDING',
    "approvedDiscount" DECIMAL(14,2),
    "approvedDiscountUnit" "DiscountUnit",
    "rejectionReason" TEXT,
    "decidedById" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "billId" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDraftItem" (
    "id" SERIAL NOT NULL,
    "draftId" INTEGER NOT NULL,
    "stockItemId" INTEGER NOT NULL,

    CONSTRAINT "SalesDraftItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JustBill_businessId_branchId_billDate_idx" ON "JustBill"("businessId", "branchId", "billDate");

-- CreateIndex
CREATE INDEX "JustBill_businessId_partyId_idx" ON "JustBill"("businessId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "JustBill_businessId_branchId_billNo_key" ON "JustBill"("businessId", "branchId", "billNo");

-- CreateIndex
CREATE INDEX "JustBillItem_justBillId_idx" ON "JustBillItem"("justBillId");

-- CreateIndex
CREATE INDEX "JustBillPayment_justBillId_idx" ON "JustBillPayment"("justBillId");

-- CreateIndex
CREATE INDEX "SalesDraft_businessId_branchId_status_idx" ON "SalesDraft"("businessId", "branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDraft_businessId_branchId_draftNo_key" ON "SalesDraft"("businessId", "branchId", "draftNo");

-- CreateIndex
CREATE INDEX "SalesDraftItem_draftId_idx" ON "SalesDraftItem"("draftId");

-- AddForeignKey
ALTER TABLE "JustBillItem" ADD CONSTRAINT "JustBillItem_justBillId_fkey" FOREIGN KEY ("justBillId") REFERENCES "JustBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JustBillPayment" ADD CONSTRAINT "JustBillPayment_justBillId_fkey" FOREIGN KEY ("justBillId") REFERENCES "JustBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDraftItem" ADD CONSTRAINT "SalesDraftItem_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "SalesDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
