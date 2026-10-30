import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import { pendingBillsQuery } from '../../shared';
import * as udhar from './udhar';
import type { TenantContext } from '../../middleware/context';

// UDH-07 Pending Bills parity: Sale Only / Purchase Only (kind), bill-date range, and 4 summary cards over every
// matching bill (not just the page). Rupees only (BILL-15 R4); due = final − paid, the list's Due Balance.
const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['udhari', 'billing'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const cust = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const sup = await db.party.create({ data: { businessId: business.id, type: 'SUPPLIER', name: 'Sup', mobile: '9000000002', countryCode: '+91' } });
  let n = 0;
  const bill = (date: string, final: number, paid: number, over: Record<string, unknown> = {}) => {
    n++;
    return db.bill.create({ data: { businessId: business.id, branchId: root.id, kind: 'SELL', billType: 'ROUGH', billNo: `B${n}`, seq: n, partyId: cust.id, billDate: new Date(date), sub: final, taxable: final, total: final, final, paid, status: 'ACTIVE', ...over } });
  };
  await bill('2026-10-01', 100, 40); // sale due 60
  await bill('2026-10-15', 300, 0); // sale due 300
  await bill('2026-10-15', 100, 120); // sale overpaid: due −20 (still pending, final ≠ paid)
  await bill('2026-10-28', 200, 50, { kind: 'PURCHASE', partyId: sup.id }); // purchase due 150
  await bill('2026-10-15', 100, 100); // settled — excluded
  await bill('2026-10-15', 500, 0, { status: 'DELETED' }); // deleted — excluded
  return { ctx: ctxFor(business.id, root.id) };
}
const page = { page: 1, pageSize: 20 };

describe('UDH-07 pending bills: tabs, date range, summary cards', () => {
  it('summary counts every matching bill across pages; total due = sale due + purchase due', async () => {
    const { ctx } = await setup();
    const all = await udhar.pendingBills(ctx, page);
    expect(all.summary).toEqual({ count: 4, saleDue: '340.00', purchaseDue: '150.00', totalDue: '490.00' });
    const one = await udhar.pendingBills(ctx, { page: 1, pageSize: 1 });
    expect([one.items.length, one.total, one.summary]).toEqual([1, 4, all.summary]); // cards don't depend on the page
  });

  it('Sale Only / Purchase Only tabs filter both the rows and the cards', async () => {
    const { ctx } = await setup();
    const sale = await udhar.pendingBills(ctx, { ...page, kind: 'SELL' });
    expect(sale.items.every((b) => b.kind === 'SELL')).toBe(true);
    expect(sale.summary).toEqual({ count: 3, saleDue: '340.00', purchaseDue: '0.00', totalDue: '340.00' });
    const purchase = await udhar.pendingBills(ctx, { ...page, kind: 'PURCHASE' });
    expect(purchase.items.map((b) => b.kind)).toEqual(['PURCHASE']);
    expect(purchase.summary).toEqual({ count: 1, saleDue: '0.00', purchaseDue: '150.00', totalDue: '150.00' });
  });

  it('bill-date range is inclusive on both ends; combines with the tab; no match → zero cards', async () => {
    const { ctx } = await setup();
    const mid = await udhar.pendingBills(ctx, { ...page, from: new Date('2026-10-15'), to: new Date('2026-10-15') });
    expect(mid.items.map((b) => b.billDate).sort()).toEqual(['2026-10-15', '2026-10-15']);
    expect(mid.summary).toEqual({ count: 2, saleDue: '280.00', purchaseDue: '0.00', totalDue: '280.00' });
    expect((await udhar.pendingBills(ctx, { ...page, from: new Date('2026-10-02'), kind: 'PURCHASE' })).summary.count).toBe(1);
    const none = await udhar.pendingBills(ctx, { ...page, to: new Date('2026-09-30') });
    expect([none.total, none.summary]).toEqual([0, { count: 0, saleDue: '0.00', purchaseDue: '0.00', totalDue: '0.00' }]);
  });

  it('query contract: kind is SELL | PURCHASE only; from/to parse from query strings', () => {
    expect(() => pendingBillsQuery.parse({ kind: 'BOTH' })).toThrow();
    const p = pendingBillsQuery.parse({ kind: 'SELL', from: '2026-10-01', to: '2026-10-31' });
    expect([p.kind, p.from instanceof Date, p.to instanceof Date]).toEqual(['SELL', true, true]);
  });
});
