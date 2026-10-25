-- CreateEnum
CREATE TYPE "BillKind" AS ENUM ('SELL', 'PURCHASE');

-- CreateEnum
CREATE TYPE "BillType" AS ENUM ('GST', 'ROUGH');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('ACTIVE', 'DELETED');

-- CreateEnum
CREATE TYPE "KeepBalanceAs" AS ENUM ('MONEY', 'GOLD', 'SILVER');

-- CreateEnum
CREATE TYPE "DiscountUnit" AS ENUM ('FIXED', 'PERCENT');

-- CreateEnum
CREATE TYPE "BillPaymentMode" AS ENUM ('CASH', 'ONLINE', 'METAL');

-- CreateEnum
CREATE TYPE "BhavDirection" AS ENUM ('MONEY_TO_METAL', 'METAL_TO_MONEY');

-- CreateTable
CREATE TABLE "DocSequence" (
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DocSequence_pkey" PRIMARY KEY ("businessId","branchId","key")
);

-- CreateTable
CREATE TABLE "Bill" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "kind" "BillKind" NOT NULL,
    "billType" "BillType" NOT NULL,
    "billNo" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "partyId" INTEGER NOT NULL,
    "billDate" DATE NOT NULL,
    "dueDate" DATE,
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
    "keepBalanceAs" "KeepBalanceAs" NOT NULL DEFAULT 'MONEY',
    "keepRate" DECIMAL(14,2),
    "keepWeight" DECIMAL(14,3),
    "remark" TEXT,
    "status" "BillStatus" NOT NULL DEFAULT 'ACTIVE',
    "deletedWithStock" BOOLEAN,
    "deletedAt" TIMESTAMP(3),
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillItem" (
    "id" SERIAL NOT NULL,
    "billId" INTEGER NOT NULL,
    "stockItemId" INTEGER,
    "itemNameId" INTEGER,
    "groupId" INTEGER,
    "stockClass" "StockClass" NOT NULL,
    "description" TEXT NOT NULL,
    "hsnCode" TEXT,
    "tagNo" TEXT,
    "karatCode" TEXT,
    "pcs" INTEGER NOT NULL DEFAULT 1,
    "gross" DECIMAL(14,3) NOT NULL,
    "less" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "net" DECIMAL(14,3) NOT NULL,
    "tunch" DECIMAL(6,3) NOT NULL DEFAULT 100,
    "wastage" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "fine" DECIMAL(14,3) NOT NULL,
    "stoneCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "rate" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "labour" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "labourUnit" "ChargeUnit" NOT NULL DEFAULT 'PER_GRAM',
    "other" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountUnit" "DiscountUnit" NOT NULL DEFAULT 'FIXED',
    "metalAmount" DECIMAL(14,2) NOT NULL,
    "labourAmount" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "BillItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillPayment" (
    "id" SERIAL NOT NULL,
    "billId" INTEGER NOT NULL,
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
    "udharTxnId" INTEGER,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UdharEntry" (
    "id" BIGSERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "partyId" INTEGER NOT NULL,
    "txnDate" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "gold" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "silver" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "narration" TEXT,
    "reversalOfId" BIGINT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UdharEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UdharTxn" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "txnNo" INTEGER NOT NULL,
    "partyId" INTEGER NOT NULL,
    "txnDate" DATE NOT NULL,
    "cashOut" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "onlineOut" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "outBankId" INTEGER,
    "cashIn" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "onlineIn" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "inBankId" INTEGER,
    "goldOut" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "goldIn" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "silverOut" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "silverIn" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "bhavDirection" "BhavDirection",
    "bhavMetal" "MetalKind",
    "bhavAmount" DECIMAL(14,2),
    "bhavRate" DECIMAL(14,2),
    "bhavUnitGrams" DECIMAL(10,4),
    "bhavWeight" DECIMAL(14,3),
    "settleBillId" INTEGER,
    "remark" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UdharTxn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bill_businessId_branchId_kind_billDate_idx" ON "Bill"("businessId", "branchId", "kind", "billDate");

-- CreateIndex
CREATE INDEX "Bill_businessId_partyId_idx" ON "Bill"("businessId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Bill_businessId_branchId_kind_billType_billNo_key" ON "Bill"("businessId", "branchId", "kind", "billType", "billNo");

-- CreateIndex
CREATE INDEX "BillItem_billId_idx" ON "BillItem"("billId");

-- CreateIndex
CREATE INDEX "BillItem_stockItemId_idx" ON "BillItem"("stockItemId");

-- CreateIndex
CREATE INDEX "BillPayment_billId_idx" ON "BillPayment"("billId");

-- CreateIndex
CREATE INDEX "UdharEntry_businessId_partyId_txnDate_idx" ON "UdharEntry"("businessId", "partyId", "txnDate");

-- CreateIndex
CREATE INDEX "UdharEntry_businessId_branchId_txnDate_idx" ON "UdharEntry"("businessId", "branchId", "txnDate");

-- CreateIndex
CREATE INDEX "UdharEntry_businessId_source_sourceId_idx" ON "UdharEntry"("businessId", "source", "sourceId");

-- CreateIndex
CREATE INDEX "UdharTxn_businessId_partyId_idx" ON "UdharTxn"("businessId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "UdharTxn_businessId_branchId_txnNo_key" ON "UdharTxn"("businessId", "branchId", "txnNo");

-- AddForeignKey
ALTER TABLE "BillItem" ADD CONSTRAINT "BillItem_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
