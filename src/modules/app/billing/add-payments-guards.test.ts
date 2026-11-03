import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { billBody } from '../../../shared';
import * as inv from '../inventory';
import * as billing from './service';
import type { TenantContext } from '../../../middleware/context';

/** G7 D-e: a later payment follows the create rules — the PAN rule on the bill's total cash (sell), and no paying a supplier past the due (purchase). */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  const ctx = ctxFor(business.id, root.id);
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const itemName = (await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 }))!;
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const supplier = await db.party.create({ data: { businessId: business.id, type: 'SUPPLIER', name: 'Supp', mobile: '9000000002', countryCode: '+91' } });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  return { ctx, itemName, party, supplier, bank };
}
const paid = async (id: number) => Number((await db.bill.findUniqueOrThrow({ where: { id } })).paid);
/** Resolves once another connection of this DB is waiting on a row lock. */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('no connection ever blocked on the bill row');
}

describe('add bill payments: create-time rules', () => {
  it('sell: cash that takes the bill total to ₹2,00,000 needs the party PAN (400 PAN_REQUIRED, nothing booked); online does not; with the PAN it goes', async () => {
    const s = await setup();
    // ₹3,00,000 ROUGH sell, ₹1,50,000 cash at create (under the limit, no PAN needed)
    const bill = await billing.createBill(s.ctx, billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ description: 'Set', stockClass: 'GOLD', gross: 50, rate: 60000 }], payments: [{ mode: 'CASH', amount: 150000 }] }));
    await expect(billing.addBillPayments(s.ctx, bill.id, { payments: [{ mode: 'CASH', amount: 60000 }] })).rejects.toMatchObject({ status: 400, details: { code: 'PAN_REQUIRED' } });
    expect(await paid(bill.id)).toBe(150000);
    await billing.addBillPayments(s.ctx, bill.id, { payments: [{ mode: 'ONLINE', amount: 10000, bankAccountId: s.bank.id }] });
    await db.party.update({ where: { id: s.party.id }, data: { pan: 'ABCDE1234F' } });
    await billing.addBillPayments(s.ctx, bill.id, { payments: [{ mode: 'CASH', amount: 60000 }] });
    expect(await paid(bill.id)).toBe(220000);
  });

  it('purchase: paying past the bill due → 409 and nothing booked; the exact due settles it; then anything more → 409', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, billBody.parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: s.supplier.id, items: [{ itemNameId: s.itemName.id, gross: 10, karatCode: '22K', rate: 60000 }] }));
    const due = Number(bill.final);
    expect(due).toBeGreaterThan(0);
    await expect(billing.addBillPayments(s.ctx, bill.id, { payments: [{ mode: 'CASH', amount: due + 1 }] })).rejects.toMatchObject({ status: 409 });
    expect(await paid(bill.id)).toBe(0);
    await billing.addBillPayments(s.ctx, bill.id, { payments: [{ mode: 'CASH', amount: due }] });
    await expect(billing.addBillPayments(s.ctx, bill.id, { payments: [{ mode: 'CASH', amount: 1 }] })).rejects.toMatchObject({ status: 409 });
    expect(await paid(bill.id)).toBe(due);
  });

  it('purchase: two payments of the full due at once cannot both pass (the bill row is locked)', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, billBody.parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: s.supplier.id, items: [{ itemNameId: s.itemName.id, gross: 10, karatCode: '22K', rate: 60000 }] }));
    const due = Number(bill.final);
    let paidIn!: () => void;
    const first = new Promise<void>((r) => (paidIn = r));
    // a full payment mid-flight, holding the bill row the way addBillPayments does
    const hold = db.$transaction(async (t) => {
      await t.$queryRaw`SELECT id FROM "Bill" WHERE id = ${bill.id} FOR NO KEY UPDATE`;
      await t.bill.update({ where: { id: bill.id }, data: { paid: { increment: due } } });
      paidIn();
      await lockWaiter(); // the second payment is waiting for the row
    });
    await first;
    const second = billing.addBillPayments(s.ctx, bill.id, { payments: [{ mode: 'CASH', amount: due }] }).catch((e: unknown) => e);
    await hold;
    expect(await second).toMatchObject({ status: 409 }); // it saw the paid bill
    expect(await paid(bill.id)).toBe(due);
  });
});
