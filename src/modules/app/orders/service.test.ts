import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import * as inv from '../inventory';
import * as orders from './service';
import type { TenantContext } from '../../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  await db.metalRate.create({ data: { businessId: business.id, metal: 'GOLD', branchId: root.id, rateUnit: 'GRAM_10', karatCode: '22K', sellRate: 60000, buyRate: 59000, effectiveAt: new Date() } });
  const ctx = ctxFor(business.id, root.id);
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const itemName = await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
  const customer = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const karigar = await db.party.create({ data: { businessId: business.id, type: 'KARIGAR', name: 'Karigar', mobile: '9000000002', countryCode: '+91' } });
  return { business, root, ctx, itemName: itemName!, customer, karigar };
}

const sumUdhar = async (partyId: number) => {
  const rows = await db.udharEntry.findMany({ where: { partyId }, select: { amount: true, gold: true, silver: true } });
  return { amount: rows.reduce((a, r) => a + Number(r.amount), 0), gold: rows.reduce((a, r) => a + Number(r.gold), 0), silver: rows.reduce((a, r) => a + Number(r.silver), 0) };
};
const orderItem = (over: Record<string, unknown> = {}) => ({ itemNameId: 0, metal: 'GOLD', karatCode: '22K', gross: 10, making: 500, makingUnit: 'PER_GRAM', pcs: 1, ...over });

async function makeOrder(ctx: TenantContext, itemNameId: number, customerId: number, payments: any[] = []) {
  return orders.createOrder(ctx, { partyId: customerId, rateType: 'ON_DELIVERY', isUrgent: false, items: [orderItem({ itemNameId })], payments } as any);
}

describe('orders', () => {
  it('create with cash + metal advance → ORDER_ADVANCE ledger + party credited (negative udhar)', async () => {
    const s = await setup();
    const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id, [
      { mode: 'CASH', amount: 10000 },
      { mode: 'METAL', metal: 'GOLD', metalForm: 'KACHA', gross: 5, less: 0, tunch: 100, rate: 60000 },
    ]);
    expect(order.status).toBe('PENDING');
    expect(Number(order.estTotal)).toBeGreaterThan(0);
    expect(order.payments).toHaveLength(2);

    const led = await db.ledgerEntry.findMany({ where: { source: 'ORDER_ADVANCE' } });
    expect(led.filter((r) => r.asset === 'MONEY' && r.direction === 'IN')).toHaveLength(1);
    const gold = led.find((r) => r.asset === 'GOLD')!;
    expect(gold.direction).toBe('IN');
    expect(Number(gold.fine)).toBe(5);

    const bal = await sumUdhar(s.customer.id); // shop owes the customer until billed
    expect(bal.amount).toBe(-10000);
    expect(bal.gold).toBe(-5);
  });

  it('karigar issue → KARIGAR_ISSUE OUT + karigar owes the shop; order IN_PROCESS, items ASSIGNED', async () => {
    const s = await setup();
    const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    const issue = await orders.createKarigarIssue(s.ctx, { karigarId: s.karigar.id, orderItemIds: [order.items[0]!.id], goldFine: 10, silverFine: 0, cash: 2000, online: 0 } as any);
    expect(issue.status).toBe('OPEN');

    const led = await db.ledgerEntry.findMany({ where: { source: 'KARIGAR_ISSUE' } });
    expect(led.find((r) => r.asset === 'GOLD')!.direction).toBe('OUT');
    expect(led.find((r) => r.asset === 'MONEY')!.direction).toBe('OUT');
    const bal = await sumUdhar(s.karigar.id);
    expect(bal.gold).toBe(10); // karigar owes the issued gold + cash
    expect(bal.amount).toBe(2000);
    expect((await orders.getOrder(s.ctx, order.id)).status).toBe('IN_PROCESS');
    expect((await orders.getOrder(s.ctx, order.id)).items[0]!.status).toBe('ASSIGNED');
  });

  it('receive with ghat → finished piece RESERVED + ORDER_RECEIVE IN, order READY, karigar udhar nets', async () => {
    const s = await setup();
    const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    const issue = await orders.createKarigarIssue(s.ctx, { karigarId: s.karigar.id, orderItemIds: [order.items[0]!.id], goldFine: 10, silverFine: 0, cash: 0, online: 0 } as any);
    const received = await orders.receiveKarigar(s.ctx, issue.id, { items: [{ orderItemId: order.items[0]!.id, returnedGross: 9.5, returnedLess: 0, touch: 100, ghatAllowance: 0.3, labour: 800 }] } as any);
    expect(received.status).toBe('RECEIVED');

    const piece = await db.stockItem.findFirst({ where: { source: 'ORDER_RECEIVE', sourceId: String(order.id) } });
    expect(piece?.status).toBe('RESERVED');
    expect(Number(piece!.fine)).toBe(9.5);
    const recv = await db.ledgerEntry.findMany({ where: { source: 'ORDER_RECEIVE', asset: 'GOLD' } });
    expect(recv[0]!.direction).toBe('IN');

    expect((await orders.getOrder(s.ctx, order.id)).status).toBe('READY');
    const bal = await sumUdhar(s.karigar.id); // issued 10 − (returned 9.5 + ghat 0.3) = 0.2 still owed
    expect(bal.gold).toBeCloseTo(0.2, 3);
    expect(bal.amount).toBe(-800); // shop owes the karigar the labour
  });

  it('cancel is blocked while a karigar issue is open (409); a plain PENDING order cancels', async () => {
    const s = await setup();
    const o1 = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    await orders.createKarigarIssue(s.ctx, { karigarId: s.karigar.id, orderItemIds: [o1.items[0]!.id], goldFine: 1, silverFine: 0, cash: 0, online: 0 } as any);
    await expect(orders.cancelOrder(s.ctx, o1.id)).rejects.toMatchObject({ status: 409 });

    const o2 = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    await orders.cancelOrder(s.ctx, o2.id);
    expect((await orders.getOrder(s.ctx, o2.id)).status).toBe('CANCELLED');
  });

  it('cross-tenant party → 404', async () => {
    const s = await setup();
    const other = await createBusiness({ name: 'B' });
    const bParty = await db.party.create({ data: { businessId: other.business.id, type: 'CUSTOMER', name: 'B cust', mobile: '9111111111', countryCode: '+91' } });
    await expect(makeOrder(s.ctx, s.itemName.id, bParty.id)).rejects.toMatchObject({ status: 404 });
  });

  it('two concurrent receives of the same item → one wins, one 409, exactly one finished piece (BUG-10)', async () => {
    const s = await setup();
    const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    const issue = await orders.createKarigarIssue(s.ctx, { karigarId: s.karigar.id, orderItemIds: [order.items[0]!.id], goldFine: 10, silverFine: 0, cash: 0, online: 0 } as any);
    const recv = () => orders.receiveKarigar(s.ctx, issue.id, { items: [{ orderItemId: order.items[0]!.id, returnedGross: 9.5, returnedLess: 0, touch: 100, ghatAllowance: 0.3, labour: 800 }] } as any);
    const results = await Promise.allSettled([recv(), recv()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as any).status === 409)).toHaveLength(1);
    expect(await db.stockItem.count({ where: { source: 'ORDER_RECEIVE', sourceId: String(order.id) } })).toBe(1); // no duplicate piece
  });

  it('two concurrent issues of the same item → one wins, one 409 (BUG-10)', async () => {
    const s = await setup();
    const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    const issue = () => orders.createKarigarIssue(s.ctx, { karigarId: s.karigar.id, orderItemIds: [order.items[0]!.id], goldFine: 1, silverFine: 0, cash: 0, online: 0 } as any);
    const results = await Promise.allSettled([issue(), issue()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as any).status === 409)).toHaveLength(1);
  });

  it('a non-karigar party cannot be issued to (400)', async () => {
    const s = await setup();
    const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    await expect(orders.createKarigarIssue(s.ctx, { karigarId: s.customer.id, orderItemIds: [order.items[0]!.id], goldFine: 1, silverFine: 0, cash: 0, online: 0 } as any)).rejects.toMatchObject({ status: 400 });
  });
});
