import argon2 from 'argon2';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createPlan, createSubscription, createUser, TEST_MPIN, TEST_PASSWORD } from '../helpers/factory';

// ADM-07 (TASK-93) My account: change password (other sessions signed out, this one kept) and set / change MPIN.

async function setup() {
  const plan = await createPlan();
  const { business, root } = await createBusiness();
  await createSubscription({ businessId: business.id, planId: plan.id });
  return createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true, mpin: TEST_MPIN });
}
const NEXT = 'N3w-Passw0rd';
const refresh = (cookie: string[]) => api.post('/api/auth/refresh').set('Cookie', cookie);

beforeEach(truncateAll);

describe('change password (ADM-07)', () => {
  it('wrong current password → 401 and nothing changes; a short new one → 400', async () => {
    const u = await setup();
    const { token } = await loginAs(u.username);
    const post = (body: Record<string, unknown>) => api.post('/api/auth/password').set('Authorization', bearer(token!)).send(body);
    const bad = await post({ current: 'not-it', next: NEXT });
    expect([bad.status, bad.body.error.code]).toEqual([401, 'INVALID_CREDENTIALS']);
    expect((await post({ current: TEST_PASSWORD, next: 'short' })).status).toBe(400);
    expect((await loginAs(u.username)).token).toBeTruthy(); // old password still works
  });

  it('success: new password logs in, old one does not; every other session is revoked, the current one keeps refreshing', async () => {
    const u = await setup();
    const here = await loginAs(u.username);
    const phone = await loginAs(u.username);
    expect((await api.post('/api/auth/password').set('Authorization', bearer(here.token!)).send({ current: TEST_PASSWORD, next: NEXT })).status).toBe(204);

    expect((await loginAs(u.username)).token).toBeFalsy();
    expect((await loginAs(u.username, NEXT)).token).toBeTruthy();
    expect((await refresh(here.cookie)).status).toBe(200);
    expect((await refresh(phone.cookie)).status).toBe(401);
    expect(await argon2.verify((await db.user.findUniqueOrThrow({ where: { id: u.user.id } })).passwordHash, NEXT)).toBe(true);
  });

  // Known gap (sent to the lead): a password change revokes the other sessions with the same revokedAt that token rotation
  // uses, so the other device's next auto-refresh looks like a replayed token and refresh() revokes EVERY session —
  // including the one that just changed the password. it.fails pins it; flip with the fix.
  it.fails('the other device refreshing after a password change does not sign out the session that changed it', async () => {
    const u = await setup();
    const here = await loginAs(u.username);
    const phone = await loginAs(u.username);
    await api.post('/api/auth/password').set('Authorization', bearer(here.token!)).send({ current: TEST_PASSWORD, next: NEXT });
    expect((await refresh(phone.cookie)).status).toBe(401);
    expect((await refresh(here.cookie)).status).toBe(200); // today: 401 (reuse detection fired)
  });

  it('without a token → 401', async () => {
    expect((await api.post('/api/auth/password').send({ current: TEST_PASSWORD, next: NEXT })).status).toBe(401);
  });
});

describe('set / change MPIN (ADM-07)', () => {
  it('needs the account password (wrong → 401, MPIN unchanged); 4 digits only; the new MPIN replaces the old', async () => {
    const u = await setup();
    const auth = bearer((await loginAs(u.username)).token!);
    const set = (body: Record<string, unknown>) => api.post('/api/auth/mpin').set('Authorization', auth).send(body);
    const verify = (mpin: string) => api.post('/api/auth/mpin/verify').set('Authorization', auth).send({ mpin });

    expect((await set({ password: 'wrong-pass', mpin: '9876' })).status).toBe(401);
    expect((await verify(TEST_MPIN)).status).toBe(204);
    for (const mpin of ['987', '98765', '98a6']) expect((await set({ password: TEST_PASSWORD, mpin })).status).toBe(400);

    expect((await set({ password: TEST_PASSWORD, mpin: '9876' })).status).toBe(204);
    expect((await verify('9876')).status).toBe(204);
    expect((await verify(TEST_MPIN)).status).toBe(403);
  });

  it('a user with no MPIN yet gets 403 MPIN_REQUIRED on verify until one is set', async () => {
    const { business, root } = await createBusiness();
    const plan = await createPlan();
    await createSubscription({ businessId: business.id, planId: plan.id });
    const u = await createUser({ businessId: business.id, branchId: root.id, level: 'BRANCH_USER', mpin: null });
    const auth = bearer((await loginAs(u.username)).token!);
    const res = await api.post('/api/auth/mpin/verify').set('Authorization', auth).send({ mpin: '1111' });
    expect([res.status, res.body.error.code]).toEqual([403, 'MPIN_REQUIRED']);
    expect((await api.post('/api/auth/mpin').set('Authorization', auth).send({ password: TEST_PASSWORD, mpin: '1111' })).status).toBe(204);
    expect((await api.post('/api/auth/mpin/verify').set('Authorization', auth).send({ mpin: '1111' })).status).toBe(204);
  });
});
