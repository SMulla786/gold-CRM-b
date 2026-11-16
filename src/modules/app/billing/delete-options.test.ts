/* eslint-disable @typescript-eslint/no-explicit-any -- service inputs are zod-parsed upstream; tests pass partial bodies */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../../test/helpers/factory';
import { billBody, openingBalanceBody, udharBody } from '../../../shared';
import { kachaBalance } from '../../../lib/kacha';
import * as inv from '../inventory';
import * as schemes from '../schemes/service';
import * as udharSvc from '../udhar';
import { createOpeningBalances } from '../opening';
import * as billing from './service';
import type { TenantContext } from '../../../middleware/context';

/**
 * G7 closure (A3): what "Delete only" (returnStock=false) and "Delete and return stock" (returnStock=true) do, read back from
 * the database, for a plain SELL bill, a PURCHASE bill and an order's bill: Bill row, stock rows and StockItems (TAG + a
 * partly sold LOOSE lot), payments and their MONEY / bank / metal ledger rows, the party balance (incl. an Udhar settlement and
 * a scheme redeemed on the bill), the kacha / bullion pools and the audit row.
 */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook', 'udhari', 'schemes'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

const stockRow = (over: Record<string, unknown>) => ({ pcs: 1, gross: 10, less: 0, wastage: 0, stoneCharge: 0, labour: 0, labourUnit: 'PER_GRAM', other: 0, ...over });

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  const ctx = ctxFor(business.id, root.id);
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const ring = (await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 }))!;
  const bar = (await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Bar', method: 'LOOSE' }))!;
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const supplier = await db.party.create({ data: { businessId: business.id, type: 'SUPPLIER', name: 'Supp', mobile: '9000000003', countryCode: '+91' } });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  return { business, root, ctx, ring, bar, party, supplier, bank };
}
type S = Awaited<ReturnType<typeof setup>>;

const net = (rows: { direction: string; amount: unknown; fine: unknown }[], f: 'amount' | 'fine') => Number(rows.reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r[f] ?? 0), 0).toFixed(3));
const sum = (rows: { amount: unknown }[]) => Number(rows.reduce((a, r) => a + Number(r.amount), 0).toFixed(2));
/** rows of a source that stand: originals never reversed */
async function standing(where: Record<string, unknown>) {
  const rows = await db.ledgerEntry.findMany({ where: { ...where, reversalOfId: null } });
  const reversed = new Set((await db.ledgerEntry.findMany({ where: { reversalOfId: { in: rows.map((r) => r.id) } } })).map((r) => r.reversalOfId));
  return rows.filter((r) => !reversed.has(r.id));
}

/** Everything a bill delete can touch, for one bill. */
async function effects(s: S, billId: number, items: number[]) {
  const bill = await db.bill.findUniqueOrThrow({ where: { id: billId }, include: { payments: { orderBy: { id: 'asc' } } } });
  const source = bill.kind === 'SELL' ? 'SELL_BILL' : 'PURCHASE_BILL';
  const payRows = await db.ledgerEntry.findMany({ where: { source, sourceId: { startsWith: `${billId}-P` } } });
  const stock = await db.stockItem.findMany({ where: { id: { in: items } }, orderBy: { id: 'asc' } });
  return {
    bill: [bill.status, bill.deletedWithStock],
    stockItems: stock.map((i) => [i.method, i.status, Number(i.gross)]),
    stockRowsStanding: (await standing({ source, sourceId: String(billId), stockItemId: { not: null } })).length,
    payments: bill.payments.map((p) => [p.mode, p.isActive, p.udharTxnId != null]),
    cash: net(payRows.filter((r) => r.asset === 'MONEY' && r.bankAccountId == null), 'amount'),
    bank: net(payRows.filter((r) => r.asset === 'MONEY' && r.bankAccountId != null), 'amount'),
    metal: net(payRows.filter((r) => r.asset === 'GOLD'), 'fine'),
    billPartyRows: sum(await db.udharEntry.findMany({ where: { source, sourceId: { in: [String(billId), `${billId}-A`] } } })),
    pools: Object.fromEntries(Object.entries(await kachaBalance(db, s.root.id, 'GOLD')).map(([k, v]) => [k, Number(v)])),
    audit: await db.activityLog.count({ where: { entity: 'BILL', entityId: String(billId), action: 'DELETED' } }),
  };
}
const partyBalance = async (partyId: number) => sum(await db.udharEntry.findMany({ where: { partyId } }));

describe('SELL bill: TAG piece + 5 g of a 20 g LOOSE lot; paid cash, bank, 2 g old gold (kacha) and a matured scheme; ₹3,000 settled later from Udhar', () => {
  async function sellBill(s: S) {
    const tag = (await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'TAG', rows: [stockRow({ itemNameId: s.ring.id, karatCode: '22K', gross: 10 })] })).items[0]!.id;
    const lot = (await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'LOOSE', rows: [stockRow({ itemNameId: s.bar.id, karatCode: '22K', gross: 20 })] })).items[0]!.id;
    const scheme = await schemes.createScheme(s.ctx, { kind: 'SAVING', type: 'CASH', name: 'S1', emiAmount: 2000, tenureMonths: 1, bonusType: 'NONE', bonusValue: 0, startDate: new Date() } as any);
    const enrollment = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'A1', displayName: 'C', tokenAmount: 0, firstPayment: { amount: 2000, medium: 'CASH' } } as any);
    const bill = await billing.createBill(s.ctx, billBody.parse({
      kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ stockItemId: tag, gross: 10, rate: 60000 }, { stockItemId: lot, gross: 5, pcs: 1, rate: 60000 }],
      payments: [{ mode: 'CASH', amount: 10000 }, { mode: 'ONLINE', amount: 5000, bankAccountId: s.bank.id }, { mode: 'METAL', metal: 'GOLD', metalForm: 'KACHA', gross: 2, tunch: 100, rate: 60000 }, { mode: 'SCHEME', enrollmentId: enrollment.id, amount: 2000 }],
    }));
    const settle = await udharSvc.createUdharTxn(s.ctx, udharBody.parse({ partyId: s.party.id, cashIn: 3000, settleBillId: bill.id }));
    const final = Number(bill.final);
    expect(await effects(s, bill.id, [tag, lot])).toEqual({
      bill: ['ACTIVE', false], stockItems: [['TAG', 'SOLD', 10], ['LOOSE', 'AVAILABLE', 15]], stockRowsStanding: 2,
      payments: [['CASH', true, false], ['ONLINE', true, false], ['METAL', true, false], ['SCHEME', true, false], ['CASH', true, true]],
      cash: 10000, bank: 5000, metal: 2, billPartyRows: Number((final - 29000 + 2000).toFixed(2)), pools: { kacha: 2, bullion: 0 }, audit: 0,
    });
    expect([await partyBalance(s.party.id), (await db.schemeEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status]).toEqual([Number((final - 32000).toFixed(2)), 'CLOSED']);
    return { tag, lot, bill, enrollment, settle };
  }
  /** shared by both options: payments, party rows, scheme and pools are undone; the Udhar settlement's own cash + party rows stay */
  const undone = { payments: [['CASH', false, false], ['ONLINE', false, false], ['METAL', false, false], ['SCHEME', false, false], ['CASH', false, true]], cash: 0, bank: 0, metal: 0, billPartyRows: 0, pools: { kacha: 0, bullion: 0 }, audit: 1 };

  it('Delete only: the sale stands (TAG piece SOLD, the lot keeps 15 g, stock rows stay); payments, bill party rows, scheme and old gold are undone; the Udhar cash stays as the customer\'s ₹3,000 credit', async () => {
    const s = await setup();
    const b = await sellBill(s);
    await billing.deleteBill(s.ctx, b.bill.id, false);
    expect(await effects(s, b.bill.id, [b.tag, b.lot])).toEqual({ bill: ['DELETED', false], stockItems: [['TAG', 'SOLD', 10], ['LOOSE', 'AVAILABLE', 15]], stockRowsStanding: 2, ...undone });
    const e = await db.schemeEnrollment.findUniqueOrThrow({ where: { id: b.enrollment.id } });
    expect([e.status, e.redeemBillId, await partyBalance(s.party.id), Number((await db.bill.findUniqueOrThrow({ where: { id: b.bill.id } })).paid)]).toEqual(['ACTIVE', null, -3000, 32000]);
    // deleting the Udhar entry afterwards takes back its cash and party rows; the deleted bill is not touched again
    await udharSvc.deleteUdharTxn(s.ctx, b.settle.id);
    expect([await partyBalance(s.party.id), net(await db.ledgerEntry.findMany({ where: { source: 'UDHAR', sourceId: String(b.settle.id) } }), 'amount'), Number((await db.bill.findUniqueOrThrow({ where: { id: b.bill.id } })).paid)]).toEqual([0, 0, 32000]);
  });

  it('Delete and return stock: the same, and the sale is undone too — TAG piece AVAILABLE, the lot back to 20 g, every stock row reversed', async () => {
    const s = await setup();
    const b = await sellBill(s);
    await billing.deleteBill(s.ctx, b.bill.id, true);
    expect(await effects(s, b.bill.id, [b.tag, b.lot])).toEqual({ bill: ['DELETED', true], stockItems: [['TAG', 'AVAILABLE', 10], ['LOOSE', 'AVAILABLE', 20]], stockRowsStanding: 0, ...undone });
    expect([(await db.schemeEnrollment.findUniqueOrThrow({ where: { id: b.enrollment.id } })).status, await partyBalance(s.party.id)]).toEqual(['ACTIVE', -3000]);
  });
});

describe('PURCHASE bill: a TAG ring and 8 g LOOSE, paid cash, bank and 1 g bullion', () => {
  async function purchase(s: S) {
    await createOpeningBalances(s.ctx, openingBalanceBody.parse({ entries: [{ kind: 'METAL', metal: 'GOLD', metalForm: 'BULLION', fine: 5 }] }));
    const bill = await billing.createBill(s.ctx, billBody.parse({
      kind: 'PURCHASE', billType: 'ROUGH', partyId: s.supplier.id, items: [{ itemNameId: s.ring.id, gross: 5, rate: 5000 }, { itemNameId: s.bar.id, gross: 8, rate: 5000 }],
      payments: [{ mode: 'CASH', amount: 1000 }, { mode: 'ONLINE', amount: 500, bankAccountId: s.bank.id }, { mode: 'METAL', metal: 'GOLD', metalForm: 'BULLION', gross: 1, tunch: 100, rate: 60000 }],
    }));
    const items = (await db.billItem.findMany({ where: { billId: bill.id }, orderBy: { id: 'asc' } })).map((i) => i.stockItemId!);
    expect(await effects(s, bill.id, items)).toEqual({
      bill: ['ACTIVE', false], stockItems: [['TAG', 'AVAILABLE', 5], ['LOOSE', 'AVAILABLE', 8]], stockRowsStanding: 2,
      payments: [['CASH', true, false], ['ONLINE', true, false], ['METAL', true, false]], cash: -1000, bank: -500, metal: -1,
      billPartyRows: -Number((Number(bill.final) - 7500).toFixed(2)), pools: { kacha: 0, bullion: 4 }, audit: 0,
    });
    return { bill, items };
  }
  const undone = { payments: [['CASH', false, false], ['ONLINE', false, false], ['METAL', false, false]], cash: 0, bank: 0, metal: 0, billPartyRows: 0, pools: { kacha: 0, bullion: 5 }, audit: 1 };

  it('Delete only: the goods stay in stock (AVAILABLE, stock rows stand) while the supplier\'s due and every payment are undone', async () => {
    const s = await setup();
    const p = await purchase(s);
    await billing.deleteBill(s.ctx, p.bill.id, false);
    expect(await effects(s, p.bill.id, p.items)).toEqual({ bill: ['DELETED', false], stockItems: [['TAG', 'AVAILABLE', 5], ['LOOSE', 'AVAILABLE', 8]], stockRowsStanding: 2, ...undone });
  });

  it('Delete and return stock: the created items are DELETED and their stock rows reversed', async () => {
    const s = await setup();
    const p = await purchase(s);
    await billing.deleteBill(s.ctx, p.bill.id, true);
    expect(await effects(s, p.bill.id, p.items)).toEqual({ bill: ['DELETED', true], stockItems: [['TAG', 'DELETED', 5], ['LOOSE', 'DELETED', 8]], stockRowsStanding: 0, ...undone });
  });

  it('Delete and return stock once a purchased item was sold → 409 and nothing changes (Delete only stays possible)', async () => {
    const s = await setup();
    const p = await purchase(s);
    await billing.createBill(s.ctx, billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ stockItemId: p.items[0]!, gross: 5, rate: 60000 }] }));
    const before = await effects(s, p.bill.id, p.items);
    await expect(billing.deleteBill(s.ctx, p.bill.id, true)).rejects.toMatchObject({ status: 409 });
    expect(await effects(s, p.bill.id, p.items)).toEqual(before);
    await billing.deleteBill(s.ctx, p.bill.id, false);
    expect((await effects(s, p.bill.id, p.items)).stockItems).toEqual([['TAG', 'SOLD', 5], ['LOOSE', 'AVAILABLE', 8]]);
  });

  // OWNER DECISION (A3, behaviour not changed): an item moved to another branch is still AVAILABLE, so "return stock" deletes it
  // and reverses only the PURCHASE_BILL row — its transfer rows stand: the purchase branch nets −5 g, the other branch +5 g for a
  // DELETED item. it.fails = today's code breaks the invariant; flip to it() once the owner picks refuse-if-moved or reverse-every-row.
  it.fails('Delete and return stock after a purchased item was transferred: every branch nets that DELETED item to zero', async () => {
    const s = await setup();
    const other = await createBranch({ businessId: s.business.id, parentId: s.root.id, name: 'B2' });
    const ctx = { ...s.ctx, branchIds: [s.root.id, other.id] };
    const p = await purchase({ ...s, ctx });
    await inv.createStockTransfer(ctx, { fromBranchId: s.root.id, toBranchId: other.id, stockItemIds: [p.items[0]!] });
    await billing.deleteBill(ctx, p.bill.id, true);
    const rows = await db.ledgerEntry.findMany({ where: { stockItemId: p.items[0]! } });
    const perBranch = [s.root.id, other.id].map((b) => net(rows.filter((r) => r.branchId === b).map((r) => ({ ...r, fine: r.gross })), 'fine'));
    expect([(await db.stockItem.findUniqueOrThrow({ where: { id: p.items[0]! } })).status, perBranch]).toEqual(['DELETED', [0, 0]]);
  });
});

describe("an order's bill", () => {
  it('Delete only → 409 and nothing changes; Delete and return stock re-opens the order (READY, pieces RESERVED) and undoes the bill\'s payments', async () => {
    const s = await setup();
    const order = await db.order.create({ data: { businessId: s.business.id, branchId: s.root.id, orderNo: 1, partyId: s.party.id, orderDate: new Date(), status: 'READY' } });
    const piece = await db.stockItem.create({ data: { businessId: s.business.id, branchId: s.root.id, stockClass: 'GOLD', groupId: s.ring.group.id, itemNameId: s.ring.id, method: 'TAG', tagNo: 'OR0001', karatCode: '22K', pcs: 1, gross: 10, less: 0, net: 10, tunch: 91.67, wastage: 0, fine: 9.167, status: 'RESERVED', source: 'ORDER_RECEIVE', sourceId: String(order.id), createdById: 1 } });
    await db.orderItem.create({ data: { orderId: order.id, itemNameId: s.ring.id, metal: 'GOLD', touch: 91.67, gross: 10, net: 10, fine: 9.167, status: 'RECEIVED', stockItemId: piece.id } });
    const bill = await billing.createBill(s.ctx, billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, orderId: order.id, items: [{ stockItemId: piece.id, gross: 10, rate: 60000 }], payments: [{ mode: 'CASH', amount: 10000 }] }));
    const orderState = async () => { const o = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } }); return [o.status, o.billId, o.items.map((i) => i.status)]; };

    const before = [await effects(s, bill.id, [piece.id]), await orderState()];
    await expect(billing.deleteBill(s.ctx, bill.id, false)).rejects.toMatchObject({ status: 409 });
    expect([await effects(s, bill.id, [piece.id]), await orderState()]).toEqual(before);

    await billing.deleteBill(s.ctx, bill.id, true);
    expect(await effects(s, bill.id, [piece.id])).toMatchObject({ bill: ['DELETED', true], stockItems: [['TAG', 'RESERVED', 10]], stockRowsStanding: 0, payments: [['CASH', false, false]], cash: 0, billPartyRows: 0, audit: 1 });
    expect(await orderState()).toEqual(['READY', null, ['RECEIVED']]);
  });
});
