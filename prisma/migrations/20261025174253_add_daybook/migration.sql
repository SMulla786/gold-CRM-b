-- CreateEnum
CREATE TYPE "DayStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "DayBook" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "status" "DayStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3),
    "openedById" INTEGER,
    "closedAt" TIMESTAMP(3),
    "closedById" INTEGER,

    CONSTRAINT "DayBook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DayBook_businessId_branchId_idx" ON "DayBook"("businessId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "DayBook_businessId_branchId_date_key" ON "DayBook"("businessId", "branchId", "date");
