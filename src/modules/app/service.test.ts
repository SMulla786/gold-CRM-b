import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness, createPlan } from '../../../test/helpers/factory';
import * as svc from './service';
import * as platform from '../platform/service';
import type { TenantContext } from '../../middleware/context';

const ctx = (over: Partial<TenantContext> & { businessId: number }): TenantContext => ({
  userId: 1,
  level: 'ADMIN',
  isOwner: true,
  scopeBranchId: null,
  branchIds: [],
  activeBranchId: null,
  readOnly: false,
  modules: [],
  limits: null,
  permissions: {},
  impersonatorId: null,
  ...over,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

describe('settings resolution', () => {
  it('returns schema defaults, then branch override beats business row', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const c = ctx({ businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id });
    expect((await svc.getSettings(c))['calc.basis']).toEqual({ sale: 'NET', purchase: 'NET' });
    await svc.putSetting({ ...c, activeBranchId: null }, 'calc.basis', undefined, { sale: 'GROSS', purchase: 'NET' });
    expect((await svc.getSettings({ ...c, activeBranchId: null }))['calc.basis'].sale).toBe('GROSS');
    await svc.putSetting(c, 'calc.basis', root.id, { sale: 'FINE', purchase: 'FINE' });
    expect((await svc.getSettings(c))['calc.basis'].sale).toBe('FINE'); // branch row wins over business
  });
  it('unknown key -> 400', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const c = ctx({ businessId: business.id, scopeBranchId: root.id, branchIds: [root.id] });
    await expect(svc.putSetting(c, 'nope.key', undefined, {})).rejects.toMatchObject({ status: 400 });
  });
});

describe('rate limits', () => {
  it('checkRateLimits flags rows outside [min,max]', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const c = ctx({ businessId: business.id, scopeBranchId: root.id, branchIds: [root.id] });
    await db.rateLimit.create({ data: { businessId: business.id, metal: 'GOLD', rateUnit: 'GRAM_10', minRate: 145000, maxRate: 200000 } });
    const off = await svc.checkRateLimits(c, {
      metal: 'GOLD',
      rateUnit: 'GRAM_10',
      rates: [
        { karatCode: '24K', sellRate: 210000, buyRate: 150000 }, // sell over max
        { karatCode: '22K', sellRate: 150000, buyRate: 150000 }, // within
      ],
    });
    expect(off.map((o) => o.karatCode)).toEqual(['24K']);
  });
});

describe('party parent validation', () => {
  it('rejects a non-customer parent and reports duplicate mobiles', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const c = ctx({ businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id });
    const supplier = await svc.createParty(c, { type: 'SUPPLIER', name: 'Supplier', mobile: '9000000001', countryCode: '+91' });
    await expect(svc.createParty(c, { type: 'CUSTOMER', name: 'Kid', mobile: '9000000002', countryCode: '+91', parentId: supplier.dto.id })).rejects.toMatchObject({ status: 400 });
    const cust = await svc.createParty(c, { type: 'CUSTOMER', name: 'Cust', mobile: '9000000003', countryCode: '+91' });
    const dup = await svc.createParty(c, { type: 'CUSTOMER', name: 'Cust2', mobile: '9000000003', countryCode: '+91' });
    expect(dup.duplicateIds).toContain(cust.dto.id);
  });
});

describe('business-creation hook', () => {
  it('seeds 7 default karats + 4 rate limits', async () => {
    const plan = await createPlan({ modules: ['dashboard', 'settings'] });
    const detail = await platform.createBusiness(1, {
      name: 'New Shop',
      ownerName: 'Owner',
      mobile: '9000000009',
      owner: { name: 'Owner', username: `newowner${Date.now()}`, password: 'Passw0rd!' },
      planId: plan.id,
    });
    expect(await db.karatMapping.count({ where: { businessId: detail.id } })).toBe(7);
    expect(await db.rateLimit.count({ where: { businessId: detail.id } })).toBe(4);
  });
});
