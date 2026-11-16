import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, bearer } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createUser, TEST_PASSWORD } from '../helpers/factory';
import * as auth from '../../src/modules/auth/service';
import { endImpersonation } from '../../src/modules/platform/service';

// G7 review: two tabs of one browser share the refresh cookie. A duplicate refresh of a just-rotated token inside
// REFRESH_GRACE_MS resolves to the SAME successor (never a competing one, never a token-reuse revoke). Outside the window,
// from another browser, or after a deliberate end (logout, block, password change, impersonation end, account switch) it
// gets no grace.

const UA = 'tab-browser/1.0';
type Res = { status: number; body: { accessToken?: string; error?: { message: string } }; headers: Record<string, unknown> };
const cookieOf = (r: Res) => (r.headers['set-cookie'] ?? []) as string[];
const tokenOf = (r: Res) => /ju_rt=([^;]+)/.exec(String(r.headers['set-cookie'] ?? ''))?.[1];
const sidOf = (r: Res) => JSON.parse(Buffer.from(r.body.accessToken!.split('.')[1]!, 'base64url').toString()).sid as string;
const refresh = (cookie: string[], ua = UA) => api.post('/api/auth/refresh').set('Cookie', cookie).set('User-Agent', ua).then((r) => r as unknown as Res);
const login = async (username: string, cookie: string[] = []) =>
  cookieOf((await api.post('/api/auth/login').set('Cookie', cookie).set('User-Agent', UA).send({ login: username, password: TEST_PASSWORD })) as unknown as Res);
const live = (userId: number) => db.session.count({ where: { userId, revokedAt: null } });
/** Moves every rotation `ms` into the past (a duplicate arriving that late). */
const ageRotations = (ms: number) => db.session.updateMany({ where: { replacedById: { not: null } }, data: { revokedAt: new Date(Date.now() - ms) } });
async function lockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ c } = { c: 0 }] = await db.$queryRaw<{ c: number }[]>`SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (c >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`fewer than ${n} connections ever waited on the session row`);
}
/** Holds the user's session rows the way a refresh does, until release(). */
async function holdSessions(userId: number) {
  let release!: () => void;
  let locked!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const gotLock = new Promise<void>((r) => (locked = r));
  const done = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Session" WHERE "userId" = ${userId} FOR UPDATE`;
    locked();
    await held;
  }, { timeout: 20_000 });
  await gotLock;
  return async () => {
    release();
    await done;
  };
}

async function owner() {
  const { business, root } = await createBusiness();
  const u = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
  return { ...u, business, root };
}

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

describe('refresh grace window (two tabs, one cookie)', () => {
  it('simultaneous duplicates all resolve to ONE successor; no session is revoked as reuse', async () => {
    const u = await owner();
    const c = await login(u.username);
    const otherDevice = await login(u.username);
    const rs = await Promise.all([refresh(c), refresh(c), refresh(c)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(rs.map(tokenOf)).size).toBe(1);
    expect(new Set(rs.map(sidOf)).size).toBe(1);
    expect(await db.session.count({ where: { replacedById: sidOf(rs[0]!) } })).toBe(1); // one rotation, one successor
    expect(await live(u.user.id)).toBe(2); // the successor + the other device
    expect((await refresh(cookieOf(rs[0]!))).status).toBe(200); // the successor rotates normally afterwards
    expect((await refresh(otherDevice)).status).toBe(200);
  });

  it('true concurrency: two requests queued on the locked session row both get the same successor, whichever commits first', async () => {
    const u = await owner();
    const c = await login(u.username);
    const release = await holdSessions(u.user.id);
    const p1 = refresh(c);
    const p2 = refresh(c);
    await lockWaiters(2);
    await release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    // response order is irrelevant: both carry the same cookie and the same session
    expect(tokenOf(r1)).toBe(tokenOf(r2));
    expect(sidOf(r1)).toBe(sidOf(r2));
    expect(await live(u.user.id)).toBe(1);
  });

  it('a delayed duplicate (4 s after the rotation) still gets the same successor and a working access token', async () => {
    const u = await owner();
    const c = await login(u.username);
    const first = await refresh(c);
    await ageRotations(4000);
    const late = await refresh(c);
    expect(late.status).toBe(200);
    expect(tokenOf(late)).toBe(tokenOf(first));
    expect((await api.get('/api/auth/me').set('Authorization', bearer(late.body.accessToken!))).status).toBe(200);
  });

  it('expired grace (6 s): the replay is reuse → 401 and every live session of the user is revoked', async () => {
    const u = await owner();
    const c = await login(u.username);
    const otherDevice = await login(u.username);
    const first = await refresh(c);
    await ageRotations(auth.REFRESH_GRACE_MS + 1000);
    const replay = await refresh(c);
    expect([replay.status, replay.body.error?.message]).toEqual([401, 'Refresh token reused']);
    expect((await refresh(cookieOf(first))).status).toBe(401);
    expect((await refresh(otherDevice)).status).toBe(401);
    expect(await live(u.user.id)).toBe(0);
  });

  it('a duplicate from a different browser (User-Agent) gets no grace: reuse → revoke', async () => {
    const u = await owner();
    const c = await login(u.username);
    expect((await refresh(c)).status).toBe(200);
    const stolen = await refresh(c, 'some-other-browser/9');
    expect([stolen.status, stolen.body.error?.message]).toEqual([401, 'Refresh token reused']);
    expect(await live(u.user.id)).toBe(0);
  });

  it('logout after another tab rotated the cookie ends the successor too; the duplicate gets a plain 401; other devices stay signed in', async () => {
    const u = await owner();
    const c = await login(u.username);
    const otherDevice = await login(u.username);
    const rotated = await refresh(c);
    expect((await api.post('/api/auth/logout').set('Cookie', c)).status).toBe(204); // this tab still held the old cookie
    expect((await refresh(cookieOf(rotated))).status).toBe(401);
    const dup = await refresh(c);
    expect([dup.status, dup.body.error?.message]).toEqual([401, 'Session ended']);
    expect((await refresh(otherDevice)).status).toBe(200);
  });

  it('logout racing a refresh on the locked row: whichever wins, the cookie chain ends and nothing is treated as theft', async () => {
    const u = await owner();
    const c = await login(u.username);
    const otherDevice = await login(u.username);
    const release = await holdSessions(u.user.id);
    const r = refresh(c);
    const out = api.post('/api/auth/logout').set('Cookie', c).then((x) => x);
    await lockWaiters(2);
    await release();
    const [rr, lo] = await Promise.all([r, out]);
    expect(lo.status).toBe(204);
    if (rr.status === 200) expect((await refresh(cookieOf(rr))).status).toBe(401); // refresh won: logout ended its successor
    else expect(rr.body.error?.message).toBe('Session ended'); // logout won
    expect(await live(u.user.id)).toBe(1); // only the other device
    expect((await refresh(otherDevice)).status).toBe(200);
  });

  it('account switch in the same browser: signing in as another user ends the old cookie chain, so a late duplicate of it gets no grace', async () => {
    const x = await owner();
    const y = await createUser({ businessId: x.business.id, branchId: x.root.id, level: 'BRANCH_USER' });
    const c = await login(x.username);
    const rotated = await refresh(c);
    const yCookie = await login(y.username, c); // tab B signs in as Y while the browser still sent X's pre-rotation cookie
    const dup = await refresh(c);
    expect([dup.status, dup.body.error?.message]).toEqual([401, 'Session ended']);
    expect((await refresh(cookieOf(rotated))).status).toBe(401);
    expect(await live(x.user.id)).toBe(0);
    const yr = await refresh(yCookie);
    expect(yr.status).toBe(200);
    expect(JSON.parse(Buffer.from(yr.body.accessToken!.split('.')[1]!, 'base64url').toString()).sub).toBe(y.user.id);
  });

  it('account changes: a block or a password change between the rotation and the duplicate → plain 401, no grace', async () => {
    const u = await owner();
    const c = await login(u.username);
    expect((await refresh(c)).status).toBe(200);
    // what admin setUserStatus(BLOCKED) does
    await db.user.update({ where: { id: u.user.id }, data: { status: 'BLOCKED' } });
    await db.session.updateMany({ where: { userId: u.user.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'BLOCKED' } });
    const dup = await refresh(c);
    expect([dup.status, dup.body.error?.message]).toEqual([401, 'Account unavailable']);

    const v = await owner();
    const tab = await login(v.username);
    const here = await api.post('/api/auth/login').set('User-Agent', UA).send({ login: v.username, password: TEST_PASSWORD });
    expect((await refresh(tab)).status).toBe(200);
    const pw = await api.post('/api/auth/password').set('Authorization', bearer(here.body.accessToken)).send({ current: TEST_PASSWORD, next: 'N3w-Passw0rd' });
    expect(pw.status).toBe(204);
    const dup2 = await refresh(tab);
    expect([dup2.status, dup2.body.error?.message]).toEqual([401, 'Session ended']);
    expect(await live(v.user.id)).toBe(1); // the session that changed the password
  });

  it('impersonation end is a deliberate revoke: a duplicate of a rotated impersonation token gets no grace', async () => {
    const u = await owner();
    const sa = await createUser({ level: 'SUPER_ADMIN' });
    const raw = 'imp-raw-token-for-test';
    await db.session.create({ data: { userId: u.user.id, impersonatorId: sa.user.id, refreshTokenHash: createHash('sha256').update(raw).digest('hex'), expiresAt: new Date(Date.now() + 3600_000) } });
    const first = await auth.refresh(raw, { userAgent: UA });
    expect((await auth.refresh(raw, { userAgent: UA })).refreshToken).toBe(first.refreshToken); // grace while it lasts
    await endImpersonation(sa.user.id);
    await expect(auth.refresh(raw, { userAgent: UA })).rejects.toMatchObject({ status: 401, message: 'Session ended' });
    await expect(auth.refresh(first.refreshToken, { userAgent: UA })).rejects.toMatchObject({ status: 401, message: 'Session ended' });
  });
});
