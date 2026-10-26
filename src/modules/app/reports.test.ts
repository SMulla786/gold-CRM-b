import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../test/helpers/factory';
import { businessDate } from '../../lib/ledger';
import type { TenantContext } from '../../middleware/context';
import { activity, dashboard, gstRegister, gstSummary } from './reports';

const ctxFor = (businessId: number, branchIds: number[], activeBranchId: number | null): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchIds[0]!, branchIds, activeBranchId,
  readOnly: false, modules: [], limits: null, permissions: {}, impersonatorId: null,
});
const party = (businessId: number, name = 'Cust', type: 'CUSTOMER' | 'SUPPLIER' = 'CUSTOMER') => db.party.create({ data: { businessId, type, name, mobile: '9000000000' } });

async function sellBill(businessId: number, branchId: number, partyId: number, over: Partial<{ final: number; paid: number; billType: 'GST' | 'ROUGH'; cgst: number; sgst: number; billNo: string; seq: number }> = {}) {
  return db.bill.create({
    data: {
      businessId, branchId, kind: 'SELL', billType: over.billType ?? 'GST', billNo: over.billNo ?? `INV-${over.seq ?? 1}`, seq: over.seq ?? 1,
      partyId, billDate: businessDate(), sub: 10000, taxable: 10000, cgst: over.cgst ?? 150, sgst: over.sgst ?? 150, total: 10300, final: over.final ?? 10300, paid: over.paid ?? 0,
    },
  });
}

describe('reports dashboard', () => {
  beforeEach(truncateAll);
  afterAll(() => db.$disconnect());

  it('empty business → zeroed totals and the right shape', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const d = await dashboard(ctxFor(business.id, [root.id], root.id));
    expect(d.date).toBe(businessDate().toISOString().slice(0, 10));
    expect(d.parties).toEqual({ customers: 0, suppliers: 0, customersNewThisMonth: 0 });
    expect(d.stock).toEqual([]);
    expect(d.sales).toMatchObject({ todayTotal: '0.00', todayCount: 0, pendingBalance: '0.00' });
    expect(d.monthly).toHaveLength(12);
    expect(d.byBranch).toBeNull(); // active branch set, not "all"
    for (const a of ['CREATED', 'EDITED', 'DELETED', 'REVERSED']) expect(d.activityToday[a as 'CREATED']).toBe(0);
  });

  it('today SELL bill → sales totals, count and pending balance', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const p = await party(business.id);
    await sellBill(business.id, root.id, p.id, { final: 10300, paid: 4000 });
    const d = await dashboard(ctxFor(business.id, [root.id], root.id));
    expect(d.sales.todayTotal).toBe('10300.00');
    expect(d.sales.todayCount).toBe(1);
    expect(d.sales.todayReceived).toBe('4000.00');
    expect(d.sales.pendingBalance).toBe('6300.00'); // 10300 − 4000
    expect(d.parties.customers).toBe(1);
  });

  it('udhari receivable counts only positive party balances; cash from MONEY ledger', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const owed = await party(business.id, 'Owes');
    const adv = await party(business.id, 'Advance');
    await db.udharEntry.createMany({
      data: [
        { businessId: business.id, branchId: root.id, partyId: owed.id, txnDate: businessDate(), amount: 5000, source: 'UDHAR', sourceId: '1' },
        { businessId: business.id, branchId: root.id, partyId: adv.id, txnDate: businessDate(), amount: -2000, source: 'UDHAR', sourceId: '2' }, // shop owes them: excluded from receivable
      ],
    });
    await db.ledgerEntry.createMany({
      data: [
        { businessId: business.id, branchId: root.id, txnDate: businessDate(), asset: 'MONEY', direction: 'IN', amount: 7000, source: 'UDHAR', sourceId: '1' },
        { businessId: business.id, branchId: root.id, txnDate: businessDate(), asset: 'MONEY', direction: 'OUT', amount: 1000, source: 'UDHAR', sourceId: '2' },
      ],
    });
    const d = await dashboard(ctxFor(business.id, [root.id], root.id));
    expect(d.udhari.amount).toBe('5000.00'); // −2000 party excluded
    expect(d.cash.inHand).toBe('6000.00'); // 7000 IN − 1000 OUT
  });

  it('byBranch present only with X-Branch-Id: all', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const other = await createBranch({ businessId: business.id, parentId: root.id, name: 'B2' });
    const d = await dashboard(ctxFor(business.id, [root.id, other.id], null)); // null active = "all"
    expect(d.byBranch).not.toBeNull();
    expect(d.byBranch!.map((b) => b.branch.id).sort()).toEqual([root.id, other.id].sort());
  });
});

describe('reports activity + GST', () => {
  beforeEach(truncateAll);
  afterAll(() => db.$disconnect());

  it('activity lists recent log rows (scoped, newest first)', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    await db.activityLog.createMany({
      data: [
        { businessId: business.id, branchId: root.id, userId: 1, module: 'UDHAR', action: 'CREATED', entity: 'UdharTxn', entityId: '1', summary: 'Udhar #1' },
        { businessId: business.id, branchId: root.id, userId: 1, module: 'BILLING', action: 'CREATED', entity: 'Bill', entityId: '2', summary: 'Bill INV-1' },
      ],
    });
    const res = await activity(ctxFor(business.id, [root.id], root.id), { page: 1, pageSize: 20 });
    expect(res.total).toBe(2);
    expect(res.items[0]!.entityId).toBe('2'); // newest (higher id) first
  });

  it('activity q matches summary or party name, case-insensitive', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    await db.activityLog.createMany({
      data: [
        { businessId: business.id, branchId: root.id, userId: 1, module: 'UDHAR', action: 'CREATED', entity: 'UdharTxn', entityId: '1', summary: 'Udhar #1', partyName: 'Ramesh Patil' },
        { businessId: business.id, branchId: root.id, userId: 1, module: 'BILLING', action: 'CREATED', entity: 'Bill', entityId: '2', summary: 'Bill INV-1' },
      ],
    });
    const ctx = ctxFor(business.id, [root.id], root.id);
    expect((await activity(ctx, { page: 1, pageSize: 20, q: 'ramesh' })).items.map((r) => r.entityId)).toEqual(['1']);
    expect((await activity(ctx, { page: 1, pageSize: 20, q: 'inv-1' })).items.map((r) => r.entityId)).toEqual(['2']);
  });

  it('GST register lists ACTIVE GST bills with HSN codes; ROUGH excluded', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const p = await party(business.id);
    const gst = await sellBill(business.id, root.id, p.id, { billType: 'GST', billNo: 'INV-1', seq: 1 });
    await sellBill(business.id, root.id, p.id, { billType: 'ROUGH', billNo: 'EST-1', seq: 2 });
    await db.billItem.create({ data: { billId: gst.id, stockClass: 'GOLD', description: 'Ring', hsnCode: '7113', gross: 10, net: 10, fine: 9.167, metalAmount: 9000, labourAmount: 500, total: 9500 } });

    const reg = await gstRegister(ctxFor(business.id, [root.id], root.id), { page: 1, pageSize: 20, kind: 'SELL' });
    expect(reg.total).toBe(1); // ROUGH excluded
    expect(reg.items[0]!.hsnCodes).toEqual(['7113']);
    expect(reg.items[0]!.cgst).toBe('150.00');

    const sum = await gstSummary(ctxFor(business.id, [root.id], root.id), { groupBy: 'MONTH' });
    expect(sum).toHaveLength(1);
    expect(sum[0]!.salesTaxable).toBe('10000.00');
    expect(sum[0]!.outputGst).toBe('300.00'); // 150 + 150
    expect(sum[0]!.netPayable).toBe('300.00');
  });
});
