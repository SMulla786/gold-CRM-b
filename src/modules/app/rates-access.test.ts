import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../../../test/helpers/app';
import { truncateAll } from '../../../test/helpers/db';
import { db } from '../../../test/helpers/db';
import { createBusiness, createPlan, createSubscription, createUser, TEST_MPIN } from '../../../test/helpers/factory';

// BUG-5: GET /app/rates/current must be readable by any tenant user (cashier/billing-only), not gated on settings.misc.
const MODULES = ['billing', 'inventory', 'daybook']; // a cashier plan WITHOUT 'settings'

beforeEach(truncateAll);

describe('BUG-5 current rates are open to any tenant user', () => {
  it('a billing-only branch user (no settings.misc, no settings module) can GET /rates/current but not the gated rate-limits', async () => {
    const plan = await createPlan({ modules: MODULES });
    const { business, root } = await createBusiness({ name: 'A' });
    await createSubscription({ businessId: business.id, planId: plan.id, modules: MODULES });
    const u = await createUser({ businessId: business.id, branchId: root.id, level: 'BRANCH_USER' });
    const { token } = await loginAs(u.username);

    const rates = await api.get('/api/app/rates/current').set('Authorization', bearer(token!));
    expect(rates.status).toBe(200);
    expect(rates.body).toHaveProperty('gold');
    expect(rates.body).toHaveProperty('silver');

    // the editing/limits side stays behind settings.misc
    const limits = await api.get('/api/app/rate-limits').set('Authorization', bearer(token!));
    expect(limits.status).toBe(403);
  });
});

// Dashboard rate card gaps: atomic POST /rates/batch, prevSellRate trend, 'rates.display' setting on GET /rates/current.
describe('rates batch + trend + display', () => {
  async function owner() {
    const mods = ['dashboard', 'settings', 'billing'];
    const plan = await createPlan({ modules: mods });
    const { business, root } = await createBusiness({ name: 'R' });
    await createSubscription({ businessId: business.id, planId: plan.id, modules: mods });
    const u = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true, mpin: TEST_MPIN });
    const { token } = await loginAs(u.username);
    const h = { Authorization: bearer(token!), 'X-Branch-Id': String(root.id) };
    return { business, root, h };
  }
  const gold = (sell: number, over: Record<string, unknown> = {}) => ({ metal: 'GOLD', rateUnit: 'GRAM_10', rates: [{ karatCode: '24K', sellRate: sell, buyRate: sell - 1000 }], ...over });
  const silver = (sell: number) => ({ metal: 'SILVER', rateUnit: 'KG_1', rates: [{ karatCode: '999', sellRate: sell, buyRate: sell - 1000 }] });

  it('saves every metal in one go with one effectiveAt; a limit breach on one metal saves nothing; override needs MPIN', async () => {
    const o = await owner();
    await db.rateLimit.deleteMany({ where: { businessId: o.business.id } });
    await db.rateLimit.create({ data: { businessId: o.business.id, metal: 'GOLD', rateUnit: 'GRAM_10', minRate: 100000, maxRate: 200000 } });
    const count = () => db.metalRate.count({ where: { businessId: o.business.id } });

    const ok = await api.post('/api/app/rates/batch').set(o.h).send({ metals: [gold(150000), silver(90000)] });
    expect(ok.status).toBe(200);
    expect(ok.body.gold.rows[0].sellRate).toBe('150000');
    expect(ok.body.silver.rows[0].sellRate).toBe('90000');
    const saved = await db.metalRate.findMany({ where: { businessId: o.business.id } });
    expect(saved).toHaveLength(2);
    expect(saved[0]!.effectiveAt.getTime()).toBe(saved[1]!.effectiveAt.getTime());

    // gold outside limits, no override → 400 and the (valid) silver is NOT saved either
    const bad = await api.post('/api/app/rates/batch').set(o.h).send({ metals: [silver(95000), gold(250000)] });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.details?.offending ?? bad.body.details?.offending).toBeTruthy();
    expect(await count()).toBe(2);

    // override without MPIN → refused, nothing written; with MPIN → saved
    const noPin = await api.post('/api/app/rates/batch').set(o.h).send({ metals: [gold(250000, { overrideLimits: true })] });
    expect(noPin.status).toBe(403);
    expect(await count()).toBe(2);
    const pin = await api.post('/api/app/rates/batch').set({ ...o.h, 'X-MPIN': TEST_MPIN }).send({ metals: [gold(250000, { overrideLimits: true })] });
    expect(pin.status).toBe(200);
    expect(await count()).toBe(3);

    // duplicate metal in one batch → 400
    const dup = await api.post('/api/app/rates/batch').set(o.h).send({ metals: [gold(150000), gold(160000)] });
    expect(dup.status).toBe(400);
  });

  it('a user without settings.misc edit cannot batch-save', async () => {
    const plan = await createPlan({ modules: MODULES });
    const { business, root } = await createBusiness({ name: 'A' });
    await createSubscription({ businessId: business.id, planId: plan.id, modules: MODULES });
    const u = await createUser({ businessId: business.id, branchId: root.id, level: 'BRANCH_USER' });
    const { token } = await loginAs(u.username);
    const res = await api.post('/api/app/rates/batch').set('Authorization', bearer(token!)).send({ metals: [gold(150000)] });
    expect(res.status).toBe(403);
  });

  it('prevSellRate = the karat previous save (same unit basis); display.showBuy follows the rates.display setting', async () => {
    const o = await owner();
    await db.rateLimit.deleteMany({ where: { businessId: o.business.id } });
    let cur = await api.get('/api/app/rates/current').set(o.h);
    expect(cur.body.display).toEqual({ showBuy: true }); // default

    await db.metalRate.create({ data: { businessId: o.business.id, branchId: 0, metal: 'GOLD', karatCode: '24K', rateUnit: 'GRAM_1', sellRate: 15000, buyRate: 14900, effectiveAt: new Date(Date.now() - 60_000) } });
    await api.post('/api/app/rates/batch').set(o.h).send({ metals: [gold(152000)] }).expect(200);
    cur = await api.get('/api/app/rates/current').set(o.h);
    expect(cur.body.gold.rows[0].prevSellRate).toBe('150000.00'); // 15000 /g re-expressed per 10 g
    expect(cur.body.silver.rows).toEqual([]);

    await api.put('/api/app/settings/rates.display').set({ ...o.h, 'X-MPIN': TEST_MPIN }).send({ value: { showBuy: false } }).expect(200);
    cur = await api.get('/api/app/rates/current').set(o.h);
    expect(cur.body.display).toEqual({ showBuy: false });
  });

  it('first ever save has no previous rate', async () => {
    const o = await owner();
    await db.rateLimit.deleteMany({ where: { businessId: o.business.id } });
    const res = await api.post('/api/app/rates/batch').set(o.h).send({ metals: [gold(150000)] });
    expect(res.body.gold.rows[0].prevSellRate).toBeNull();
  });
});
