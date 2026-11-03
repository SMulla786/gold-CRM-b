import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { billBody } from '../../../shared';
import * as ledger from '../../../lib/ledger';
import * as udharLib from '../../../lib/udhar';
import * as billing from './service';
import type { TenantContext } from '../../../middleware/context';

/** G7 audit M3: bill edit / delete undo the bill as it is under their lock — a payment that committed after their first read is undone with the rest,
 *  not left with its cash still booked while its party credit is reversed. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/** ROUGH sell bill, one direct line: final = ₹60,000. */
const sell = (partyId: number, payments: unknown[] = []) =>
  billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 10, rate: 60000 }], payments });

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['billing', 'udhari', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
  };
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const bill = await billing.createBill(ctx, sell(party.id, [{ mode: 'CASH', amount: 10000 }]));
  return { business, root, ctx, party, bill };
}
type S = Awaited<ReturnType<typeof setup>>;
/** [cash in hand from this bill, what the party owes, active payments on the bill] */
const books = async (s: S) => [
  (await db.ledgerEntry.findMany({ where: { asset: 'MONEY', source: 'SELL_BILL' } })).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0),
  (await db.udharEntry.findMany({ where: { partyId: s.party.id } })).reduce((a, r) => a + Number(r.amount), 0),
  await db.billPayment.count({ where: { billId: s.bill.id, isActive: true } }),
];

/** Resolves once another connection of this DB is waiting on a row lock. */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('no connection ever blocked on the bill row');
}
/** Runs `op` while a ₹5,000 cash payment on the bill is mid-flight, written the way addBillPayments writes it; it commits once `op` waits on the bill row. */
async function duringPayment(s: S, op: () => Promise<unknown>): Promise<unknown> {
  const lctx = { businessId: s.business.id, branchIds: [s.root.id], userId: 1 };
  const txnDate = ledger.businessDate();
  let paying!: () => void;
  const inFlight = new Promise<void>((r) => (paying = r));
  const payment = db.$transaction(async (t) => {
    await t.$queryRaw`SELECT id FROM "Bill" WHERE id = ${s.bill.id} FOR NO KEY UPDATE`;
    const p = await t.billPayment.create({ data: { billId: s.bill.id, mode: 'CASH', amount: 5000, txnDate, isActive: true, createdById: 1 } });
    await ledger.post(t, lctx, [{ branchId: s.root.id, txnDate, asset: 'MONEY', direction: 'IN', amount: 5000, source: 'SELL_BILL', sourceId: `${s.bill.id}-P${p.id}` }]);
    await t.bill.update({ where: { id: s.bill.id }, data: { paid: { increment: 5000 } } });
    await udharLib.post(t, lctx, [{ branchId: s.root.id, partyId: s.party.id, txnDate, source: 'SELL_BILL', sourceId: String(s.bill.id), amount: -5000 }]);
    paying();
    await lockWaiter();
  });
  await inFlight;
  const res = op().catch((e: unknown) => e);
  await payment;
  return res;
}

describe('bill undo reads the bill under its lock', () => {
  it('delete while a payment commits: that payment is undone too — no cash left booked, party back to zero', async () => {
    const s = await setup();
    expect(await books(s)).toEqual([10000, 50000, 1]);
    await duringPayment(s, () => billing.deleteBill(s.ctx, s.bill.id, true));
    expect(await books(s)).toEqual([0, 0, 0]);
  });

  it('edit while a payment commits: the edit replaces every payment, the late one included — cash and party agree with the edited bill', async () => {
    const s = await setup();
    await duringPayment(s, () => billing.editBill(s.ctx, s.bill.id, sell(s.party.id, [{ mode: 'CASH', amount: 20000 }])));
    expect(await books(s)).toEqual([20000, 40000, 1]);
  });
});
