import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../test/helpers/factory';
import type { TenantContext } from '../../middleware/context';
import { gstHsn } from './reports';

// Phase 8: GET /gst/hsn (gstHsn) had no test. Pins the EXISTING rule (reports.ts): bill-level GST split to each line's
// HSN pro-rata by the line's share of its bill total; only SELL + GST + ACTIVE bills, lines with an HSN; inclusive
// bill-date range; branch + tenant scope.
const ctxFor = (businessId: number, branchIds: number[], activeBranchId: number | null): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchIds[0]!, branchIds, activeBranchId,
  readOnly: false, modules: [], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

type Line = { hsn: string | null; cls: 'GOLD' | 'SILVER'; total: number; fine: number };
let seq = 0;
async function bill(businessId: number, branchId: number, partyId: number, date: string, lines: Line[], over: Record<string, unknown> = {}) {
  seq++;
  const total = lines.reduce((a, l) => a + l.total, 0);
  const b = await db.bill.create({
    data: { businessId, branchId, kind: 'SELL', billType: 'GST', billNo: `INV-${seq}`, seq, partyId, billDate: new Date(date), sub: total, taxable: total, cgst: total * 0.015, sgst: total * 0.015, igst: 0, total, final: total * 1.03, paid: 0, ...over },
  });
  for (const l of lines) {
    await db.billItem.create({ data: { billId: b.id, stockClass: l.cls, description: 'x', hsnCode: l.hsn, pcs: 1, gross: l.fine, net: l.fine, fine: l.fine, metalAmount: l.total, labourAmount: 0, total: l.total } });
  }
  return b;
}

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const other = await createBranch({ businessId: business.id, parentId: root.id, name: 'B2' });
  const p = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000000' } });
  // bill 1: CGST/SGST 150 + 150 on 10 000, lines 6000 + 2000 (7113 gold) and 2000 (7114 silver) → 80 % / 20 %
  await bill(business.id, root.id, p.id, '2026-10-01', [{ hsn: '7113', cls: 'GOLD', total: 6000, fine: 5 }, { hsn: '7113', cls: 'GOLD', total: 2000, fine: 1 }, { hsn: '7114', cls: 'SILVER', total: 2000, fine: 100 }]);
  // bill 2: IGST 300 on 10 000, one 7113 gold line
  await bill(business.id, root.id, p.id, '2026-10-15', [{ hsn: '7113', cls: 'GOLD', total: 10000, fine: 10 }], { cgst: 0, sgst: 0, igst: 300 });
  // never counted: ROUGH, PURCHASE, DELETED, a line without HSN, another branch, another business
  const never: Line[] = [{ hsn: '7113', cls: 'GOLD', total: 5000, fine: 50 }];
  await bill(business.id, root.id, p.id, '2026-10-15', never, { billType: 'ROUGH' });
  await bill(business.id, root.id, p.id, '2026-10-15', never, { kind: 'PURCHASE' });
  await bill(business.id, root.id, p.id, '2026-10-15', never, { status: 'DELETED' });
  await bill(business.id, root.id, p.id, '2026-10-15', [{ hsn: null, cls: 'GOLD', total: 5000, fine: 50 }]);
  await bill(business.id, other.id, p.id, '2026-10-15', never);
  const x = await createBusiness({ name: 'X' });
  const xp = await db.party.create({ data: { businessId: x.business.id, type: 'CUSTOMER', name: 'X', mobile: '9000000001' } });
  await bill(x.business.id, x.root.id, xp.id, '2026-10-15', never);
  return { ctx: ctxFor(business.id, [root.id, other.id], root.id), all: ctxFor(business.id, [root.id, other.id], null) };
}

describe('gstHsn report', () => {
  it('per HSN + class: GST split pro-rata by line share; weight = Σ fine; rows add up to the bills', async () => {
    const { ctx } = await setup();
    const rows = await gstHsn(ctx, {});
    expect(rows).toEqual([
      { hsnCode: '7113', stockClass: 'GOLD', weight: '16.000', taxable: '18000.00', cgst: '120.00', sgst: '120.00', igst: '300.00', total: '18540.00' },
      { hsnCode: '7114', stockClass: 'SILVER', weight: '100.000', taxable: '2000.00', cgst: '30.00', sgst: '30.00', igst: '0.00', total: '2060.00' },
    ]);
    expect(rows.reduce((a, r) => a + Number(r.total), 0)).toBe(20600); // = Σ final of the two counted bills
  });

  it('bill-date range is inclusive', async () => {
    const { ctx } = await setup();
    const late = await gstHsn(ctx, { from: new Date('2026-10-15'), to: new Date('2026-10-15') });
    expect(late.map((r) => [r.hsnCode, r.taxable, r.igst])).toEqual([['7113', '10000.00', '300.00']]);
    expect(await gstHsn(ctx, { to: new Date('2026-09-30') })).toEqual([]);
  });

  it('"all branches" adds the other branch of the same business; another business never counts', async () => {
    const { all } = await setup();
    const gold = (await gstHsn(all, {})).find((r) => r.hsnCode === '7113')!;
    expect([gold.weight, gold.taxable]).toEqual(['66.000', '23000.00']); // + the B2 bill (50 g, 5000)
  });
});
