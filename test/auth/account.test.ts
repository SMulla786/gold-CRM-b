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
const cookieOf = (res: { headers: Record<string, unknown> }) => (res.headers['set-cookie'] ?? []) as string[];

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

  // G2b B: a password change ends the other sessions with revokeReason PASSWORD_CHANGED, so their next refresh is a plain
  // 401 — not a replayed-token theft cascade that would also sign out the session that changed it.
  it('the other device refreshing after a password change does not sign out the session that changed it; the revoked row is kept', async () => {
    const u = await setup();
    const here = await loginAs(u.username);
    const phone = await loginAs(u.username);
    await api.post('/api/auth/password').set('Authorization', bearer(here.token!)).send({ current: TEST_PASSWORD, next: NEXT });
    const b = await refresh(phone.cookie);
    expect([b.status, b.body.error.message]).toEqual([401, 'Session ended']);
    const a1 = await refresh(here.cookie);
    expect(a1.status).toBe(200);
    expect((await refresh(cookieOf(a1))).status).toBe(200); // keeps rotating normally afterwards
    const ended = await db.session.findMany({ where: { userId: u.user.id, revokeReason: 'PASSWORD_CHANGED' } });
    expect(ended).toHaveLength(1); // the phone's row is kept for audit, not deleted
    expect(await db.session.count({ where: { userId: u.user.id, revokedAt: null } })).toBe(1);
  });

  it('a replayed ROTATED token is still treated as theft: every live session of the user is revoked', async () => {
    const u = await setup();
    const a = await loginAs(u.username);
    const other = await loginAs(u.username);
    expect((await refresh(a.cookie)).status).toBe(200); // rotates a
    const replay = await refresh(a.cookie);
    expect([replay.status, replay.body.error.message]).toEqual([401, 'Refresh token reused']);
    expect((await refresh(other.cookie)).status).toBe(401);
    expect(await db.session.count({ where: { userId: u.user.id, revokedAt: null } })).toBe(0);
  });

  it('OTP reset and admin reset end old sessions without the cascade: the login made afterwards survives the old device refreshing', async () => {
    const u = await setup();
    const old = await loginAs(u.username);
    await db.otpCode.create({ data: { userId: u.user.id, purpose: 'PASSWORD_RESET', codeHash: await argon2.hash('123456'), expiresAt: new Date(Date.now() + 60_000) } });
    expect((await api.post('/api/auth/reset-password').send({ login: u.username, otp: '123456', next: NEXT })).status).toBe(204);
    const fresh = await loginAs(u.username, NEXT);
    expect((await refresh(old.cookie)).status).toBe(401);
    expect((await refresh(fresh.cookie)).status).toBe(200);
    expect(await db.session.count({ where: { userId: u.user.id, revokeReason: 'PASSWORD_RESET' } })).toBe(1);

    const staff = await createUser({ businessId: u.user.businessId, branchId: u.user.branchId, level: 'BRANCH_USER' });
    const phone = await loginAs(staff.username);
    const ownerAuth = bearer((await loginAs(u.username, NEXT)).token!);
    expect((await api.post(`/api/admin/users/${staff.user.id}/reset-password`).set('Authorization', ownerAuth).send({ password: NEXT })).status).toBe(204);
    const again = await loginAs(staff.username, NEXT);
    expect((await refresh(phone.cookie)).status).toBe(401);
    expect((await refresh(again.cookie)).status).toBe(200);
    expect(await db.session.count({ where: { userId: staff.user.id, revokeReason: 'ADMIN_RESET' } })).toBe(1);
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

describe("impersonating Super Admin cannot change the owner's credentials (G2b B)", () => {
  it("403 on /auth/password, /auth/mpin and the owner's reset-password / reset-mpin; staff resets still work; nothing changes", async () => {
    const u = await setup();
    const staff = await createUser({ businessId: u.user.businessId, branchId: u.user.branchId, level: 'BRANCH_USER' });
    const sa = await createUser({ level: 'SUPER_ADMIN' });
    const saAuth = bearer((await loginAs(sa.username)).token!);
    const imp = await api.post(`/api/platform/businesses/${u.user.businessId}/impersonate`).set('Authorization', saAuth).send({ reason: 'support ticket' });
    expect(imp.status).toBe(201);
    const as = bearer(imp.body.accessToken);
    const blocked = [
      await api.post('/api/auth/password').set('Authorization', as).send({ current: TEST_PASSWORD, next: NEXT }),
      await api.post('/api/auth/mpin').set('Authorization', as).send({ password: TEST_PASSWORD, mpin: '9999' }),
      await api.post(`/api/admin/users/${u.user.id}/reset-password`).set('Authorization', as).send({ password: NEXT }),
      await api.post(`/api/admin/users/${u.user.id}/reset-mpin`).set('Authorization', as).send({ mpin: '9999' }),
    ];
    expect(blocked.map((r) => [r.status, r.body.error?.code])).toEqual(Array(4).fill([403, 'FORBIDDEN']));
    const owner = await db.user.findUniqueOrThrow({ where: { id: u.user.id } });
    expect([await argon2.verify(owner.passwordHash, TEST_PASSWORD), await argon2.verify(owner.mpinHash!, TEST_MPIN)]).toEqual([true, true]);

    expect((await api.post(`/api/admin/users/${staff.user.id}/reset-mpin`).set('Authorization', as).send({ mpin: '4321' })).status).toBe(204);
    // the real owner (not impersonated) still can
    const ownerAuth = bearer((await loginAs(u.username)).token!);
    expect((await api.post('/api/auth/mpin').set('Authorization', ownerAuth).send({ password: TEST_PASSWORD, mpin: '9999' })).status).toBe(204);
  });
});

