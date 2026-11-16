import { createHash, createHmac } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { api, bearer } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createPlan, createSubscription, createUser, TEST_PASSWORD } from '../helpers/factory';

// G7 closure: a password change, an admin password reset or a block revokes the user's sessions with one UPDATE. A refresh
// that is rotating one of those sessions at that moment inserts its successor after the UPDATE took its snapshot, so the
// successor escaped the revoke and stayed live (READ COMMITTED: a concurrent insert is invisible to a running UPDATE).
// The refresh now takes the user row (FOR SHARE) before the session row, and every revoker holds the user row (its
// UPDATE "User") until its session revoke commits: lock order User → Session everywhere, so the two serialise.

const UA = 'race-browser/1.0';
const NEXT = 'N3w-Passw0rd';
type Res = { status: number; body: { accessToken?: string; error?: { message: string } }; headers: Record<string, unknown> };
const cookieOf = (r: Res) => (r.headers['set-cookie'] ?? []) as string[];
const rawOf = (cookie: string[]) => /ju_rt=([^;]+)/.exec(cookie.join(';'))![1]!;
const refresh = (cookie: string[]) => api.post('/api/auth/refresh').set('Cookie', cookie).set('User-Agent', UA).then((r) => r as unknown as Res);
const login = async (username: string) => (await api.post('/api/auth/login').set('User-Agent', UA).send({ login: username, password: TEST_PASSWORD })) as unknown as Res;
const live = (userId: number) => db.session.findMany({ where: { userId, revokedAt: null }, select: { id: true } });
const sidOf = (r: Res) => JSON.parse(Buffer.from(r.body.accessToken!.split('.')[1]!, 'base64url').toString()).sid as string;
/** The refresh's successor token (auth/service.ts successorToken): only its sha256 is ever stored. */
const successorHash = (raw: string) =>
  createHash('sha256').update(createHmac('sha256', env.JWT_REFRESH_SECRET).update(`rt-successor:${raw}`).digest('base64url')).digest('hex');

async function until(cond: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const lockWaiters = async () =>
  (await db.$queryRaw<{ c: number }[]>`SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.c;

/** Runs fn in a transaction held open until release(); `rollback` ends it without committing anything. */
async function hold(fn: (tx: Prisma.TransactionClient) => Promise<unknown>, end: 'commit' | 'rollback') {
  let release!: () => void;
  let ready!: () => void;
  const go = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (ready = r));
  const done = db
    .$transaction(async (tx) => {
      await fn(tx);
      ready();
      await go;
      if (end === 'rollback') throw new Error('rollback');
    }, { timeout: 30_000 })
    .catch((e: Error) => {
      if (e.message !== 'rollback') throw e;
    });
  await started;
  return async () => {
    release();
    await done;
  };
}

async function setup() {
  const plan = await createPlan();
  const { business, root } = await createBusiness();
  await createSubscription({ businessId: business.id, planId: plan.id });
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
  const staff = await createUser({ businessId: business.id, branchId: root.id, level: 'BRANCH_USER' });
  const ownerAuth = bearer((await login(owner.username)).body.accessToken!);
  return { owner, staff, ownerAuth };
}

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

describe('a revoke racing a refresh rotation never leaves a live successor', () => {
  it.each([
    ['password change', 204],
    ['admin password reset', 204],
    ['admin block', 204],
    ['token reuse (theft: every session revoked)', 401],
  ] as const)(
    '%s while another device refreshes: the refresh holds its session row and waits on its successor insert',
    async (action, revokeStatus) => {
      const s = await setup();
      const target = action === 'password change' ? s.owner : s.staff;
      const device = await login(target.username); // e.g. a stolen cookie the user wants signed out
      const here = action === 'password change' ? await login(target.username) : null; // the session making the change
      let replay: string[] = [];
      if (revokeStatus === 401) {
        // another tab rotated a while ago (past the grace window): replaying its old cookie is reuse → every live session goes
        const tab = await login(target.username);
        expect((await refresh(cookieOf(tab))).status).toBe(200);
        await db.session.updateMany({ where: { replacedById: { not: null } }, data: { revokedAt: new Date(Date.now() - 60_000) } });
        replay = cookieOf(tab);
      }

      // an uncommitted row with the successor's token hash: the refresh locks its session row, inserts the successor and
      // waits on that unique index — i.e. it is mid-rotation, holding the row, when the revoke runs
      const releaseInsert = await hold((tx) => tx.session.create({ data: { userId: target.user.id, refreshTokenHash: successorHash(rawOf(cookieOf(device))), expiresAt: new Date(Date.now() + 60_000) } }), 'rollback');
      const rotating = refresh(cookieOf(device));
      await until(async () => (await lockWaiters()) >= 1, 'the refresh to wait on its successor insert');
      const revoke =
        action === 'password change'
          ? api.post('/api/auth/password').set('Authorization', bearer(here!.body.accessToken!)).send({ current: TEST_PASSWORD, next: NEXT })
          : revokeStatus === 401
            ? api.post('/api/auth/refresh').set('Cookie', replay).set('User-Agent', UA)
            : api.post(`/api/admin/users/${target.user.id}/${action === 'admin block' ? 'block' : 'reset-password'}`).set('Authorization', s.ownerAuth).send({ password: NEXT });
      const revoked = revoke.then((r) => r);
      await until(async () => (await lockWaiters()) >= 2, 'the revoke to wait on the refresh');
      await releaseInsert();
      const [rr, rv] = await Promise.all([rotating, revoked]);

      expect(rv.status).toBe(revokeStatus);
      expect((await live(target.user.id)).map((x) => x.id)).toEqual(here ? [sidOf(here)] : []); // nothing of the other device survives
      if (rr.status === 200) {
        if (action === 'admin block') await db.user.update({ where: { id: target.user.id }, data: { status: 'ACTIVE' } }); // an unblock must not revive it
        expect((await refresh(cookieOf(rr))).status).toBe(401);
      }
    },
  );

  it("admin password reset: a rotation between the reset's user update and its session revoke does not escape it either", async () => {
    const s = await setup();
    const other = await login(s.staff.username); // visited first by the revoke's scan
    const device = await login(s.staff.username);
    const order = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Session" WHERE "userId" = ${s.staff.user.id} ORDER BY ctid`;
    expect(order.map((r) => r.id)).toEqual([sidOf(other), sidOf(device)]); // heap order = the UPDATE's visiting order

    // the reset updates the user row, then its session UPDATE stops on the other device's row…
    const releaseOther = await hold((tx) => tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sidOf(other)} FOR UPDATE`, 'commit');
    const reset = api.post(`/api/admin/users/${s.staff.user.id}/reset-password`).set('Authorization', s.ownerAuth).send({ password: NEXT }).then((r) => r);
    await until(async () => (await lockWaiters()) >= 1, 'the reset to wait on the other session row');
    // …while this device refreshes: it either completes (rotating under the running UPDATE) or waits for the reset
    let settled = false;
    const rotating = refresh(cookieOf(device)).then((r) => {
      settled = true;
      return r;
    });
    await until(async () => settled || (await lockWaiters()) >= 2, 'the refresh to finish or queue');
    await releaseOther();
    const [rr, rs] = await Promise.all([rotating, reset]);

    expect(rs.status).toBe(204);
    expect(await live(s.staff.user.id)).toEqual([]);
    if (rr.status === 200) expect((await refresh(cookieOf(rr))).status).toBe(401);
    else expect(rr.body.error?.message).toBe('Session ended');
  });
});
