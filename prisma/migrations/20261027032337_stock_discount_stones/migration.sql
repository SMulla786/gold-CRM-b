-- group (C) dev2: New Stock discount/total, purchase stones per item, metal-pay jewellery type. Additive only.

-- AlterTable
ALTER TABLE "BillPayment" ADD COLUMN     "jewelleryTypeId" INTEGER;

-- AlterTable
ALTER TABLE "StockItem" ADD COLUMN     "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "total" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "StockItemStone" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "stockItemId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "pcs" INTEGER NOT NULL DEFAULT 0,
    "weight" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'CT',
    "rate" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "StockItemStone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockItemStone_stockItemId_idx" ON "StockItemStone"("stockItemId");

-- AddForeignKey
ALTER TABLE "StockItemStone" ADD CONSTRAINT "StockItemStone_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "StockItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
