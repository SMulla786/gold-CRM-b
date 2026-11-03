import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import { billBody, udharBody } from '../../shared';
import * as ledger from '../../lib/ledger';
import * as udharLib from '../../lib/udhar';
import * as billing from './billing/service';
import { createUdharTxn, deleteUdharTxn } from './udhar';
import type { TenantContext } from '../../middleware/context';

/** G7 H: an udhar delete undoes the udhar as it is under its row lock — an edit that moved the settlement to another bill meanwhile is undone on that bill. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/** Resolves once another connection of this DB is waiting on a row lock. */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('no connection ever blocked on the udhar row');
}

it('delete while an edit moves the settlement from bill 1 to bill 2 → bill 2 is un-settled too (no "paid" without money)', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['billing', 'udhari', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
  };
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const sell = () => billing.createBill(ctx, billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId: party.id, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 10, rate: 60000 }], payments: [{ mode: 'CASH', amount: 10000 }] }));
  const [b1, b2] = [await sell(), await sell()];
  const u = await createUdharTxn(ctx, udharBody.parse({ partyId: party.id, cashIn: 20000, settleBillId: b1.id }));
  const lctx = { businessId: business.id, branchIds: [root.id], userId: 1 };
  const ref = { source: 'UDHAR' as const, sourceId: String(u.id) };
  const paid = async (id: number) => Number((await db.bill.findUniqueOrThrow({ where: { id } })).paid);

  let moving!: () => void;
  const inFlight = new Promise<void>((r) => (moving = r));
  // an edit mid-flight, as updateUdharTxn does it: row locked, the bill-1 settlement undone, then re-posted on bill 2 — committed once the delete waits
  const edit = db.$transaction(async (t) => {
    await t.udharTxn.updateMany({ where: { id: u.id, isDeleted: false }, data: { isDeleted: false } });
    await ledger.reverse(t, lctx, ref);
    await udharLib.reverse(t, lctx, ref);
    await t.billPayment.updateMany({ where: { billId: b1.id, udharTxnId: u.id, isActive: true }, data: { isActive: false } });
    await t.bill.update({ where: { id: b1.id }, data: { paid: { decrement: 20000 } } });
    const txnDate = ledger.businessDate();
    await t.udharTxn.update({ where: { id: u.id }, data: { settleBillId: b2.id } });
    await ledger.post(t, lctx, [{ branchId: root.id, txnDate, asset: 'MONEY', direction: 'IN', amount: 20000, source: 'UDHAR', sourceId: String(u.id), partyId: party.id }]);
    await udharLib.post(t, lctx, [{ branchId: root.id, partyId: party.id, txnDate, amount: -20000, source: 'UDHAR', sourceId: String(u.id) }]);
    await t.billPayment.create({ data: { billId: b2.id, mode: 'CASH', amount: 20000, txnDate, udharTxnId: u.id, createdById: 1 } });
    await t.bill.update({ where: { id: b2.id }, data: { paid: { increment: 20000 } } });
    moving();
    await lockWaiter();
  });
  await inFlight;
  const del = deleteUdharTxn(ctx, u.id);
  await edit;
  await del;
  expect([await paid(b1.id), await paid(b2.id)]).toEqual([10000, 10000]);
  expect(await db.billPayment.count({ where: { udharTxnId: u.id, isActive: true } })).toBe(0);
});
