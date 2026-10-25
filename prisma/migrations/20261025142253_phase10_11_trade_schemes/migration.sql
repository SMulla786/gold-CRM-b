-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "KachaProcessType" AS ENUM ('MELT', 'REFINE');

-- CreateEnum
CREATE TYPE "BhavStatus" AS ENUM ('PENDING', 'PARTIAL', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SchemeKind" AS ENUM ('SAVING', 'ANJUMAN');

-- CreateEnum
CREATE TYPE "SchemeType" AS ENUM ('CASH', 'GOLD');

-- CreateEnum
CREATE TYPE "SchemeBonusType" AS ENUM ('NONE', 'ONE_EMI', 'PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "SchemeEnrollmentStatus" AS ENUM ('ACTIVE', 'WON', 'WITHDRAWN', 'CLOSED');

-- CreateEnum
CREATE TYPE "SchemePayMedium" AS ENUM ('CASH', 'ONLINE', 'TOKEN', 'DRAW', 'VENDOR');

-- CreateTable
CREATE TABLE "Exchange" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "exchangeNo" INTEGER NOT NULL,
    "side" "TradeSide" NOT NULL,
    "partyId" INTEGER NOT NULL,
    "metal" "MetalKind" NOT NULL,
    "txnDate" DATE NOT NULL,
    "totalFine" DECIMAL(14,3) NOT NULL,
    "diffFine" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "afterFine" DECIMAL(14,3) NOT NULL,
    "rate" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "charges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "finalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cash" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "online" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bankAccountId" INTEGER,
    "remark" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Exchange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeLine" (
    "id" SERIAL NOT NULL,
    "exchangeId" INTEGER NOT NULL,
    "weight" DECIMAL(14,3) NOT NULL,
    "touch" DECIMAL(6,3) NOT NULL,
    "fine" DECIMAL(14,3) NOT NULL,
    "serialNo" TEXT,

    CONSTRAINT "ExchangeLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KachaProcess" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "type" "KachaProcessType" NOT NULL,
    "metal" "MetalKind" NOT NULL,
    "txnDate" DATE NOT NULL,
    "inFine" DECIMAL(14,3) NOT NULL,
    "outFine" DECIMAL(14,3) NOT NULL,
    "ravalFine" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "difference" DECIMAL(14,3) NOT NULL,
    "exchangeId" INTEGER,
    "remark" TEXT,
    "reverted" BOOLEAN NOT NULL DEFAULT false,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KachaProcess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuySell" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "buySellNo" INTEGER NOT NULL,
    "side" "TradeSide" NOT NULL,
    "partyId" INTEGER NOT NULL,
    "metal" "MetalKind" NOT NULL,
    "txnDate" DATE NOT NULL,
    "totalWeight" DECIMAL(14,3) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "cash" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "online" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bankAccountId" INTEGER,
    "bhavBookingId" INTEGER,
    "narration" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuySell_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuySellLine" (
    "id" SERIAL NOT NULL,
    "buySellId" INTEGER NOT NULL,
    "weight" DECIMAL(14,3) NOT NULL,
    "rate" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "BuySellLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BhavBooking" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "bookingNo" INTEGER NOT NULL,
    "side" "TradeSide" NOT NULL,
    "partyId" INTEGER NOT NULL,
    "metal" "MetalKind" NOT NULL,
    "txnDate" DATE NOT NULL,
    "weight" DECIMAL(14,3) NOT NULL,
    "rate" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "cash" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "online" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bankAccountId" INTEGER,
    "pendingWeight" DECIMAL(14,3) NOT NULL,
    "status" "BhavStatus" NOT NULL DEFAULT 'PENDING',
    "narration" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BhavBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scheme" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "kind" "SchemeKind" NOT NULL DEFAULT 'SAVING',
    "type" "SchemeType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "emiAmount" DECIMAL(14,2) NOT NULL,
    "tenureMonths" INTEGER NOT NULL,
    "bonusType" "SchemeBonusType" NOT NULL DEFAULT 'NONE',
    "bonusValue" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "startDate" DATE NOT NULL,
    "validityDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemeGroup" (
    "id" SERIAL NOT NULL,
    "schemeId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "memberLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchemeGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemeEnrollment" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "schemeId" INTEGER NOT NULL,
    "groupId" INTEGER,
    "partyId" INTEGER NOT NULL,
    "assignId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "emiAmount" DECIMAL(14,2) NOT NULL,
    "startDate" DATE NOT NULL,
    "status" "SchemeEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "redeemValue" DECIMAL(14,2),
    "redeemFine" DECIMAL(14,3),
    "redeemRate" DECIMAL(14,2),
    "closedAt" TIMESTAMP(3),
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchemeEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemePayment" (
    "id" SERIAL NOT NULL,
    "enrollmentId" INTEGER NOT NULL,
    "emiNo" INTEGER,
    "emiDate" DATE,
    "txnDate" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "medium" "SchemePayMedium" NOT NULL DEFAULT 'CASH',
    "bankAccountId" INTEGER,
    "rate" DECIMAL(14,2),
    "fine" DECIMAL(14,3),
    "remark" TEXT,
    "isReversed" BOOLEAN NOT NULL DEFAULT false,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchemePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Exchange_businessId_branchId_txnDate_idx" ON "Exchange"("businessId", "branchId", "txnDate");

-- CreateIndex
CREATE INDEX "Exchange_businessId_partyId_idx" ON "Exchange"("businessId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Exchange_businessId_branchId_exchangeNo_key" ON "Exchange"("businessId", "branchId", "exchangeNo");

-- CreateIndex
CREATE INDEX "ExchangeLine_exchangeId_idx" ON "ExchangeLine"("exchangeId");

-- CreateIndex
CREATE INDEX "KachaProcess_businessId_branchId_metal_txnDate_idx" ON "KachaProcess"("businessId", "branchId", "metal", "txnDate");

-- CreateIndex
CREATE INDEX "BuySell_businessId_branchId_txnDate_idx" ON "BuySell"("businessId", "branchId", "txnDate");

-- CreateIndex
CREATE INDEX "BuySell_businessId_partyId_idx" ON "BuySell"("businessId", "partyId");

-- CreateIndex
CREATE INDEX "BuySell_bhavBookingId_idx" ON "BuySell"("bhavBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "BuySell_businessId_branchId_buySellNo_key" ON "BuySell"("businessId", "branchId", "buySellNo");

-- CreateIndex
CREATE INDEX "BuySellLine_buySellId_idx" ON "BuySellLine"("buySellId");

-- CreateIndex
CREATE INDEX "BhavBooking_businessId_branchId_status_idx" ON "BhavBooking"("businessId", "branchId", "status");

-- CreateIndex
CREATE INDEX "BhavBooking_businessId_partyId_idx" ON "BhavBooking"("businessId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "BhavBooking_businessId_branchId_bookingNo_key" ON "BhavBooking"("businessId", "branchId", "bookingNo");

-- CreateIndex
CREATE INDEX "Scheme_businessId_branchId_kind_isActive_idx" ON "Scheme"("businessId", "branchId", "kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SchemeGroup_schemeId_name_key" ON "SchemeGroup"("schemeId", "name");

-- CreateIndex
CREATE INDEX "SchemeEnrollment_businessId_branchId_schemeId_status_idx" ON "SchemeEnrollment"("businessId", "branchId", "schemeId", "status");

-- CreateIndex
CREATE INDEX "SchemeEnrollment_businessId_partyId_idx" ON "SchemeEnrollment"("businessId", "partyId");

-- CreateIndex
CREATE INDEX "SchemeEnrollment_groupId_idx" ON "SchemeEnrollment"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "SchemeEnrollment_schemeId_assignId_key" ON "SchemeEnrollment"("schemeId", "assignId");

-- CreateIndex
CREATE INDEX "SchemePayment_enrollmentId_idx" ON "SchemePayment"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "SchemePayment_enrollmentId_emiNo_key" ON "SchemePayment"("enrollmentId", "emiNo");

-- AddForeignKey
ALTER TABLE "ExchangeLine" ADD CONSTRAINT "ExchangeLine_exchangeId_fkey" FOREIGN KEY ("exchangeId") REFERENCES "Exchange"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuySellLine" ADD CONSTRAINT "BuySellLine_buySellId_fkey" FOREIGN KEY ("buySellId") REFERENCES "BuySell"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeGroup" ADD CONSTRAINT "SchemeGroup_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeEnrollment" ADD CONSTRAINT "SchemeEnrollment_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeEnrollment" ADD CONSTRAINT "SchemeEnrollment_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SchemeGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemePayment" ADD CONSTRAINT "SchemePayment_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "SchemeEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
