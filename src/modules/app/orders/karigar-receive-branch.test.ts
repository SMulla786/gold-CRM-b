/* eslint-disable @typescript-eslint/no-explicit-any -- service inputs are zod-parsed upstream; tests pass partial bodies */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../../test/helpers/factory';
import { openingBalanceBody } from '../../../shared';
import * as inv from '../inventory';
import { createOpeningBalances } from '../opening';
import * as orders from './service';
import type { TenantContext } from '../../../middleware/context';

/**
 * Owner decision 2026-11-09: a karigar receive posts to the acting user's branch (X-Branch-Id → activeBranch(ctx)), not to the
 * issue's own branch — the finished piece, its ORDER_RECEIVE stock row and the karigar's party row land there, and the issue's
 * order still turns READY. With 'all' (no one branch picked) the receive is refused (400) and nothing is written.
 */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const shop = await createBranch({ businessId: business.id, parentId: root.id, name: 'Station Road' });
  const ctxOn = (active: number | null): TenantContext => ({
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id, shop.id], activeBranchId: active,
    readOnly: false, modules: ['orders', 'billing', 'inventory'], limits: null, permissions: {}, impersonatorId: null,
  });
  const shopCtx = ctxOn(shop.id);
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  const [group] = await inv.createItemGroups(shopCtx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const ring = (await inv.createItemName(shopCtx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 }))!;
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const karigar = await db.party.create({ data: { businessId: business.id, type: 'KARIGAR', name: 'Kari', mobile: '9000000004', countryCode: '+91' } });
  await createOpeningBalances(shopCtx, openingBalanceBody.parse({ entries: [{ kind: 'METAL', metal: 'GOLD', metalForm: 'BULLION', fine: 10 }] }));
  const order = await orders.createOrder(shopCtx, { partyId: party.id, rateType: 'ON_DELIVERY', isUrgent: false, items: [{ itemNameId: ring.id, metal: 'GOLD', karatCode: '22K', gross: 10, making: 0, makingUnit: 'PER_GRAM', pcs: 1 }], payments: [] } as any);
  const issue = await orders.createKarigarIssue(shopCtx, { karigarId: karigar.id, orderItemIds: [order.items[0]!.id], goldFine: 9, silverFine: 0, cash: 0, online: 0 } as any); // 9 g bullion out of the shop
  const receive = (ctx: TenantContext) => orders.receiveKarigar(ctx, issue.id, { items: [{ orderItemId: order.items[0]!.id, returnedGross: 10, returnedLess: 0, ghatAllowance: 0.2, labour: 500, tagNo: 'K0001' }] });
  return { root, ctxOn, order, receive };
}

/** Where each row of the receive landed: the piece, its ORDER_RECEIVE stock row, the karigar's ORDER_RECEIVE party row. */
async function landing(orderId: number) {
  const pieces = await db.stockItem.findMany({ where: { source: 'ORDER_RECEIVE', sourceId: String(orderId) } });
  const stockRows = await db.ledgerEntry.findMany({ where: { source: 'ORDER_RECEIVE', sourceId: String(orderId) } });
  const partyRows = await db.udharEntry.findMany({ where: { source: 'ORDER_RECEIVE' } });
  return { pieces: pieces.map((r) => r.branchId), stockRows: stockRows.map((r) => r.branchId), partyRows: partyRows.map((r) => r.branchId) };
}
const orderState = async (id: number) => {
  const o = await db.order.findUniqueOrThrow({ where: { id }, include: { items: true } });
  return [o.status, o.items.map((i) => i.status)];
};

describe("owner decision 2026-11-09: posts to the acting user's branch", () => {
  it("received with X-Branch-Id of another branch (the root): the piece, its stock row and the karigar's party row land in the root; the order turns READY", async () => {
    const s = await setup();
    await s.receive(s.ctxOn(s.root.id));
    expect(await landing(s.order.id)).toEqual({ pieces: [s.root.id], stockRows: [s.root.id], partyRows: [s.root.id] });
    expect(await orderState(s.order.id)).toEqual(['READY', ['RECEIVED']]);
  });

  it("received with X-Branch-Id 'all': 400 (pick one branch), nothing written, the order unchanged", async () => {
    const s = await setup();
    const before = await orderState(s.order.id);
    await expect(s.receive(s.ctxOn(null))).rejects.toMatchObject({ status: 400 });
    expect(await landing(s.order.id)).toEqual({ pieces: [], stockRows: [], partyRows: [] });
    expect(await orderState(s.order.id)).toEqual(before);
  });
});
