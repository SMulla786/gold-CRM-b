-- AlterTable
ALTER TABLE "GirviBatch" ADD COLUMN     "firstMonthInterest" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "penaltyRatePercent" DECIMAL(6,3) NOT NULL DEFAULT 0;
