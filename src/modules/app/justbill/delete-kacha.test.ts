import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { justBillBody, kachaProcessBody } from '../../../shared';
import * as kacha from '../trade/kacha';
import * as jb from './service';
import type { TenantContext } from '../../../middleware/context';

/** G7 D-g: deleting a Just Bill takes its kacha back out of the pool — the same pool guard as a bill delete (ACC-05), so a melt can't leave it negative. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

it('delete of a Just Bill whose kacha was melted → 409 KACHA_SHORT, bill still ACTIVE; after the melt is reverted it deletes', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['exchange', 'billing', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
  };
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const gold = async () => (await kacha.kachaBalanceCard(ctx, {})).byMetal!.find((m) => m.metal === 'GOLD')!.kachaFine;
  // ₹20,000 coin, 2 g of old gold taken in as kacha
  const b = await jb.createJustBill(ctx, justBillBody.parse({ partyId: party.id, items: [{ name: 'Coin', quantity: 1, unit: 'PCS', rate: 20000 }], payments: [{ mode: 'METAL', metal: 'GOLD', metalForm: 'KACHA', gross: 2, tunch: 100, rate: 60000 }] }));
  expect(await gold()).toBe('2.000');
  const melt = await kacha.processKacha(ctx, kachaProcessBody.parse({ metal: 'GOLD', type: 'MELT', inFine: 2, outFine: 1.9 }));

  await expect(jb.deleteJustBill(ctx, b.id)).rejects.toMatchObject({ status: 409, details: { code: 'KACHA_SHORT', metal: 'GOLD', available: '0.000', needed: '2.000' } });
  expect((await db.justBill.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('ACTIVE');
  expect(await db.justBillPayment.count({ where: { justBillId: b.id, isActive: true } })).toBe(1);
  expect(await gold()).toBe('0.000');

  await kacha.revertKacha(ctx, melt.id);
  await jb.deleteJustBill(ctx, b.id);
  expect(await gold()).toBe('0.000');
});
