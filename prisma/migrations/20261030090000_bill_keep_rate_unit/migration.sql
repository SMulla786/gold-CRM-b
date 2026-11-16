-- BILL-15 R2: freeze the keep-rate unit on each bill (additive, nullable; existing rows stay NULL, no conversion)
ALTER TABLE "Bill" ADD COLUMN "keepRateUnitGrams" DECIMAL(10,3);
