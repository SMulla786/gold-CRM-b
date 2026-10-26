import argon2 from 'argon2';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createPlan, createSubscription, createUser } from '../helpers/factory';

// TASK-97 (Masters & Settings + Roles): user trash/restore, admin MPIN reset, role rename/delete.

async function setup() {
  const plan = await createPlan();
  const { business, root } = await createBusiness({ name: 'A' });
  await createSubscription({ businessId: business.id, planId: plan.id });
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
  const staff = await createUser({ businessId: business.id, branchId: root.id, level: 'BRANCH_USER' });
  const { token } = await loginAs(owner.username);
  return { business, owner, staff, auth: bearer(token!) };
}

beforeEach(truncateAll);

describe('user trash / restore', () => {
  it('DELETE hides the user from the default list, shows it under status=DELETED, blocks login; restore reverses it', async () => {
    const { staff, auth } = await setup();
    expect((await api.delete(`/api/admin/users/${staff.user.id}`).set('Authorization', auth)).status).toBe(204);

    const all = await api.get('/api/admin/users').set('Authorization', auth);
    expect((all.body.items as { id: number }[]).map((u) => u.id)).not.toContain(staff.user.id);
    const trash = await api.get('/api/admin/users?status=DELETED').set('Authorization', auth);
    expect((trash.body.items as { id: number }[]).map((u) => u.id)).toEqual([staff.user.id]);
    expect((await loginAs(staff.username)).token).toBeFalsy();

    expect((await api.post(`/api/admin/users/${staff.user.id}/restore`).set('Authorization', auth)).status).toBe(204);
    expect((await db.user.findUniqueOrThrow({ where: { id: staff.user.id } })).status).toBe('ACTIVE');
    expect((await loginAs(staff.username)).token).toBeTruthy();
  });

  it('the owner and the caller themself cannot be trashed', async () => {
    const { owner, auth } = await setup();
    const res = await api.delete(`/api/admin/users/${owner.user.id}`).set('Authorization', auth);
    expect(res.status).toBe(403);
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.user.id } })).status).toBe('ACTIVE');
  });
});

describe('admin MPIN reset', () => {
  it('sets the target user MPIN; rejects non-4-digit input', async () => {
    const { staff, auth } = await setup();
    expect((await api.post(`/api/admin/users/${staff.user.id}/reset-mpin`).set('Authorization', auth).send({ mpin: '12a4' })).status).toBe(400);
    expect((await api.post(`/api/admin/users/${staff.user.id}/reset-mpin`).set('Authorization', auth).send({ mpin: '4321' })).status).toBe(204);
    const u = await db.user.findUniqueOrThrow({ where: { id: staff.user.id } });
    expect(await argon2.verify(u.mpinHash!, '4321')).toBe(true);
  });
});

describe('role rename / delete', () => {
  it('renames a business role; duplicate name -> 409', async () => {
    const { auth } = await setup();
    const a = await api.post('/api/admin/roles').set('Authorization', auth).send({ name: 'Cashier' });
    await api.post('/api/admin/roles').set('Authorization', auth).send({ name: 'Manager' });
    const ok = await api.patch(`/api/admin/roles/${a.body.id}`).set('Authorization', auth).send({ name: 'Senior Cashier' });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe('Senior Cashier');
    expect((await api.patch(`/api/admin/roles/${a.body.id}`).set('Authorization', auth).send({ name: 'Manager' })).status).toBe(409);
  });

  it('deletes an unused role; a role with users -> 409; a system role -> 403', async () => {
    const { staff, auth } = await setup();
    const used = await api.post('/api/admin/roles').set('Authorization', auth).send({ name: 'Used' });
    await db.user.update({ where: { id: staff.user.id }, data: { roleId: used.body.id } });
    expect((await api.delete(`/api/admin/roles/${used.body.id}`).set('Authorization', auth)).status).toBe(409);

    const unused = await api.post('/api/admin/roles').set('Authorization', auth).send({ name: 'Unused' });
    expect((await api.delete(`/api/admin/roles/${unused.body.id}`).set('Authorization', auth)).status).toBe(204);
    expect(await db.role.findUnique({ where: { id: unused.body.id } })).toBeNull();

    const sys = await db.role.create({ data: { name: 'Template', isSystem: true } });
    expect((await api.delete(`/api/admin/roles/${sys.id}`).set('Authorization', auth)).status).toBe(403);
  });
});
