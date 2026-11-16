import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import { udharBody } from '../../shared';
import * as ledger from '../../lib/ledger';
import * as udharLib from '../../lib/udhar';
import { createUdharTxn, updateUdharTxn } from './udhar';
import type { TenantContext } from '../../middleware/context';

/** G7 audit M2: an udhar edit locks its row (still not deleted) before it reverses anything, and reverses what is live then —
 *  an edit racing a delete (or a second edit) must not reverse the same rows twice. */

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

it('edit while a delete of the same udhar is mid-flight → 404; the party and the cash book net to zero', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['udhari'], limits: null, permissions: {}, impersonatorId: null,
  };
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const u = await createUdharTxn(ctx, udharBody.parse({ partyId: party.id, cashOut: 1000 }));
  const lctx = { businessId: business.id, branchIds: [root.id], userId: 1 };
  const ref = { source: 'UDHAR' as const, sourceId: String(u.id) };

  let deleting!: () => void;
  const inFlight = new Promise<void>((r) => (deleting = r));
  // a delete mid-flight, as deleteUdharTxn does it: the row flagged deleted, its ledger and party rows reversed — committed once the edit waits
  const del = db.$transaction(async (t) => {
    await t.udharTxn.update({ where: { id: u.id }, data: { isDeleted: true } });
    await ledger.reverse(t, lctx, ref);
    await udharLib.reverse(t, lctx, ref);
    deleting();
    await lockWaiter();
  });
  await inFlight;
  const edit = updateUdharTxn(ctx, u.id, udharBody.parse({ partyId: party.id, cashOut: 1500 })).catch((e: unknown) => e);
  await del;
  expect(await edit).toMatchObject({ status: 404 });
  const owes = (await db.udharEntry.findMany({ where: { partyId: party.id } })).reduce((a, r) => a + Number(r.amount), 0);
  const cash = (await db.ledgerEntry.findMany({ where: { source: 'UDHAR', asset: 'MONEY' } })).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0);
  expect([owes, cash]).toEqual([0, 0]);
});
