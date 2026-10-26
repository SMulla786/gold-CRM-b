/* eslint-disable @typescript-eslint/no-explicit-any -- service inputs are zod-parsed upstream; tests pass partial bodies */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { addBillPaymentsBody, billBody } from '../../../shared';
import * as inv from '../inventory';
import * as schemes from '../schemes/service';
import { closeDay } from '../daybook/service';
import * as billing from './service';
import type { TenantContext } from '../../../middleware/context';

/** TASK-98 Wave 3: SCHEME + UDHAR_ADVANCE bill payment modes — post / edit / delete to zero / DAY_CLOSED / over-balance 409. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx = ctxFor(business.id, root.id);
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const other = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Other', mobile: '9000000002', countryCode: '+91' } });
  return { business, root, ctx, party, other };
}

/** ROUGH sell bill, one direct line: final = ₹60,000. */
const sell = (partyId: number, payments: unknown[]) =>
  billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 10, rate: 60000 }], payments });

const partyMoney = async (partyId: number) => (await db.udharEntry.findMany({ where: { partyId } })).reduce((a, r) => a + Number(r.amount), 0);
const billMoneyIn = async () => (await db.ledgerEntry.findMany({ where: { source: 'SELL_BILL', asset: 'MONEY' } })).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0);
/** party credit of ₹amount (shop owes the party), as an earlier udhar receipt would leave it */
const giveAdvance = (s: Awaited<ReturnType<typeof setup>>, amount: number) =>
  db.udharEntry.create({ data: { businessId: s.business.id, branchId: s.root.id, partyId: s.party.id, txnDate: new Date(), amount: -amount, gold: 0, silver: 0, source: 'UDHAR', sourceId: '999', createdById: 1 } });

describe('UDHAR_ADVANCE pay mode', () => {
  it('post: uses the party credit, no cash ledger row; party balance nets to zero', async () => {
    const s = await setup();
    await giveAdvance(s, 10000);
    const bill = await billing.createBill(s.ctx, sell(s.party.id, [{ mode: 'UDHAR_ADVANCE', amount: 10000 }, { mode: 'CASH', amount: 50000 }]));
    expect(Number(bill.paid)).toBe(60000);
    expect(Number(bill.balance)).toBe(0);
    expect(bill.payments.map((p) => p.mode)).toEqual(['UDHAR_ADVANCE', 'CASH']);
    expect(await billMoneyIn()).toBe(50000); // only the cash moved
    expect(await partyMoney(s.party.id)).toBe(0); // advance −10000 consumed
  });

  it('over-balance → 409 (more than the credit, or no credit at all); nothing is written', async () => {
    const s = await setup();
    await expect(billing.createBill(s.ctx, sell(s.party.id, [{ mode: 'UDHAR_ADVANCE', amount: 1 }]))).rejects.toMatchObject({ status: 409 });
    await giveAdvance(s, 10000);
    await expect(billing.createBill(s.ctx, sell(s.party.id, [{ mode: 'UDHAR_ADVANCE', amount: 10000.01 }]))).rejects.toMatchObject({ status: 409 });
    expect(await db.bill.count()).toBe(0);
    expect(await partyMoney(s.party.id)).toBe(-10000);
  });

  it('edit re-checks against the restored credit; delete returns the party + ledger to where they started', async () => {
    const s = await setup();
    await giveAdvance(s, 10000);
    const bill = await billing.createBill(s.ctx, sell(s.party.id, [{ mode: 'UDHAR_ADVANCE', amount: 10000 }, { mode: 'CASH', amount: 50000 }]));
    // the whole 10000 is available again inside the edit (old use reversed first)
    await billing.editBill(s.ctx, bill.id, sell(s.party.id, [{ mode: 'UDHAR_ADVANCE', amount: 4000 }, { mode: 'CASH', amount: 56000 }]));
    expect(await partyMoney(s.party.id)).toBe(-6000);
    expect(await billMoneyIn()).toBe(56000);
    await billing.deleteBill(s.ctx, bill.id, true);
    expect(await partyMoney(s.party.id)).toBe(-10000);
    expect(await billMoneyIn()).toBe(0);
  });

  it('add-payment: a credit can be used once — the second use of the same advance → 409', async () => {
    const s = await setup();
    await giveAdvance(s, 10000);
    const bill = await billing.createBill(s.ctx, sell(s.party.id, []));
    expect(await partyMoney(s.party.id)).toBe(50000); // 60000 owed − 10000 credit
    const after = await billing.addBillPayments(s.ctx, bill.id, addBillPaymentsBody.parse({ payments: [{ mode: 'UDHAR_ADVANCE', amount: 10000 }] }));
    expect(Number(after.balance)).toBe(50000);
    expect(await partyMoney(s.party.id)).toBe(50000); // moving credit onto the bill changes nothing net
    await expect(billing.addBillPayments(s.ctx, bill.id, addBillPaymentsBody.parse({ payments: [{ mode: 'UDHAR_ADVANCE', amount: 1 }] }))).rejects.toMatchObject({ status: 409 });
  });

  it('DAY_CLOSED → 403 even though no shop asset moves', async () => {
    const s = await setup();
    await giveAdvance(s, 10000);
    await closeDay(s.ctx);
    await expect(billing.createBill(s.ctx, sell(s.party.id, [{ mode: 'UDHAR_ADVANCE', amount: 10000 }]))).rejects.toMatchObject({ status: 403, code: 'DAY_CLOSED' });
    expect(await partyMoney(s.party.id)).toBe(-10000);
  });

  it('purchase bills cannot use it (400)', async () => {
    const s = await setup();
    const [group] = await inv.createItemGroups(s.ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
    const name = await inv.createItemName(s.ctx, { groupId: group!.id, name: 'Gold Ring', method: 'LOOSE' } as any);
    const body = billBody.parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: s.party.id, items: [{ itemNameId: name!.id, gross: 1, rate: 100 }], payments: [{ mode: 'UDHAR_ADVANCE', amount: 1 }] });
    await expect(billing.createBill(s.ctx, body)).rejects.toMatchObject({ status: 400 });
  });
});

describe('SCHEME pay mode', () => {
  /** matured 1-month CASH scheme, no bonus → maturity value ₹2,000 */
  async function maturedEnrollment(s: Awaited<ReturnType<typeof setup>>, partyId = s.party.id, assignId = 'A1') {
    const scheme = await schemes.createScheme(s.ctx, { kind: 'SAVING', type: 'CASH', name: 'S1', emiAmount: 2000, tenureMonths: 1, bonusType: 'NONE', bonusValue: 0, startDate: new Date() });
    return schemes.enroll(s.ctx, { schemeId: scheme.id, partyId, assignId, displayName: 'C', tokenAmount: 0, firstPayment: { amount: 2000, medium: 'CASH' } } as any);
  }
  const status = async (id: number) => db.schemeEnrollment.findUniqueOrThrow({ where: { id } });

  it('post: redeems the enrollment into the bill, no cash ledger row; party balance nets to zero', async () => {
    const s = await setup();
    const e = await maturedEnrollment(s);
    const bill = await billing.createBill(s.ctx, sell(s.party.id, [{ mode: 'SCHEME', enrollmentId: e.id, amount: 2000 }, { mode: 'CASH', amount: 58000 }]));
    expect(Number(bill.balance)).toBe(0);
    expect(bill.payments[0]).toMatchObject({ mode: 'SCHEME', schemeEnrollmentId: e.id });
    expect(Number(bill.payments[0]!.amount)).toBe(2000);
    const after = await status(e.id);
    expect(after.status).toBe('CLOSED');
    expect(after.redeemBillId).toBe(bill.id);
    expect(Number(after.redeemValue)).toBe(2000);
    expect(await billMoneyIn()).toBe(58000);
    expect(await partyMoney(s.party.id)).toBe(0); // maturity credit −2000 used by the bill +2000
  });

  it('over the maturity value → 409 and the enrollment stays open; another party\'s enrollment → 409', async () => {
    const s = await setup();
    const e = await maturedEnrollment(s);
    await expect(billing.createBill(s.ctx, sell(s.party.id, [{ mode: 'SCHEME', enrollmentId: e.id, amount: 2000.01 }]))).rejects.toMatchObject({ status: 409 });
    expect((await status(e.id)).status).toBe('ACTIVE');
    expect(await partyMoney(s.party.id)).toBe(0);
    const theirs = await maturedEnrollment(s, s.other.id, 'B1');
    await expect(billing.createBill(s.ctx, sell(s.party.id, [{ mode: 'SCHEME', enrollmentId: theirs.id, amount: 100 }]))).rejects.toMatchObject({ status: 409 });
  });

  it('edit re-redeems (unused part stays as party credit); delete reopens with the pre-redeem status and nets to zero', async () => {
    const s = await setup();
    const e = await maturedEnrollment(s);
    await schemes.markWon(s.ctx, e.id);
    const bill = await billing.createBill(s.ctx, sell(s.party.id, [{ mode: 'SCHEME', enrollmentId: e.id, amount: 2000 }, { mode: 'CASH', amount: 58000 }]));
    await billing.editBill(s.ctx, bill.id, sell(s.party.id, [{ mode: 'SCHEME', enrollmentId: e.id, amount: 1500 }, { mode: 'CASH', amount: 58500 }]));
    expect((await status(e.id)).status).toBe('CLOSED');
    expect(await partyMoney(s.party.id)).toBe(-500); // 2000 credited, 1500 used
    await billing.deleteBill(s.ctx, bill.id, true);
    const back = await status(e.id);
    expect(back.status).toBe('WON');
    expect(back.redeemBillId).toBeNull();
    expect(back.redeemValue).toBeNull();
    expect(await partyMoney(s.party.id)).toBe(0);
    expect(await billMoneyIn()).toBe(0);
  });

  it('DAY_CLOSED → 403 and the enrollment is not redeemed', async () => {
    const s = await setup();
    const e = await maturedEnrollment(s);
    await closeDay(s.ctx);
    await expect(billing.createBill(s.ctx, sell(s.party.id, [{ mode: 'SCHEME', enrollmentId: e.id, amount: 2000 }]))).rejects.toMatchObject({ status: 403, code: 'DAY_CLOSED' });
    expect((await status(e.id)).status).toBe('ACTIVE');
  });
});
