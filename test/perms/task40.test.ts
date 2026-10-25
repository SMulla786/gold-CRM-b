import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createPlan, createSubscription, createUser } from '../helpers/factory';

// TASK-40: requireAnyPermission on balance + stock-movement ledgers, and the open business-profile route.
const MODULES = ['udhari', 'billing', 'inventory', 'daybook'];

async function grant(userId: number, keys: string[]) {
  for (const key of keys) {
    const perm = await db.permission.upsert({ where: { key }, update: {}, create: { key, module: key.split('.')[0]!, label: key, sort: 0, isModule: false, hasActions: true } });
    await db.userPermission.create({ data: { userId, permissionId: perm.id, canView: true, canEdit: true, canDelete: true } });
  }
}

async function biz() {
  const plan = await createPlan({ modules: MODULES });
  const { business, root } = await createBusiness({ name: 'A' });
  await createSubscription({ businessId: business.id, planId: plan.id, modules: MODULES });
  return { business, root };
}

async function branchUser(businessId: number, branchId: number, keys: string[]) {
  const u = await createUser({ businessId, branchId, level: 'BRANCH_USER' });
  await grant(u.user.id, keys);
  const { token } = await loginAs(u.username);
  return token!;
}

beforeEach(truncateAll);

describe('TASK-40 widened read permissions', () => {
  it('party balance is readable by an udhari.entry-only user and a billing.sell_bill-only user', async () => {
    const { business, root } = await biz();
    const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'C', mobile: '9000000000' } });
    for (const keys of [['udhari.entry'], ['billing.sell_bill']]) {
      const token = await branchUser(business.id, root.id, keys);
      const res = await api.get(`/api/app/udhar/parties/${party.id}/balance`).set('Authorization', bearer(token));
      expect(res.status, keys.join()).toBe(200);
      expect(res.body).toEqual({ amount: '0.00', gold: '0.000', silver: '0.000' });
    }
  });

  it('inventory.all_stock user reads /ledgers WITH stockItemId (200) but not without it (403)', async () => {
    const { business, root } = await biz();
    const token = await branchUser(business.id, root.id, ['inventory.all_stock']);
    const withItem = await api.get('/api/app/ledgers?asset=GOLD&stockItemId=1').set('Authorization', bearer(token));
    expect(withItem.status).toBe(200);
    const without = await api.get('/api/app/ledgers?asset=GOLD').set('Authorization', bearer(token));
    expect(without.status).toBe(403); // no daybook.gold permission
  });

  it('business-profile is readable by a plain branch user', async () => {
    const { business, root } = await biz();
    const token = await branchUser(business.id, root.id, []);
    const res = await api.get('/api/app/business-profile').set('Authorization', bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(business.id);
    expect(res.body).toHaveProperty('gstin');
    expect(res.body).toHaveProperty('state');
  });

  it('business-profile prefers the active branch GSTIN / state when the branch has them', async () => {
    const { business, root } = await biz();
    await db.state.upsert({ where: { id: 27 }, update: {}, create: { id: 27, name: 'Maharashtra' } });
    await db.branch.update({ where: { id: root.id }, data: { gstin: '27ABCDE1234F1Z5', stateId: 27 } });
    const token = await branchUser(business.id, root.id, []); // branch user's active branch = root
    const res = await api.get('/api/app/business-profile').set('Authorization', bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.gstin).toBe('27ABCDE1234F1Z5'); // branch override, not the business's
    expect(res.body.state).toEqual({ id: 27, name: 'Maharashtra' });
  });
});
