import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { truncateAll } from '../helpers/db';
import { createBusiness, createPlan, createSubscription, createUser, TEST_PASSWORD } from '../helpers/factory';

// ISS-18: a password change must end the OTHER sessions' still-unexpired ACCESS tokens too, not only their refresh
// (refresh → 401 is covered in account.test.ts). Business APIs re-check the session on every request (loadContext).

async function setup() {
  const plan = await createPlan();
  const { business, root } = await createBusiness();
  await createSubscription({ businessId: business.id, planId: plan.id });
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
  const staff = await createUser({ businessId: business.id, branchId: root.id, level: 'BRANCH_USER' });
  return { owner, staff };
}
const NEXT = 'N3w-Passw0rd';
const users = (token: string) => api.get('/api/admin/users').set('Authorization', bearer(token));

beforeEach(truncateAll);

describe('revoked sessions: access tokens', () => {
  it('own change via /auth/password: the other session is rejected on its next request; this session keeps working', async () => {
    const { owner } = await setup();
    const here = await loginAs(owner.username);
    const phone = await loginAs(owner.username);
    expect((await users(phone.token!)).status).toBe(200);
    expect((await api.post('/api/auth/password').set('Authorization', bearer(here.token!)).send({ current: TEST_PASSWORD, next: NEXT })).status).toBe(204);

    const r = await users(phone.token!);
    expect([r.status, r.body.error.message]).toEqual([401, 'Session expired']);
    expect((await users(here.token!)).status).toBe(200);
  });

  it("admin reset-password of a staff user: the staff's access token is rejected on its next request", async () => {
    const { owner, staff } = await setup();
    const phone = await loginAs(staff.username);
    const dash = () => api.get('/api/app/dashboard').set('Authorization', bearer(phone.token!));
    expect((await dash()).status).not.toBe(401);
    const ownerAuth = bearer((await loginAs(owner.username)).token!);
    expect((await api.post(`/api/admin/users/${staff.user.id}/reset-password`).set('Authorization', ownerAuth).send({ password: NEXT })).status).toBe(204);

    const r = await dash();
    expect([r.status, r.body.error.message]).toEqual([401, 'Session expired']);
  });

  // Found by Developer 1: /api/auth/me, /password, /mpin and /mpin/verify used requireAuth only (stateless JWT), so a
  // revoked session's access token still worked there for up to 15 min. Fixed: those routes also run loadContext.
  it('/api/auth/* rejects a revoked session at once (me, password, mpin, mpin/verify)', async () => {
    const { owner } = await setup();
    const here = await loginAs(owner.username);
    const phone = await loginAs(owner.username);
    await api.post('/api/auth/password').set('Authorization', bearer(here.token!)).send({ current: TEST_PASSWORD, next: NEXT });
    const as = bearer(phone.token!);
    const rs = [
      await api.get('/api/auth/me').set('Authorization', as),
      await api.post('/api/auth/password').set('Authorization', as).send({ current: NEXT, next: 'An0ther-Passw0rd' }),
      await api.post('/api/auth/mpin').set('Authorization', as).send({ password: NEXT, mpin: '4321' }),
      await api.post('/api/auth/mpin/verify').set('Authorization', as).send({ mpin: '1234' }),
    ];
    expect(rs.map((r) => [r.status, r.body.error?.message])).toEqual(Array(4).fill([401, 'Session expired']));
    expect((await api.get('/api/auth/me').set('Authorization', bearer(here.token!))).status).toBe(200); // this session stays
  });

  it('/api/auth/me rejects a blocked user at once', async () => {
    const { owner, staff } = await setup();
    const phone = await loginAs(staff.username);
    const ownerAuth = bearer((await loginAs(owner.username)).token!);
    const { db } = await import('../helpers/db');
    await db.user.update({ where: { id: staff.user.id }, data: { status: 'BLOCKED' } });
    const r = await api.get('/api/auth/me').set('Authorization', bearer(phone.token!));
    expect(r.status).toBe(401);
    expect((await api.get('/api/auth/me').set('Authorization', ownerAuth)).status).toBe(200);
  });
});
