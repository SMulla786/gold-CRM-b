import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { girviBody } from '../../../shared';
import * as ledger from '../../../lib/ledger';
import * as girvi from './service';
import type { TenantContext } from '../../../middleware/context';

/** G7 audit L3: deleting a girvi locks the loan and re-checks "grant only" under the lock — an interest payment that commits meanwhile blocks the delete. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/** Resolves once another connection of this DB is waiting on a row lock. */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('no connection ever blocked on the loan row');
}

it('delete while an interest payment is mid-flight → 409; the loan, the payment and its cash all stay', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['girvi'], limits: null, permissions: {}, impersonatorId: null,
  };
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const g = await girvi.createGirvi(ctx, girviBody.parse({
    partyId: party.id, items: [{ category: 'Gold', name: 'Chain', gross: 12, net: 10, purity: 91.67, rate: 6000 }],
    principal: 50000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', tenureMonths: 3, cash: 50000, online: 0,
  }));
  const cashIn = async () => (await db.ledgerEntry.findMany({ where: { source: 'GIRVI', asset: 'MONEY' } })).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0);

  let paying!: () => void;
  const inFlight = new Promise<void>((r) => (paying = r));
  // an interest payment mid-flight, as payInterest writes it: the loan row locked, the INTEREST txn and its cash — committed once the delete waits
  const payment = db.$transaction(async (t) => {
    await t.$queryRaw`SELECT id FROM "GirviBatch" WHERE id = ${g.id} FOR NO KEY UPDATE`;
    const txnDate = ledger.businessDate();
    await t.girviTxn.create({ data: { batchId: g.id, type: 'INTEREST', txnDate, interest: 500, cash: 500 } });
    await ledger.post(t, { businessId: business.id, branchIds: [root.id], userId: 1 }, [{ branchId: root.id, txnDate, asset: 'MONEY', direction: 'IN', amount: 500, source: 'GIRVI', sourceId: String(g.id) }]);
    paying();
    await lockWaiter();
  });
  await inFlight;
  const del = girvi.deleteGirvi(ctx, g.id).catch((e: unknown) => e);
  await payment;
  expect(await del).toMatchObject({ status: 409 });
  expect(await db.girviTxn.count({ where: { batchId: g.id } })).toBe(2);
  expect(await cashIn()).toBe(-50000 + 500);
});
