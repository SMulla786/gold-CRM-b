import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../../test/helpers/factory';
import { billBody } from '../../../shared';
import * as inv from '../inventory';
import * as billing from './service';
import type { TenantContext } from '../../../middleware/context';

/** G7 (review A): a sell bill takes from a LOOSE lot only while the lot is in the bill's branch — the in-tx claim re-checks the branch, like the TAG claim. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/** Resolves once another connection of this DB is waiting on a row lock. */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('no connection ever blocked on the stock row');
}

it('a LOOSE lot moved to another branch while the sale waits on its row → 409, nothing taken from it', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  const child = await createBranch({ businessId: business.id, parentId: root.id, name: 'Child' });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id, child.id], activeBranchId: root.id,
    readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
  };
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Bars'], gstRate: 3 });
  const looseName = await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Bar', method: 'LOOSE' });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const e = await inv.createStockEntry(ctx, { stockClass: 'GOLD', method: 'LOOSE', branchId: root.id, rows: [{ itemNameId: looseName!.id, karatCode: '22K', gross: 20, pcs: 1, less: 0, wastage: 0, stoneCharge: 0, labour: 0, labourUnit: 'PER_GRAM', other: 0 }] });
  const lot = e.items[0]!.id;

  let moving!: () => void;
  const inFlight = new Promise<void>((r) => (moving = r));
  // a stock transfer mid-flight: the lot's row locked and moved to the child branch, committed once the sale waits on it
  const transfer = db.$transaction(async (t) => {
    await t.stockItem.update({ where: { id: lot }, data: { branchId: child.id } });
    moving();
    await lockWaiter();
  });
  await inFlight;
  const sale = billing.createBill(ctx, billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId: party.id, items: [{ stockItemId: lot, gross: 5, pcs: 1, rate: 60000 }] })).catch((err: unknown) => err);
  await transfer;
  expect(await sale).toMatchObject({ status: 409 });
  const after = await db.stockItem.findUniqueOrThrow({ where: { id: lot } });
  expect([after.branchId, Number(after.gross)]).toEqual([child.id, 20]);
  expect(await db.bill.count()).toBe(0);
});
