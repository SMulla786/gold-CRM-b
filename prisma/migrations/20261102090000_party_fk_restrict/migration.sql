-- Phase 4 (G7): real FKs on every party-reference column, ON DELETE NO ACTION (NOT DEFERRABLE), so a child row can never point at a deleted Party.
-- NO ACTION, not RESTRICT: both refuse the delete, but RESTRICT raises SQLSTATE 23001, which Prisma 6 does not map to P2003 (it would surface as a 500);
-- non-deferrable NO ACTION raises 23503 → P2003 → 409, and deleteParty then archives instead.
-- Added NOT VALID: enforced for every new/updated row from now on, but existing rows are not scanned here (no long lock, no failure on legacy orphans).
-- Party."parentId" keeps its existing ON DELETE SET NULL (deleteParty archives any party that has members, so it never fires).
--
-- OPERATOR STEPS, after this migration is deployed (per database):
-- 1) Orphan pre-check. Every row must show 0:
--   SELECT 'LedgerEntry.partyId' AS col, count(*) FROM "LedgerEntry" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'Bill.partyId' AS col, count(*) FROM "Bill" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'UdharEntry.partyId' AS col, count(*) FROM "UdharEntry" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'UdharTxn.partyId' AS col, count(*) FROM "UdharTxn" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'JustBill.partyId' AS col, count(*) FROM "JustBill" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'SalesDraft.partyId' AS col, count(*) FROM "SalesDraft" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'Order.partyId' AS col, count(*) FROM "Order" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'KarigarIssue.karigarId' AS col, count(*) FROM "KarigarIssue" c WHERE c."karigarId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."karigarId")
--   UNION ALL
--   SELECT 'RepairTicket.partyId' AS col, count(*) FROM "RepairTicket" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'RepairTicket.karigarId' AS col, count(*) FROM "RepairTicket" c WHERE c."karigarId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."karigarId")
--   UNION ALL
--   SELECT 'GirviBatch.partyId' AS col, count(*) FROM "GirviBatch" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'GirviTransfer.lenderPartyId' AS col, count(*) FROM "GirviTransfer" c WHERE c."lenderPartyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."lenderPartyId")
--   UNION ALL
--   SELECT 'Exchange.partyId' AS col, count(*) FROM "Exchange" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'BuySell.partyId' AS col, count(*) FROM "BuySell" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'BhavBooking.partyId' AS col, count(*) FROM "BhavBooking" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'SchemeEnrollment.partyId' AS col, count(*) FROM "SchemeEnrollment" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'Sample.partyId' AS col, count(*) FROM "Sample" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'Sample.karigarId' AS col, count(*) FROM "Sample" c WHERE c."karigarId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."karigarId")
--   UNION ALL
--   SELECT 'SampleMovement.partyId' AS col, count(*) FROM "SampleMovement" c WHERE c."partyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."partyId")
--   UNION ALL
--   SELECT 'SampleMovement.karigarId' AS col, count(*) FROM "SampleMovement" c WHERE c."karigarId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = c."karigarId");
-- 2) If all are 0, validate each constraint (SHARE UPDATE EXCLUSIVE on the child table only; reads/writes keep running):
--   ALTER TABLE "LedgerEntry" VALIDATE CONSTRAINT "LedgerEntry_partyId_fkey";
--   ALTER TABLE "Bill" VALIDATE CONSTRAINT "Bill_partyId_fkey";
--   ALTER TABLE "UdharEntry" VALIDATE CONSTRAINT "UdharEntry_partyId_fkey";
--   ALTER TABLE "UdharTxn" VALIDATE CONSTRAINT "UdharTxn_partyId_fkey";
--   ALTER TABLE "JustBill" VALIDATE CONSTRAINT "JustBill_partyId_fkey";
--   ALTER TABLE "SalesDraft" VALIDATE CONSTRAINT "SalesDraft_partyId_fkey";
--   ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_partyId_fkey";
--   ALTER TABLE "KarigarIssue" VALIDATE CONSTRAINT "KarigarIssue_karigarId_fkey";
--   ALTER TABLE "RepairTicket" VALIDATE CONSTRAINT "RepairTicket_partyId_fkey";
--   ALTER TABLE "RepairTicket" VALIDATE CONSTRAINT "RepairTicket_karigarId_fkey";
--   ALTER TABLE "GirviBatch" VALIDATE CONSTRAINT "GirviBatch_partyId_fkey";
--   ALTER TABLE "GirviTransfer" VALIDATE CONSTRAINT "GirviTransfer_lenderPartyId_fkey";
--   ALTER TABLE "Exchange" VALIDATE CONSTRAINT "Exchange_partyId_fkey";
--   ALTER TABLE "BuySell" VALIDATE CONSTRAINT "BuySell_partyId_fkey";
--   ALTER TABLE "BhavBooking" VALIDATE CONSTRAINT "BhavBooking_partyId_fkey";
--   ALTER TABLE "SchemeEnrollment" VALIDATE CONSTRAINT "SchemeEnrollment_partyId_fkey";
--   ALTER TABLE "Sample" VALIDATE CONSTRAINT "Sample_partyId_fkey";
--   ALTER TABLE "Sample" VALIDATE CONSTRAINT "Sample_karigarId_fkey";
--   ALTER TABLE "SampleMovement" VALIDATE CONSTRAINT "SampleMovement_partyId_fkey";
--   ALTER TABLE "SampleMovement" VALIDATE CONSTRAINT "SampleMovement_karigarId_fkey";
-- 3) If any count is > 0, do NOT validate that constraint. List the rows and report them to the owner. Never delete or re-point them automatically.

ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "UdharEntry" ADD CONSTRAINT "UdharEntry_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "UdharTxn" ADD CONSTRAINT "UdharTxn_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "JustBill" ADD CONSTRAINT "JustBill_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "SalesDraft" ADD CONSTRAINT "SalesDraft_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Order" ADD CONSTRAINT "Order_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "KarigarIssue" ADD CONSTRAINT "KarigarIssue_karigarId_fkey" FOREIGN KEY ("karigarId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "RepairTicket" ADD CONSTRAINT "RepairTicket_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "RepairTicket" ADD CONSTRAINT "RepairTicket_karigarId_fkey" FOREIGN KEY ("karigarId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "GirviBatch" ADD CONSTRAINT "GirviBatch_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "GirviTransfer" ADD CONSTRAINT "GirviTransfer_lenderPartyId_fkey" FOREIGN KEY ("lenderPartyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "BuySell" ADD CONSTRAINT "BuySell_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "BhavBooking" ADD CONSTRAINT "BhavBooking_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "SchemeEnrollment" ADD CONSTRAINT "SchemeEnrollment_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Sample" ADD CONSTRAINT "Sample_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Sample" ADD CONSTRAINT "Sample_karigarId_fkey" FOREIGN KEY ("karigarId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "SampleMovement" ADD CONSTRAINT "SampleMovement_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "SampleMovement" ADD CONSTRAINT "SampleMovement_karigarId_fkey" FOREIGN KEY ("karigarId") REFERENCES "Party"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
