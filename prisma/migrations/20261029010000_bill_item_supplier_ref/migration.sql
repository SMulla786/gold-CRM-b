-- Purchase Bill parity: supplier's item name / tag no. per bill line (original "Supp item" / "Supp tag"). Nullable, no backfill.
ALTER TABLE "BillItem" ADD COLUMN "supplierItem" TEXT,
ADD COLUMN "supplierTag" TEXT;
