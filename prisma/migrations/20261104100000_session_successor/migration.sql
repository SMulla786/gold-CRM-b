-- G7 review: refresh grace window. A rotated session points at its successor so a duplicate refresh (two tabs at once)
-- resolves to that same successor instead of a competing one or a token-reuse revoke.
ALTER TABLE "Session" ADD COLUMN "replacedById" TEXT;
