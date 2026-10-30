import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBranch, createBusiness, createPlan, createSubscription, createUser } from '../helpers/factory';

// ADM-05 (TASK-94) branch dialog details + counters, ADM-06 (TASK-96) user status tabs — over HTTP as the owner.

async function setup(name = 'A') {
  const plan = await createPlan();
  const { business, root } = await createBusiness({ name });
  await createSubscription({ businessId: business.id, planId: plan.id });
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
  const auth = bearer((await loginAs(owner.username)).token!);
  return { business, root, owner, auth };
}
async function geo() {
  const mh = await db.state.create({ data: { id: 27, name: 'Maharashtra' } });
  const gj = await db.state.create({ data: { id: 24, name: 'Gujarat' } });
  const pune = await db.district.create({ data: { stateId: mh.id, name: 'Pune' } });
  const surat = await db.district.create({ data: { stateId: gj.id, name: 'Surat' } });
  return { mh, gj, pune, surat };
}
type Node = { id: number; children: Node[] } & Record<string, unknown>;
const find = (n: Node, id: number): Node | undefined => (n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean));

beforeEach(truncateAll);

describe('branch dialog details (ADM-05)', () => {
  it('incharge, mobile, GSTIN (upper-cased), state, district, address, disclaimer: saved on create, shown in the tree, editable', async () => {
    const s = await setup();
    const g = await geo();
    const body = { parentId: s.root.id, name: 'Pune Camp', code: 'PC', inchargeName: 'Suresh', mobile: '9876543210', gstin: '27aapfu0939f1zv', stateId: g.mh.id, districtId: g.pune.id, address: 'MG Road', disclaimer: 'Goods once sold…' };
    const made = await api.post('/api/admin/branches').set('Authorization', s.auth).send(body);
    expect(made.status).toBe(201);
    const tree = await api.get('/api/admin/branches').set('Authorization', s.auth);
    expect(find(tree.body, made.body.id)).toMatchObject({ ...body, gstin: '27AAPFU0939F1ZV', countryCode: '+91', parentId: s.root.id });

    const upd = await api.patch(`/api/admin/branches/${made.body.id}`).set('Authorization', s.auth).send({ inchargeName: 'Ramesh', gstin: '24AAPFU0939F1ZX', stateId: g.gj.id, districtId: g.surat.id });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ inchargeName: 'Ramesh', gstin: '24AAPFU0939F1ZX', stateId: g.gj.id, districtId: g.surat.id, address: 'MG Road' });
  });

  it('bad GSTIN / mobile → 400 and nothing is written', async () => {
    const s = await setup();
    const post = (o: Record<string, unknown>) => api.post('/api/admin/branches').set('Authorization', s.auth).send({ parentId: s.root.id, name: 'X Branch', ...o });
    expect((await post({ gstin: '27AAPFU0939F1Z' })).status).toBe(400);
    expect((await post({ mobile: '98765' })).status).toBe(400);
    expect(await db.branch.count({ where: { businessId: s.business.id } })).toBe(1);
  });

  // Known gap (sent to the lead): state/district ids are not checked — an unknown id hits the FK (P2003, unmapped → 500)
  // and a district from another state is saved as is. it.fails pins it; flip with the fix.
  it('an unknown state id → 400', async () => {
    const s = await setup();
    const res = await api.post('/api/admin/branches').set('Authorization', s.auth).send({ parentId: s.root.id, name: 'X Branch', stateId: 99 });
    expect(res.status).toBe(400);
  });
  it('a district from another state → 400', async () => {
    const s = await setup();
    const g = await geo();
    const res = await api.post('/api/admin/branches').set('Authorization', s.auth).send({ parentId: s.root.id, name: 'X Branch', stateId: g.mh.id, districtId: g.surat.id });
    expect(res.status).toBe(400);
  });
});

describe('counters (ADM-05)', () => {
  it('per branch: create, list (all or one branch), duplicate name in a branch → 409, same name in another branch is fine', async () => {
    const s = await setup();
    const b2 = await createBranch({ businessId: s.business.id, parentId: s.root.id, name: 'B2' });
    const post = (branchId: number, name: string) => api.post('/api/admin/counters').set('Authorization', s.auth).send({ branchId, name });
    expect((await post(s.root.id, 'Counter 1')).status).toBe(201);
    expect((await post(s.root.id, 'Counter 1')).status).toBe(409);
    expect((await post(b2.id, 'Counter 1')).status).toBe(201);
    expect((await post(s.root.id, '')).status).toBe(400);

    const all = await api.get('/api/admin/counters').set('Authorization', s.auth);
    expect((all.body as { branchName: string; name: string }[]).map((c) => `${c.branchName}/${c.name}`)).toEqual(['HQ/Counter 1', 'B2/Counter 1']);
    const one = await api.get(`/api/admin/counters?branchId=${b2.id}`).set('Authorization', s.auth);
    expect((one.body as { branchId: number }[]).map((c) => c.branchId)).toEqual([b2.id]);
  });

  it('another business: its branch and its counters are 404 — list, create, rename, deactivate', async () => {
    const a = await setup('A');
    const b = await setup('B');
    const theirs = await api.post('/api/admin/counters').set('Authorization', b.auth).send({ branchId: b.root.id, name: 'Theirs' });
    expect((await api.get(`/api/admin/counters?branchId=${b.root.id}`).set('Authorization', a.auth)).status).toBe(404);
    expect((await api.post('/api/admin/counters').set('Authorization', a.auth).send({ branchId: b.root.id, name: 'Mine' })).status).toBe(404);
    expect((await api.patch(`/api/admin/counters/${theirs.body.id}`).set('Authorization', a.auth).send({ name: 'Hacked' })).status).toBe(404);
    expect((await api.patch(`/api/admin/counters/${theirs.body.id}`).set('Authorization', a.auth).send({ isActive: false })).status).toBe(404);
    expect(await db.counter.findUniqueOrThrow({ where: { id: theirs.body.id } })).toMatchObject({ name: 'Theirs', isActive: true });
    expect((await api.get('/api/admin/counters').set('Authorization', a.auth)).body).toEqual([]);
  });
});

describe('user status tabs (ADM-06)', () => {
  it('default = everyone but trashed; ACTIVE / BLOCKED / DELETED tabs each list only their users, with matching totals', async () => {
    const s = await setup();
    const mk = () => createUser({ businessId: s.business.id, branchId: s.root.id, level: 'BRANCH_USER' });
    const [blocked, trashed, active] = [await mk(), await mk(), await mk()];
    expect((await api.post(`/api/admin/users/${blocked.user.id}/block`).set('Authorization', s.auth)).status).toBe(204);
    expect((await api.delete(`/api/admin/users/${trashed.user.id}`).set('Authorization', s.auth)).status).toBe(204);

    const tab = async (status?: string) => {
      const r = await api.get(`/api/admin/users${status ? `?status=${status}` : ''}`).set('Authorization', s.auth);
      expect(r.body.total).toBe(r.body.items.length);
      return (r.body.items as { id: number }[]).map((u) => u.id);
    };
    expect(await tab()).toEqual([s.owner.user.id, blocked.user.id, active.user.id]);
    expect(await tab('ACTIVE')).toEqual([s.owner.user.id, active.user.id]);
    expect(await tab('BLOCKED')).toEqual([blocked.user.id]);
    expect(await tab('DELETED')).toEqual([trashed.user.id]);
    expect((await api.get('/api/admin/users?status=GONE').set('Authorization', s.auth)).status).toBe(400);

    // unblock moves the user back to the ACTIVE tab
    await api.post(`/api/admin/users/${blocked.user.id}/unblock`).set('Authorization', s.auth);
    expect(await tab('BLOCKED')).toEqual([]);
  });
});
