-- G7 review 2: LGD district master. lgdCode = the Local Government Directory district code, so a later LGD import
-- renames a district in place (same id: branch / party / business references stay) instead of adding a second row.
ALTER TABLE "District" ADD COLUMN "lgdCode" INTEGER;
CREATE UNIQUE INDEX "District_lgdCode_key" ON "District"("lgdCode");
