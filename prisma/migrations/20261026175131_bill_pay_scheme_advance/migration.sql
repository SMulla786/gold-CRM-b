-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BillPaymentMode" ADD VALUE 'SCHEME';
ALTER TYPE "BillPaymentMode" ADD VALUE 'UDHAR_ADVANCE';

-- AlterTable
ALTER TABLE "BillPayment" ADD COLUMN     "schemeEnrollmentId" INTEGER;

-- AlterTable
ALTER TABLE "SchemeEnrollment" ADD COLUMN     "redeemBillId" INTEGER,
ADD COLUMN     "statusBeforeRedeem" "SchemeEnrollmentStatus";
