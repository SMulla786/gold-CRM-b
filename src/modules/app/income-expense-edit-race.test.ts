import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import { incomeExpenseBody } from '../../shared';
import * as ledger from '../../lib/ledger';
import * as acc from './accounts';
import type { TenantContext } from '../../middleware/context';

/** G7 audit L4: an income / expense edit only touches a row that is still not deleted — checked by its first write, under the row lock. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/** Resolves once another connection of this DB is waiting on a row lock. */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('no connection ever blocked on the entry row');
}

it('edit while a delete of the same entry is mid-flight → 404; no cash is booked for the deleted entry', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['accounts', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
  };
  const ie = (cash: number) => incomeExpenseBody.parse({ type: 'EXPENSE', reason: 'Tea', cash });
  const entry = await acc.createIncomeExpense(ctx, ie(300));
  const cash = async () => (await db.ledgerEntry.findMany({ where: { source: 'INCOME_EXPENSE', asset: 'MONEY' } })).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0);
  expect(await cash()).toBe(-300);

  let deleting!: () => void;
  const inFlight = new Promise<void>((r) => (deleting = r));
  // a delete mid-flight, as deleteIncomeExpense does it: the row flagged deleted and its ledger rows reversed — committed once the edit waits
  const del = db.$transaction(async (t) => {
    await t.incomeExpense.update({ where: { id: entry.id }, data: { isDeleted: true } });
    await ledger.reverse(t, { businessId: business.id, branchIds: [root.id], userId: 1 }, { source: 'INCOME_EXPENSE', sourceId: String(entry.id) });
    deleting();
    await lockWaiter();
  });
  await inFlight;
  const edit = acc.updateIncomeExpense(ctx, entry.id, ie(500)).catch((e: unknown) => e);
  await del;
  expect(await edit).toMatchObject({ status: 404 });
  expect(await cash()).toBe(0);
});
