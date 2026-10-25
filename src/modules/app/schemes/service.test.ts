import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import * as schemes from './service';
import type { TenantContext } from '../../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.metalRate.create({ data: { businessId: business.id, metal: 'GOLD', branchId: root.id, rateUnit: 'GRAM_10', karatCode: '24K', sellRate: 60000, buyRate: 59000, effectiveAt: new Date() } });
  const ctx = ctxFor(business.id, root.id);
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  return { business, root, ctx, party, bank };
}
const cashScheme = (ctx: TenantContext, over: Record<string, unknown> = {}) =>
  schemes.createScheme(ctx, { kind: 'SAVING', type: 'CASH', name: 'Gold11', emiAmount: 2000, tenureMonths: 11, bonusType: 'ONE_EMI', bonusValue: 0, startDate: new Date(), ...over });
const schemeMoneyIn = async () => (await db.ledgerEntry.findMany({ where: { source: 'SCHEME', asset: 'MONEY', direction: 'IN' } })).length;
const udharAmount = async (partyId: number) => (await db.udharEntry.findMany({ where: { partyId } })).reduce((a, r) => a + Number(r.amount), 0);

describe('schemes', () => {
  it('enroll with token + first EMI → 2 payments, 2 SCHEME money-in rows', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'A1', displayName: 'Cust', tokenAmount: 500, firstPayment: { amount: 2000, medium: 'CASH' } } as any);
    expect(e.payments).toHaveLength(2);
    expect(await schemeMoneyIn()).toBe(2);
    expect(e.emisPaid).toBe(1); // token takes no installment slot
  });

  it('paying the same month twice → 409, even concurrently', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'A1', displayName: 'C', tokenAmount: 0 } as any);
    await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 1, amount: 2000, medium: 'CASH' } as any);
    await expect(schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 1, amount: 2000, medium: 'CASH' } as any)).rejects.toMatchObject({ status: 409 });

    const e2 = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'A2', displayName: 'C', tokenAmount: 0 } as any);
    const pay = () => schemes.addPayment(s.ctx, { enrollmentId: e2.id, emiNo: 3, amount: 2000, medium: 'CASH' } as any);
    const r = await Promise.allSettled([pay(), pay()]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected' && (x.reason as any).status === 409)).toHaveLength(1);
  });

  it('reversing a payment frees the month to be paid again', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'A1', displayName: 'C', tokenAmount: 0 } as any);
    const paid = await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 1, amount: 2000, medium: 'CASH' } as any);
    await schemes.reversePayment(s.ctx, paid.payments.find((p) => p.emiNo === 1)!.id);
    const after = await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 1, amount: 2000, medium: 'CASH' } as any); // month 1 free again
    expect(after.emisPaid).toBe(1);
  });

  it('a DRAW payment counts as paid but posts no ledger row', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'A1', displayName: 'C', tokenAmount: 0 } as any);
    const after = await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 1, amount: 2000, medium: 'DRAW' } as any);
    expect(after.emisPaid).toBe(1);
    expect(await schemeMoneyIn()).toBe(0);
  });

  it('GOLD payment fine = moneyToMetal(amount, rate, /10g)', async () => {
    const s = await setup();
    const scheme = await schemes.createScheme(s.ctx, { kind: 'SAVING', type: 'GOLD', name: 'GoldGram', emiAmount: 6000, tenureMonths: 12, bonusType: 'NONE', bonusValue: 0, startDate: new Date() } as any);
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'G1', displayName: 'C', tokenAmount: 0 } as any);
    const after = await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 1, amount: 6000, rate: 60000, medium: 'CASH' } as any);
    expect(Number(after.payments.find((p) => p.emiNo === 1)!.fine)).toBeCloseTo(1, 3); // 6000 / (60000/10)
  });

  it('redeem before maturity → 409; early withdraw gives no bonus (credit = paid)', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'A1', displayName: 'C', tokenAmount: 0 } as any);
    await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 1, amount: 2000, medium: 'CASH' } as any);
    await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 2, amount: 2000, medium: 'CASH' } as any);
    await expect(schemes.redeem(s.ctx, e.id, { early: false } as any)).rejects.toMatchObject({ status: 409 });
    const w = await schemes.redeem(s.ctx, e.id, { early: true } as any);
    expect(w.status).toBe('WITHDRAWN');
    expect(await udharAmount(s.party.id)).toBeCloseTo(-4000, 2); // paid 4000, no bonus
  });

  it('matured CASH 11+1 bonus → redeem credits the party −24000; a second redeem → 409', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'A1', displayName: 'C', tokenAmount: 0 } as any);
    for (let m = 1; m <= 11; m++) await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: m, amount: 2000, medium: 'CASH' } as any);
    const r = await schemes.redeem(s.ctx, e.id, { early: false } as any);
    expect(r.status).toBe('CLOSED');
    expect(await udharAmount(s.party.id)).toBeCloseTo(-24000, 2); // 22000 paid + 2000 one-EMI bonus
    await expect(schemes.redeem(s.ctx, e.id, { early: false } as any)).rejects.toMatchObject({ status: 409 });
  });

  it('a payment racing a redeem is never saved-but-excluded (BUG-13)', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx, { tenureMonths: 1 });
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'A1', displayName: 'C', tokenAmount: 0 } as any);
    const results = await Promise.allSettled([
      schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 1, amount: 2000, medium: 'CASH' } as any),
      schemes.redeem(s.ctx, e.id, { early: true } as any),
    ]);
    // redeem always succeeds (early); the payment either commits first (included) or is blocked out (409) — never silently excluded
    const paymentOk = results[0].status === 'fulfilled';
    if (!paymentOk) expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    const paidSum = (await db.schemePayment.findMany({ where: { enrollmentId: e.id, isReversed: false } })).reduce((a, p) => a + Number(p.amount), 0);
    const closed = await db.schemeEnrollment.findUniqueOrThrow({ where: { id: e.id } });
    expect(Number(closed.redeemValue)).toBeCloseTo(paidSum, 2); // credit == what is actually on the books
  });

  it('group over its member limit → 409', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const g = await schemes.createGroup(s.ctx, { schemeId: scheme.id, name: 'G', memberLimit: 1 });
    await schemes.enroll(s.ctx, { schemeId: scheme.id, groupId: g.id, partyId: s.party.id, assignId: 'A1', displayName: 'C', tokenAmount: 0 } as any);
    await expect(schemes.enroll(s.ctx, { schemeId: scheme.id, groupId: g.id, partyId: s.party.id, assignId: 'A2', displayName: 'C2', tokenAmount: 0 } as any)).rejects.toMatchObject({ status: 409 });
  });

  it('duplicate assignId in a scheme → 409', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'DUP', displayName: 'C', tokenAmount: 0 } as any);
    await expect(schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'DUP', displayName: 'C', tokenAmount: 0 } as any)).rejects.toMatchObject({ status: 409 });
  });

  it('cross-tenant party / scheme → 404', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const other = await createBusiness({ name: 'B' });
    const bParty = await db.party.create({ data: { businessId: other.business.id, type: 'CUSTOMER', name: 'B', mobile: '9111111111', countryCode: '+91' } });
    await expect(schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: bParty.id, assignId: 'X', displayName: 'C', tokenAmount: 0 } as any)).rejects.toMatchObject({ status: 404 });
    await expect(schemes.getScheme(ctxFor(other.business.id, other.root.id), scheme.id)).rejects.toMatchObject({ status: 404 });
  });
});
