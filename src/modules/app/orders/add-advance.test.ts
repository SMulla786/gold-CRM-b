import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import * as inv from '../inventory';
import * as orders from './service';
import type { TenantContext } from '../../../middleware/context';

// Phase 8: POST /orders/:id/advance (addOrderAdvance) had no test. The order's running `advance` must equal every
// advance posted to the ledger, also when two advances land at once, and a closed order takes none.
const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  await db.metalRate.create({ data: { businessId: business.id, metal: 'GOLD', branchId: root.id, rateUnit: 'GRAM_10', karatCode: '22K', sellRate: 60000, buyRate: 59000, effectiveAt: new Date() } });
  const ctx = ctxFor(business.id, root.id);
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const itemName = await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
  const customer = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const order = await orders.createOrder(ctx, { partyId: customer.id, rateType: 'ON_DELIVERY', isUrgent: false, items: [{ itemNameId: itemName!.id, metal: 'GOLD', karatCode: '22K', gross: 10, making: 500, makingUnit: 'PER_GRAM', pcs: 1 }], payments: [] } as any);
  return { ctx, customer, order };
}
const cash = (amount: number) => [{ mode: 'CASH' as const, amount }];
const ledgerIn = async (orderId: number) =>
  (await db.ledgerEntry.findMany({ where: { source: 'ORDER_ADVANCE', sourceId: { startsWith: `${orderId}-P` }, asset: 'MONEY' } })).reduce((a, r) => a + Number(r.amount), 0);
const udharOf = async (partyId: number) => (await db.udharEntry.findMany({ where: { partyId } })).reduce((a, r) => a + Number(r.amount), 0);

describe('addOrderAdvance', () => {
  it('adds to the order advance, posts MONEY IN + party credit; payments are kept', async () => {
    const s = await setup();
    const after = await orders.addOrderAdvance(s.ctx, s.order.id, cash(5000));
    expect(after.advance).toBe('5000.00');
    await orders.addOrderAdvance(s.ctx, s.order.id, cash(2500));
    expect((await orders.getOrder(s.ctx, s.order.id)).advance).toBe('7500.00');
    expect(await ledgerIn(s.order.id)).toBe(7500);
    expect(await udharOf(s.customer.id)).toBe(-7500); // shop owes the customer until billed
    expect(await db.orderPayment.count({ where: { orderId: s.order.id } })).toBe(2);
  });

  it('a cancelled or delivered order takes no advance (409) and nothing is posted', async () => {
    const s = await setup();
    await orders.cancelOrder(s.ctx, s.order.id);
    await expect(orders.addOrderAdvance(s.ctx, s.order.id, cash(1000))).rejects.toMatchObject({ status: 409 });
    await db.order.update({ where: { id: s.order.id }, data: { status: 'DELIVERED' } });
    await expect(orders.addOrderAdvance(s.ctx, s.order.id, cash(1000))).rejects.toMatchObject({ status: 409 });
    expect([await ledgerIn(s.order.id), await udharOf(s.customer.id), await db.orderPayment.count({ where: { orderId: s.order.id } })]).toEqual([0, 0, 0]);
  });

  it("another business's order → 404", async () => {
    const a = await setup('A');
    const b = await setup('B');
    await expect(orders.addOrderAdvance(a.ctx, b.order.id, cash(1000))).rejects.toMatchObject({ status: 404 });
    expect(await ledgerIn(b.order.id)).toBe(0);
  });

  it('two advances at once: order.advance equals everything posted (no lost update)', async () => {
    const ROUNDS = 5;
    for (let i = 0; i < ROUNDS; i++) {
      await truncateAll();
      const s = await setup();
      await Promise.all([orders.addOrderAdvance(s.ctx, s.order.id, cash(1000)), orders.addOrderAdvance(s.ctx, s.order.id, cash(2000))]);
      const order = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
      expect([Number(order.advance), await ledgerIn(s.order.id)]).toEqual([3000, 3000]);
    }
  });
});
