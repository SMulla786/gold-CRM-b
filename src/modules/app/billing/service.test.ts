import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { billBody } from '../../../shared';
import * as inv from '../inventory';
import * as billing from './service';
import type { TenantContext } from '../../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1,
  level: 'ADMIN',
  isOwner: true,
  businessId,
  scopeBranchId: branchId,
  branchIds: [branchId],
  activeBranchId: branchId,
  readOnly: false,
  modules: ['billing', 'inventory', 'settings', 'daybook'],
  limits: null,
  permissions: {},
  impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

const stockRow = (over: Record<string, unknown>) => ({ pcs: 1, gross: 10, less: 0, wastage: 0, stoneCharge: 0, labour: 0, labourUnit: 'PER_GRAM', other: 0, ...over });
const parse = (o: Record<string, unknown>) => billBody.parse(o);

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  const ctx = ctxFor(business.id, root.id);
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const itemName = await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  return { business, root, ctx, itemName: itemName!, group: group!, party, bank };
}

async function newTagItem(ctx: TenantContext, itemNameId: number, gross = 10): Promise<number> {
  const e = await inv.createStockEntry(ctx, { stockClass: 'GOLD', method: 'TAG', rows: [stockRow({ itemNameId, karatCode: '22K', gross })] });
  return e.items[0]!.id;
}

const sumUdhar = async (partyId: number) => {
  const rows = await db.udharEntry.findMany({ where: { partyId }, select: { amount: true, gold: true } });
  return { amount: rows.reduce((a, r) => a + Number(r.amount), 0), gold: rows.reduce((a, r) => a + Number(r.gold), 0) };
};

describe('sell bill', () => {
  it('TAG line, intra-state GST (CGST/SGST), partial cash: sells the item, posts ledger + udhar balance', async () => {
    const s = await setup();
    const itemId = await newTagItem(s.ctx, s.itemName.id);
    const bill = await billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'GST', partyId: s.party.id, gstPercent: 3, items: [{ stockItemId: itemId, gross: 10, rate: 60000 }], payments: [{ mode: 'CASH', amount: 50000 }] }));
    expect(bill.billNo).toBe('00001');
    expect(Number(bill.sub)).toBe(60000); // metal 10g × 60000/10g, before GST
    expect([Number(bill.cgst), Number(bill.sgst), Number(bill.igst)]).toEqual([900, 900, 0]);
    expect(Number(bill.final)).toBe(61800);
    expect(Number(bill.balance)).toBe(11800);
    expect(bill.items[0]!.stockItemId).toBe(itemId);
    expect((await db.stockItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe('SOLD');

    const led = await db.ledgerEntry.findMany({ where: { source: 'SELL_BILL' } });
    const gold = led.find((r) => r.asset === 'GOLD')!;
    expect(gold.direction).toBe('OUT');
    expect(Number(gold.fine)).toBeCloseTo(9.167, 3);
    const money = led.filter((r) => r.asset === 'MONEY');
    expect(money).toHaveLength(1);
    expect(money[0]!.direction).toBe('IN');
    expect(Number(money[0]!.amount)).toBe(50000);
    expect((await sumUdhar(s.party.id)).amount).toBe(11800);
  });

  it('ROUGH bill has no GST', async () => {
    const s = await setup();
    const itemId = await newTagItem(s.ctx, s.itemName.id);
    const bill = await billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ stockItemId: itemId, gross: 10, rate: 60000 }] }));
    expect([Number(bill.cgst), Number(bill.sgst), Number(bill.igst)]).toEqual([0, 0, 0]);
    expect(Number(bill.final)).toBe(60000);
  });

  it('inter-state party → IGST instead of CGST/SGST', async () => {
    const s = await setup();
    await db.state.createMany({ data: [{ id: 27, name: 'MH' }, { id: 24, name: 'GJ' }] });
    await db.business.update({ where: { id: s.business.id }, data: { stateId: 27 } });
    await db.party.update({ where: { id: s.party.id }, data: { stateId: 24 } });
    const itemId = await newTagItem(s.ctx, s.itemName.id);
    const bill = await billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'GST', partyId: s.party.id, gstPercent: 3, items: [{ stockItemId: itemId, gross: 10, rate: 60000 }] }));
    expect(bill.interState).toBe(true);
    expect([Number(bill.cgst), Number(bill.sgst), Number(bill.igst)]).toEqual([0, 0, 1800]);
  });

  it('mixed payments (cash + online + metal) post one ledger row each', async () => {
    const s = await setup();
    const itemId = await newTagItem(s.ctx, s.itemName.id);
    await billing.createBill(s.ctx, parse({
      kind: 'SELL', billType: 'GST', partyId: s.party.id, items: [{ stockItemId: itemId, gross: 10, rate: 60000 }],
      payments: [{ mode: 'CASH', amount: 10000 }, { mode: 'ONLINE', amount: 5000, bankAccountId: s.bank.id }, { mode: 'METAL', metal: 'GOLD', metalForm: 'BULLION', gross: 2, tunch: 100, rate: 60000 }],
    }));
    const led = await db.ledgerEntry.findMany({ where: { source: 'SELL_BILL' } });
    expect(led.filter((r) => r.asset === 'MONEY' && r.bankAccountId == null)).toHaveLength(1); // cash
    expect(led.filter((r) => r.asset === 'MONEY' && r.bankAccountId === s.bank.id)).toHaveLength(1); // online
    const metalIn = led.filter((r) => r.asset === 'GOLD' && r.direction === 'IN'); // metal payment received
    expect(metalIn).toHaveLength(1);
    expect(Number(metalIn[0]!.fine)).toBeCloseTo(2, 3); // 2g × 100%
  });

  it('balance kept as GOLD writes a gold udhar row + keepWeight', async () => {
    const s = await setup();
    const itemId = await newTagItem(s.ctx, s.itemName.id);
    const bill = await billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, keepBalanceAs: 'GOLD', keepRate: 60000, items: [{ stockItemId: itemId, gross: 10, rate: 60000 }] }));
    // final 60000, paid 0 → 60000 kept as gold at 60000/10g = 10g
    expect(Number(bill.keepWeight)).toBeCloseTo(10, 3);
    const u = await sumUdhar(s.party.id);
    expect(u.amount).toBe(0);
    expect(u.gold).toBeCloseTo(10, 3);
  });

  it('advance (overpayment) → negative money balance', async () => {
    const s = await setup();
    const itemId = await newTagItem(s.ctx, s.itemName.id);
    const bill = await billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ stockItemId: itemId, gross: 10, rate: 60000 }], payments: [{ mode: 'CASH', amount: 70000 }] }));
    expect(Number(bill.balance)).toBe(-10000);
    expect((await sumUdhar(s.party.id)).amount).toBe(-10000);
  });

  it('PAN required when cash ≥ limit and party has no PAN', async () => {
    const s = await setup();
    const itemId = await newTagItem(s.ctx, s.itemName.id);
    await expect(billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ stockItemId: itemId, gross: 10, rate: 300000 }], payments: [{ mode: 'CASH', amount: 200000 }] }))).rejects.toMatchObject({ status: 400 });
  });

  it('line rate outside a RateLimit → 400', async () => {
    const s = await setup();
    await db.rateLimit.create({ data: { businessId: s.business.id, metal: 'GOLD', rateUnit: 'GRAM_10', minRate: 50000, maxRate: 70000 } });
    const itemId = await newTagItem(s.ctx, s.itemName.id);
    await expect(billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ stockItemId: itemId, gross: 10, rate: 80000 }] }))).rejects.toMatchObject({ status: 400 });
  });

  it('cross-tenant party → 404', async () => {
    const s = await setup();
    const b = await createBusiness({ name: 'B' });
    const bParty = await db.party.create({ data: { businessId: b.business.id, type: 'CUSTOMER', name: 'X', mobile: '9000000002', countryCode: '+91' } });
    const itemId = await newTagItem(s.ctx, s.itemName.id);
    await expect(billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'ROUGH', partyId: bParty.id, items: [{ stockItemId: itemId, gross: 10, rate: 60000 }] }))).rejects.toMatchObject({ status: 404 });
  });
});

describe('purchase bill', () => {
  it('creates a new stock item + IN ledger row', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, parse({ kind: 'PURCHASE', billType: 'GST', partyId: s.party.id, items: [{ itemNameId: s.itemName.id, gross: 10, karatCode: '22K', rate: 5000 }] }));
    const newStockId = bill.items[0]!.stockItemId!;
    const item = await db.stockItem.findUniqueOrThrow({ where: { id: newStockId } });
    expect(item.status).toBe('AVAILABLE');
    expect(item.source).toBe('PURCHASE_BILL');
    expect(item.sourceId).toBe(String(bill.id));
    const led = await db.ledgerEntry.findMany({ where: { source: 'PURCHASE_BILL', asset: 'GOLD' } });
    expect(led).toHaveLength(1);
    expect(led[0]!.direction).toBe('IN');
  });
});

describe('delete bill', () => {
  it('delete with returnStock restores the item and nets every ledger + udhar to zero', async () => {
    const s = await setup();
    const itemId = await newTagItem(s.ctx, s.itemName.id);
    const bill = await billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ stockItemId: itemId, gross: 10, rate: 60000 }], payments: [{ mode: 'CASH', amount: 50000 }] }));
    await billing.deleteBill(s.ctx, bill.id, true);
    expect((await db.stockItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe('AVAILABLE');
    const led = await db.ledgerEntry.findMany({ where: { source: 'SELL_BILL' } });
    const signed = (asset: string) => led.filter((r) => r.asset === asset).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(asset === 'MONEY' ? r.amount : r.fine), 0);
    expect(signed('GOLD')).toBeCloseTo(0, 3);
    expect(signed('MONEY')).toBeCloseTo(0, 2);
    expect((await sumUdhar(s.party.id)).amount).toBe(0);
    expect((await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe('DELETED');
  });

  it('delete-only keeps the stock SOLD and the stock ledger, but reverses payments + udhar', async () => {
    const s = await setup();
    const itemId = await newTagItem(s.ctx, s.itemName.id);
    const bill = await billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ stockItemId: itemId, gross: 10, rate: 60000 }], payments: [{ mode: 'CASH', amount: 50000 }] }));
    await billing.deleteBill(s.ctx, bill.id, false);
    expect((await db.stockItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe('SOLD');
    const led = await db.ledgerEntry.findMany({ where: { source: 'SELL_BILL' } });
    expect(led.filter((r) => r.asset === 'GOLD').every((r) => r.reversalOfId == null)).toBe(true); // stock rows untouched
    const moneyNet = led.filter((r) => r.asset === 'MONEY').reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0);
    expect(moneyNet).toBeCloseTo(0, 2); // payment reversed
    expect((await sumUdhar(s.party.id)).amount).toBe(0);
    expect((await db.billPayment.findMany({ where: { billId: bill.id } })).every((p) => !p.isActive)).toBe(true);
  });

  it('purchase delete with returnStock is 409 when a created item is no longer AVAILABLE', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: s.party.id, items: [{ itemNameId: s.itemName.id, gross: 10, karatCode: '22K', rate: 5000 }] }));
    await db.stockItem.update({ where: { id: bill.items[0]!.stockItemId! }, data: { status: 'SOLD' } });
    await expect(billing.deleteBill(s.ctx, bill.id, true)).rejects.toMatchObject({ status: 409 });
  });

  it('a partially-sold LOOSE item is locked for edit, then editable again after the bill is deleted with return', async () => {
    const s = await setup();
    const looseName = await inv.createItemName(s.ctx, { groupId: s.group.id, name: 'Gold Bar', method: 'LOOSE' });
    const e = await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'LOOSE', rows: [stockRow({ itemNameId: looseName!.id, karatCode: '22K', gross: 20, pcs: 1 })] });
    const itemId = e.items[0]!.id;
    const bill = await billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ stockItemId: itemId, gross: 5, pcs: 1, rate: 60000 }] }));
    expect((await db.stockItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe('AVAILABLE'); // partial — still on hand
    await expect(inv.updateStock(s.ctx, itemId, { gross: 10 })).rejects.toMatchObject({ status: 409 }); // live SELL_BILL row blocks edit
    await billing.deleteBill(s.ctx, bill.id, true); // SELL_BILL reversed → no live row
    expect(Number((await inv.updateStock(s.ctx, itemId, { gross: 18 })).gross)).toBe(18);
  });
});

describe('add bill payments', () => {
  it('increments paid atomically and drops the balance + party udhar', async () => {
    const s = await setup();
    const itemId = await newTagItem(s.ctx, s.itemName.id);
    const bill = await billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ stockItemId: itemId, gross: 10, rate: 60000 }], payments: [{ mode: 'CASH', amount: 20000 }] }));
    expect(Number(bill.balance)).toBe(40000);
    const after = await billing.addBillPayments(s.ctx, bill.id, { payments: [{ mode: 'CASH', amount: 15000 }] });
    expect(Number(after.paid)).toBe(35000);
    expect(Number(after.balance)).toBe(25000);
    expect((await sumUdhar(s.party.id)).amount).toBe(25000);
  });
});
