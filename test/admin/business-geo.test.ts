import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createPlan, createSubscription, createUser } from '../helpers/factory';

// G2b-D: business (and branch) state/district — both must exist and the district must be in the state; changing the
// state on its own clears a district of the old state. Same rule on platform create/update, owner update, public signup.

async function geo() {
  const mh = await db.state.create({ data: { id: 27, name: 'Maharashtra' } });
  const gj = await db.state.create({ data: { id: 24, name: 'Gujarat' } });
  const pune = await db.district.create({ data: { stateId: mh.id, name: 'Pune' } });
  const surat = await db.district.create({ data: { stateId: gj.id, name: 'Surat' } });
  return { mh, gj, pune, surat };
}
const superAuth = async () => bearer((await loginAs((await createUser({ level: 'SUPER_ADMIN' })).username)).token!);
let n = 0;
const createBody = (planId: number, o: Record<string, unknown>) => ({ name: 'Shree Jewellers', ownerName: 'Owner', mobile: '9876543210', planId, owner: { name: 'Owner', username: `geo${Date.now()}${n++}`, password: 'Passw0rd!' }, ...o });
const geoOf = (id: number) => db.business.findUniqueOrThrow({ where: { id }, select: { stateId: true, districtId: true } });

beforeEach(truncateAll);

describe('business state / district (G2b)', () => {
  it('platform create: a matching pair is saved; unknown state, unknown district or a district of another state → 400 and nothing is created', async () => {
    const g = await geo();
    const plan = await createPlan();
    const sa = await superAuth();
    const ok = await api.post('/api/platform/businesses').set('Authorization', sa).send(createBody(plan.id, { stateId: g.mh.id, districtId: g.pune.id }));
    expect(ok.status).toBe(201);
    expect(await geoOf(ok.body.id)).toEqual({ stateId: g.mh.id, districtId: g.pune.id });

    const before = await db.business.count();
    for (const bad of [{ stateId: 99 }, { stateId: g.mh.id, districtId: 9999 }, { stateId: g.mh.id, districtId: g.surat.id }]) {
      const res = await api.post('/api/platform/businesses').set('Authorization', sa).send(createBody(plan.id, bad));
      expect([res.status, res.body.error?.code]).toEqual([400, 'VALIDATION']);
    }
    expect(await db.business.count()).toBe(before);
  });

  it('platform update: mismatch → 400 and unchanged; changing the state alone clears the old district; state + district together are checked', async () => {
    const g = await geo();
    const { business } = await createBusiness({ name: 'A' });
    await db.business.update({ where: { id: business.id }, data: { stateId: g.mh.id, districtId: g.pune.id } });
    const sa = await superAuth();
    const patch = (body: Record<string, unknown>) => api.patch(`/api/platform/businesses/${business.id}`).set('Authorization', sa).send(body);

    expect((await patch({ districtId: g.surat.id })).status).toBe(400); // checked against the stored state (MH)
    expect((await patch({ stateId: 99 })).status).toBe(400);
    expect(await geoOf(business.id)).toEqual({ stateId: g.mh.id, districtId: g.pune.id });

    expect((await patch({ stateId: g.gj.id })).status).toBe(200);
    expect(await geoOf(business.id)).toEqual({ stateId: g.gj.id, districtId: null }); // Pune is not in Gujarat
    expect((await patch({ stateId: g.mh.id, districtId: g.pune.id })).status).toBe(200);
    expect((await patch({ name: 'Renamed' })).status).toBe(200); // no geo in the body → untouched
    expect(await geoOf(business.id)).toEqual({ stateId: g.mh.id, districtId: g.pune.id });
    expect((await patch({ stateId: g.gj.id, districtId: g.pune.id })).status).toBe(400);
    expect((await api.patch('/api/platform/businesses/999999').set('Authorization', sa).send({ name: 'Nobody Jewellers' })).status).toBe(404);
  });

  it('owner update (/admin/business): same rule; other businesses are never touched', async () => {
    const g = await geo();
    const plan = await createPlan();
    const { business, root } = await createBusiness({ name: 'A' });
    const other = await createBusiness({ name: 'B' });
    await db.business.update({ where: { id: other.business.id }, data: { stateId: g.gj.id, districtId: g.surat.id } });
    await createSubscription({ businessId: business.id, planId: plan.id });
    const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
    const auth = bearer((await loginAs(owner.username)).token!);
    const patch = (body: Record<string, unknown>) => api.patch('/api/admin/business').set('Authorization', auth).send(body);

    expect((await patch({ stateId: g.mh.id, districtId: g.surat.id })).status).toBe(400);
    expect((await patch({ stateId: g.mh.id, districtId: g.pune.id })).status).toBe(200);
    expect((await patch({ stateId: g.gj.id })).body).toMatchObject({ stateId: g.gj.id, districtId: null });
    expect(await geoOf(other.business.id)).toEqual({ stateId: g.gj.id, districtId: g.surat.id });
  });

  it('public signup: a district of another state → 400 and no request saved; a matching pair is accepted', async () => {
    const g = await geo();
    const body = (o: Record<string, unknown>) => ({ shopName: 'Shree', ownerName: 'Owner', whatsapp: '9876543210', address: 'Main Road', ...o });
    expect((await api.post('/api/public/signup').send(body({ stateId: g.mh.id, districtId: g.surat.id }))).status).toBe(400);
    expect((await api.post('/api/public/signup').send(body({ stateId: 99 }))).status).toBe(400);
    expect(await db.signupRequest.count()).toBe(0);
    expect((await api.post('/api/public/signup').send(body({ stateId: g.mh.id, districtId: g.pune.id }))).status).toBe(201);
  });

  it('branch update: changing the state alone clears the old district (same helper as businesses)', async () => {
    const g = await geo();
    const plan = await createPlan();
    const { business, root } = await createBusiness({ name: 'A' });
    await createSubscription({ businessId: business.id, planId: plan.id });
    const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
    const auth = bearer((await loginAs(owner.username)).token!);
    const made = await api.post('/api/admin/branches').set('Authorization', auth).send({ parentId: root.id, name: 'Geo Branch', stateId: g.mh.id, districtId: g.pune.id });
    expect(made.status).toBe(201);
    expect((await api.patch(`/api/admin/branches/${made.body.id}`).set('Authorization', auth).send({ stateId: g.gj.id })).status).toBe(200);
    expect(await db.branch.findUniqueOrThrow({ where: { id: made.body.id }, select: { stateId: true, districtId: true } })).toEqual({ stateId: g.gj.id, districtId: null });
  });
});
