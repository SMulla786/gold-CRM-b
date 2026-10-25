import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import * as udhar from './udhar';
import type { TenantContext } from '../../middleware/context';

// TASK-44b: pendingBills now resolves final≠paid via a scoped raw id query, then pages normally.
const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['udhari', 'billing'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

describe('TASK-44b pendingBills (scoped raw id filter)', () => {
  it('returns only ACTIVE bills with final ≠ paid, filters by party type, and paginates', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const cust = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
    const sup = await db.party.create({ data: { businessId: business.id, type: 'SUPPLIER', name: 'Sup', mobile: '9000000002', countryCode: '+91' } });
    const ctx = ctxFor(business.id, root.id);
    const bill = (over: Record<string, unknown>, n: number) =>
      db.bill.create({ data: { businessId: business.id, branchId: root.id, kind: 'SELL', billType: 'ROUGH', billNo: `B${n}`, seq: n, partyId: cust.id, billDate: new Date(), sub: 100, taxable: 100, total: 100, final: 100, paid: 0, status: 'ACTIVE', ...over } });

    await bill({ final: 100, paid: 100 }, 1); // settled — excluded
    await bill({ final: 100, paid: 40 }, 2); // pending customer
    await bill({ kind: 'PURCHASE', partyId: sup.id, final: 200, paid: 0 }, 3); // pending supplier

    const all = await udhar.pendingBills(ctx, { page: 1, pageSize: 20 });
    expect(all.total).toBe(2);
    expect(all.items.every((b) => Number(b.balance) !== 0)).toBe(true);

    const custOnly = await udhar.pendingBills(ctx, { page: 1, pageSize: 20, type: 'CUSTOMER' });
    expect(custOnly.total).toBe(1);
    expect(custOnly.items[0]!.party.type).toBe('CUSTOMER');
    expect((await udhar.pendingBills(ctx, { page: 1, pageSize: 20, type: 'SUPPLIER' })).total).toBe(1);

    const paged = await udhar.pendingBills(ctx, { page: 1, pageSize: 1 });
    expect(paged.total).toBe(2);
    expect(paged.items).toHaveLength(1);
  });

  it('TASK-83: itemsSummary groups line items by description (pcs summed)', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const cust = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000009', countryCode: '+91' } });
    const ctx = ctxFor(business.id, root.id);
    const bill = await db.bill.create({ data: { businessId: business.id, branchId: root.id, kind: 'SELL', billType: 'ROUGH', billNo: 'B9', seq: 9, partyId: cust.id, billDate: new Date(), sub: 100, taxable: 100, total: 100, final: 100, paid: 0, status: 'ACTIVE' } });
    const item = (description: string) => db.billItem.create({ data: { billId: bill.id, stockClass: 'GOLD', description, pcs: 1, gross: 1, net: 1, fine: 1, metalAmount: 1, labourAmount: 0, total: 1 } });
    await item('Ring');
    await item('Ring');
    await item('Chain');

    const b = (await udhar.pendingBills(ctx, { page: 1, pageSize: 20 })).items.find((x) => x.id === bill.id)!;
    expect(b.itemsSummary).toBe('2× Ring, 1× Chain');
    expect(b.itemCount).toBe(3);
  });

  it('excludes bills of another business (scope)', async () => {
    const a = await createBusiness({ name: 'A' });
    const b = await createBusiness({ name: 'B' });
    const bParty = await db.party.create({ data: { businessId: b.business.id, type: 'CUSTOMER', name: 'X', mobile: '9000000003', countryCode: '+91' } });
    await db.bill.create({ data: { businessId: b.business.id, branchId: b.root.id, kind: 'SELL', billType: 'ROUGH', billNo: 'X1', seq: 1, partyId: bParty.id, billDate: new Date(), sub: 100, taxable: 100, total: 100, final: 100, paid: 0, status: 'ACTIVE' } });
    expect((await udhar.pendingBills(ctxFor(a.business.id, a.root.id), { page: 1, pageSize: 20 })).total).toBe(0);
  });
});
