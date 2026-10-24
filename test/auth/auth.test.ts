import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createUser, TEST_MPIN, TEST_PASSWORD } from '../helpers/factory';
import type { UserStatus } from '@prisma/client';

// Verifies TASK-3. Red until the auth module lands; green after. See backend/test/PLAN.md §1.

async function seedOwner(status: UserStatus = 'ACTIVE', mpin: string | null = null) {
  const { business, root } = await createBusiness();
  return createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true, status, mpin });
}

beforeEach(truncateAll);

describe('auth/login', () => {
  it('A1 valid login -> 200 token + httpOnly ju_rt cookie, never leaks hash', async () => {
    const u = await seedOwner();
    const res = await api.post('/api/auth/login').send({ login: u.username, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    const cookie = String(res.headers['set-cookie'] ?? '');
    expect(cookie).toContain('ju_rt=');
    expect(cookie.toLowerCase()).toContain('httponly');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$argon2/);
  });

  it('A2 wrong password -> 401 INVALID_CREDENTIALS, no cookie', async () => {
    const u = await seedOwner();
    const res = await api.post('/api/auth/login').send({ login: u.username, password: 'definitely-wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('A3 blocked user -> 403 ACCOUNT_BLOCKED', async () => {
    const u = await seedOwner('BLOCKED');
    const res = await api.post('/api/auth/login').send({ login: u.username, password: TEST_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_BLOCKED');
  });

  it('A4 unknown user -> 401 INVALID_CREDENTIALS, identical message to wrong-password (no enumeration)', async () => {
    const u = await seedOwner();
    const wrong = await api.post('/api/auth/login').send({ login: u.username, password: 'definitely-wrong' });
    const unknown = await api.post('/api/auth/login').send({ login: 'nobody-here', password: TEST_PASSWORD });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });
});

describe('auth/refresh + logout', () => {
  async function freshLogin() {
    const u = await seedOwner();
    const res = await api.post('/api/auth/login').send({ login: u.username, password: TEST_PASSWORD });
    return { u, cookie: (res.headers['set-cookie'] ?? []) as unknown as string[] };
  }

  it('A5 refresh -> 200 new token + rotated cookie', async () => {
    const { cookie } = await freshLogin();
    const r = await api.post('/api/auth/refresh').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(typeof r.body.accessToken).toBe('string');
    const rotated = String(r.headers['set-cookie'] ?? '');
    expect(rotated).toContain('ju_rt=');
    expect(rotated).not.toBe(String(cookie)); // rotated value differs
  });

  it('A6 reusing a rotated (old) refresh token -> 401', async () => {
    const { cookie } = await freshLogin();
    await api.post('/api/auth/refresh').set('Cookie', cookie); // rotate once
    const reuse = await api.post('/api/auth/refresh').set('Cookie', cookie); // old token replayed
    expect(reuse.status).toBe(401);
  });

  it('A7 logout revokes session; later refresh -> 401', async () => {
    const { cookie } = await freshLogin();
    const out = await api.post('/api/auth/logout').set('Cookie', cookie);
    expect([200, 204]).toContain(out.status);
    const after = await api.post('/api/auth/refresh').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });

  it('A15 a user blocked after login can no longer refresh (TASK-3b) -> 401', async () => {
    const u = await seedOwner();
    const login = await api.post('/api/auth/login').send({ login: u.username, password: TEST_PASSWORD });
    const cookie = (login.headers['set-cookie'] ?? []) as unknown as string[];
    await db.user.update({ where: { id: u.user.id }, data: { status: 'BLOCKED' } });
    const after = await api.post('/api/auth/refresh').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });
});

describe('auth/me', () => {
  it('A8 /me returns MeDto shape, no hash', async () => {
    const u = await seedOwner();
    const login = await api.post('/api/auth/login').send({ login: u.username, password: TEST_PASSWORD });
    const me = await api.get('/api/auth/me').set('Authorization', bearer(login.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      id: expect.any(Number),
      username: expect.any(String),
      level: 'ADMIN',
      isOwner: true,
    });
    for (const k of ['business', 'branch', 'accessibleBranches', 'permissions', 'modules', 'subscription', 'hasMpin']) {
      expect(me.body).toHaveProperty(k);
    }
    expect(Array.isArray(me.body.accessibleBranches)).toBe(true);
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|\$argon2/);
  });

  it('A9 /me without token -> 401 UNAUTHENTICATED', async () => {
    const res = await api.get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('auth/mpin', () => {
  it('A10/A12 set MPIN then verify correct -> 204', async () => {
    const u = await seedOwner('ACTIVE', null);
    const login = await api.post('/api/auth/login').send({ login: u.username, password: TEST_PASSWORD });
    const token = bearer(login.body.accessToken);
    const set = await api.post('/api/auth/mpin').set('Authorization', token).send({ password: TEST_PASSWORD, mpin: TEST_MPIN });
    expect(set.status).toBe(204);
    const ok = await api.post('/api/auth/mpin/verify').set('Authorization', token).send({ mpin: TEST_MPIN });
    expect(ok.status).toBe(204);
  });

  it('A11 verify wrong MPIN -> 403 MPIN_REQUIRED', async () => {
    const u = await seedOwner('ACTIVE', TEST_MPIN);
    const login = await api.post('/api/auth/login').send({ login: u.username, password: TEST_PASSWORD });
    const res = await api
      .post('/api/auth/mpin/verify')
      .set('Authorization', bearer(login.body.accessToken))
      .send({ mpin: '0000' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MPIN_REQUIRED');
  });
});

describe('auth misc', () => {
  it('A13 password is stored argon2-hashed, not plaintext', async () => {
    const u = await seedOwner();
    const row = await db.user.findUniqueOrThrow({ where: { id: u.user.id } });
    expect(row.passwordHash.startsWith('$argon2')).toBe(true);
    expect(row.passwordHash).not.toContain(TEST_PASSWORD);
  });

  it('A14 forgot-password -> 202 (OTP stub)', async () => {
    const u = await seedOwner();
    const res = await api.post('/api/auth/forgot-password').send({ login: u.username });
    expect(res.status).toBe(202);
  });
});
