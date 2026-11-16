import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createPlan, createSubscription, createUser } from '../helpers/factory';

// ISS-13: All Stock Summary reads accept stock_summary.view OR inventory.all_stock; Set Stock stays inventory edit + MPIN.
const READS = ['/api/app/stock/all-summary', '/api/app/stock/set-stock-logs'];
const SET = '/api/app/stock/all-summary/set';
const setBody = { card: 'SHOP_CASH', newBalance: 100 };

async function grant(userId: number, keys: string[]) {
  for (const key of keys) {
    const perm = await db.permission.upsert({ where: { key }, update: {}, create: { key, module: key.split('.')[0]!, label: key, sort: 0, isModule: false, hasActions: true } });
    await db.userPermission.create({ data: { userId, permissionId: perm.id, canView: true, canEdit: true, canDelete: true } });
  }
}

async function biz(modules: string[]) {
  const plan = await createPlan({ modules });
  const { business, root } = await createBusiness({ name: 'A' });
  await createSubscription({ businessId: business.id, planId: plan.id, modules });
  return { business, root };
}

async function branchUser(businessId: number, branchId: number, keys: string[]) {
  const u = await createUser({ businessId, branchId, level: 'BRANCH_USER' });
  await grant(u.user.id, keys);
  const { token } = await loginAs(u.username);
  return token!;
}

beforeEach(truncateAll);

describe('ISS-13 All Stock Summary permissions', () => {
  it('stock_summary.view alone reads the summary + set-stock log, but cannot set stock', async () => {
    const { business, root } = await biz(['inventory', 'stock_summary']);
    const token = await branchUser(business.id, root.id, ['stock_summary.view']);
    for (const url of READS) expect((await api.get(url).set('Authorization', bearer(token))).status, url).toBe(200);
    const set = await api.post(SET).set('Authorization', bearer(token)).send(setBody);
    expect(set.status).toBe(403);
    expect(set.body.error.code).toBe('FORBIDDEN');
  });

  it('inventory.all_stock still reads both (unchanged)', async () => {
    const { business, root } = await biz(['inventory', 'stock_summary']);
    const token = await branchUser(business.id, root.id, ['inventory.all_stock']);
    for (const url of READS) expect((await api.get(url).set('Authorization', bearer(token))).status, url).toBe(200);
  });

  it('a user with neither key is forbidden', async () => {
    const { business, root } = await biz(['inventory', 'stock_summary']);
    const token = await branchUser(business.id, root.id, ['inventory.new_stock']);
    for (const url of READS) {
      const res = await api.get(url).set('Authorization', bearer(token));
      expect(res.status, url).toBe(403);
      expect(res.body.error.code, url).toBe('FORBIDDEN');
    }
  });

  it('a plan with stock_summary but no inventory module: reads work, Set Stock is MODULE_DISABLED', async () => {
    const { business, root } = await biz(['stock_summary']);
    const token = await branchUser(business.id, root.id, ['stock_summary.view', 'inventory.all_stock']);
    for (const url of READS) expect((await api.get(url).set('Authorization', bearer(token))).status, url).toBe(200);
    const set = await api.post(SET).set('Authorization', bearer(token)).send(setBody);
    expect(set.status).toBe(403);
    expect(set.body.error.code).toBe('MODULE_DISABLED');
  });

  it('Set Stock with inventory.all_stock edit still requires an MPIN', async () => {
    const { business, root } = await biz(['inventory', 'stock_summary']);
    const token = await branchUser(business.id, root.id, ['inventory.all_stock']);
    const set = await api.post(SET).set('Authorization', bearer(token)).send(setBody);
    expect(set.status).toBe(403);
    expect(set.body.error.code).toBe('MPIN_REQUIRED');
  });
});
