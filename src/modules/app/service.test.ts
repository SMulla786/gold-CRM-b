import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBranch, createBusiness, createPlan } from '../../../test/helpers/factory';
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

describe('TASK-14c', () => {
  it('(a) a branch user cannot update/delete a sibling branch bank account', async () => {
    const A = await createBusiness({ name: 'A' });
    const x = await createBranch({ businessId: A.business.id, parentId: A.root.id, name: 'X' });
    const y = await createBranch({ businessId: A.business.id, parentId: A.root.id, name: 'Y' });
    const ownerCtx = ctx({ businessId: A.business.id, scopeBranchId: A.root.id, branchIds: [A.root.id, x.id, y.id] });
    await svc.createBankAccount(ownerCtx, { branchId: y.id, bankName: 'YBank', accountNo: '123456', ifsc: 'HDFC0001234', applyTo: 'ALL', isActive: true });
    const acct = await db.bankAccount.findFirstOrThrow({ where: { businessId: A.business.id, branchId: y.id } });
    const xUser = ctx({ businessId: A.business.id, level: 'BRANCH_USER', isOwner: false, scopeBranchId: x.id, branchIds: [x.id], activeBranchId: x.id });

    await expect(svc.updateBankAccount(xUser, acct.id, { bankName: 'HACKED' })).rejects.toBeTruthy();
    expect((await db.bankAccount.findUniqueOrThrow({ where: { id: acct.id } })).bankName).toBe('YBank');
    await expect(svc.deleteBankAccount(xUser, acct.id)).rejects.toBeTruthy();
    expect((await db.bankAccount.findUniqueOrThrow({ where: { id: acct.id } })).isActive).toBe(true);
  });

  it('(b) putRateLimits is atomic — a failed replace leaves the old limits intact', async () => {
    const B = await createBusiness({ name: 'B' });
    const bctx = ctx({ businessId: B.business.id, scopeBranchId: B.root.id, branchIds: [B.root.id] });
    await db.rateLimit.create({ data: { businessId: B.business.id, metal: 'GOLD', rateUnit: 'GRAM_10', minRate: 1, maxRate: 2 } });
    // Two rows with the same (metal,rateUnit) → createMany P2002 → whole tx rolls back (deleteMany undone).
    await expect(svc.putRateLimits(bctx, [{ metal: 'SILVER', rateUnit: 'KG_1', minRate: 1, maxRate: 2 }, { metal: 'SILVER', rateUnit: 'KG_1', minRate: 3, maxRate: 4 }])).rejects.toBeTruthy();
    const after = await db.rateLimit.findMany({ where: { businessId: B.business.id } });
    expect(after).toHaveLength(1);
    expect(after[0]!.metal).toBe('GOLD');
  });

  it('(d) cannot change a customer type away from CUSTOMER while it has members', async () => {
    const C = await createBusiness({ name: 'C' });
    const cctx = ctx({ businessId: C.business.id, scopeBranchId: C.root.id, branchIds: [C.root.id], activeBranchId: C.root.id });
    const cust = await svc.createParty(cctx, { type: 'CUSTOMER', name: 'Cust', mobile: '9000000010', countryCode: '+91' });
    await svc.createParty(cctx, { type: 'CUSTOMER', name: 'Son', mobile: '9000000011', countryCode: '+91', parentId: cust.dto.id });
    await expect(svc.updateParty(cctx, cust.dto.id, { type: 'SUPPLIER' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('TASK-89 occasions', () => {
  // birthday/anniversary month-day `offset` days from the IST day of `now` (year is ignored by the lookup)
  const atOffset = (now: Date, offset: number) => {
    const ist = new Date(now.getTime() + 330 * 60000);
    const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + offset));
    return new Date(Date.UTC(1990, d.getUTCMonth(), d.getUTCDate()));
  };

  it('lists active parties whose birthday/anniversary is within the window, sorted by daysAway', async () => {
    const { business } = await createBusiness({ name: 'A' });
    const c = ctx({ businessId: business.id });
    const now = new Date();
    const mk = (name: string, over: Record<string, unknown>, n: number) => db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name, mobile: `90000000${n}`, ...over } });
    await mk('In3', { anniversary: atOffset(now, 3) }, 1);
    await mk('Today', { birthday: atOffset(now, 0) }, 2);
    await mk('Tomorrow', { birthday: atOffset(now, 1) }, 3);
    await mk('Inactive', { birthday: atOffset(now, 0), isActive: false }, 4);
    await mk('FarAway', { birthday: atOffset(now, 20) }, 5);
    await mk('NoDates', {}, 6);

    const occ = await svc.listOccasions(c, 7, now);
    expect(occ.map((o) => [o.party.name, o.kind, o.daysAway])).toEqual([
      ['Today', 'BIRTHDAY', 0],
      ['Tomorrow', 'BIRTHDAY', 1],
      ['In3', 'ANNIVERSARY', 3],
    ]);
  });

  it('Feb-29 birthday shows on Feb-28 in a non-leap year', async () => {
    const { business } = await createBusiness({ name: 'A' });
    const c = ctx({ businessId: business.id });
    await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Leap', mobile: '9100000001', birthday: new Date(Date.UTC(2000, 1, 29)) } });
    const occ = await svc.listOccasions(c, 7, new Date(Date.UTC(2027, 1, 27, 6, 0))); // 2027 is non-leap; IST day = Feb 27
    expect(occ[0]!.date).toBe('2027-02-28');
    expect(occ[0]!.daysAway).toBe(1);
  });
});
