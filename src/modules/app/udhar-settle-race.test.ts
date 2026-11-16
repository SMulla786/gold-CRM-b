import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import { billBody, udharBody } from '../../shared';
import * as inv from './inventory';
import * as billing from './billing/service';
import { createUdharTxn } from './udhar';
import type { TenantContext } from '../../middleware/context';

/** G7 udhar-settle lock: settling a purchase bill from Udhar caps the payment at the bill's due — read under the bill row lock,
 *  so a payment that commits meanwhile (addBillPayments, another settle) can't let the supplier be paid twice. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/** Resolves once another connection of this DB is waiting on a row lock. */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('no connection ever blocked on the bill row');
}

it('udhar settle of a purchase bill while a full payment holds the bill row → 409 (already settled); the supplier is paid once', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['billing', 'inventory', 'udhari', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
  };
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const itemName = (await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 }))!;
  const supplier = await db.party.create({ data: { businessId: business.id, type: 'SUPPLIER', name: 'Supp', mobile: '9000000002', countryCode: '+91' } });
  const bill = await billing.createBill(ctx, billBody.parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: supplier.id, items: [{ itemNameId: itemName.id, gross: 10, karatCode: '22K', rate: 60000 }] }));
  const due = Number(bill.final);

  let paidIn!: () => void;
  const first = new Promise<void>((r) => (paidIn = r));
  // a full payment mid-flight, holding the bill row the way addBillPayments does
  const hold = db.$transaction(async (t) => {
    await t.$queryRaw`SELECT id FROM "Bill" WHERE id = ${bill.id} FOR NO KEY UPDATE`;
    await t.bill.update({ where: { id: bill.id }, data: { paid: { increment: due } } });
    paidIn();
    await lockWaiter(); // the settle is waiting for the row
  });
  await first;
  const settle = createUdharTxn(ctx, udharBody.parse({ partyId: supplier.id, cashOut: due, settleBillId: bill.id })).catch((e: unknown) => e);
  await hold;
  expect(await settle).toMatchObject({ status: 409 });
  expect(Number((await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).paid)).toBe(due);
  expect(await db.udharTxn.count()).toBe(0);
});
