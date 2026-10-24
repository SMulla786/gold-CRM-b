-- CreateEnum
CREATE TYPE "StockClass" AS ENUM ('GOLD', 'SILVER', 'STONE', 'ARTIFICIAL', 'FRANCHISE');

-- CreateEnum
CREATE TYPE "EntryMethod" AS ENUM ('LOOSE', 'TAG', 'BOTH');

-- CreateEnum
CREATE TYPE "StockStatus" AS ENUM ('AVAILABLE', 'SOLD', 'RESERVED', 'ISSUED', 'TRANSFERRED', 'DELETED');

-- CreateEnum
CREATE TYPE "ChargeUnit" AS ENUM ('PER_GRAM', 'PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "LedgerAsset" AS ENUM ('MONEY', 'GOLD', 'SILVER', 'STONE', 'ARTIFICIAL', 'FRANCHISE');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "MetalForm" AS ENUM ('USUAL', 'BULLION', 'KACHA');

-- CreateTable
CREATE TABLE "JewelleryType" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER,
    "stockClass" "StockClass",
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "JewelleryType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemGroup" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "stockClass" "StockClass" NOT NULL,
    "jewelleryTypeId" INTEGER,
    "name" TEXT NOT NULL,
    "hsnId" INTEGER,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 3,
    "minWeight" DECIMAL(14,3),
    "maxWeight" DECIMAL(14,3),
    "minPcs" INTEGER,
    "maxPcs" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemName" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "groupId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "hsnId" INTEGER,
    "taxValue" DECIMAL(8,2),
    "taxUnit" "ChargeUnit",
    "method" "EntryMethod" NOT NULL DEFAULT 'BOTH',
    "tagPrefix" TEXT,
    "tagDigits" INTEGER,
    "minWeight" DECIMAL(14,3),
    "maxWeight" DECIMAL(14,3),
    "minPcs" INTEGER,
    "maxPcs" INTEGER,
    "defKaratCode" TEXT,
    "defTunch" DECIMAL(6,3),
    "defWastage" DECIMAL(6,3),
    "defLabour" DECIMAL(12,2),
    "defLabourUnit" "ChargeUnit",
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemName_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TagSequence" (
    "businessId" INTEGER NOT NULL,
    "prefix" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TagSequence_pkey" PRIMARY KEY ("businessId","prefix")
);

-- CreateTable
CREATE TABLE "StockItem" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "stockClass" "StockClass" NOT NULL,
    "groupId" INTEGER NOT NULL,
    "itemNameId" INTEGER NOT NULL,
    "method" "EntryMethod" NOT NULL,
    "tagNo" TEXT,
    "huid" TEXT,
    "karatCode" TEXT,
    "pcs" INTEGER NOT NULL DEFAULT 0,
    "gross" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "less" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "net" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "tunch" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "wastage" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "fine" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "stoneCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "labour" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "labourUnit" "ChargeUnit" NOT NULL DEFAULT 'PER_GRAM',
    "other" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "rate" DECIMAL(14,2),
    "purchaseCost" DECIMAL(14,2),
    "status" "StockStatus" NOT NULL DEFAULT 'AVAILABLE',
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "entryNo" INTEGER,
    "photoUrl" TEXT,
    "remarks" TEXT,
    "soldAt" TIMESTAMP(3),
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" BIGSERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "txnDate" DATE NOT NULL,
    "asset" "LedgerAsset" NOT NULL,
    "direction" "Direction" NOT NULL,
    "bankAccountId" INTEGER,
    "metalForm" "MetalForm",
    "karatCode" TEXT,
    "pcs" INTEGER,
    "gross" DECIMAL(14,3),
    "net" DECIMAL(14,3),
    "fine" DECIMAL(14,3),
    "amount" DECIMAL(14,2),
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "partyId" INTEGER,
    "stockItemId" INTEGER,
    "narration" TEXT,
    "reversalOfId" BIGINT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JewelleryType_businessId_name_key" ON "JewelleryType"("businessId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ItemGroup_businessId_stockClass_name_key" ON "ItemGroup"("businessId", "stockClass", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ItemName_businessId_groupId_name_key" ON "ItemName"("businessId", "groupId", "name");

-- CreateIndex
CREATE INDEX "StockItem_businessId_branchId_stockClass_status_idx" ON "StockItem"("businessId", "branchId", "stockClass", "status");

-- CreateIndex
CREATE INDEX "StockItem_businessId_huid_idx" ON "StockItem"("businessId", "huid");

-- CreateIndex
CREATE UNIQUE INDEX "StockItem_businessId_tagNo_key" ON "StockItem"("businessId", "tagNo");

-- CreateIndex
CREATE INDEX "LedgerEntry_businessId_branchId_asset_txnDate_idx" ON "LedgerEntry"("businessId", "branchId", "asset", "txnDate");

-- CreateIndex
CREATE INDEX "LedgerEntry_businessId_source_sourceId_idx" ON "LedgerEntry"("businessId", "source", "sourceId");

-- CreateIndex
CREATE INDEX "LedgerEntry_businessId_partyId_idx" ON "LedgerEntry"("businessId", "partyId");

-- AddForeignKey
ALTER TABLE "ItemGroup" ADD CONSTRAINT "ItemGroup_jewelleryTypeId_fkey" FOREIGN KEY ("jewelleryTypeId") REFERENCES "JewelleryType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemName" ADD CONSTRAINT "ItemName_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ItemGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ItemGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_itemNameId_fkey" FOREIGN KEY ("itemNameId") REFERENCES "ItemName"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
