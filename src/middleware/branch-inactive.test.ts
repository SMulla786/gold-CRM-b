/* eslint-disable @typescript-eslint/no-explicit-any -- service inputs are zod-parsed upstream; tests pass partial bodies */
import { beforeEach, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../../test/helpers/app';
import { db, truncateAll } from '../../test/helpers/db';
import { createBranch, createBusiness, createPlan, createSubscription, createUser, TEST_MPIN } from '../../test/helpers/factory';
import * as inv from '../modules/app/inventory';
import type { TenantContext } from './context';

/** G7 item 3: Branch.isActive = false → no new write lands on it (403 BRANCH_INACTIVE), whether the branch comes from X-Branch-Id,
 *  the user's own branch, the request body, or the document being written to. Reads and reports stay open; Settings → Branches can reactivate. */

beforeEach(truncateAll);
const MODS = ['udhari', 'inventory', 'settings'];
const INACTIVE = { code: 'BRANCH_INACTIVE', message: expect.stringMatching(/"Station Road" is inactive\. Reactivate it in Settings → Branches/) };

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

it('X-Branch-Id of an inactive branch: writes 403, nothing saved; its history still reads; reactivating in Settings → Branches opens it again', async () => {
  const s = await setup();
  const udhar = () => api.post('/api/app/udhar').set(s.h(s.shop.id)).send({ partyId: s.party.id, cashOut: 500 });
  expect((await udhar()).status).toBe(201);
  await s.off();

  const r = await udhar();
  expect([r.status, r.body.error]).toEqual([403, expect.objectContaining(INACTIVE)]);
  expect(await db.udharTxn.count()).toBe(1);
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

  const into = await api.post('/api/app/stock/entries').set(s.h(s.root.id)).send(entry({ branchId: s.shop.id }));
  expect([into.status, into.body.error]).toEqual([403, expect.objectContaining(INACTIVE)]);
  const to = await api.post('/api/app/stock/transfers').set(s.h(s.root.id)).send({ fromBranchId: s.root.id, toBranchId: s.shop.id, stockItemIds: [item.id] });
  expect([to.status, to.body.error]).toEqual([403, expect.objectContaining(INACTIVE)]);
  expect([await db.stockItem.count(), (await db.stockItem.findUniqueOrThrow({ where: { id: item.id } })).branchId, await db.stockTransfer.count()]).toEqual([1, s.root.id, 0]);

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

  const own = await api.post('/api/app/udhar').set({ Authorization: bearer(clerkToken) }).send({ partyId: s.party.id, cashOut: 100 });
  expect([own.status, own.body.error]).toEqual([403, expect.objectContaining(INACTIVE)]);

  for (const via of ['all', s.root.id] as const) {
    const del = await api.delete(`/api/app/udhar/${created.body.id}`).set(s.h(via));
    expect([via, del.status, del.body.error]).toEqual([via, 403, expect.objectContaining(INACTIVE)]);
  }
  expect([await db.udharTxn.count({ where: { isDeleted: false } }), await db.ledgerEntry.count({ where: { reversalOfId: { not: null } } })]).toEqual([1, 0]);
});
