-- G5: exchange money round-off as its own figure; given-metal measurements (additive; existing rows: roundOff 0, given null)
ALTER TABLE "Exchange" ADD COLUMN "roundOff" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "givenGross" DECIMAL(14,3),
  ADD COLUMN "givenNet" DECIMAL(14,3),
  ADD COLUMN "givenTouch" DECIMAL(6,3);
