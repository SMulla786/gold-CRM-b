import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../test/helpers/factory';
import { pendingBillsQuery } from '../../shared';
import * as udhar from './udhar';
import type { TenantContext } from '../../middleware/context';

// UDH-07 Pending Bills parity: Sale Only / Purchase Only (kind), bill-date range, and 3 summary cards (count, sale due,
// purchase due; never netted) over every matching bill (not just the page). Rupees only (BILL-15 R4); due = final − paid, the list's Due Balance.
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
  return { ctx: ctxFor(business.id, root.id), business, root, cust, sup, bill };
}
const page = { page: 1, pageSize: 20 };

describe('UDH-07 pending bills: tabs, date range, summary cards', () => {
  it('summary counts every matching bill across pages; sale and purchase due stay separate (no netted total)', async () => {
    const { ctx } = await setup();
    const all = await udhar.pendingBills(ctx, page);
    expect(all.summary).toEqual({ count: 4, saleDue: '340.00', purchaseDue: '150.00' });
    const one = await udhar.pendingBills(ctx, { page: 1, pageSize: 1 });
    expect([one.items.length, one.total, one.summary]).toEqual([1, 4, all.summary]); // cards don't depend on the page
  });

  it('Sale Only / Purchase Only tabs filter both the rows and the cards', async () => {
    const { ctx } = await setup();
    const sale = await udhar.pendingBills(ctx, { ...page, kind: 'SELL' });
    expect(sale.items.every((b) => b.kind === 'SELL')).toBe(true);
    expect(sale.summary).toEqual({ count: 3, saleDue: '340.00', purchaseDue: '0.00' });
    const purchase = await udhar.pendingBills(ctx, { ...page, kind: 'PURCHASE' });
    expect(purchase.items.map((b) => b.kind)).toEqual(['PURCHASE']);
    expect(purchase.summary).toEqual({ count: 1, saleDue: '0.00', purchaseDue: '150.00' });
  });

  it('bill-date range is inclusive on both ends; combines with the tab; no match → zero cards', async () => {
    const { ctx } = await setup();
    const mid = await udhar.pendingBills(ctx, { ...page, from: new Date('2026-10-15'), to: new Date('2026-10-15') });
    expect(mid.items.map((b) => b.billDate).sort()).toEqual(['2026-10-15', '2026-10-15']);
    expect(mid.summary).toEqual({ count: 2, saleDue: '280.00', purchaseDue: '0.00' });
    expect((await udhar.pendingBills(ctx, { ...page, from: new Date('2026-10-02'), kind: 'PURCHASE' })).summary.count).toBe(1);
    const none = await udhar.pendingBills(ctx, { ...page, to: new Date('2026-09-30') });
    expect([none.total, none.summary]).toEqual([0, { count: 0, saleDue: '0.00', purchaseDue: '0.00' }]);
  });

  it('query contract: kind is SELL | PURCHASE only; from/to parse from query strings', () => {
    expect(() => pendingBillsQuery.parse({ kind: 'BOTH' })).toThrow();
    const p = pendingBillsQuery.parse({ kind: 'SELL', from: '2026-10-01', to: '2026-10-31' });
    expect([p.kind, p.from instanceof Date, p.to instanceof Date]).toEqual(['SELL', true, true]);
  });

  it('cards always equal the full list under the same filters (kind, from/to, party, type, q, branch)', async () => {
    const { ctx, business, root, sup, bill } = await setup();
    const b2 = await createBranch({ businessId: business.id, parentId: root.id, name: 'B2' });
    const other = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Zubair', mobile: '9000000003', countryCode: '+91' } });
    await bill('2026-10-20', 70, 0, { partyId: other.id, billNo: 'ZB-1' }); // sale due 70, another customer
    await bill('2026-10-15', 900, 0, { branchId: b2.id }); // other branch: only counted when that branch is in scope
    const both = { ...ctx, branchIds: [root.id, b2.id] };
    const filters: Record<string, unknown>[] = [
      {}, { kind: 'SELL' }, { kind: 'PURCHASE' }, { from: '2026-10-15' }, { to: '2026-10-15' }, { from: '2026-10-15', to: '2026-10-20', kind: 'SELL' },
      { partyId: other.id }, { partyId: sup.id }, { type: 'SUPPLIER' }, { type: 'CUSTOMER', kind: 'SELL' }, { q: 'zub' }, { q: 'ZB-' }, { q: '9000000002' }, { q: 'nobody' },
    ];
    for (const c of [ctx, both]) {
      for (const f of filters) {
        const r = await udhar.pendingBills(c, pendingBillsQuery.parse({ ...f, page: 1, pageSize: 100 }));
        const dueOf = (kind: string) => r.items.filter((b) => b.kind === kind).reduce((a, b) => a + Number(b.balance), 0).toFixed(2);
        expect([r.summary, r.total], JSON.stringify(f)).toEqual([{ count: r.items.length, saleDue: dueOf('SELL'), purchaseDue: dueOf('PURCHASE') }, r.items.length]);
      }
    }
    // the filters really bite (so the parity above is not vacuous)
    const sum = async (c: TenantContext, f: Record<string, unknown>) => (await udhar.pendingBills(c, pendingBillsQuery.parse(f))).summary;
    expect(await sum(both, {})).toEqual({ count: 6, saleDue: '1310.00', purchaseDue: '150.00' });
    expect(await sum(ctx, {})).toEqual({ count: 5, saleDue: '410.00', purchaseDue: '150.00' });
    expect(await sum(ctx, { q: 'zub' })).toEqual({ count: 1, saleDue: '70.00', purchaseDue: '0.00' });
    expect(await sum(ctx, { type: 'SUPPLIER' })).toEqual({ count: 1, saleDue: '0.00', purchaseDue: '150.00' });
  });
});
