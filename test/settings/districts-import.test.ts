import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createPlan, createSubscription, createUser } from '../helpers/factory';
import { importDistricts } from '../../prisma/districts';
import { INDIAN_STATES } from '../../src/shared';

// G7 review 2: the LGD district master (prisma/data/lgd-districts.csv) loads idempotently, keeps existing ids and
// references, and drives state → district filtering and the branch district.

const MH = 27; // GST code
const GOA = 30;

beforeEach(async () => {
  await truncateAll();
  await db.state.createMany({ data: INDIAN_STATES.map((s) => ({ id: s.code, name: s.name })) });
});
afterAll(() => db.$disconnect());

describe('LGD district import', () => {
  it('loads all 790 districts of the 36 states / UTs; a second run changes nothing; a dry run writes nothing', async () => {
    const dry = await importDistricts(db, { apply: false });
    expect([dry.sourceRows, dry.created, await db.district.count()]).toEqual([790, 790, 0]);

    const first = await importDistricts(db, { apply: true });
    expect([first.created, first.updated.length, first.unchanged]).toEqual([790, 0, 0]);
    const perState = await db.district.groupBy({ by: ['stateId'], _count: true });
    expect(perState).toHaveLength(36); // every state / UT has its districts
    expect(await db.district.count({ where: { lgdCode: null } })).toBe(0);

    const again = await importDistricts(db, { apply: true });
    expect([again.created, again.updated.length, again.unchanged, again.notInSource.length]).toEqual([0, 0, 790, 0]);
    expect(await db.district.count()).toBe(790);
  });

  it('keeps existing ids and references: an older spelling is linked in place; a district LGD does not list is kept and reported', async () => {
    const pune = await db.district.create({ data: { stateId: MH, name: 'PUNE' } });
    const legacy = await db.district.create({ data: { stateId: MH, name: 'Old Legacy District' } });
    const { business, root } = await createBusiness();
    await db.branch.update({ where: { id: root.id }, data: { stateId: MH, districtId: pune.id } });
    await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'P', mobile: '9000000009', countryCode: '+91', stateId: MH, districtId: legacy.id } });

    const r = await importDistricts(db, { apply: true });
    expect([r.created, r.updated]).toEqual([789, [{ id: pune.id, from: `${MH}:PUNE`, to: `${MH}:Pune` }]]);
    expect(r.notInSource).toEqual([{ id: legacy.id, stateId: MH, name: 'Old Legacy District', references: 1 }]);
    const p = await db.district.findUniqueOrThrow({ where: { id: pune.id } });
    expect([p.name, p.lgdCode]).toEqual(['Pune', 490]);
    expect((await db.branch.findUniqueOrThrow({ where: { id: root.id } })).districtId).toBe(pune.id);
    expect(await db.district.findUnique({ where: { id: legacy.id } })).not.toBeNull();
  });

  it('state → district filtering, and a branch saves, reloads and refuses a district of another state', async () => {
    await importDistricts(db, { apply: true });
    const mh = await api.get(`/api/public/states/${MH}/districts`);
    expect(mh.status).toBe(200);
    expect(mh.body).toHaveLength(36);
    expect(mh.body.map((d: { name: string }) => d.name)).toEqual(expect.arrayContaining(['Pune', 'Mumbai', 'Mumbai Suburban']));
    const goa = await api.get(`/api/public/states/${GOA}/districts`);
    expect(goa.body.map((d: { name: string }) => d.name)).toEqual(['Kushavati', 'North Goa', 'South Goa']);

    const plan = await createPlan();
    const { business, root } = await createBusiness();
    await createSubscription({ businessId: business.id, planId: plan.id });
    const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
    const as = bearer((await loginAs(owner.username)).token!);
    const pune = mh.body.find((d: { name: string }) => d.name === 'Pune') as { id: number };
    const saved = await api.patch(`/api/admin/branches/${root.id}`).set('Authorization', as).send({ stateId: MH, districtId: pune.id });
    expect(saved.status).toBe(200);
    const tree = await api.get('/api/admin/branches').set('Authorization', as);
    expect([tree.body.stateId, tree.body.districtId]).toEqual([MH, pune.id]);
    const wrong = await api.patch(`/api/admin/branches/${root.id}`).set('Authorization', as).send({ stateId: MH, districtId: goa.body[1].id });
    expect([wrong.status, wrong.body.error.message]).toEqual([400, 'District is not in the selected state']);
  });
});
