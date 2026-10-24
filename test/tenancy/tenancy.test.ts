import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBranch, createBusiness, createPlan, createSubscription, createUser } from '../helpers/factory';

// Verifies TASK-4 (tenant scoping extension + guards). Red until that lands; green after.
// See backend/test/PLAN.md §2. Cross-tenant/subtree hiding -> 404 NOT_FOUND (never reveal existence).

/** Business A: HQ(root,adminNode) -> Pune(adminNode) -> Kothrud; HQ -> Mumbai.
 *  Users: owner@HQ (ADMIN), puneAdmin@Pune (ADMIN), cashier@Kothrud (BRANCH_USER). */
async function buildBusinessA(sub?: { maxBranches?: number; maxUsers?: number; status?: 'ACTIVE' | 'CANCELLED'; endsAt?: Date; modules?: string[] }) {
  const plan = await createPlan({ maxBranches: sub?.maxBranches ?? 10, maxUsers: sub?.maxUsers ?? 10 });
  const { business, root } = await createBusiness({ name: 'A' });
  await createSubscription({
    businessId: business.id,
    planId: plan.id,
    status: sub?.status,
    endsAt: sub?.endsAt,
    maxBranches: sub?.maxBranches ?? 10,
    maxUsers: sub?.maxUsers ?? 10,
    modules: sub?.modules,
  });
  const pune = await createBranch({ businessId: business.id, parentId: root.id, name: 'Pune', isAdminNode: true });
  const kothrud = await createBranch({ businessId: business.id, parentId: pune.id, name: 'Kothrud' });
  const mumbai = await createBranch({ businessId: business.id, parentId: root.id, name: 'Mumbai' });
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
  const puneAdmin = await createUser({ businessId: business.id, branchId: pune.id, level: 'ADMIN' });
  const cashier = await createUser({ businessId: business.id, branchId: kothrud.id, level: 'BRANCH_USER' });
  return { plan, business, root, pune, kothrud, mumbai, owner, puneAdmin, cashier };
}

/** Business B: HQ(root) + one extra branch + owner + a counter. Separate tenant. */
async function buildBusinessB() {
  const plan = await createPlan();
  const { business, root } = await createBusiness({ name: 'B' });
  await createSubscription({ businessId: business.id, planId: plan.id });
  const branch = await createBranch({ businessId: business.id, parentId: root.id, name: 'B-Shop' });
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
  const counter = await db.counter.create({ data: { businessId: business.id, branchId: branch.id, name: 'B-Counter-1' } });
  return { business, root, branch, owner, counter };
}

async function superAdmin() {
  return createUser({ level: 'SUPER_ADMIN' });
}

beforeEach(truncateAll);

describe('(a) cross-tenant / cross-branch access by id -> 404', () => {
  it('T-a1 admin of A cannot GET a user of B by id', async () => {
    const a = await buildBusinessA();
    const b = await buildBusinessB();
    const { token } = await loginAs(a.owner.username);
    const res = await api.get(`/api/admin/users/${b.owner.user.id}`).set('Authorization', bearer(token!));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('T-a2 admin of A cannot PATCH a branch of B (B unchanged)', async () => {
    const a = await buildBusinessA();
    const b = await buildBusinessB();
    const { token } = await loginAs(a.owner.username);
    const res = await api
      .patch(`/api/admin/branches/${b.branch.id}`)
      .set('Authorization', bearer(token!))
      .send({ name: 'hacked' });
    expect(res.status).toBe(404);
    const after = await db.branch.findUniqueOrThrow({ where: { id: b.branch.id } });
    expect(after.name).toBe('B-Shop');
  });

  it('T-a3 branch-admin at Pune cannot read sibling Mumbai counters (out of subtree)', async () => {
    const a = await buildBusinessA();
    const { token } = await loginAs(a.puneAdmin.username);
    const res = await api
      .get(`/api/admin/counters?branchId=${a.mumbai.id}`)
      .set('Authorization', bearer(token!));
    expect(res.status).toBe(404);
  });

  it('T-a5 admin list is scoped to own subtree (no B users leak)', async () => {
    const a = await buildBusinessA();
    const b = await buildBusinessB();
    const { token } = await loginAs(a.owner.username);
    const res = await api.get('/api/admin/users').set('Authorization', bearer(token!));
    expect(res.status).toBe(200);
    const ids = (res.body.items as { id: number }[]).map((x) => x.id);
    expect(ids).not.toContain(b.owner.user.id);
    expect(ids).toEqual(expect.arrayContaining([a.owner.user.id, a.puneAdmin.user.id, a.cashier.user.id]));
  });
});

describe('(b) admin consolidation & branch-admin subtree', () => {
  it.todo('T-b1 admin consolidated totals = sum of branches (needs a consolidated totals endpoint — later phase)');

  it('T-b2 owner admin sees the whole branch tree', async () => {
    const a = await buildBusinessA();
    const { token } = await loginAs(a.owner.username);
    const res = await api.get('/api/admin/branches').set('Authorization', bearer(token!));
    expect(res.status).toBe(200);
    const flat = JSON.stringify(res.body);
    for (const name of ['HQ', 'Pune', 'Kothrud', 'Mumbai']) expect(flat).toContain(name);
  });

  it('T-b3 branch-admin tree is rooted at own node (no parent/sibling)', async () => {
    const a = await buildBusinessA();
    const { token } = await loginAs(a.puneAdmin.username);
    const res = await api.get('/api/admin/branches').set('Authorization', bearer(token!));
    expect(res.status).toBe(200);
    const flat = JSON.stringify(res.body);
    expect(flat).toContain('Pune');
    expect(flat).toContain('Kothrud');
    expect(flat).not.toContain('Mumbai'); // sibling
    expect(flat).not.toContain('"name":"HQ"'); // parent root
  });

  it('T-b4 branch-admin can create a sub-branch under its node', async () => {
    const a = await buildBusinessA();
    const { token } = await loginAs(a.puneAdmin.username);
    const res = await api
      .post('/api/admin/branches')
      .set('Authorization', bearer(token!))
      .send({ parentId: a.pune.id, name: 'Hadapsar' });
    expect([200, 201]).toContain(res.status);
  });

  it('T-b5 plain BRANCH_USER cannot create a branch -> 403 FORBIDDEN', async () => {
    const a = await buildBusinessA();
    const { token } = await loginAs(a.cashier.username);
    const res = await api
      .post('/api/admin/branches')
      .set('Authorization', bearer(token!))
      .send({ parentId: a.kothrud.id, name: 'Nope' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('T-b6 moving a branch updates subtree access', async () => {
    const a = await buildBusinessA();
    const { token } = await loginAs(a.owner.username);
    // move Kothrud from under Pune to under Mumbai
    const mv = await api
      .post(`/api/admin/branches/${a.kothrud.id}/move`)
      .set('Authorization', bearer(token!))
      .send({ newParentId: a.mumbai.id });
    expect([200, 204]).toContain(mv.status);
    const moved = await db.branch.findUniqueOrThrow({ where: { id: a.kothrud.id } });
    expect(moved.path.startsWith(a.mumbai.path)).toBe(true);
    expect(moved.path.startsWith(a.pune.path)).toBe(false);
  });
});

describe('(c) subscription read-only guard', () => {
  it('T-c1 expired subscription -> non-GET admin write 403 READ_ONLY', async () => {
    const a = await buildBusinessA({ endsAt: new Date(Date.now() - 864e5) }); // ended yesterday
    const { token } = await loginAs(a.owner.username);
    const res = await api
      .post('/api/admin/users')
      .set('Authorization', bearer(token!))
      .send({ name: 'Blocked Write', username: 'blocked-write', password: 'Passw0rd!', level: 'BRANCH_USER', branchId: a.kothrud.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('READ_ONLY');
  });

  it('T-c2 expired subscription -> GETs still work (200)', async () => {
    const a = await buildBusinessA({ endsAt: new Date(Date.now() - 864e5) });
    const { token } = await loginAs(a.owner.username);
    const res = await api.get('/api/admin/branches').set('Authorization', bearer(token!));
    expect(res.status).toBe(200);
  });

  it('T-c3 active subscription -> write allowed (control)', async () => {
    const a = await buildBusinessA();
    const { token } = await loginAs(a.owner.username);
    const res = await api
      .post('/api/admin/branches')
      .set('Authorization', bearer(token!))
      .send({ parentId: a.root.id, name: 'Nashik' });
    expect([200, 201]).toContain(res.status);
  });

  it.todo('T-c4 module not in plan -> 403 MODULE_DISABLED (needs a module-gated /app route — later phase)');
});

describe('(d) plan-limit guards', () => {
  it('T-d1 at branch limit -> POST branch 403 PLAN_LIMIT (none created)', async () => {
    const a = await buildBusinessA({ maxBranches: 4 }); // HQ+Pune+Kothrud+Mumbai = 4, at limit
    const before = await db.branch.count({ where: { businessId: a.business.id } });
    const { token } = await loginAs(a.owner.username);
    const res = await api
      .post('/api/admin/branches')
      .set('Authorization', bearer(token!))
      .send({ parentId: a.root.id, name: 'Overflow' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLAN_LIMIT');
    expect(await db.branch.count({ where: { businessId: a.business.id } })).toBe(before);
  });

  it('T-d2 at user limit -> POST user 403 PLAN_LIMIT (none created)', async () => {
    const a = await buildBusinessA({ maxUsers: 3 }); // owner+puneAdmin+cashier = 3, at limit
    const before = await db.user.count({ where: { businessId: a.business.id } });
    const { token } = await loginAs(a.owner.username);
    const res = await api
      .post('/api/admin/users')
      .set('Authorization', bearer(token!))
      .send({ name: 'Overflow User', username: 'overflow-user', password: 'Passw0rd!', level: 'BRANCH_USER', branchId: a.kothrud.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLAN_LIMIT');
    expect(await db.user.count({ where: { businessId: a.business.id } })).toBe(before);
  });
});

describe('(e) super-admin impersonation auditing', () => {
  it('T-e1 impersonate writes an ImpersonationLog row', async () => {
    const sa = await superAdmin();
    const b = await buildBusinessB();
    const { token } = await loginAs(sa.username);
    const before = await db.impersonationLog.count();
    const res = await api
      .post(`/api/platform/businesses/${b.business.id}/impersonate`)
      .set('Authorization', bearer(token!))
      .send({ reason: 'support' });
    expect([200, 201]).toContain(res.status);
    expect(res.body.accessToken).toBeDefined();
    expect(await db.impersonationLog.count()).toBe(before + 1);
  });

  it('T-e2 super-admin hitting a tenant/admin route directly -> 403 FORBIDDEN', async () => {
    const sa = await superAdmin();
    const { token } = await loginAs(sa.username);
    const res = await api.get('/api/admin/branches').set('Authorization', bearer(token!));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
