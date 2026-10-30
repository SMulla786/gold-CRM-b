import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { addBillPaymentsBody, billBody, moneyToMetal } from '../../../shared';
import { businessDate } from '../../../lib/ledger';
import * as inv from '../inventory';
import { pendingBills } from '../udhar';
import { dashboard } from '../reports';
import * as billing from './service';
import type { TenantContext } from '../../../middleware/context';

/** BILL-15 (owner-approved rules R1, R3, R4, R5): how a bill's unpaid balance is kept — money OR gold OR silver — and what
 *  later payments, Pending Bills, the overdue card, delete/edit and other tenants do with it. Pins CURRENT behaviour. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook', 'udhari'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const ctx = ctxFor(business.id, root.id);
  const customer = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const supplier = await db.party.create({ data: { businessId: business.id, type: 'SUPPLIER', name: 'Supp', mobile: '9000000003', countryCode: '+91' } });
  return { business, root, ctx, customer, supplier };
}

// Default rate units: gold per 10 g (GRAM_10), silver per kg (KG_1) — the keep weight uses the same units.
const GOLD_UNIT = 10;
const SILVER_UNIT = 1000;

/** ROUGH sell, one direct gold line: 10 g × ₹60,000 / 10 g = ₹60,000 final. */
const sell = (partyId: number, over: Record<string, unknown> = {}) =>
  billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 10, rate: 60000 }], payments: [{ mode: 'CASH', amount: 10000 }], ...over });

/** ROUGH purchase, one TAG gold line: 5 g × ₹5,000/g = ₹25,000 final (purchase lines are priced per gram). */
async function purchase(s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) {
  const [group] = await inv.createItemGroups(s.ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const itemName = await inv.createItemName(s.ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
  return billBody.parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: s.supplier.id, items: [{ itemNameId: itemName!.id, gross: 5, rate: 5000 }], ...over });
}

const n = (v: unknown) => Number(v ?? 0);
/** party balance per asset = Σ every udhar row (reversals included, so it is the net effect) */
const partyBal = async (partyId: number) => {
  const rows = await db.udharEntry.findMany({ where: { partyId } });
  return { amount: rows.reduce((a, r) => a + n(r.amount), 0), gold: +rows.reduce((a, r) => a + n(r.gold), 0).toFixed(3), silver: +rows.reduce((a, r) => a + n(r.silver), 0).toFixed(3) };
};
/** udhar rows still in effect for a bill: not a reversal and not reversed */
const liveRows = async (billId: number) => {
  const rows = await db.udharEntry.findMany({ where: { sourceId: String(billId) }, orderBy: { id: 'asc' } });
  const reversed = new Set(rows.filter((r) => r.reversalOfId != null).map((r) => String(r.reversalOfId)));
  return rows.filter((r) => r.reversalOfId == null && !reversed.has(String(r.id)));
};
/** net ledger effect per asset (signed amount and fine) — every bill's postings, for "back to zero" checks */
const ledgerNet = async (businessId: number) => {
  const out: Record<string, { amount: number; fine: number }> = {};
  for (const r of await db.ledgerEntry.findMany({ where: { businessId } })) {
    const k = (out[r.asset] ??= { amount: 0, fine: 0 });
    const sign = r.direction === 'IN' ? 1 : -1;
    k.amount = +(k.amount + sign * n(r.amount)).toFixed(2);
    k.fine = +(k.fine + sign * n(r.fine)).toFixed(3);
  }
  return out;
};
const allZero = (o: Record<string, { amount: number; fine: number }>) => Object.values(o).every((v) => v.amount === 0 && v.fine === 0);

describe('BILL-15 R1 — one outstanding unit per bill', () => {
  it('MONEY: one udhar row carrying the ₹ balance only', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.customer.id));
    expect(bill).toMatchObject({ balance: '50000.00', keepBalanceAs: 'MONEY', keepWeight: null });
    const rows = await liveRows(bill.id);
    expect(rows.map((r) => [n(r.amount), n(r.gold), n(r.silver)])).toEqual([[50000, 0, 0]]);
  });

  it('GOLD: one row with gold = moneyToMetal(balance, keepRate, gold unit), no ₹', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.customer.id, { keepBalanceAs: 'GOLD', keepRate: 62000 }));
    const w = moneyToMetal(50000, 62000, GOLD_UNIT);
    expect(bill.keepBalanceAs).toBe('GOLD');
    expect(Number(bill.keepWeight)).toBe(Number(w));
    expect((await liveRows(bill.id)).map((r) => [n(r.amount), n(r.gold), n(r.silver)])).toEqual([[0, Number(w), 0]]);
    expect(await partyBal(s.customer.id)).toEqual({ amount: 0, gold: Number(w), silver: 0 });
  });

  it('SILVER: one row with silver = moneyToMetal(balance, keepRate, silver unit), no ₹', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.customer.id, { keepBalanceAs: 'SILVER', keepRate: 80000 }));
    const w = moneyToMetal(50000, 80000, SILVER_UNIT); // 625 g
    expect(Number(bill.keepWeight)).toBe(Number(w));
    expect((await liveRows(bill.id)).map((r) => [n(r.amount), n(r.gold), n(r.silver)])).toEqual([[0, 0, Number(w)]]);
  });

  it('fully paid with GOLD chosen: no udhar row and no keep weight', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.customer.id, { keepBalanceAs: 'GOLD', keepRate: 62000, payments: [{ mode: 'CASH', amount: 60000 }] }));
    expect(bill.keepWeight).toBeNull();
    expect(await liveRows(bill.id)).toHaveLength(0);
  });

  it('GOLD without a keep rate is rejected by the contract', () => {
    expect(() => sell(1, { keepBalanceAs: 'GOLD' })).toThrow();
  });
});

describe('BILL-15 R3 — later cash payment on a GOLD-kept bill', () => {
  it('reduces the ₹ side only: gold due unchanged, separate money credit row, no conversion', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.customer.id, { keepBalanceAs: 'GOLD', keepRate: 62000 }));
    const w = Number(moneyToMetal(50000, 62000, GOLD_UNIT));
    const after = await billing.addBillPayments(s.ctx, bill.id, addBillPaymentsBody.parse({ payments: [{ mode: 'CASH', amount: 20000 }] }));
    expect(after).toMatchObject({ balance: '30000.00', keepWeight: String(bill.keepWeight) });
    expect(Number(after.paid)).toBe(30000);
    expect(await partyBal(s.customer.id)).toEqual({ amount: -20000, gold: w, silver: 0 }); // party now has a ₹ credit AND still owes the gold
    const rows = await liveRows(bill.id);
    expect(rows.map((r) => [n(r.amount), n(r.gold), n(r.silver)])).toEqual([[0, w, 0], [-20000, 0, 0]]);
  });
});

describe('BILL-15 R4 — Pending Bills and the overdue card stay as they are', () => {
  it('Pending Bills lists a GOLD-kept bill with its ₹ balance (final − paid), not the gold', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.customer.id, { keepBalanceAs: 'GOLD', keepRate: 62000 }));
    const r = await pendingBills(s.ctx, { page: 1, pageSize: 20 });
    expect(r.items.map((b) => [b.id, b.balance])).toEqual([[bill.id, '50000.00']]);
  });

  it('overdue = udhar date + 30 days; Bill.dueDate is ignored both ways', async () => {
    const s = await setup();
    const today = businessDate();
    const ago = (d: number) => new Date(today.getTime() - d * 86_400_000);
    const ahead = (d: number) => new Date(today.getTime() + d * 86_400_000);
    // 40 days old but due in the future → overdue anyway (gold balance)
    await billing.createBill(s.ctx, sell(s.customer.id, { billDate: ago(40), dueDate: ahead(30), keepBalanceAs: 'GOLD', keepRate: 62000 }));
    // dated today with a due date already past → not overdue
    const other = await db.party.create({ data: { businessId: s.business.id, type: 'CUSTOMER', name: 'Fresh', mobile: '9000000009', countryCode: '+91' } });
    await billing.createBill(s.ctx, sell(other.id, { dueDate: ago(5) }));
    const d = await dashboard(s.ctx);
    expect(d.udharOverdue!.map((o) => [o.party.name, o.amount, o.gold, o.daysOverdue])).toEqual([
      ['Cust', '0.00', moneyToMetal(50000, 62000, GOLD_UNIT), 10],
    ]);
  });
});

describe('BILL-15 R5 — PURCHASE may keep its balance in metal, sign opposite to SELL', () => {
  it('GOLD-kept purchase: one row, gold = −moneyToMetal(balance, keepRate, gold unit)', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, await purchase(s, { keepBalanceAs: 'GOLD', keepRate: 50000 }));
    const w = Number(moneyToMetal(25000, 50000, GOLD_UNIT)); // 5 g
    expect(Number(bill.final)).toBe(25000);
    expect((await liveRows(bill.id)).map((r) => [n(r.amount), n(r.gold), n(r.silver)])).toEqual([[0, -w, 0]]);
    expect(await partyBal(s.supplier.id)).toEqual({ amount: 0, gold: -w, silver: 0 }); // shop owes the supplier gold
  });

  it('later cash payment on a GOLD-kept purchase: + ₹ row, gold untouched', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, await purchase(s, { keepBalanceAs: 'GOLD', keepRate: 50000 }));
    await billing.addBillPayments(s.ctx, bill.id, addBillPaymentsBody.parse({ payments: [{ mode: 'CASH', amount: 5000 }] }));
    expect(await partyBal(s.supplier.id)).toEqual({ amount: 5000, gold: -Number(moneyToMetal(25000, 50000, GOLD_UNIT)), silver: 0 });
  });
});

describe('BILL-15 reversals', () => {
  it('delete a GOLD-kept sell bill (with a later payment): party money/gold/silver and the ledger net to 0', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.customer.id, { keepBalanceAs: 'GOLD', keepRate: 62000 }));
    await billing.addBillPayments(s.ctx, bill.id, addBillPaymentsBody.parse({ payments: [{ mode: 'CASH', amount: 20000 }] }));
    await billing.deleteBill(s.ctx, bill.id, true);
    expect(await partyBal(s.customer.id)).toEqual({ amount: 0, gold: 0, silver: 0 });
    expect(allZero(await ledgerNet(s.business.id))).toBe(true);
    expect(await liveRows(bill.id)).toHaveLength(0);
  });

  it('delete a SILVER-kept purchase bill: supplier and ledger (money + stock) net to 0', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, await purchase(s, { keepBalanceAs: 'SILVER', keepRate: 80000, payments: [{ mode: 'CASH', amount: 5000 }] }));
    expect((await partyBal(s.supplier.id)).silver).toBeLessThan(0);
    await billing.deleteBill(s.ctx, bill.id, true);
    expect(await partyBal(s.supplier.id)).toEqual({ amount: 0, gold: 0, silver: 0 });
    expect(allZero(await ledgerNet(s.business.id))).toBe(true);
  });

  it('edit a GOLD-kept bill reposts once: one live row at the new weight, nothing doubled', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.customer.id, { keepBalanceAs: 'GOLD', keepRate: 62000 }));
    // keepRateChange: R6 confirm flag (covered in keep-rate.test.ts); here only the repost is checked
    await billing.editBill(s.ctx, bill.id, sell(s.customer.id, { keepBalanceAs: 'GOLD', keepRate: 64000, keepRateChange: true, payments: [{ mode: 'CASH', amount: 20000 }] }));
    const w = Number(moneyToMetal(40000, 64000, GOLD_UNIT));
    expect((await liveRows(bill.id)).map((r) => [n(r.amount), n(r.gold), n(r.silver)])).toEqual([[0, w, 0]]);
    expect(await partyBal(s.customer.id)).toEqual({ amount: 0, gold: w, silver: 0 });
    // GOLD → MONEY on edit: the gold row goes, one ₹ row comes
    await billing.editBill(s.ctx, bill.id, sell(s.customer.id, { keepRateChange: true, payments: [{ mode: 'CASH', amount: 20000 }] }));
    expect((await liveRows(bill.id)).map((r) => [n(r.amount), n(r.gold), n(r.silver)])).toEqual([[40000, 0, 0]]);
    expect(await partyBal(s.customer.id)).toEqual({ amount: 40000, gold: 0, silver: 0 });
  });
});

describe('BILL-15 tenant isolation', () => {
  it('another business gets 404 on get / edit / delete / add-payment and moves nothing', async () => {
    const a = await setup('A');
    const b = await setup('B');
    const bill = await billing.createBill(a.ctx, sell(a.customer.id, { keepBalanceAs: 'GOLD', keepRate: 62000 }));
    const before = await partyBal(a.customer.id);
    await expect(billing.getBill(b.ctx, bill.id)).rejects.toMatchObject({ status: 404 });
    await expect(billing.editBill(b.ctx, bill.id, sell(b.customer.id, { keepBalanceAs: 'GOLD', keepRate: 62000 }))).rejects.toMatchObject({ status: 404 });
    await expect(billing.addBillPayments(b.ctx, bill.id, addBillPaymentsBody.parse({ payments: [{ mode: 'CASH', amount: 1000 }] }))).rejects.toMatchObject({ status: 404 });
    await expect(billing.deleteBill(b.ctx, bill.id, true)).rejects.toMatchObject({ status: 404 });
    expect(await partyBal(a.customer.id)).toEqual(before);
    expect(await partyBal(b.customer.id)).toEqual({ amount: 0, gold: 0, silver: 0 });
    expect((await billing.getBill(a.ctx, bill.id)).status).toBe('ACTIVE');
  });
});
