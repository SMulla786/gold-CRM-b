/* eslint-disable @typescript-eslint/no-explicit-any -- service inputs are zod-parsed upstream; tests pass partial bodies */
import { beforeEach, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../../test/helpers/app';
import { db, truncateAll } from '../../test/helpers/db';
import { createBranch, createBusiness, createPlan, createSubscription, createUser, TEST_MPIN } from '../../test/helpers/factory';
import { girviBody } from '../shared';
import * as girvi from '../modules/app/girvi/service';
import * as inv from '../modules/app/inventory';
import type { TenantContext } from './context';

/** G7 item 3: Branch.isActive = false → no new write lands on it (403 BRANCH_INACTIVE), whether the branch comes from X-Branch-Id,
 *  the user's own branch, the request body, or the document being written to (ledger postings, and the writes that post nothing). Reads and reports stay open; Admin → Branches can reactivate. */

beforeEach(truncateAll);
const MODS = ['udhari', 'inventory', 'settings'];
const INACTIVE = { code: 'BRANCH_INACTIVE', message: expect.stringMatching(/"Station Road" is inactive\. Reactivate it in Admin → Branches/) };

async function setup() {
  const plan = await createPlan({ modules: MODS });
  const { business, root } = await createBusiness();
  await createSubscription({ businessId: business.id, planId: plan.id, modules: MODS });
  const shop = await createBranch({ businessId: business.id, parentId: root.id, name: 'Station Road' });
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true, mpin: TEST_MPIN });
  const { token } = await loginAs(owner.username);
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const h = (branch: number | 'all') => ({ Authorization: bearer(token!), 'X-Branch-Id': String(branch), 'X-MPIN': TEST_MPIN });
  const off = () => db.branch.update({ where: { id: shop.id }, data: { isActive: false } });
  return { business, root, shop, party, h, off };
}

/** md5 of every table's rows (G7 closure): a refused write must leave the whole database as it was — no ledger, udhar, payment,
 *  stock, transfer, girvi, scheme, kacha or activity row added, changed or removed, anywhere. */
async function contents(): Promise<Record<string, string>> {
  const tables = await db.$queryRaw<{ t: string }[]>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'`;
  const sql = tables.map(({ t }) => `SELECT '${t}' AS t, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`).join(' UNION ALL ');
  return Object.fromEntries((await db.$queryRawUnsafe<{ t: string; h: string }[]>(sql)).map((r) => [r.t, r.h]));
}

it('X-Branch-Id of an inactive branch: writes 403, nothing saved; its history still reads; reactivating in Admin → Branches opens it again', async () => {
  const s = await setup();
  const udhar = () => api.post('/api/app/udhar').set(s.h(s.shop.id)).send({ partyId: s.party.id, cashOut: 500 });
  expect((await udhar()).status).toBe(201);
  await s.off();

  const before = await contents();
  const r = await udhar();
  expect([r.status, r.body.error]).toEqual([403, expect.objectContaining(INACTIVE)]);
  expect(await db.udharTxn.count()).toBe(1);
  expect(await contents()).toEqual(before);
  const read = await api.get('/api/app/udhar/entries').set(s.h(s.shop.id));
  expect([read.status, read.body.total]).toEqual([200, 1]);

  // the branch picker still sends the inactive branch: the admin route must not be blocked by it
  expect((await api.patch(`/api/admin/branches/${s.shop.id}`).set(s.h(s.shop.id)).send({ isActive: true })).status).toBe(200);
  expect((await udhar()).status).toBe(201);
});

it('a branch id in the body: stock entry into, or transfer to, an inactive branch → 403, nothing moved; another business\'s branch never answers BRANCH_INACTIVE', async () => {
  const s = await setup();
  const ctx = { userId: 1, level: 'ADMIN', isOwner: true, businessId: s.business.id, scopeBranchId: s.root.id, branchIds: [s.root.id, s.shop.id], activeBranchId: s.root.id, readOnly: false, modules: MODS, limits: null, permissions: {}, impersonatorId: null } as TenantContext;
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'SILVER', names: ['Payal'], gstRate: 3 } as any);
  const itemName = (await inv.createItemName(ctx, { groupId: group!.id, name: 'Payal', method: 'TAG', tagPrefix: 'PY', tagDigits: 4 } as any))!;
  const entry = (over: object) => ({ stockClass: 'SILVER', method: 'TAG', rows: [{ itemNameId: itemName.id, gross: 50 }], ...over });
  const made = await api.post('/api/app/stock/entries').set(s.h(s.root.id)).send(entry({}));
  expect(made.status).toBe(201);
  const item = await db.stockItem.findFirstOrThrow();
  await s.off();

  const before = await contents();
  const into = await api.post('/api/app/stock/entries').set(s.h(s.root.id)).send(entry({ branchId: s.shop.id }));
  expect([into.status, into.body.error]).toEqual([403, expect.objectContaining(INACTIVE)]);
  const to = await api.post('/api/app/stock/transfers').set(s.h(s.root.id)).send({ fromBranchId: s.root.id, toBranchId: s.shop.id, stockItemIds: [item.id] });
  expect([to.status, to.body.error]).toEqual([403, expect.objectContaining(INACTIVE)]);
  expect([await db.stockItem.count(), (await db.stockItem.findUniqueOrThrow({ where: { id: item.id } })).branchId, await db.stockTransfer.count()]).toEqual([1, s.root.id, 0]);
  expect(await contents()).toEqual(before);

  const other = await createBusiness({ name: 'Other' });
  await db.branch.update({ where: { id: other.root.id }, data: { isActive: false } });
  const foreign = await api.post('/api/app/stock/transfers').set(s.h(s.root.id)).send({ fromBranchId: s.root.id, toBranchId: other.root.id, stockItemIds: [item.id] });
  expect(foreign.body.error?.code).not.toBe('BRANCH_INACTIVE');
});

it("a branch user whose own branch is inactive cannot write; a write onto an existing document of an inactive branch (via 'all' or another branch) → 403 too", async () => {
  const s = await setup();
  const created = await api.post('/api/app/udhar').set(s.h(s.shop.id)).send({ partyId: s.party.id, cashOut: 500 });
  expect(created.status).toBe(201);
  const clerk = await createUser({ businessId: s.business.id, branchId: s.shop.id, level: 'BRANCH_USER' });
  const clerkToken = (await loginAs(clerk.username)).token!;
  await s.off();

  const before = await contents();
  const own = await api.post('/api/app/udhar').set({ Authorization: bearer(clerkToken) }).send({ partyId: s.party.id, cashOut: 100 });
  expect([own.status, own.body.error]).toEqual([403, expect.objectContaining(INACTIVE)]);

  for (const via of ['all', s.root.id] as const) {
    const del = await api.delete(`/api/app/udhar/${created.body.id}`).set(s.h(via));
    expect([via, del.status, del.body.error]).toEqual([via, 403, expect.objectContaining(INACTIVE)]);
  }
  expect([await db.udharTxn.count({ where: { isDeleted: false } }), await db.ledgerEntry.count({ where: { reversalOfId: { not: null } } })]).toEqual([1, 0]);
  expect(await contents()).toEqual(before);
});

it("writes on an existing document that post nothing to the ledger (order, repair, stock, draft, sample, girvi item, bhav) → 403 via 'all' or another branch; fine once reactivated", async () => {
  const s = await setup();
  const all = ['dashboard', 'billing', 'orders', 'inventory', 'udhari', 'girvi', 'schemes', 'repair', 'exchange', 'buy_sell', 'income_expense', 'daybook', 'stock_summary', 'settings'];
  await db.subscription.updateMany({ where: { businessId: s.business.id }, data: { modules: all } });
  const B = { businessId: s.business.id, branchId: s.shop.id };
  const shopCtx = { userId: 1, level: 'ADMIN', isOwner: true, businessId: s.business.id, scopeBranchId: s.root.id, branchIds: [s.root.id, s.shop.id], activeBranchId: s.shop.id, readOnly: false, modules: all, limits: null, permissions: {}, impersonatorId: null } as TenantContext;
  const [group] = await inv.createItemGroups(shopCtx, { stockClass: 'SILVER', names: ['Payal'], gstRate: 3 } as any);
  const itemName = (await inv.createItemName(shopCtx, { groupId: group!.id, name: 'Payal', method: 'TAG', tagPrefix: 'PY', tagDigits: 4 } as any))!;
  const order = await db.order.create({ data: { ...B, orderNo: 1, partyId: s.party.id, orderDate: new Date(), status: 'PENDING' } });
  const ticket = await db.repairTicket.create({ data: { ...B, ticketNo: 1, partyId: s.party.id, metal: 'GOLD', category: 'Ring', description: 'Resize', gross: 5, expectedDate: new Date() } });
  const consumable = await db.repairConsumable.create({ data: { ...B, name: 'Solder' } });
  const stock = await db.stockItem.create({ data: { ...B, stockClass: 'SILVER', groupId: group!.id, itemNameId: itemName.id, method: 'TAG', tagNo: 'PY0001', pcs: 1, gross: 50, less: 0, net: 50, tunch: 100, wastage: 0, fine: 50, status: 'AVAILABLE', source: 'MANUAL', sourceId: 'x', createdById: 1 } });
  const draft = await db.salesDraft.create({ data: { ...B, draftNo: 1, createdById: 1, customerName: 'Walk-in', estTotal: 1000, expiresAt: new Date(Date.now() + 864e5) } });
  const sample = await db.sample.create({ data: { ...B, sampleNo: 1, metal: 'GOLD', grossWt: 5, tounchPercent: 91.6, fine: 4.58 } });
  const loan = await girvi.createGirvi(shopCtx, girviBody.parse({
    partyId: s.party.id, issueDate: new Date(), items: [{ category: 'Gold', name: 'Chain', gross: 12, net: 10, purity: 91.67, rate: 6000 }],
    principal: 10000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', tenureMonths: 6, cash: 10000, online: 0,
  }));
  const bhav = await db.bhavBooking.create({ data: { ...B, bookingNo: 1, side: 'BUY', partyId: s.party.id, metal: 'GOLD', txnDate: new Date(), weight: 10, rate: 60000, amount: 600000, pendingWeight: 10 } });
  const writes: Array<[string, 'post' | 'patch' | 'delete', string, object?, 'all'?]> = [
    ['order design', 'delete', `/api/app/orders/${order.id}/design`],
    ['order cancel', 'post', `/api/app/orders/${order.id}/cancel`],
    ['repair status', 'post', `/api/app/repairs/${ticket.id}/status`, { status: 'IN_PROGRESS' }],
    ['repair consumable', 'post', `/api/app/repair/consumables/${consumable.id}/adjust`, { delta: 2 }, 'all'], // scoped to the selected branch: from another one it is a 404
    ['stock remark', 'patch', `/api/app/stock/${stock.id}`, { remarks: 'polished' }],
    ['stock photo', 'delete', `/api/app/stock/${stock.id}/photo`],
    ['draft cancel', 'post', `/api/app/drafts/${draft.id}/cancel`],
    ['sample edit', 'patch', `/api/app/samples/${sample.id}`, { note: 'checked' }],
    ['sample melt', 'post', `/api/app/samples/${sample.id}/melt`, {}],
    ['girvi item replace', 'patch', `/api/app/girvi/${loan.id}/items/${loan.items[0]!.id}`, { category: 'Gold', name: 'Chain', gross: 12, net: 9, purity: 91.67, rate: 6000, remark: 'revalued' }],
    ['bhav verify', 'post', `/api/app/bhav-booking/${bhav.id}/verify`],
    ['girvi top-up (posts to the ledger)', 'post', `/api/app/girvi/${loan.id}/topup`, { principal: 1000, cash: 1000, online: 0 }],
  ];
  const send = (w: (typeof writes)[number], via: number | 'all') => api[w[1]](w[2]).set(s.h(via)).send(w[3] ?? {});
  await s.off();
  const before = await contents();
  for (const w of writes) {
    for (const via of w[4] ? (['all'] as const) : (['all', s.root.id] as const)) {
      const r = await send(w, via);
      expect([w[0], via, r.status, r.body.error]).toEqual([w[0], via, 403, expect.objectContaining(INACTIVE)]);
    }
  }
  expect([(await db.order.findUniqueOrThrow({ where: { id: order.id } })).status, (await db.stockItem.findUniqueOrThrow({ where: { id: stock.id } })).remarks]).toEqual(['PENDING', null]);
  expect(await contents()).toEqual(before);

  await db.branch.update({ where: { id: s.shop.id }, data: { isActive: true } });
  for (const w of writes) expect([w[0], (await send(w, 'all')).status < 300]).toEqual([w[0], true]); // each row is a real, valid write
});
