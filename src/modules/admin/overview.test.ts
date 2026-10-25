import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBranch, createBusiness, createUser } from '../../../test/helpers/factory';
import { adminOverview } from './overview';
import type { TenantContext } from '../../middleware/context';

// TASK-88: GET /api/admin/overview — per-branch + business aggregation over the caller's accessible subtree.

const ctx = (over: Partial<TenantContext> & { businessId: number; branchIds: number[]; scopeBranchId: number; userId: number }): TenantContext => ({
  level: 'ADMIN',
  isOwner: false,
  activeBranchId: null,
  readOnly: false,
  modules: [],
  limits: { maxBranches: 100, maxUsers: 100 },
  permissions: {},
  impersonatorId: null,
  ...over,
});

let seq = 0;
async function addStock(businessId: number, branchId: number, stockClass: 'GOLD' | 'SILVER', fine: number, cost: number) {
  seq++;
  const group = await db.itemGroup.create({ data: { businessId, stockClass, name: `G${seq}` } });
  const itemName = await db.itemName.create({ data: { businessId, groupId: group.id, name: `N${seq}` } });
  await db.stockItem.create({ data: { businessId, branchId, stockClass, groupId: group.id, itemNameId: itemName.id, method: 'LOOSE', net: fine, fine, purchaseCost: cost, status: 'AVAILABLE', source: 'STOCK_INSERT' } });
}
async function addUdhar(businessId: number, branchId: number, partyId: number, amount: number, gold = 0, silver = 0) {
  seq++;
  await db.udharEntry.create({ data: { businessId, branchId, partyId, txnDate: new Date(), amount, gold, silver, source: 'UDHAR', sourceId: `u${seq}` } });
}

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const pune = await createBranch({ businessId: business.id, parentId: root.id, name: 'Pune', isAdminNode: true });
  const mumbai = await createBranch({ businessId: business.id, parentId: root.id, name: 'Mumbai' });
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
  await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN' }); // 2nd root user
  const puneAdmin = await createUser({ businessId: business.id, branchId: pune.id, level: 'ADMIN' });
  await createUser({ businessId: business.id, branchId: pune.id, level: 'BRANCH_USER' }); // 2nd pune user
  const all = [root.id, pune.id, mumbai.id];
  return {
    business,
    root,
    pune,
    mumbai,
    ownerCtx: ctx({ businessId: business.id, branchIds: all, scopeBranchId: root.id, userId: owner.user.id, isOwner: true }),
    puneCtx: ctx({ businessId: business.id, branchIds: [pune.id], scopeBranchId: pune.id, userId: puneAdmin.user.id }),
  };
}

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

describe('adminOverview', () => {
  it('aggregates stock / udhari / users per branch across the whole subtree', async () => {
    const s = await setup();
    await addStock(s.business.id, s.pune.id, 'GOLD', 10, 1000);
    await addStock(s.business.id, s.pune.id, 'SILVER', 500, 2000);
    await addStock(s.business.id, s.mumbai.id, 'GOLD', 5, 800);
    await addUdhar(s.business.id, s.pune.id, 101, 600);
    await addUdhar(s.business.id, s.mumbai.id, 101, 400);

    const o = await adminOverview(s.ownerCtx);

    expect(o.branches).toHaveLength(3);
    expect(o.branches[0]!.branch.id).toBe(s.root.id); // path order → root first
    expect(new Set(o.branches.map((b) => b.branch.id))).toEqual(new Set([s.root.id, s.pune.id, s.mumbai.id]));

    const pune = o.branches.find((b) => b.branch.id === s.pune.id)!;
    expect(pune.stock).toMatchObject({ goldFine: '10.000', silverFine: '500.000', items: 2, value: '3000.00' });
    expect(pune.udhariReceivable.amount).toBe('600.00');
    expect(pune.userCount).toBe(2);

    const mumbai = o.branches.find((b) => b.branch.id === s.mumbai.id)!;
    expect(mumbai.stock).toMatchObject({ goldFine: '5.000', silverFine: '0.000', items: 1, value: '800.00' });
    expect(mumbai.userCount).toBe(0);

    expect(o.totals.stock).toMatchObject({ goldFine: '15.000', silverFine: '500.000', items: 3, value: '3800.00' });
    expect(o.totals.userCount).toBe(4);
    expect(o.totals.udhariReceivable.amount).toBe('1000.00'); // party 101 net +1000
    expect(o.rates.branchId).toBeNull(); // business-level rates
  });

  it('a branch-admin sees only its own subtree', async () => {
    const s = await setup();
    await addUdhar(s.business.id, s.mumbai.id, 101, 400); // not visible to pune admin

    const o = await adminOverview(s.puneCtx);

    expect(o.branches).toHaveLength(1);
    expect(o.branches[0]!.branch.id).toBe(s.pune.id);
  });

  it('excludes another tenant', async () => {
    const s = await setup();
    await addUdhar(s.business.id, s.pune.id, 101, 600);
    const b = await createBusiness({ name: 'B' });
    await addUdhar(b.business.id, b.root.id, 777, 9999);

    const o = await adminOverview(s.ownerCtx);

    expect(o.branches.map((br) => br.branch.id)).not.toContain(b.root.id);
    expect(o.totals.udhariReceivable.amount).toBe('600.00'); // B's 9999 excluded
  });

  it('totals.udhariReceivable is the positive-only business figure, NOT the sum of signed per-branch rows', async () => {
    const s = await setup();
    // party 101 net +1000 (positive); party 102 net -500 (negative, excluded from receivable)
    await addUdhar(s.business.id, s.pune.id, 101, 600);
    await addUdhar(s.business.id, s.mumbai.id, 101, 400);
    await addUdhar(s.business.id, s.pune.id, 102, 200);
    await addUdhar(s.business.id, s.mumbai.id, 102, -700);

    const o = await adminOverview(s.ownerCtx);

    const sumRows = o.branches.reduce((a, r) => a + Number(r.udhariReceivable.amount), 0);
    expect(sumRows).toBe(500); // pune 800 + mumbai -300 + root 0 (signed attribution)
    expect(o.totals.udhariReceivable.amount).toBe('1000.00'); // only party 101's positive balance
    expect(Number(o.totals.udhariReceivable.amount)).not.toBe(sumRows);
  });
});
