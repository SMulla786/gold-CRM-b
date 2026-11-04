import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { billBody } from '../../../shared';
import * as inv from '../inventory';
import * as billing from './service';
import type { TenantContext } from '../../../middleware/context';

/** G7 D-d: an order is billed whole, and deleting its bill (with stock) re-opens it — READY, pieces RESERVED — so it can be billed again. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/** A READY order with two finished (RESERVED) pieces. */
async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  const ctx = ctxFor(business.id, root.id);
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const itemName = (await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 }))!;
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const other = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Other', mobile: '9000000002', countryCode: '+91' } });
  const order = await db.order.create({ data: { businessId: business.id, branchId: root.id, orderNo: 1, partyId: party.id, orderDate: new Date(), status: 'READY' } });
  const pieces: number[] = [];
  for (const tagNo of ['OR0001', 'OR0002']) {
    const p = await db.stockItem.create({ data: { businessId: business.id, branchId: root.id, stockClass: 'GOLD', groupId: group!.id, itemNameId: itemName.id, method: 'TAG', tagNo, karatCode: '22K', pcs: 1, gross: 10, less: 0, net: 10, tunch: 91.67, wastage: 0, fine: 9.167, status: 'RESERVED', source: 'ORDER_RECEIVE', sourceId: String(order.id), createdById: 1 } });
    await db.orderItem.create({ data: { orderId: order.id, itemNameId: itemName.id, metal: 'GOLD', touch: 91.67, gross: 10, net: 10, fine: 9.167, status: 'RECEIVED', stockItemId: p.id } });
    pieces.push(p.id);
  }
  const body = (ids = pieces, partyId = party.id) => billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId, orderId: order.id, items: ids.map((stockItemId) => ({ stockItemId, gross: 10, rate: 60000 })) });
  return { ctx, order, pieces, party, other, body };
}
/** [order status, order billId, item statuses, piece statuses] */
const state = async (orderId: number, pieces: number[]) => {
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: { orderBy: { id: 'asc' } } } });
  const st = await db.stockItem.findMany({ where: { id: { in: pieces } }, orderBy: { id: 'asc' } });
  return [o.status, o.billId, o.items.map((i) => i.status), st.map((p) => p.status)];
};

describe('order → bill lifecycle', () => {
  it('a bill by orderId must carry every finished piece of the order (409, nothing changes); with all of them it delivers', async () => {
    const s = await setup();
    await expect(billing.createBill(s.ctx, s.body([s.pieces[0]!]))).rejects.toMatchObject({ status: 409 });
    expect(await state(s.order.id, s.pieces)).toEqual(['READY', null, ['RECEIVED', 'RECEIVED'], ['RESERVED', 'RESERVED']]);
    const bill = await billing.createBill(s.ctx, s.body());
    expect(await state(s.order.id, s.pieces)).toEqual(['DELIVERED', bill.id, ['DELIVERED', 'DELIVERED'], ['SOLD', 'SOLD']]);
  });

  it('deleting the bill with its stock re-opens the order (READY, no bill, pieces RESERVED) and it can be billed again', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, s.body());
    await billing.deleteBill(s.ctx, bill.id, true);
    expect(await state(s.order.id, s.pieces)).toEqual(['READY', null, ['RECEIVED', 'RECEIVED'], ['RESERVED', 'RESERVED']]);
    const again = await billing.createBill(s.ctx, s.body());
    expect(await state(s.order.id, s.pieces)).toEqual(['DELIVERED', again.id, ['DELIVERED', 'DELIVERED'], ['SOLD', 'SOLD']]);
  });

  it('deleting it without the stock → 409 (the order could never be billed again); nothing changes', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, s.body());
    await expect(billing.deleteBill(s.ctx, bill.id, false)).rejects.toMatchObject({ status: 409 });
    expect((await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe('ACTIVE');
    expect(await state(s.order.id, s.pieces)).toEqual(['DELIVERED', bill.id, ['DELIVERED', 'DELIVERED'], ['SOLD', 'SOLD']]);
  });

  it('editing the bill keeps the order DELIVERED on the same bill; dropping a piece or changing the party → 409', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, s.body());
    await expect(billing.editBill(s.ctx, bill.id, s.body([s.pieces[0]!]))).rejects.toMatchObject({ status: 409 });
    await expect(billing.editBill(s.ctx, bill.id, s.body(s.pieces, s.other.id))).rejects.toMatchObject({ status: 409 });
    expect(Number((await billing.editBill(s.ctx, bill.id, { ...s.body(), items: s.body().items.map((l) => ({ ...l, rate: 61000 })) })).final)).toBe(122000);
    expect(await state(s.order.id, s.pieces)).toEqual(['DELIVERED', bill.id, ['DELIVERED', 'DELIVERED'], ['SOLD', 'SOLD']]);
  });
});

/** Resolves once `n` other connections of this DB are waiting on a row lock. */
async function lockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ w } = { w: 0 }] = await db.$queryRaw<{ w: number }[]>`SELECT count(*)::int AS w FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (w >= n) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`never ${n} connections blocked on the bill row`);
}

describe('G7 owner rule: deleting an order bill returns its stock atomically and exactly once', () => {
  it('race: two deletes queued on the bill row → one returns the stock, the other 409; a repeat changes nothing', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, s.body());
    const sold = await db.ledgerEntry.findMany({ where: { source: 'SELL_BILL', sourceId: String(bill.id), stockItemId: { not: null }, reversalOfId: null }, select: { id: true } });
    expect(sold).toHaveLength(2);

    let locked!: () => void;
    let release!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const held = new Promise<void>((r) => (release = r));
    const hold = db.$transaction(async (t) => {
      await t.$queryRaw`SELECT id FROM "Bill" WHERE id = ${bill.id} FOR UPDATE`;
      locked();
      await held;
    }, { timeout: 20_000 });
    await isLocked;
    const del = () => billing.deleteBill(s.ctx, bill.id, true).then(() => 'deleted', (e: unknown) => e);
    const both = Promise.all([del(), del()]);
    await lockWaiters(2); // both deletes wait to flip the bill
    release();
    await hold;
    const results = await both;

    expect(results.filter((r) => r === 'deleted')).toHaveLength(1);
    expect(results.find((r) => r !== 'deleted')).toMatchObject({ status: 409 });
    const once = async () => [
      await state(s.order.id, s.pieces),
      await db.ledgerEntry.count({ where: { reversalOfId: { in: sold.map((r) => r.id) } } }),
      await db.activityLog.count({ where: { entity: 'BILL', entityId: String(bill.id), action: 'DELETED' } }),
    ];
    expect(await once()).toEqual([['READY', null, ['RECEIVED', 'RECEIVED'], ['RESERVED', 'RESERVED']], 2, 1]);

    await expect(billing.deleteBill(s.ctx, bill.id, true)).rejects.toMatchObject({ status: 409 });
    expect(await once()).toEqual([['READY', null, ['RECEIVED', 'RECEIVED'], ['RESERVED', 'RESERVED']], 2, 1]);
  });
});
