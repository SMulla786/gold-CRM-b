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

  // G7 closure (A3) peer-review notes: a code match and a name match on one district; a district whose LGD code moved state
  const lgd = (rows: [stateName: string, code: number, name: string][]) =>
    ['S.No.,State Code,State Name (In English),District Code,District Name(In English),Census 2001 Code,Census 2011 Code', ...rows.map(([st, code, name], i) => `${i + 1},0,${st},${code},${name},0,0`)].join('\n');

  it('two source rows on one district — one by LGD code, one by name: the code keeps it, the other becomes a district of its own (either order), nothing overwritten', async () => {
    for (const order of [0, 1]) {
      await db.district.deleteMany();
      const old = await db.district.create({ data: { stateId: MH, name: 'Aurangabad', lgdCode: 466 } });
      const rows: [string, number, string][] = [['Maharashtra', 466, 'Chhatrapati Sambhajinagar'], ['Maharashtra', 9466, 'Aurangabad']];
      const csv = lgd(order ? rows.reverse() : rows);

      const dry = await importDistricts(db, { apply: false, csv });
      expect([dry.created, dry.updated, dry.nameTaken]).toEqual([1, [{ id: old.id, from: `${MH}:Aurangabad`, to: `${MH}:Chhatrapati Sambhajinagar` }], [{ lgdCode: 9466, stateId: MH, name: 'Aurangabad', districtId: old.id, created: true }]]);
      expect(await db.district.count()).toBe(1); // a dry run writes nothing

      await importDistricts(db, { apply: true, csv });
      const all = (await db.district.findMany({ orderBy: { id: 'asc' } })).map((d) => [d.id === old.id, d.stateId, d.name, d.lgdCode]);
      expect(all).toEqual([[true, MH, 'Chhatrapati Sambhajinagar', 466], [false, MH, 'Aurangabad', 9466]]);
    }
  });

  it('a name match whose name another district keeps is reported, not created (no unique-name clash), and that district is untouched', async () => {
    const old = await db.district.create({ data: { stateId: MH, name: 'Pune', lgdCode: 490 } });
    const r = await importDistricts(db, { apply: true, csv: lgd([['Maharashtra', 9490, 'Pune'], ['Maharashtra', 490, 'Pune']]) });
    expect([r.created, r.updated, r.unchanged, r.nameTaken]).toEqual([0, [], 1, [{ lgdCode: 9490, stateId: MH, name: 'Pune', districtId: old.id, created: false }]]);
    expect((await db.district.findMany()).map((d) => [d.id, d.name, d.lgdCode])).toEqual([[old.id, 'Pune', 490]]);
  });

  it('a district whose LGD code moved to another state: updated in place, reported as moved with its references — which keep their state (never rewritten)', async () => {
    const d = await db.district.create({ data: { stateId: GOA, name: 'Kushavati', lgdCode: 9999 } });
    const { business, root } = await createBusiness();
    await db.branch.update({ where: { id: root.id }, data: { stateId: GOA, districtId: d.id } });
    await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'P', mobile: '9000000009', countryCode: '+91', stateId: GOA, districtId: d.id } });
    const csv = lgd([['Maharashtra', 9999, 'Kushavati']]);

    const dry = await importDistricts(db, { apply: false, csv });
    expect(dry.movedState).toEqual([{ id: d.id, name: 'Kushavati', lgdCode: 9999, fromStateId: GOA, toStateId: MH, references: 2 }]);
    expect((await db.district.findUniqueOrThrow({ where: { id: d.id } })).stateId).toBe(GOA);

    const r = await importDistricts(db, { apply: true, csv });
    expect(r.movedState).toEqual(dry.movedState);
    expect((await db.district.findUniqueOrThrow({ where: { id: d.id } })).stateId).toBe(MH);
    const branch = await db.branch.findUniqueOrThrow({ where: { id: root.id } });
    expect([branch.stateId, branch.districtId]).toEqual([GOA, d.id]);
    expect(await db.party.count({ where: { stateId: GOA, districtId: d.id } })).toBe(1);
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
