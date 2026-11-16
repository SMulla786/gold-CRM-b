import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import { openingBalanceBody } from '../../shared';
import * as udharLib from '../../lib/udhar';
import * as opening from './opening';
import type { TenantContext } from '../../middleware/context';

/** G7 audit M4: deleting a party-only opening batch (no ledger rows to lock) locks its party rows, so two deletes can't both reverse them. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/** Resolves once another connection of this DB is waiting on a row lock. */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('no connection ever blocked on the party rows');
}

it('a second delete of a party-only opening batch, while the first is mid-flight → 404; the party balance is reversed once', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['udhari', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
  };
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const batch = await opening.createOpeningBalances(ctx, openingBalanceBody.parse({ entries: [{ kind: 'PARTY', partyId: party.id, amount: 1000 }] }));
  const owes = async () => (await db.udharEntry.findMany({ where: { partyId: party.id } })).reduce((a, r) => a + Number(r.amount), 0);
  expect(await owes()).toBe(1000);

  let deleting!: () => void;
  const inFlight = new Promise<void>((r) => (deleting = r));
  let secondDone!: () => void;
  const secondSettled = new Promise<void>((r) => (secondDone = r));
  // the first delete mid-flight, as the fixed delete does it: the batch's party rows locked and reversed; it commits once the second
  // delete waits on those rows — or, if the second never waits (no lock to wait on), once it has finished
  const first = db.$transaction(async (t) => {
    await t.$queryRaw`SELECT id FROM "UdharEntry" WHERE "businessId" = ${business.id} AND source = 'OPENING_BALANCE' AND "sourceId" = ${batch.sourceId} AND "reversalOfId" IS NULL ORDER BY id FOR UPDATE`;
    await udharLib.reverse(t, { businessId: business.id, branchIds: [root.id], userId: 1 }, { source: 'OPENING_BALANCE', sourceId: batch.sourceId });
    deleting();
    await Promise.race([lockWaiter(), secondSettled]);
  });
  await inFlight;
  const second = opening.deleteOpeningBalances(ctx, batch.sourceId).catch((e: unknown) => e).finally(() => secondDone());
  await first;
  expect(await second).toMatchObject({ status: 404 });
  expect(await owes()).toBe(0);
});
