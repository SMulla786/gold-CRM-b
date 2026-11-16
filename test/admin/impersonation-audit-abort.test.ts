import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createPlan, createSubscription, createUser } from '../helpers/factory';

// G7 closure: the impersonation audit row was written on res 'finish', which never fires when the client hangs up before the
// response — yet the handler still runs its write. A Super Admin could make an unaudited change by dropping the connection.

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function until<T>(read: () => Promise<T | null | undefined>, what: string, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('impersonation audit when the client aborts', () => {
  it('a write whose client disconnected before the response is still audited with both identities and its real status', async () => {
    const plan = await createPlan();
    const { business, root } = await createBusiness();
    await createSubscription({ businessId: business.id, planId: plan.id });
    const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
    const sa = await createUser({ level: 'SUPER_ADMIN' });
    const saAuth = bearer((await loginAs(sa.username)).token!);
    const imp = await api.post(`/api/platform/businesses/${business.id}/impersonate`).set('Authorization', saAuth).send({ reason: 'support' });
    expect(imp.status).toBe(201);

    // hold the Business row so the PATCH stops at its update, mid-request
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const gotLock = new Promise<void>((r) => (locked = r));
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Business" WHERE id = ${business.id} FOR UPDATE`;
      locked();
      await held;
    }, { timeout: 20_000 });
    await gotLock;

    const server = http.createServer(createApp()).listen(0);
    await new Promise((r) => server.once('listening', r));
    const body = JSON.stringify({ address: 'Shop 9, Station Road' });
    const req = http.request({
      port: (server.address() as AddressInfo).port, method: 'PATCH', path: '/api/admin/business',
      headers: { Authorization: bearer(imp.body.accessToken as string), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {}); // we hang up on purpose
    req.end(body);
    await until(async () => (await db.$queryRaw<{ c: number }[]>`SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.c > 0, 'the PATCH to wait on the row');
    req.destroy(); // the client gives up before any response
    await new Promise((r) => setTimeout(r, 100));
    release();
    await holder;

    // the write went through…
    await until(async () => (await db.business.findUniqueOrThrow({ where: { id: business.id } })).address === 'Shop 9, Station Road', 'the address to change');
    // …so its audit row must exist too
    const row = await until(() => db.activityLog.findFirst({ where: { module: 'IMPERSONATION', businessId: business.id } }), 'the impersonation audit row', 3000).catch((e: Error) => e);
    server.close();
    expect(row).not.toBeInstanceOf(Error);
    const r = row as { userId: number | null; entityId: string; meta: unknown };
    expect([r.userId, r.entityId, r.meta]).toEqual([
      owner.user.id,
      'PATCH /api/admin/business',
      { impersonatorId: sa.user.id, impersonatedUserId: owner.user.id, method: 'PATCH', path: '/api/admin/business', status: 200 },
    ]);

    // an ordinary (not aborted) write is still logged exactly once
    expect((await api.patch('/api/admin/business').set('Authorization', bearer(imp.body.accessToken as string)).send({ address: 'Shop 10' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect((await db.activityLog.findMany({ where: { module: 'IMPERSONATION' }, orderBy: { id: 'asc' } })).map((x) => (x.meta as { status: number }).status)).toEqual([200, 200]);
  });
});
