-- AlterEnum
ALTER TYPE "SchemePayMedium" ADD VALUE 'CHEQUE';

-- AlterTable
ALTER TABLE "Scheme" ADD COLUMN     "title" TEXT;
