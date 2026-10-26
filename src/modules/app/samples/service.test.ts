import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import * as samples from './service';
import type { TenantContext } from '../../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['inventory'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const ctx = ctxFor(business.id, root.id);
  const customer = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust Sample', mobile: '9000000001', countryCode: '+91' } });
  const karigar = await db.party.create({ data: { businessId: business.id, type: 'KARIGAR', name: 'Karigar Sample', mobile: '9000000002', countryCode: '+91' } });
  return { business, root, ctx, customer, karigar };
}

describe('samples (custody register)', () => {
  it('create defaults fine = gross × tounch / 100 (3 dp) and numbers per branch from 1', async () => {
    const s = await setup();
    const a = await samples.createSample(s.ctx, { metal: 'GOLD', grossWt: 10.123, tounchPercent: 91.67, partyId: s.customer.id });
    expect(a.sampleNo).toBe(1);
    expect(a.fine).toBe('9.280'); // 10.123 × 0.9167 = 9.2797… → 9.280
    expect(a.status).toBe('IN_HAND');
    expect(a.party).toEqual({ id: s.customer.id, name: 'Cust Sample' });
    expect(a.movements.map((m) => m.action)).toEqual(['CREATED']);
    const b = await samples.createSample(s.ctx, { metal: 'SILVER', grossWt: 5, tounchPercent: 80, fine: 3.9 });
    expect(b.sampleNo).toBe(2);
    expect(b.fine).toBe('3.900'); // explicit fine kept
  });

  it('lifecycle create → issue → return → melt; movements logged; no ledger rows', async () => {
    const s = await setup();
    const a = await samples.createSample(s.ctx, { metal: 'GOLD', grossWt: 2, tounchPercent: 75 });
    const issued = await samples.issueSample(s.ctx, a.id, { karigarId: s.karigar.id, note: 'for melting test' });
    expect(issued.status).toBe('ISSUED');
    expect(issued.karigar?.id).toBe(s.karigar.id);
    const returned = await samples.returnSample(s.ctx, a.id, {});
    expect(returned.status).toBe('RETURNED');
    const reissued = await samples.issueSample(s.ctx, a.id, {});
    expect(reissued.status).toBe('ISSUED');
    const melted = await samples.meltSample(s.ctx, a.id, { note: 'melted in kacha' });
    expect(melted.status).toBe('MELTED');
    expect(melted.movements.map((m) => m.action)).toEqual(['CREATED', 'ISSUED', 'RETURNED', 'ISSUED', 'MELTED']);
    expect(melted.movements[1]!.karigar?.name).toBe('Karigar Sample');
    expect(await db.ledgerEntry.count()).toBe(0);
    expect(await db.activityLog.count({ where: { module: 'SAMPLE' } })).toBe(5);
  });

  it('illegal transitions → 409 (return while in hand, issue twice, anything after melt, edit while issued)', async () => {
    const s = await setup();
    const a = await samples.createSample(s.ctx, { metal: 'GOLD', grossWt: 1, tounchPercent: 90 });
    await expect(samples.returnSample(s.ctx, a.id, {})).rejects.toMatchObject({ status: 409 });
    await samples.issueSample(s.ctx, a.id, {});
    await expect(samples.issueSample(s.ctx, a.id, {})).rejects.toMatchObject({ status: 409 });
    await expect(samples.updateSample(s.ctx, a.id, { note: 'x' })).rejects.toMatchObject({ status: 409 });
    await samples.meltSample(s.ctx, a.id, {});
    await expect(samples.meltSample(s.ctx, a.id, {})).rejects.toMatchObject({ status: 409 });
    await expect(samples.issueSample(s.ctx, a.id, {})).rejects.toMatchObject({ status: 409 });
    await expect(samples.returnSample(s.ctx, a.id, {})).rejects.toMatchObject({ status: 409 });
  });

  it('two concurrent issues → one wins, one 409', async () => {
    const s = await setup();
    const a = await samples.createSample(s.ctx, { metal: 'GOLD', grossWt: 1, tounchPercent: 90 });
    const results = await Promise.allSettled([samples.issueSample(s.ctx, a.id, {}), samples.issueSample(s.ctx, a.id, {})]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as { status: number }).status === 409)).toHaveLength(1);
    expect(await db.sampleMovement.count({ where: { sampleId: a.id, action: 'ISSUED' } })).toBe(1);
  });

  it('edit recomputes fine when gross/tounch change; null clears party', async () => {
    const s = await setup();
    const a = await samples.createSample(s.ctx, { metal: 'GOLD', grossWt: 10, tounchPercent: 90, partyId: s.customer.id });
    const e = await samples.updateSample(s.ctx, a.id, { tounchPercent: 80, partyId: null });
    expect(e.fine).toBe('8.000');
    expect(e.party).toBeNull();
    expect(e.movements.at(-1)!.action).toBe('EDITED');
  });

  it('non-karigar as karigar → 400; cross-tenant party → 404; cross-tenant sample → 404', async () => {
    const s = await setup('A');
    const b = await setup('B');
    await expect(samples.createSample(s.ctx, { metal: 'GOLD', grossWt: 1, tounchPercent: 90, karigarId: s.customer.id })).rejects.toMatchObject({ status: 400 });
    await expect(samples.createSample(s.ctx, { metal: 'GOLD', grossWt: 1, tounchPercent: 90, partyId: b.customer.id })).rejects.toMatchObject({ status: 404 });
    const bs = await samples.createSample(b.ctx, { metal: 'GOLD', grossWt: 1, tounchPercent: 90 });
    await expect(samples.getSample(s.ctx, bs.id)).rejects.toMatchObject({ status: 404 });
    await expect(samples.issueSample(s.ctx, bs.id, {})).rejects.toMatchObject({ status: 404 });
    await expect(samples.meltSample(s.ctx, bs.id, {})).rejects.toMatchObject({ status: 404 });
    await expect(samples.updateSample(s.ctx, bs.id, { note: 'x' })).rejects.toMatchObject({ status: 404 });
    expect((await samples.listSamples(s.ctx, { page: 1, pageSize: 20 })).total).toBe(0);
  });

  it('list filters + q (sample no / party name / note; a 10-digit number never hits sampleNo) and picker search defaults', async () => {
    const s = await setup();
    const a = await samples.createSample(s.ctx, { metal: 'GOLD', grossWt: 1, tounchPercent: 90, partyId: s.customer.id });
    const b = await samples.createSample(s.ctx, { metal: 'SILVER', grossWt: 2, tounchPercent: 70, note: 'payal lot' });
    await samples.meltSample(s.ctx, b.id, {});
    const page = { page: 1, pageSize: 20 };
    expect((await samples.listSamples(s.ctx, { ...page, q: 'cust' })).items.map((x) => x.id)).toEqual([a.id]);
    expect((await samples.listSamples(s.ctx, { ...page, q: '#2' })).items.map((x) => x.id)).toEqual([b.id]);
    expect((await samples.listSamples(s.ctx, { ...page, q: 'payal' })).items.map((x) => x.id)).toEqual([b.id]);
    expect((await samples.listSamples(s.ctx, { ...page, q: '9876543210' })).total).toBe(0);
    expect((await samples.listSamples(s.ctx, { ...page, status: 'MELTED' })).items.map((x) => x.id)).toEqual([b.id]);
    expect((await samples.listSamples(s.ctx, { ...page, metal: 'GOLD' })).items.map((x) => x.id)).toEqual([a.id]);
    expect((await samples.searchSamples(s.ctx, { limit: 20 })).map((x) => x.id)).toEqual([a.id]); // MELTED excluded by default
    expect((await samples.searchSamples(s.ctx, { limit: 20, statuses: ['MELTED'] })).map((x) => x.id)).toEqual([b.id]);
  });
});
