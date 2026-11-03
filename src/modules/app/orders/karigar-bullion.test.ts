/* eslint-disable @typescript-eslint/no-explicit-any -- service inputs are zod-parsed upstream; tests pass partial bodies */
import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { openingBalanceBody } from '../../../shared';
import * as inv from '../inventory';
import { createOpeningBalances } from '../opening';
import { kachaBalanceCard } from '../trade/kacha';
import * as orders from './service';
import type { TenantContext } from '../../../middleware/context';

/** G7 D-i: a karigar issue draws fine gold / silver from the branch's BULLION pool — guarded like every other draw (ACC-05): 409 BULLION_SHORT, never below zero. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

it('karigar issue beyond the bullion pool → 409 BULLION_SHORT and nothing written; within it → issued and drawn', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
  };
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const itemName = (await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 }))!;
  const customer = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const karigar = await db.party.create({ data: { businessId: business.id, type: 'KARIGAR', name: 'Karigar', mobile: '9000000002', countryCode: '+91' } });
  const order = await orders.createOrder(ctx, { partyId: customer.id, rateType: 'ON_DELIVERY', isUrgent: false, items: [{ itemNameId: itemName.id, metal: 'GOLD', karatCode: '22K', gross: 10, making: 500, makingUnit: 'PER_GRAM', pcs: 1 }], payments: [] } as any);
  const issue = (goldFine: number, silverFine: number) => orders.createKarigarIssue(ctx, { karigarId: karigar.id, orderItemIds: [order.items[0]!.id], goldFine, silverFine, cash: 0, online: 0 } as any);
  const bullion = async () => Object.fromEntries((await kachaBalanceCard(ctx, {})).byMetal!.map((m) => [m.metal, m.bullionFine]));

  await expect(issue(10, 0)).rejects.toMatchObject({ status: 409, details: { code: 'BULLION_SHORT', metal: 'GOLD', available: '0.000', needed: '10.000' } });
  await createOpeningBalances(ctx, openingBalanceBody.parse({ entries: [{ kind: 'METAL', metal: 'GOLD', metalForm: 'BULLION', fine: 10 }] }));
  await expect(issue(10, 5)).rejects.toMatchObject({ status: 409, details: { code: 'BULLION_SHORT', metal: 'SILVER' } }); // gold is covered now, silver is not
  expect([await db.karigarIssue.count(), (await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } })).status]).toEqual([0, 'PENDING']);

  await issue(10, 0);
  expect(await bullion()).toMatchObject({ GOLD: '0.000' });
});
