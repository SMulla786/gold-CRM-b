import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createPlan, createSubscription, createUser, TEST_PASSWORD } from '../helpers/factory';

// G7 review 4: while a Super Admin impersonates the owner, the backend refuses every change to who controls the business —
// owner / admin email, mobile, credentials and status, admin creation or promotion, access grants — and audits every
// write with both identities. Ending the impersonation restores the Super Admin's own access.

async function setup() {
  const plan = await createPlan();
  const { business, root } = await createBusiness();
  await createSubscription({ businessId: business.id, planId: plan.id });
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
  const admin = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN' });
  const staff = await createUser({ businessId: business.id, branchId: root.id, level: 'BRANCH_USER' });
  const sa = await createUser({ level: 'SUPER_ADMIN' });
  const saAuth = bearer((await loginAs(sa.username)).token!);
  const imp = await api.post(`/api/platform/businesses/${business.id}/impersonate`).set('Authorization', saAuth).send({ reason: 'support ticket 42' });
  expect(imp.status).toBe(201);
  return { business, root, owner, admin, staff, sa, saAuth, as: bearer(imp.body.accessToken as string) };
}
const blocked = (r: { status: number; body: { error?: { code: string; message: string } } }) =>
  r.status === 403 && r.body.error?.code === 'FORBIDDEN' && r.body.error.message.startsWith('Not allowed while impersonating');
/** Audit rows are written once each response finishes. */
async function auditRows(businessId: number, n: number) {
  for (let i = 0; i < 100; i++) {
    const rows = await db.activityLog.findMany({ where: { businessId, module: 'IMPERSONATION' }, orderBy: { id: 'asc' } });
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`fewer than ${n} impersonation audit rows`);
}

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

describe('impersonation restrictions (direct API)', () => {
  it('refuses owner email / mobile, admin creation / promotion, admin credentials / status and access grants — nothing changes', async () => {
    const s = await setup();
    const role = await db.role.create({ data: { businessId: s.business.id, name: 'Cashier' } });
    const req = (m: 'post' | 'patch' | 'put', url: string, body: object) => () => api[m](url).set('Authorization', s.as).send(body);
    const attempts = [
      req('patch', `/api/admin/users/${s.owner.user.id}`, { email: 'new-owner@example.com' }),
      req('patch', `/api/admin/users/${s.owner.user.id}`, { mobile: '9876500000' }),
      req('patch', '/api/admin/business', { email: 'shop@example.com' }),
      req('patch', '/api/admin/business', { mobile: '9876500001' }),
      req('post', '/api/admin/users', { name: 'New Admin', username: 'new.admin', password: TEST_PASSWORD, level: 'ADMIN', branchId: s.root.id }),
      req('patch', `/api/admin/users/${s.staff.user.id}`, { level: 'ADMIN' }),
      req('patch', `/api/admin/users/${s.admin.user.id}`, { email: 'admin2@example.com' }),
      req('post', `/api/admin/users/${s.admin.user.id}/reset-password`, { password: 'An0ther-pass' }),
      req('post', `/api/admin/users/${s.admin.user.id}/reset-mpin`, { mpin: '4321' }),
      req('post', `/api/admin/users/${s.owner.user.id}/reset-password`, { password: 'An0ther-pass' }),
      req('post', `/api/admin/users/${s.admin.user.id}/block`, {}),
      req('put', `/api/admin/users/${s.staff.user.id}/permissions`, { grants: [] }),
      req('put', `/api/admin/roles/${role.id}/permissions`, { grants: [] }),
      req('post', '/api/auth/password', { current: TEST_PASSWORD, next: 'An0ther-pass' }),
    ];
    const rs = [];
    for (const a of attempts) rs.push(await a());
    expect(rs.map((r) => (blocked(r) ? 'blocked' : `${r.status} ${JSON.stringify(r.body)}`))).toEqual(Array(attempts.length).fill('blocked'));

    const [owner, admin, staff, biz] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: s.owner.user.id } }),
      db.user.findUniqueOrThrow({ where: { id: s.admin.user.id } }),
      db.user.findUniqueOrThrow({ where: { id: s.staff.user.id } }),
      db.business.findUniqueOrThrow({ where: { id: s.business.id } }),
    ]);
    expect([owner.email, owner.mobile, admin.email, admin.status, staff.level]).toEqual([s.owner.user.email, s.owner.user.mobile, s.admin.user.email, 'ACTIVE', 'BRANCH_USER']);
    expect([biz.email, biz.mobile]).toEqual([s.business.email, s.business.mobile]);
    expect(await db.user.count({ where: { username: 'new.admin' } })).toBe(0);
    expect(admin.passwordHash).toBe(s.admin.user.passwordHash);
  });

  it('ordinary support work still goes through, and every write is audited with the Super Admin and the impersonated owner', async () => {
    const s = await setup();
    const staff = await api.post('/api/admin/users').set('Authorization', s.as).send({ name: 'New Staff', username: 'new.staff', password: TEST_PASSWORD, level: 'BRANCH_USER', branchId: s.root.id });
    expect(staff.status).toBe(201);
    expect((await api.patch('/api/admin/business').set('Authorization', s.as).send({ address: 'Shop 4, Main Road' })).status).toBe(200);
    const refused = await api.patch(`/api/admin/users/${s.owner.user.id}`).set('Authorization', s.as).send({ email: 'x@example.com' });
    expect(blocked(refused)).toBe(true);

    const rows = await auditRows(s.business.id, 3);
    expect(rows.map((r) => [r.userId, (r.meta as { impersonatorId: number }).impersonatorId, (r.meta as { status: number }).status, r.entityId])).toEqual([
      [s.owner.user.id, s.sa.user.id, 201, 'POST /api/admin/users'],
      [s.owner.user.id, s.sa.user.id, 200, 'PATCH /api/admin/business'],
      [s.owner.user.id, s.sa.user.id, 403, `PATCH /api/admin/users/${s.owner.user.id}`],
    ]);
    expect(JSON.stringify(rows.map((r) => [r.summary, r.meta]))).not.toContain(TEST_PASSWORD); // bodies are never recorded
  });

  it('the owner signed in normally may do all of it (no impersonation) and leaves no impersonation audit row', async () => {
    const s = await setup();
    const own = bearer((await loginAs(s.owner.username)).token!);
    expect((await api.patch(`/api/admin/users/${s.owner.user.id}`).set('Authorization', own).send({ email: 'owner@example.com', mobile: '9876500002' })).status).toBe(200);
    expect((await api.patch('/api/admin/business').set('Authorization', own).send({ email: 'shop@example.com' })).status).toBe(200);
    expect((await api.post('/api/admin/users').set('Authorization', own).send({ name: 'New Admin', username: 'new.admin', password: TEST_PASSWORD, level: 'ADMIN', branchId: s.root.id })).status).toBe(201);
    expect((await api.post(`/api/admin/users/${s.admin.user.id}/reset-mpin`).set('Authorization', own).send({ mpin: '4321' })).status).toBe(204);
    await new Promise((r) => setTimeout(r, 150));
    expect(await db.activityLog.count({ where: { module: 'IMPERSONATION' } })).toBe(0);
  });

  it('ending the impersonation restores the Super Admin: platform access works, the impersonation token is dead', async () => {
    const s = await setup();
    expect((await api.get('/api/platform/businesses').set('Authorization', s.as)).status).toBe(403); // the owner token is no Super Admin
    expect((await api.post('/api/platform/impersonation/end').set('Authorization', s.saAuth)).status).toBe(204);
    expect((await api.get('/api/admin/users').set('Authorization', s.as)).status).toBe(401);
    expect((await api.get('/api/platform/businesses').set('Authorization', s.saAuth)).status).toBe(200);
    const log = await db.impersonationLog.findFirstOrThrow({ where: { superAdminId: s.sa.user.id } });
    expect([log.targetUserId, log.reason, log.endedAt != null]).toEqual([s.owner.user.id, 'support ticket 42', true]);
  });
});
