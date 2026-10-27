import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { billBody, billListQuery } from '../../../shared';
import * as inv from '../inventory';
import * as billing from './service';
import type { TenantContext } from '../../../middleware/context';

// TASK-98 billing extras: bill list partyType filter, purchase "default sale value" on the created stock item.

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

const parse = (o: Record<string, unknown>) => billBody.parse(o);

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  const ctx = ctxFor(business.id, root.id);
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const itemName = await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
  const customer = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const supplier = await db.party.create({ data: { businessId: business.id, type: 'SUPPLIER', name: 'Supp', mobile: '9000000003', countryCode: '+91' } });
  return { business, root, ctx, itemName: itemName!, group: group!, customer, supplier };
}

const list = (ctx: TenantContext, q: Record<string, unknown>) => billing.listBills(ctx, billListQuery.parse({ kind: 'PURCHASE', ...q }));

describe('bill list partyType filter', () => {
  it('returns only bills whose party has that type; combines with q', async () => {
    const s = await setup();
    const line = { itemNameId: s.itemName.id, gross: 10, karatCode: '22K', rate: 5000 };
    const fromSupplier = await billing.createBill(s.ctx, parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: s.supplier.id, items: [line] }));
    const fromCustomer = await billing.createBill(s.ctx, parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: s.customer.id, items: [line] }));

    expect((await list(s.ctx, {})).total).toBe(2);
    expect((await list(s.ctx, { partyType: 'SUPPLIER' })).items.map((b) => b.id)).toEqual([fromSupplier.id]);
    expect((await list(s.ctx, { partyType: 'CUSTOMER' })).items.map((b) => b.id)).toEqual([fromCustomer.id]);
    expect((await list(s.ctx, { partyType: 'KARIGAR' })).total).toBe(0);
    // AND-ed with q (q alone matches the customer's bill by name)
    expect((await list(s.ctx, { q: 'Cust', partyType: 'SUPPLIER' })).total).toBe(0);
    expect((await list(s.ctx, { q: 'Cust', partyType: 'CUSTOMER' })).items.map((b) => b.id)).toEqual([fromCustomer.id]);
  });

  it('rejects an unknown party type', () => {
    expect(() => billListQuery.parse({ kind: 'SELL', partyType: 'NOPE' })).toThrow();
  });
});

describe('purchase default sale value', () => {
  const ledgerSnapshot = async (billId: number) => {
    const led = await db.ledgerEntry.findMany({ where: { source: 'PURCHASE_BILL', sourceId: String(billId) }, orderBy: { id: 'asc' } });
    return led.map((r) => ({ asset: r.asset, direction: r.direction, fine: Number(r.fine), amount: Number(r.amount) }));
  };
  const udhar = async (partyId: number) => (await db.udharEntry.findMany({ where: { partyId }, select: { amount: true } })).reduce((a, r) => a + Number(r.amount), 0);

  it('saleRate / saleLabour / saleLabourUnit land on the stock item; purchaseCost, bill, ledger and udhar are unchanged', async () => {
    const s = await setup();
    const base = { itemNameId: s.itemName.id, gross: 10, karatCode: '22K', rate: 5000, labour: 100, labourUnit: 'PER_GRAM' };
    const plain = await billing.createBill(s.ctx, parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: s.supplier.id, items: [base], payments: [{ mode: 'CASH', amount: 1000 }] }));
    const udharAfterPlain = await udhar(s.supplier.id);
    const withSale = await billing.createBill(s.ctx, parse({
      kind: 'PURCHASE', billType: 'ROUGH', partyId: s.supplier.id, payments: [{ mode: 'CASH', amount: 1000 }],
      items: [{ ...base, saleRate: 6500, saleLabour: 12, saleLabourUnit: 'PERCENT' }],
    }));

    const plainItem = await db.stockItem.findUniqueOrThrow({ where: { id: plain.items[0]!.stockItemId! } });
    const saleItem = await db.stockItem.findUniqueOrThrow({ where: { id: withSale.items[0]!.stockItemId! } });
    // without sale values: today's behaviour (purchase rate/labour copied)
    expect(Number(plainItem.rate)).toBe(5000);
    expect(Number(plainItem.labour)).toBe(100);
    expect(plainItem.labourUnit).toBe('PER_GRAM');
    // with sale values: stored on the stock item
    expect(Number(saleItem.rate)).toBe(6500);
    expect(Number(saleItem.labour)).toBe(12);
    expect(saleItem.labourUnit).toBe('PERCENT');
    // cost side identical
    expect(Number(saleItem.purchaseCost)).toBe(Number(plainItem.purchaseCost));
    expect(Number(withSale.final)).toBe(Number(plain.final));
    expect(Number(withSale.items[0]!.rate)).toBe(5000);
    expect(Number(withSale.items[0]!.labour)).toBe(100);
    expect(await ledgerSnapshot(withSale.id)).toEqual(await ledgerSnapshot(plain.id));
    expect((await udhar(s.supplier.id)) - udharAfterPlain).toBeCloseTo(udharAfterPlain, 2); // second bill adds the same udhar as the first
  });

  it('sale values are ignored on SELL lines (schema accepts, nothing breaks)', () => {
    const b = parse({ kind: 'SELL', billType: 'ROUGH', partyId: 1, items: [{ stockItemId: 1, gross: 10, rate: 60000, saleRate: 1 }] });
    expect(b.items[0]!.saleRate).toBe(1);
    expect(parse({ kind: 'SELL', billType: 'ROUGH', partyId: 1, items: [{ stockItemId: 1, gross: 10 }] }).items[0]!.saleRate).toBeUndefined();
  });
});
