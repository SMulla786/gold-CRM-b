import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBranch, createBusiness, createPlan, createSubscription, createUser, TEST_MPIN } from '../helpers/factory';

// Verifies TASK-16 Phase 2 inventory routes. (MODULE_DISABLED is covered by tenancy T-c4, not duplicated here.)

const H = (token: string, branchId?: number) => {
  const h: Record<string, string> = { Authorization: bearer(token) };
  if (branchId) h['X-Branch-Id'] = String(branchId);
  return h;
};

async function inventoryBusiness(name: string) {
  const plan = await createPlan({ modules: ['inventory'] });
  const { business, root } = await createBusiness({ name });
  await createSubscription({ businessId: business.id, planId: plan.id, modules: ['inventory'] });
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true, mpin: TEST_MPIN });
  const { token } = await loginAs(owner.username);
  return { plan, business, root, owner, token: token! };
}

/** Grants a branch user the inventory permissions (test DB has no seeded catalog). */
async function grantInventory(userId: number) {
  for (const key of ['inventory.all_stock', 'inventory.new_stock', 'inventory.item_masters']) {
    const perm = await db.permission.upsert({
      where: { key },
      update: {},
      create: { key, module: 'inventory', label: key, sort: 0, isModule: false, hasActions: true },
    });
    await db.userPermission.create({ data: { userId, permissionId: perm.id, canView: true, canEdit: true, canDelete: true } });
  }
}

/** Creates a GOLD group + a BOTH item-name (LOOSE & TAG), returns the item-name id. */
async function goldItemName(token: string, branchId: number, tagPrefix = 'GR') {
  const g = await api.post('/api/app/item-groups').set(H(token, branchId)).send({ stockClass: 'GOLD', names: ['Rings'] });
  expect(g.status, `create group: ${JSON.stringify(g.body)}`).toBeLessThan(300);
  const groups = await api.get('/api/app/item-groups?stockClass=GOLD').set(H(token, branchId));
  const groupId = groups.body.items[0].id;
  const n = await api
    .post('/api/app/item-names')
    .set(H(token, branchId))
    .send({ groupId, name: 'Gold Ring', method: 'BOTH', tagPrefix, tagDigits: 4 });
  expect(n.status, `create item-name: ${JSON.stringify(n.body)}`).toBeLessThan(300);
  const names = await api.get(`/api/app/item-names?groupId=${groupId}`).set(H(token, branchId));
  return names.body.items[0].id as number;
}

function addStock(token: string, branchId: number, itemNameId: number, method: 'LOOSE' | 'TAG' = 'LOOSE') {
  return api
    .post('/api/app/stock/entries')
    .set(H(token, branchId))
    .send({ stockClass: 'GOLD', method, branchId, rows: [{ itemNameId, gross: 10, tunch: 91.67, pcs: 1 }] });
}

beforeEach(truncateAll);

describe('Phase 2 inventory routes', () => {
  it('cross-business: admin of B cannot read business A stock by id -> 404', async () => {
    const a = await inventoryBusiness('InvA');
    const stock = await addStock(a.token, a.root.id, await goldItemName(a.token, a.root.id));
    const stockId = stock.body.items[0].id;
    const b = await inventoryBusiness('InvB');
    const res = await api.get(`/api/app/stock/${stockId}`).set(H(b.token, b.root.id));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('cross-branch: a branch user cannot read a sibling branch\'s stock by id -> 404', async () => {
    const a = await inventoryBusiness('InvSibling');
    const pune = await createBranch({ businessId: a.business.id, parentId: a.root.id, name: 'Pune', isAdminNode: true });
    const kothrud = await createBranch({ businessId: a.business.id, parentId: pune.id, name: 'Kothrud' });
    const mumbai = await createBranch({ businessId: a.business.id, parentId: a.root.id, name: 'Mumbai' });
    const stock = await addStock(a.token, mumbai.id, await goldItemName(a.token, mumbai.id));
    const stockId = stock.body.items[0].id;

    const cashier = await createUser({ businessId: a.business.id, branchId: kothrud.id, level: 'BRANCH_USER' });
    await grantInventory(cashier.user.id);
    const { token } = await loginAs(cashier.username);
    const res = await api.get(`/api/app/stock/${stockId}`).set(H(token!));
    expect(res.status).toBe(404);
  });

  it('tag auto-number stays unique under 10 parallel TAG entries', async () => {
    const a = await inventoryBusiness('TagRace');
    const itemNameId = await goldItemName(a.token, a.root.id, 'GR');
    const results = await Promise.all(Array.from({ length: 10 }, () => addStock(a.token, a.root.id, itemNameId, 'TAG')));
    const tags = results.flatMap((r) => {
      expect(r.status, `entry failed: ${JSON.stringify(r.body)}`).toBeLessThan(300);
      return (r.body.items as { tagNo: string }[]).map((i) => i.tagNo);
    });
    expect(tags).toHaveLength(10);
    expect(new Set(tags).size).toBe(10); // all distinct — FOR UPDATE lock held
  });

  it('delete requires X-MPIN', async () => {
    const a = await inventoryBusiness('DelMpin');
    const stock = await addStock(a.token, a.root.id, await goldItemName(a.token, a.root.id));
    const stockId = stock.body.items[0].id;

    const noMpin = await api.delete(`/api/app/stock/${stockId}`).set(H(a.token, a.root.id));
    expect(noMpin.status).toBe(403);
    expect(noMpin.body.error.code).toBe('MPIN_REQUIRED');

    const withMpin = await api.delete(`/api/app/stock/${stockId}`).set({ ...H(a.token, a.root.id), 'X-MPIN': TEST_MPIN });
    expect([200, 204]).toContain(withMpin.status);
    const row = await db.stockItem.findUnique({ where: { id: stockId } });
    expect(row?.status).toBe('DELETED');
  });
});
