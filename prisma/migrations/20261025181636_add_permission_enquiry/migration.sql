-- CreateEnum
CREATE TYPE "EnquiryStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "PermissionEnquiry" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "permissionId" INTEGER NOT NULL,
    "wantView" BOOLEAN NOT NULL DEFAULT false,
    "wantEdit" BOOLEAN NOT NULL DEFAULT false,
    "wantDelete" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "status" "EnquiryStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermissionEnquiry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PermissionEnquiry_businessId_status_idx" ON "PermissionEnquiry"("businessId", "status");

-- CreateIndex
CREATE INDEX "PermissionEnquiry_userId_permissionId_status_idx" ON "PermissionEnquiry"("userId", "permissionId", "status");
