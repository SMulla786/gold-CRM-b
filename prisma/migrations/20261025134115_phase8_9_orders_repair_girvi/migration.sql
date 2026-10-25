-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'IN_PROCESS', 'READY', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderRateType" AS ENUM ('FIXED', 'ON_DELIVERY');

-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('PENDING', 'ASSIGNED', 'RECEIVED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "KarigarIssueStatus" AS ENUM ('OPEN', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RepairStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'IN_REVIEW', 'READY', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RepairPriority" AS ENUM ('NORMAL', 'URGENT', 'EXPRESS');

-- CreateEnum
CREATE TYPE "InterestType" AS ENUM ('SI', 'CI');

-- CreateEnum
CREATE TYPE "InterestPeriod" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "CiPeriod" AS ENUM ('DAILY', 'MONTHLY', 'HALF_YEARLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "InterestMethod" AS ENUM ('FULL_MONTH', 'DAY_WISE');

-- CreateEnum
CREATE TYPE "GirviStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "GirviItemStatus" AS ENUM ('PLEDGED', 'RELEASED');

-- CreateEnum
CREATE TYPE "GirviTxnType" AS ENUM ('GRANT', 'TOPUP', 'INTEREST', 'RELEASE');

-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "orderNo" INTEGER NOT NULL,
    "partyId" INTEGER NOT NULL,
    "orderDate" DATE NOT NULL,
    "deliveryDate" DATE,
    "rateType" "OrderRateType" NOT NULL DEFAULT 'ON_DELIVERY',
    "goldRate" DECIMAL(14,2),
    "silverRate" DECIMAL(14,2),
    "isUrgent" BOOLEAN NOT NULL DEFAULT false,
    "designUrl" TEXT,
    "remark" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "estTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "advance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "billId" INTEGER,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "itemNameId" INTEGER NOT NULL,
    "metal" "MetalKind" NOT NULL,
    "karatCode" TEXT,
    "touch" DECIMAL(6,3) NOT NULL,
    "size" TEXT,
    "pcs" INTEGER NOT NULL DEFAULT 1,
    "gross" DECIMAL(14,3) NOT NULL,
    "less" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "net" DECIMAL(14,3) NOT NULL,
    "wastage" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "fine" DECIMAL(14,3) NOT NULL,
    "making" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "makingUnit" "ChargeUnit" NOT NULL DEFAULT 'PER_GRAM',
    "other" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "estTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "remark" TEXT,
    "status" "OrderItemStatus" NOT NULL DEFAULT 'PENDING',
    "karigarIssueId" INTEGER,
    "stockItemId" INTEGER,
    "returnedGross" DECIMAL(14,3),
    "returnedNet" DECIMAL(14,3),
    "returnedFine" DECIMAL(14,3),
    "ghatAllowance" DECIMAL(14,3),
    "karigarLabour" DECIMAL(12,2),
    "receivedAt" TIMESTAMP(3),

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderPayment" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
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

    CONSTRAINT "OrderPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KarigarIssue" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "issueNo" INTEGER NOT NULL,
    "karigarId" INTEGER NOT NULL,
    "issueDate" DATE NOT NULL,
    "dueDate" DATE,
    "goldFine" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "silverFine" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "cash" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "online" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bankAccountId" INTEGER,
    "remark" TEXT,
    "status" "KarigarIssueStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KarigarIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairTicket" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "ticketNo" INTEGER NOT NULL,
    "partyId" INTEGER NOT NULL,
    "metal" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "pcs" INTEGER NOT NULL DEFAULT 1,
    "gross" DECIMAL(14,3) NOT NULL,
    "net" DECIMAL(14,3),
    "karatCode" TEXT,
    "hallmark" TEXT,
    "photoUrl" TEXT,
    "expectedDate" DATE NOT NULL,
    "priority" "RepairPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "RepairStatus" NOT NULL DEFAULT 'RECEIVED',
    "karigarId" INTEGER,
    "labourCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "advanceCash" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "advanceOnline" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "advanceBankId" INTEGER,
    "finalWeight" DECIMAL(14,3),
    "remarks" TEXT,
    "addedMetal" "MetalKind",
    "addedFine" DECIMAL(14,3),
    "addedRate" DECIMAL(14,2),
    "deliveryCash" DECIMAL(14,2),
    "deliveryOnline" DECIMAL(14,2),
    "deliveryBankId" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepairTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GirviBatch" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "girviNo" INTEGER NOT NULL,
    "partyId" INTEGER NOT NULL,
    "issueDate" DATE NOT NULL,
    "tenureMonths" INTEGER NOT NULL DEFAULT 12,
    "returnDate" DATE NOT NULL,
    "ratePercent" DECIMAL(6,3) NOT NULL,
    "ratePeriod" "InterestPeriod" NOT NULL DEFAULT 'MONTHLY',
    "interestType" "InterestType" NOT NULL DEFAULT 'SI',
    "ciPeriod" "CiPeriod",
    "method" "InterestMethod" NOT NULL DEFAULT 'DAY_WISE',
    "valuation" DECIMAL(14,2) NOT NULL,
    "principal" DECIMAL(14,2) NOT NULL,
    "interestFrom" DATE NOT NULL,
    "status" "GirviStatus" NOT NULL DEFAULT 'ACTIVE',
    "docUrl" TEXT,
    "remark" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GirviBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GirviItem" (
    "id" SERIAL NOT NULL,
    "batchId" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "photoUrl" TEXT,
    "gross" DECIMAL(14,3) NOT NULL,
    "net" DECIMAL(14,3) NOT NULL,
    "purity" DECIMAL(6,3) NOT NULL,
    "fine" DECIMAL(14,3) NOT NULL,
    "rate" DECIMAL(14,2) NOT NULL,
    "valuation" DECIMAL(14,2) NOT NULL,
    "status" "GirviItemStatus" NOT NULL DEFAULT 'PLEDGED',
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "GirviItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GirviTxn" (
    "id" SERIAL NOT NULL,
    "batchId" INTEGER NOT NULL,
    "type" "GirviTxnType" NOT NULL,
    "txnDate" DATE NOT NULL,
    "principal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "interest" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cash" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "online" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bankAccountId" INTEGER,
    "itemIds" INTEGER[],
    "remark" TEXT,
    "isReversed" BOOLEAN NOT NULL DEFAULT false,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GirviTxn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_businessId_branchId_status_idx" ON "Order"("businessId", "branchId", "status");

-- CreateIndex
CREATE INDEX "Order_businessId_partyId_idx" ON "Order"("businessId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_businessId_branchId_orderNo_key" ON "Order"("businessId", "branchId", "orderNo");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_karigarIssueId_idx" ON "OrderItem"("karigarIssueId");

-- CreateIndex
CREATE INDEX "OrderPayment_orderId_idx" ON "OrderPayment"("orderId");

-- CreateIndex
CREATE INDEX "KarigarIssue_businessId_karigarId_idx" ON "KarigarIssue"("businessId", "karigarId");

-- CreateIndex
CREATE UNIQUE INDEX "KarigarIssue_businessId_branchId_issueNo_key" ON "KarigarIssue"("businessId", "branchId", "issueNo");

-- CreateIndex
CREATE INDEX "RepairTicket_businessId_branchId_status_idx" ON "RepairTicket"("businessId", "branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RepairTicket_businessId_branchId_ticketNo_key" ON "RepairTicket"("businessId", "branchId", "ticketNo");

-- CreateIndex
CREATE INDEX "GirviBatch_businessId_branchId_status_idx" ON "GirviBatch"("businessId", "branchId", "status");

-- CreateIndex
CREATE INDEX "GirviBatch_businessId_partyId_idx" ON "GirviBatch"("businessId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "GirviBatch_businessId_branchId_girviNo_key" ON "GirviBatch"("businessId", "branchId", "girviNo");

-- CreateIndex
CREATE INDEX "GirviItem_batchId_idx" ON "GirviItem"("batchId");

-- CreateIndex
CREATE INDEX "GirviTxn_batchId_idx" ON "GirviTxn"("batchId");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPayment" ADD CONSTRAINT "OrderPayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GirviItem" ADD CONSTRAINT "GirviItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "GirviBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GirviTxn" ADD CONSTRAINT "GirviTxn_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "GirviBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
