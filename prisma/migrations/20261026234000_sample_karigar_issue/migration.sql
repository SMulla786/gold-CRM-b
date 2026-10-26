-- AlterTable
ALTER TABLE "Sample" ADD COLUMN     "karigarIssueId" INTEGER;

-- CreateIndex
CREATE INDEX "Sample_karigarIssueId_idx" ON "Sample"("karigarIssueId");
