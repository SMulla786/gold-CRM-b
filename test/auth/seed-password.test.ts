import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import argon2 from 'argon2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, truncateAll } from '../helpers/db';
import { SEED_PASSWORD_PLACEHOLDER, seedPasswordHash, seedPasswordProblem } from '../../prisma/seed-password';

// Security hotfix P1: the Super Admin seed password was a public default in .env.example. The seed must refuse a
// missing / placeholder / leaked / weak value before writing anything, and never print the value it hashes.

const STRONG = 'Kx9#mQ2v!Lr7pZ';
const FAKE_LEAKED = 'Leaked@Pass123'; // stands in for the real leaked value, which only exists as a hash in code
const leaked = new Set([createHash('sha256').update(FAKE_LEAKED).digest('hex')]);

describe('seedPasswordProblem', () => {
  it('refuses missing, placeholder, leaked and weak values; accepts a strong one', () => {
    for (const pw of [undefined, '', '   ']) expect(seedPasswordProblem(pw, leaked)).toBe('is not set');
    expect(seedPasswordProblem(SEED_PASSWORD_PLACEHOLDER, leaked)).toMatch(/placeholder/);
    expect(seedPasswordProblem(FAKE_LEAKED, leaked)).toMatch(/public in git history/); // would pass the strength rules
    for (const weak of ['Ab1!short', 'alllowercaseletters', 'lowercase123456', 'x'.repeat(98) + 'A1!'])
      expect(seedPasswordProblem(weak, leaked)).toMatch(/characters|mix/);
    expect(seedPasswordProblem(STRONG, leaked)).toBeNull();
    expect(seedPasswordProblem(STRONG)).toBeNull(); // the built-in leaked list
  });
});

describe('seedPasswordHash', () => {
  afterEach(() => vi.restoreAllMocks());

  it('strong → an argon2 hash of it, and nothing printed', async () => {
    const out = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const write = vi.spyOn(process.stdout, 'write');
    const hash = await seedPasswordHash(STRONG, leaked);
    expect(hash).not.toContain(STRONG);
    expect(await argon2.verify(hash, STRONG)).toBe(true);
    for (const spy of [...out, write]) expect(JSON.stringify(spy.mock.calls)).not.toContain(STRONG);
  });

  it('a refusal never echoes the value', async () => {
    await expect(seedPasswordHash(FAKE_LEAKED, leaked)).rejects.toThrow(/^Refusing to seed: SEED_SUPERADMIN_PASSWORD/);
    const err = await seedPasswordHash('weakpassword', leaked).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^Refusing to seed/);
    expect((err as Error).message).not.toContain('weakpassword');
  });
});

describe('prisma/seed.ts (real script, test DB)', () => {
  beforeEach(truncateAll);
  const seed = (pw: string | undefined) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: process.env.DATABASE_URL, SEED_DEMO: 'false', SEED_SUPERADMIN_PASSWORD: pw };
    if (pw === undefined) delete env.SEED_SUPERADMIN_PASSWORD;
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'prisma/seed.ts'], { env, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('missing / placeholder / weak → exit 1, nothing created, value not printed', async () => {
    for (const pw of [undefined, SEED_PASSWORD_PLACEHOLDER, 'weakpassword']) {
      const r = seed(pw);
      expect(r.status).toBe(1);
      expect(r.out).toContain('Refusing to seed');
      if (pw) expect(r.out).not.toContain(pw);
    }
    expect([await db.user.count(), await db.state.count(), await db.plan.count()]).toEqual([0, 0, 0]);
  });

  it('strong → Super Admin created with an argon2 hash of it; the value is never printed', async () => {
    const r = seed(STRONG);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain(STRONG);
    const sa = await db.user.findFirstOrThrow({ where: { level: 'SUPER_ADMIN' } });
    expect(await argon2.verify(sa.passwordHash, STRONG)).toBe(true);
  }, 120_000);
});
