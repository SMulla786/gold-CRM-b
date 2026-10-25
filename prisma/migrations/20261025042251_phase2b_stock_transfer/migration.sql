-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "transferNo" INTEGER NOT NULL,
    "fromBranchId" INTEGER NOT NULL,
    "toBranchId" INTEGER NOT NULL,
    "txnDate" DATE NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "remarks" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockTransfer_businessId_fromBranchId_idx" ON "StockTransfer"("businessId", "fromBranchId");

-- CreateIndex
CREATE INDEX "StockTransfer_businessId_toBranchId_idx" ON "StockTransfer"("businessId", "toBranchId");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_businessId_transferNo_key" ON "StockTransfer"("businessId", "transferNo");
