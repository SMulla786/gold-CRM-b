import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { justBillBody } from '../../../shared';
import * as jb from './service';
import type { TenantContext } from '../../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing'], limits: null, permissions: {}, impersonatorId: null,
});
const parse = (o: Record<string, unknown>) => justBillBody.parse(o);

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  return { business, root, party, ctx: ctxFor(business.id, root.id) };
}

describe('Just Bill (TASK-56)', () => {
  it('cash + old-gold (KACHA) payment → MONEY + GOLD ledger rows; party balance kept', async () => {
    const s = await setup();
    const bill = await jb.createJustBill(s.ctx, parse({
      partyId: s.party.id,
      items: [{ name: 'Gold Ring', quantity: 10, unit: 'GRAM', rate: 6000, making: 500, makingUnit: 'PER_GRAM' }],
      payments: [{ mode: 'CASH', amount: 5000 }, { mode: 'METAL', metal: 'GOLD', metalForm: 'KACHA', gross: 2, tunch: 100, rate: 60000 }],
    }));
    expect(Number(bill.sub)).toBe(65000); // 10×6000 + 10×500
    expect(Number(bill.final)).toBe(65000);
    expect(Number(bill.weight)).toBeCloseTo(10, 3);

    const led = await db.ledgerEntry.findMany({ where: { source: 'JUST_BILL' } });
    expect(led.filter((r) => r.asset === 'MONEY' && r.direction === 'IN' && Number(r.amount) === 5000)).toHaveLength(1);
    const gold = led.filter((r) => r.asset === 'GOLD' && r.direction === 'IN');
    expect(gold).toHaveLength(1);
    expect(gold[0]!.metalForm).toBe('KACHA');
    expect(Number(gold[0]!.fine)).toBeCloseTo(2, 3); // 2g × 100%

    const udhar = (await db.udharEntry.findMany({ where: { source: 'JUST_BILL', partyId: s.party.id } })).reduce((a, r) => a + Number(r.amount), 0);
    expect(udhar).toBeCloseTo(Number(bill.balance), 2);
    expect(udhar).toBeGreaterThan(0);
  });

  it('a walk-in with a non-zero balance is rejected (400); fully paid walk-in is fine', async () => {
    const s = await setup();
    await expect(jb.createJustBill(s.ctx, parse({ customerName: 'Walk In', items: [{ name: 'Coin', quantity: 1, unit: 'PCS', rate: 1000 }] }))).rejects.toMatchObject({ status: 400 });
    const ok = await jb.createJustBill(s.ctx, parse({ customerName: 'Walk In', mobile: '9000000009', items: [{ name: 'Coin', quantity: 1, unit: 'PCS', rate: 1000 }], payments: [{ mode: 'CASH', amount: 1000 }] }));
    expect(ok.customerName).toBe('Walk In');
    expect(Number(ok.balance)).toBe(0);
    expect(ok.party).toBeNull();
  });

  it('making PER_GRAM on a PCS line → 400', async () => {
    const s = await setup();
    await expect(jb.createJustBill(s.ctx, parse({ customerName: 'W', items: [{ name: 'Coin', quantity: 1, unit: 'PCS', rate: 1000, making: 100, makingUnit: 'PER_GRAM' }], payments: [{ mode: 'CASH', amount: 1100 }] }))).rejects.toMatchObject({ status: 400 });
  });

  it('numbers JB per financial year and previews the next number', async () => {
    const s = await setup();
    const a = await jb.createJustBill(s.ctx, parse({ customerName: 'A', items: [{ name: 'x', quantity: 1, unit: 'PCS', rate: 100 }], payments: [{ mode: 'CASH', amount: 100 }] }));
    const b = await jb.createJustBill(s.ctx, parse({ customerName: 'B', items: [{ name: 'x', quantity: 1, unit: 'PCS', rate: 100 }], payments: [{ mode: 'CASH', amount: 100 }] }));
    expect(a.billNo.startsWith('JB')).toBe(true);
    expect(a.billNo.endsWith('00001')).toBe(true);
    expect(b.billNo.endsWith('00002')).toBe(true);
    expect((await jb.nextJustBillNo(s.ctx)).billNo.endsWith('00003')).toBe(true);
  });

  it('delete reverses the ledger + udhar to zero and lists by status', async () => {
    const s = await setup();
    const bill = await jb.createJustBill(s.ctx, parse({ partyId: s.party.id, items: [{ name: 'Ring', quantity: 5, unit: 'GRAM', rate: 6000 }], payments: [{ mode: 'CASH', amount: 10000 }] }));
    expect((await jb.listJustBills(s.ctx, { page: 1, pageSize: 20, status: 'ACTIVE' })).total).toBe(1);
    await jb.deleteJustBill(s.ctx, bill.id);
    expect((await db.justBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe('DELETED');
    const money = (await db.ledgerEntry.findMany({ where: { source: 'JUST_BILL', asset: 'MONEY' } })).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0);
    expect(money).toBe(0);
    expect((await db.udharEntry.findMany({ where: { source: 'JUST_BILL' } })).reduce((a, r) => a + Number(r.amount), 0)).toBe(0);
    expect((await jb.listJustBills(s.ctx, { page: 1, pageSize: 20, status: 'ACTIVE' })).total).toBe(0);
    expect((await jb.listJustBills(s.ctx, { page: 1, pageSize: 20, status: 'DELETED' })).total).toBe(1);
  });

  it('cross-tenant party → 404', async () => {
    const s = await setup();
    const b = await createBusiness({ name: 'B' });
    const bParty = await db.party.create({ data: { businessId: b.business.id, type: 'CUSTOMER', name: 'X', mobile: '9000000002', countryCode: '+91' } });
    await expect(jb.createJustBill(s.ctx, parse({ partyId: bParty.id, items: [{ name: 'x', quantity: 1, unit: 'PCS', rate: 100 }], payments: [{ mode: 'CASH', amount: 100 }] }))).rejects.toMatchObject({ status: 404 });
  });
});
