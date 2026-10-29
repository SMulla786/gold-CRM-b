import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { TEST_MPIN, createBusiness, createPlan, createSubscription, createUser } from '../helpers/factory';

// UDH-03: editing or deleting an udhar receipt needs the MPIN (and udhari.entry edit / delete); a refused call changes nothing.
const body = (partyId: number, cashOut: number) => ({ partyId, cashOut, onlineOut: 0, cashIn: 0, onlineIn: 0, goldOut: 0, goldIn: 0, silverOut: 0, silverIn: 0 });

async function setup() {
  const modules = ['udhari'];
  const plan = await createPlan({ modules });
  const { business, root } = await createBusiness({ name: 'A' });
  await createSubscription({ businessId: business.id, planId: plan.id, modules });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const admin = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', mpin: TEST_MPIN });
  const token = (await loginAs(admin.username)).token!;
  const created = await api.post('/api/app/udhar').set('Authorization', bearer(token)).send(body(party.id, 1000));
  expect(created.status).toBe(201);
  return { business, root, party, token, id: created.body.id as number };
}

beforeEach(truncateAll);

describe('UDH-03 udhar edit / delete guards', () => {
  it('edit and delete without the MPIN → 403 MPIN_REQUIRED and the receipt is unchanged', async () => {
    const s = await setup();
    const put = await api.put(`/api/app/udhar/${s.id}`).set('Authorization', bearer(s.token)).send(body(s.party.id, 2000));
    expect(put.status).toBe(403);
    expect(put.body.error.code).toBe('MPIN_REQUIRED');
    const del = await api.delete(`/api/app/udhar/${s.id}`).set('Authorization', bearer(s.token)).set('X-MPIN', '0000');
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe('MPIN_REQUIRED');
    const got = await api.get(`/api/app/udhar/${s.id}`).set('Authorization', bearer(s.token));
    expect(got.status).toBe(200);
    expect(got.body.final.amount).toBe('1000.00');
  });

  it('with the MPIN: edit re-posts, delete removes it', async () => {
    const s = await setup();
    const put = await api.put(`/api/app/udhar/${s.id}`).set('Authorization', bearer(s.token)).set('X-MPIN', TEST_MPIN).send(body(s.party.id, 2000));
    expect(put.status).toBe(200);
    expect(put.body.final.amount).toBe('2000.00');
    expect((await api.delete(`/api/app/udhar/${s.id}`).set('Authorization', bearer(s.token)).set('X-MPIN', TEST_MPIN)).status).toBe(204);
  });

  it('udhari.entry edit without delete cannot delete, even with the MPIN', async () => {
    const s = await setup();
    const u = await createUser({ businessId: s.business.id, branchId: s.root.id, level: 'BRANCH_USER', mpin: TEST_MPIN });
    const perm = await db.permission.upsert({ where: { key: 'udhari.entry' }, update: {}, create: { key: 'udhari.entry', module: 'udhari', label: 'udhari.entry', sort: 0, isModule: false, hasActions: true } });
    await db.userPermission.create({ data: { userId: u.user.id, permissionId: perm.id, canView: true, canEdit: true, canDelete: false } });
    const token = (await loginAs(u.username)).token!;
    const del = await api.delete(`/api/app/udhar/${s.id}`).set('Authorization', bearer(token)).set('X-MPIN', TEST_MPIN);
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe('FORBIDDEN');
  });
});
