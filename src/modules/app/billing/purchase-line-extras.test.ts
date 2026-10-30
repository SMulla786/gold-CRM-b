import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { billBody } from '../../../shared';
import * as inv from '../inventory';
import * as billing from './service';
import type { TenantContext } from '../../../middleware/context';

// Purchase Bill parity: Supp item / Supp tag kept on the bill line; HUID / RFID / Remark land on the created stock item.

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

const parse = (o: Record<string, unknown>) => billBody.parse(o);

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx = ctxFor(business.id, root.id);
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const itemName = await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
  const supplier = await db.party.create({ data: { businessId: business.id, type: 'SUPPLIER', name: 'Supp', mobile: '9000000003', countryCode: '+91' } });
  const customer = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  return { ctx, itemName: itemName!, supplier, customer };
}

const purchase = (s: Awaited<ReturnType<typeof setup>>, line: Record<string, unknown>) =>
  parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: s.supplier.id, items: [{ itemNameId: s.itemName.id, gross: 5, rate: 5000, ...line }] });

describe('purchase line extras', () => {
  it('supplier item / tag stay on the bill line; HUID, RFID EPC and remark go onto the stock item', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, purchase(s, { supplierItem: 'Ladies ring 22k', supplierTag: 'SR-77', huid: 'ab12cd', epcCode: 'e2801170', remarks: 'from Mumbai lot' }));
    // getBill echoes the stock item's HUID / RFID / remark so the edit form can send them back
    expect(bill.items[0]).toMatchObject({ supplierItem: 'Ladies ring 22k', supplierTag: 'SR-77', huid: 'AB12CD', epcCode: 'E2801170', remarks: 'from Mumbai lot' });
    const item = await db.stockItem.findUniqueOrThrow({ where: { id: bill.items[0]!.stockItemId! } });
    expect(item).toMatchObject({ huid: 'AB12CD', codeType: 'RFID', epcCode: 'E2801170', remarks: 'from Mumbai lot' });
  });

  it('edit re-creates the stock with the same RFID EPC (the old, deleted item frees it)', async () => {
    const s = await setup();
    const line = { supplierItem: 'Ladies ring', huid: 'AB12CD', epcCode: 'E2801170', remarks: 'lot 1' };
    const bill = await billing.createBill(s.ctx, purchase(s, line));
    const edited = await billing.editBill(s.ctx, bill.id, purchase(s, { ...line, gross: 6, remarks: 'lot 1 (fixed)' }));
    expect(edited.items[0]).toMatchObject({ supplierItem: 'Ladies ring', huid: 'AB12CD', epcCode: 'E2801170', remarks: 'lot 1 (fixed)', gross: '6' });
    const old = await db.stockItem.findUniqueOrThrow({ where: { id: bill.items[0]!.stockItemId! } });
    expect(old).toMatchObject({ status: 'DELETED', epcCode: null });
  });

  it('edit of a TAG purchase keeps its tag no. (was 409: the deleted old item still held the tag)', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, purchase(s, { tagNo: 'GR9001' }));
    const edited = await billing.editBill(s.ctx, bill.id, purchase(s, { tagNo: 'GR9001', gross: 6 }));
    expect(edited.items[0]).toMatchObject({ tagNo: 'GR9001', gross: '6' });
    expect(await db.stockItem.count({ where: { tagNo: 'GR9001', status: 'AVAILABLE' } })).toBe(1);
  });

  it('without the extras nothing changes (BARCODE, nulls)', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, purchase(s, {}));
    expect(bill.items[0]).toMatchObject({ supplierItem: null, supplierTag: null });
    const item = await db.stockItem.findUniqueOrThrow({ where: { id: bill.items[0]!.stockItemId! } });
    expect(item).toMatchObject({ huid: null, codeType: 'BARCODE', epcCode: null, remarks: null });
  });

  it('bad HUID / EPC are rejected by the schema; a duplicate EPC → 409 and no bill', async () => {
    const s = await setup();
    expect(() => purchase(s, { huid: 'ABC' })).toThrow();
    expect(() => purchase(s, { epcCode: 'not-hex' })).toThrow();
    await billing.createBill(s.ctx, purchase(s, { epcCode: 'E2801170' }));
    await expect(billing.createBill(s.ctx, purchase(s, { epcCode: 'E2801170' }))).rejects.toMatchObject({ code: 'P2002' });
    expect(await db.bill.count()).toBe(1);
  });

  it('supplier fields are ignored on a sell bill', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.customer.id, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 1, rate: 60000, supplierItem: 'x', supplierTag: 'y' }] }));
    expect(bill.items[0]).toMatchObject({ supplierItem: null, supplierTag: null });
  });
});

describe('INV-12 purchase stones per item', () => {
  const stones = [{ name: 'Ruby', pcs: 2, weight: 0.5, unit: 'CT', rate: 4000, amount: 2000 }, { name: 'CZ', pcs: 10 }];

  it('stones land on the created stock item (tenant-tagged), are echoed by getBill + GET /stock/:id, and do not change the money', async () => {
    const s = await setup();
    const plain = await billing.createBill(s.ctx, purchase(s, { stoneCharge: 2000 }));
    const bill = await billing.createBill(s.ctx, purchase(s, { stoneCharge: 2000, stones }));
    expect(bill.final).toBe(plain.final); // descriptive: stoneCharge stays the line's stone money
    expect(bill.items[0]!.stones!.map(({ id: _id, ...x }) => x)).toEqual([
      { name: 'Ruby', pcs: 2, weight: '0.5', unit: 'CT', rate: '4000', amount: '2000' },
      { name: 'CZ', pcs: 10, weight: '0', unit: 'CT', rate: '0', amount: '0' },
    ]);
    expect((await inv.getStock(s.ctx, bill.items[0]!.stockItemId!)).stones).toHaveLength(2);
    expect(await db.stockItemStone.count({ where: { businessId: s.ctx.businessId! } })).toBe(2);
    expect(plain.items[0]!.stones).toEqual([]);
  });

  it('edit re-creates the stock with the stones sent back; the deleted item keeps its own', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, purchase(s, { stones }));
    const edited = await billing.editBill(s.ctx, bill.id, purchase(s, { gross: 6, stones: [stones[0]] }));
    expect(edited.items[0]!.stones!.map((x) => x.name)).toEqual(['Ruby']);
    expect(await db.stockItemStone.count({ where: { stockItemId: bill.items[0]!.stockItemId! } })).toBe(2);
  });

  it('a blank stone name is rejected by the schema; stones on a sell line are ignored', async () => {
    const s = await setup();
    expect(() => purchase(s, { stones: [{ name: ' ' }] })).toThrow();
    const bill = await billing.createBill(s.ctx, parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.customer.id, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 1, rate: 60000, stones }] }));
    expect(bill.items[0]!.stones).toBeUndefined();
    expect(await db.stockItemStone.count()).toBe(0);
  });
});

describe('INV-12 stone charge = Σ stone amounts (owner 2026-10-30)', () => {
  const st = (name: string, amount: number) => ({ name, amount });
  const line = async (b: { items: { stockItemId: number | null; stoneCharge: string }[] }) => {
    const item = await db.stockItem.findUniqueOrThrow({ where: { id: b.items[0]!.stockItemId! } });
    return { bill: Number(b.items[0]!.stoneCharge), stock: Number(item.stoneCharge) };
  };
  const partyMoney = async (partyId: number) => (await db.udharEntry.findMany({ where: { partyId } })).reduce((a, r) => a + Number(r.amount), 0);
  const stockValue = async () => (await db.ledgerEntry.findMany({ where: { source: 'PURCHASE_BILL' } })).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0);

  it('several stones: charge = their total rounded half-up to the paisa, counted once in the bill total', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, purchase(s, { stoneCharge: 9999, stones: [st('Ruby', 100.125), st('Emerald', 200.13), st('CZ', 0)] }));
    expect(await line(bill)).toEqual({ bill: 300.26, stock: 300.26 }); // 300.255 → 300.26; the typed 9999 is replaced
    const plain = await billing.createBill(s.ctx, purchase(s, { stoneCharge: 300.26 }));
    expect(bill.final).toBe(plain.final);
    expect(Number(bill.items[0]!.total)).toBe(Number(plain.items[0]!.total));
  });

  it('stones of zero amount give a zero charge; no stones keeps the typed charge', async () => {
    const s = await setup();
    expect((await line(await billing.createBill(s.ctx, purchase(s, { stoneCharge: 500, stones: [st('CZ', 0)] })))).bill).toBe(0);
    expect((await line(await billing.createBill(s.ctx, purchase(s, { stoneCharge: 500 })))).bill).toBe(500);
    expect((await line(await billing.createBill(s.ctx, purchase(s, { stoneCharge: 500, stones: [] })))).bill).toBe(500);
  });

  it('edit re-syncs the charge (more stones, then none → typed charge); stock value and party balance follow', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, purchase(s, { stones: [st('Ruby', 2000)] }));
    const base = Number(bill.final) - 2000;
    const more = await billing.editBill(s.ctx, bill.id, purchase(s, { stones: [st('Ruby', 2000), st('Pearl', 1000.5)] }));
    expect(await line(more)).toEqual({ bill: 3000.5, stock: 3000.5 });
    expect(Number(more.final)).toBe(Math.round(base + 3000.5)); // final rounds to the rupee
    expect(await stockValue()).toBe(Number(more.items[0]!.total));
    expect(await partyMoney(s.supplier.id)).toBe(-Number(more.final)); // shop owes the supplier the new total once
    const none = await billing.editBill(s.ctx, bill.id, purchase(s, { stoneCharge: 700 }));
    expect(await line(none)).toEqual({ bill: 700, stock: 700 });
    expect(none.items[0]!.stones).toEqual([]);
  });

  it('delete reverses stock value and the supplier balance to zero; stones stay with the deleted stock item', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, purchase(s, { stones: [st('Ruby', 2000), st('Pearl', 500)] }));
    expect(await partyMoney(s.supplier.id)).toBe(-Number(bill.final));
    await billing.deleteBill(s.ctx, bill.id, true); // purchase: delete the created stock too
    expect(await partyMoney(s.supplier.id)).toBe(0);
    expect(await stockValue()).toBe(0);
    expect((await db.stockItem.findUniqueOrThrow({ where: { id: bill.items[0]!.stockItemId! } })).status).toBe('DELETED');
    expect(await db.stockItemStone.count({ where: { stockItemId: bill.items[0]!.stockItemId! } })).toBe(2);
  });

  it('tenant scope: stone rows carry the business; another business cannot read the bill or its stock', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, purchase(s, { stones: [st('Ruby', 2000)] }));
    expect(await db.stockItemStone.findMany({ select: { businessId: true } })).toEqual([{ businessId: s.ctx.businessId }]);
    const other = await createBusiness({ name: 'B' });
    const octx = { ...s.ctx, businessId: other.business.id, scopeBranchId: other.root.id, branchIds: [other.root.id], activeBranchId: other.root.id };
    await expect(billing.getBill(octx, bill.id)).rejects.toMatchObject({ status: 404 });
    await expect(inv.getStock(octx, bill.items[0]!.stockItemId!)).rejects.toMatchObject({ status: 404 });
  });
});
