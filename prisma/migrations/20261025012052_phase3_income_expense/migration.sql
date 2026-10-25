-- CreateEnum
CREATE TYPE "IncomeExpenseType" AS ENUM ('INCOME', 'EXPENSE');

-- CreateTable
CREATE TABLE "IncomeExpense" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "txnDate" DATE NOT NULL,
    "type" "IncomeExpenseType" NOT NULL,
    "reason" TEXT NOT NULL,
    "cash" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "online" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bankAccountId" INTEGER,
    "gold" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "silver" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "remark" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncomeExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncomeExpense_businessId_branchId_txnDate_idx" ON "IncomeExpense"("businessId", "branchId", "txnDate");
