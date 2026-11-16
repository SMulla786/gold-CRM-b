-- G2b: auto-renew on confirmation only for payments submitted from now on; existing rows default to false (no data rewritten)
ALTER TABLE "SubscriptionPayment" ADD COLUMN "renewOnConfirm" BOOLEAN NOT NULL DEFAULT false;
