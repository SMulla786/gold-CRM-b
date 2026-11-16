-- AlterTable
ALTER TABLE "JustBillItem" ADD COLUMN     "photoUrl" TEXT;

-- AlterTable
ALTER TABLE "JustBillPayment" ADD COLUMN     "schemeEnrollmentId" INTEGER;

-- AlterTable
ALTER TABLE "SchemeEnrollment" ADD COLUMN     "redeemJustBillId" INTEGER;
