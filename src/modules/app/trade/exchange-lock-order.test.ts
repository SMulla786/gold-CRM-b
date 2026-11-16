import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { exchangeBody, udharBody } from '../../../shared';
import { lockedKacha } from '../../../lib/kacha';
import * as exchange from './exchange';
import * as udharSvc from '../udhar';
import type { TenantContext } from '../../../middleware/context';

/**
 * G7 closure (A3): lib/kacha's global lock order — the pools before child rows. updateExchange (and every buy-sell write) takes
 * the KACHA / BULLION pool before the UDHAR sequence row of an inline udhar; createExchange took the UDHAR sequence first, so a
 * create with an inline udhar and a write holding the pool that then numbers an udhar deadlocked (Postgres 40P01 → 500).
 */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/** Resolves once another connection of this DB waits on a lock (an advisory pool lock counts). */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('the exchange never waited on the pool');
}

it('createExchange with an inline udhar, while another write holds the kacha pool and then numbers an udhar: both complete, no deadlock', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['exchange', 'udhari'], limits: null, permissions: {}, impersonatorId: null,
  };
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  await udharSvc.createUdharTxn(ctx, udharBody.parse({ partyId: party.id, cashOut: 100 })); // the branch's UDHAR sequence row exists

  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  // as updateExchange adding an inline udhar: the pool first, then the UDHAR sequence row (insertTxn's upsert)
  const poolThenUdhar = db.$transaction(async (t) => {
    await lockedKacha(t, root.id, 'GOLD');
    locked();
    await lockWaiter(); // the create now waits on the pool
    await t.$executeRaw`UPDATE "DocSequence" SET "next" = "next" + 1 WHERE "businessId" = ${business.id} AND "branchId" = ${root.id} AND "key" = 'UDHAR'`;
  }, { timeout: 30_000 });
  await isLocked;
  const create = exchange.createExchange(ctx, exchangeBody.parse({ partyId: party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight: 10, touch: 100 }], rate: 0, udhar: { cashOut: 500 } }));

  const [held, made] = await Promise.allSettled([poolThenUdhar, create]);
  expect([held.status, made.status, made.status === 'rejected' ? String((made.reason as Error).message).slice(0, 200) : '']).toEqual(['fulfilled', 'fulfilled', '']);
  const ex = await db.exchange.findFirstOrThrow({ where: { businessId: business.id } });
  expect((ex.inlineUdhar as { udharTxnId?: number } | null)?.udharTxnId).toEqual(expect.any(Number));
  expect(await db.udharTxn.count({ where: { businessId: business.id } })).toBe(2);
});
