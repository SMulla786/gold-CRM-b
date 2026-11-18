import argon2 from 'argon2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';

// GET /api/public/seed-superadmin: the base seed (masters + Super Admin from env), Super Admin skipped once present, 3 calls max.

const URL = '/api/public/seed-superadmin';
const STRONG = 'Kx9#mQ2v!Lr7pZ';
const saved = { ...process.env };
const masters = async () => ({
  states: await db.state.count(),
  districts: await db.district.count(),
  permissions: await db.permission.count(),
  systemRoles: await db.role.count({ where: { businessId: null, isSystem: true } }),
  plans: await db.plan.count(),
  hsn: await db.hsnCode.count(),
});

describe('GET /api/public/seed-superadmin', () => {
  beforeEach(truncateAll);
  afterEach(() => {
    for (const k of ['SEED_SUPERADMIN_PASSWORD', 'SEED_SUPERADMIN_USERNAME', 'SEED_SUPERADMIN_EMAIL']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('weak env password → 500 SEED_CONFIG, nothing written, value not echoed', async () => {
    process.env.SEED_SUPERADMIN_PASSWORD = 'weakpassword';
    const res = await api.get(URL);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('SEED_CONFIG');
    expect(JSON.stringify(res.body)).not.toContain('weakpassword');
    expect(await db.user.count()).toBe(0);
    expect(Object.values(await masters())).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('seeds masters + the Super Admin from env, then skips the Super Admin on the next call', async () => {
    process.env.SEED_SUPERADMIN_PASSWORD = STRONG;
    process.env.SEED_SUPERADMIN_USERNAME = 'owner.sa';
    const first = await api.get(URL);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: true, username: 'owner.sa' });
    const sa = await db.user.findUniqueOrThrow({ where: { username: 'owner.sa' } });
    expect(sa.level).toBe('SUPER_ADMIN');
    expect(await argon2.verify(sa.passwordHash, STRONG)).toBe(true);
    const seeded = await masters();
    for (const [k, n] of Object.entries(seeded)) expect(n, k).toBeGreaterThan(0);

    process.env.SEED_SUPERADMIN_USERNAME = 'someone.else'; // a changed env must not add a second Super Admin
    const second = await api.get(URL);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ created: false, message: 'Super admin already present' });
    expect(await db.user.count({ where: { level: 'SUPER_ADMIN' } })).toBe(1);
    expect(await masters()).toEqual(seeded); // idempotent: re-running adds no duplicates
  }, 120_000);

  it('3 calls in total (failed ones count too), then 403 SEED_LIMIT', async () => {
    process.env.SEED_SUPERADMIN_PASSWORD = 'weakpassword';
    for (let i = 0; i < 3; i++) expect((await api.get(URL)).status).toBe(500);
    process.env.SEED_SUPERADMIN_PASSWORD = STRONG; // fixing the env does not give more tries
    const fourth = await api.get(URL);
    expect(fourth.status).toBe(403);
    expect(fourth.body.error.code).toBe('SEED_LIMIT');
    expect(await db.user.count()).toBe(0);
  });

  it('a burst of parallel calls cannot get past the limit', async () => {
    process.env.SEED_SUPERADMIN_PASSWORD = 'weakpassword'; // fast 500s, so only the limit decides
    const statuses = (await Promise.all(Array.from({ length: 6 }, () => api.get(URL)))).map((r) => r.status);
    expect(statuses.filter((s) => s !== 403)).toHaveLength(3);
    expect(await db.activityLog.count({ where: { entity: 'SEED_SUPERADMIN' } })).toBe(3);
  });
});
