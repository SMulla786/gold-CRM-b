-- CreateEnum
CREATE TYPE "GirviTransferStatus" AS ENUM ('ACTIVE', 'RETURNED');

-- CreateTable
CREATE TABLE "GirviTransfer" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "transferNo" INTEGER NOT NULL,
    "lenderPartyId" INTEGER NOT NULL,
    "transferDate" DATE NOT NULL,
    "tenureMonths" INTEGER NOT NULL DEFAULT 12,
    "returnDate" DATE NOT NULL,
    "ratePercent" DECIMAL(6,3) NOT NULL,
    "ratePeriod" "InterestPeriod" NOT NULL DEFAULT 'MONTHLY',
    "interestType" "InterestType" NOT NULL DEFAULT 'SI',
    "ciPeriod" "CiPeriod",
    "method" "InterestMethod" NOT NULL DEFAULT 'DAY_WISE',
    "principal" DECIMAL(14,2) NOT NULL,
    "cash" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "online" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bankAccountId" INTEGER,
    "status" "GirviTransferStatus" NOT NULL DEFAULT 'ACTIVE',
    "returnedOn" DATE,
    "interestPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "returnCash" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "returnOnline" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "returnBankAccountId" INTEGER,
    "remark" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GirviTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GirviTransferItem" (
    "id" SERIAL NOT NULL,
    "transferId" INTEGER NOT NULL,
    "girviItemId" INTEGER NOT NULL,

    CONSTRAINT "GirviTransferItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GirviTransfer_businessId_branchId_status_idx" ON "GirviTransfer"("businessId", "branchId", "status");

-- CreateIndex
CREATE INDEX "GirviTransfer_businessId_lenderPartyId_idx" ON "GirviTransfer"("businessId", "lenderPartyId");

-- CreateIndex
CREATE UNIQUE INDEX "GirviTransfer_businessId_branchId_transferNo_key" ON "GirviTransfer"("businessId", "branchId", "transferNo");

-- CreateIndex
CREATE INDEX "GirviTransferItem_girviItemId_idx" ON "GirviTransferItem"("girviItemId");

-- CreateIndex
CREATE UNIQUE INDEX "GirviTransferItem_transferId_girviItemId_key" ON "GirviTransferItem"("transferId", "girviItemId");

-- AddForeignKey
ALTER TABLE "GirviTransferItem" ADD CONSTRAINT "GirviTransferItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "GirviTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GirviTransferItem" ADD CONSTRAINT "GirviTransferItem_girviItemId_fkey" FOREIGN KEY ("girviItemId") REFERENCES "GirviItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
