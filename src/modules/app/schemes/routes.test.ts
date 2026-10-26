import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../../../../test/helpers/app';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness, createPlan, createSubscription, createUser } from '../../../../test/helpers/factory';

// Lead-approved read-only widenings: GET enrollments (+/:id) also for schemes.add_money; GET /schemes also for schemes.anjuman.
const MODULES = ['schemes'];

async function grant(userId: number, keys: string[]) {
  for (const key of keys) {
    const perm = await db.permission.upsert({ where: { key }, update: {}, create: { key, module: key.split('.')[0]!, label: key, sort: 0, isModule: false, hasActions: true } });
    await db.userPermission.create({ data: { userId, permissionId: perm.id, canView: true, canEdit: true, canDelete: true } });
  }
}

async function userWith(keys: string[]) {
  const plan = await createPlan({ modules: MODULES });
  const { business, root } = await createBusiness({ name: 'A' });
  await createSubscription({ businessId: business.id, planId: plan.id, modules: MODULES });
  const u = await createUser({ businessId: business.id, branchId: root.id, level: 'BRANCH_USER' });
  await grant(u.user.id, keys);
  return (await loginAs(u.username)).token!;
}

beforeEach(truncateAll);

describe('scheme read routes accept the alternate permission (GET only)', () => {
  it('schemes.add_money reads enrollments list + detail; no permission → 403', async () => {
    const token = await userWith(['schemes.add_money']);
    expect((await api.get('/api/app/schemes/enrollments').set('Authorization', bearer(token))).status).toBe(200);
    expect((await api.get('/api/app/schemes/enrollments/999999').set('Authorization', bearer(token))).status).toBe(404); // guard passed
    await truncateAll();
    const none = await userWith([]);
    expect((await api.get('/api/app/schemes/enrollments').set('Authorization', bearer(none))).status).toBe(403);
    expect((await api.get('/api/app/schemes/enrollments/999999').set('Authorization', bearer(none))).status).toBe(403);
  });

  it('schemes.anjuman reads GET /schemes; no permission → 403', async () => {
    const token = await userWith(['schemes.anjuman']);
    expect((await api.get('/api/app/schemes?kind=ANJUMAN').set('Authorization', bearer(token))).status).toBe(200);
    await truncateAll();
    const none = await userWith([]);
    expect((await api.get('/api/app/schemes').set('Authorization', bearer(none))).status).toBe(403);
  });

  it('write routes are not widened', async () => {
    const token = await userWith(['schemes.add_money', 'schemes.anjuman']);
    const res = await api.post('/api/app/schemes').set('Authorization', bearer(token)).send({ type: 'CASH', name: 'X1', emiAmount: 100, tenureMonths: 2, startDate: '2026-01-01' });
    expect(res.status).toBe(403); // needs schemes.all edit
  });
});
