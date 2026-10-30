-- Phase 5: explicit ad-supported plans; each subscription term keeps an immutable snapshot (additive, default false = no ads)
ALTER TABLE "Plan" ADD COLUMN "adSupported" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Subscription" ADD COLUMN "adSupported" BOOLEAN NOT NULL DEFAULT false;
