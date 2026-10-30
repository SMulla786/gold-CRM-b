/* eslint-disable @typescript-eslint/no-explicit-any -- service inputs are zod-parsed upstream; tests pass partial bodies */
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

  it('a reversal racing a redeem never leaves a reversed payment counted in the credit (TASK-77)', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx, { tenureMonths: 1 });
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'A1', displayName: 'C', tokenAmount: 0 } as any);
    const p1 = await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 1, amount: 2000, medium: 'CASH' } as any);
    const payId = p1.payments.find((p) => p.emiNo === 1)!.id;
    const results = await Promise.allSettled([
      schemes.reversePayment(s.ctx, payId),
      schemes.redeem(s.ctx, e.id, { early: true } as any),
    ]);
    // redeem succeeds (early); the reversal either wins first (payment excluded) or is blocked after the close (409)
    if (results[0].status === 'rejected') expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    const paidSum = (await db.schemePayment.findMany({ where: { enrollmentId: e.id, isReversed: false } })).reduce((a, p) => a + Number(p.amount), 0);
    const closed = await db.schemeEnrollment.findUniqueOrThrow({ where: { id: e.id } });
    expect(Number(closed.redeemValue)).toBeCloseTo(paidSum, 2); // credit never counts a reversed payment
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

  it('member list q matches assign id, display name, party name and party mobile (case-insensitive)', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const other = await db.party.create({ data: { businessId: s.business.id, type: 'CUSTOMER', name: 'Zubair Khan', mobile: '9876543210', countryCode: '+91' } });
    await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'AX1', displayName: 'Alpha', tokenAmount: 0 } as any);
    await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: other.id, assignId: 'BY2', displayName: 'Beta', tokenAmount: 0 } as any);
    const list = (q: string) => schemes.listEnrollments(s.ctx, { page: 1, pageSize: 20, q });
    expect((await list('ax')).items.map((e) => e.assignId)).toEqual(['AX1']);
    expect((await list('beta')).items.map((e) => e.assignId)).toEqual(['BY2']);
    expect((await list('zubair')).items.map((e) => e.assignId)).toEqual(['BY2']);
    expect((await list('98765')).items.map((e) => e.assignId)).toEqual(['BY2']);
    expect((await list('nomatch')).total).toBe(0);
  });

  it("'due today' filters before paging, so total and pages count only due members", async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const enrol = (assignId: string) => schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId, displayName: 'C', tokenAmount: 0, startDate: new Date() } as any);
    const a = await enrol('D1');
    await enrol('D2');
    await enrol('D3');
    await schemes.addPayment(s.ctx, { enrollmentId: a.id, emiNo: 1, amount: 2000, medium: 'CASH' } as any); // D1 now has nothing due today
    const p1 = await schemes.listEnrollments(s.ctx, { page: 1, pageSize: 1, due: 'true' });
    const p2 = await schemes.listEnrollments(s.ctx, { page: 2, pageSize: 1, due: 'true' });
    expect(p1.total).toBe(2);
    expect([...p1.items, ...p2.items].map((e) => e.assignId).sort()).toEqual(['D2', 'D3']);
  });

  it('an Anjuman with no EMI (tenure 0) takes ad-hoc deposits with no installment slot; SAVING still needs tenure ≥ 1', async () => {
    const { schemeBody } = await import('../../../shared');
    expect(schemeBody.safeParse({ kind: 'SAVING', type: 'CASH', name: 'S1', emiAmount: 100, startDate: '2026-01-01' }).success).toBe(false);
    expect(schemeBody.safeParse({ kind: 'ANJUMAN', type: 'CASH', name: 'A1', emiAmount: 0, startDate: '2026-01-01' }).success).toBe(true);
    const s = await setup();
    const scheme = await cashScheme(s.ctx, { kind: 'ANJUMAN', emiAmount: 0, tenureMonths: 0, bonusType: 'NONE' });
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'N1', displayName: 'C', tokenAmount: 0 } as any);
    const after = await schemes.addPayment(s.ctx, { enrollmentId: e.id, amount: 750, medium: 'CASH' } as any);
    expect(after.payments[0]!.emiNo).toBeNull();
    expect(after.emisDue).toBe(0);
    expect(after.maturity.paid).toBe('750.00');
  });

  it('token medium: default TOKEN unchanged; CASH token posts money-in with no EMI slot; ONLINE needs a bank', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const t1 = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'T1', displayName: 'C', tokenAmount: 300 } as any);
    expect(t1.payments.map((p) => [p.medium, p.emiNo])).toEqual([['TOKEN', null]]);
    const t2 = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'T2', displayName: 'C', tokenAmount: 300, tokenMedium: 'CASH' } as any);
    expect(t2.payments.map((p) => [p.medium, p.emiNo])).toEqual([['CASH', null]]);
    expect(t2.emisPaid).toBe(0);
    expect(await schemeMoneyIn()).toBe(2);
    await expect(schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'T3', displayName: 'C', tokenAmount: 300, tokenMedium: 'ONLINE' } as any)).rejects.toMatchObject({ status: 400 });
    const t4 = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'T4', displayName: 'C', tokenAmount: 300, tokenMedium: 'ONLINE', tokenBankAccountId: s.bank.id } as any);
    expect(t4.payments[0]!.bankAccount?.id).toBe(s.bank.id);
  });

  it('enrollment list: comma status list and enrol-date range', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const a = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'S1', displayName: 'C', tokenAmount: 0, startDate: new Date('2026-01-10') } as any);
    await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'S2', displayName: 'C', tokenAmount: 0, startDate: new Date('2026-03-10') } as any);
    await schemes.markWon(s.ctx, a.id);
    const { enrollmentListQuery } = await import('../../../shared');
    const list = (raw: Record<string, string>) => schemes.listEnrollments(s.ctx, enrollmentListQuery.parse(raw));
    expect((await list({ status: 'WON,WITHDRAWN' })).items.map((e) => e.assignId)).toEqual(['S1']);
    expect((await list({ status: 'ACTIVE' })).items.map((e) => e.assignId)).toEqual(['S2']);
    expect((await list({ from: '2026-03-01', to: '2026-03-31' })).items.map((e) => e.assignId)).toEqual(['S2']);
  });

  it('transactions medium filter: single value or comma list (CASH,TOKEN)', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'M1', displayName: 'C', tokenAmount: 500 } as any);
    await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 1, amount: 2000, medium: 'CASH' } as any);
    await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 2, amount: 2000, medium: 'DRAW' } as any);
    const { schemeTxnListQuery } = await import('../../../shared');
    const media = async (raw: Record<string, string>) => (await schemes.transactions(s.ctx, schemeTxnListQuery.parse(raw))).items.map((t) => t.medium).sort();
    expect(await media({ medium: 'CASH' })).toEqual(['CASH']);
    expect(await media({ medium: 'CASH,TOKEN' })).toEqual(['CASH', 'TOKEN']);
    expect(await media({ medium: 'DRAW, VENDOR' })).toEqual(['DRAW']);
    expect(await media({})).toHaveLength(3);
    expect(() => schemeTxnListQuery.parse({ medium: 'CASH,BOGUS' })).toThrow();
  });

  it('dues: q filters server-side; perMonth gives one row per due EMI (count = emisDue)', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const start = new Date(); start.setUTCMonth(start.getUTCMonth() - 2); // EMIs 1..3 are due today
    await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'P1', displayName: 'Alpha', tokenAmount: 0, startDate: start } as any);
    const e2 = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'P2', displayName: 'Beta', tokenAmount: 0, startDate: start } as any);
    await schemes.addPayment(s.ctx, { enrollmentId: e2.id, emiNo: 2, amount: 2000, medium: 'CASH' } as any);
    const flat = (await schemes.dues(s.ctx, {})) as any[];
    const months = (await schemes.dues(s.ctx, { perMonth: 'true' })) as any[];
    expect(months.length).toBe(flat.reduce((a, d) => a + d.emisDue, 0));
    expect(months.filter((m) => m.assignId === 'P2').map((m) => m.emiNo)).toEqual([1, 3]);
    expect(((await schemes.dues(s.ctx, { q: 'beta' })) as any[]).map((d) => d.assignId)).toEqual(['P2']);
  });

  it('day book days: per-day opening/in/out/closing chain to the range totals', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'D1', displayName: 'C', tokenAmount: 0 } as any);
    await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 1, amount: 2000, medium: 'CASH' } as any);
    const today = new Date();
    const from = new Date(today.getTime() - 2 * 86_400_000);
    const book = await schemes.dayBook(s.ctx, { from, to: today });
    expect(book.days).toHaveLength(3);
    expect(book.days![0]!.opening).toBe(book.opening);
    expect(book.days![2]!.closing).toBe(book.closing);
    expect(book.days![2]!.moneyIn).toBe('2000.00');
    expect(book.days![2]!.txnCount).toBe(1);
  });

  it('CHEQUE posts money IN to the chosen bank like ONLINE (bank required); reversal undoes it', async () => {
    const { addSchemePaymentBody } = await import('../../../shared');
    expect(addSchemePaymentBody.safeParse({ enrollmentId: 1, amount: 100, medium: 'CHEQUE' }).success).toBe(false);
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'C1', displayName: 'C', tokenAmount: 0 } as any);
    const paid = await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 1, amount: 2000, medium: 'CHEQUE', bankAccountId: s.bank.id } as any);
    expect(paid.emisPaid).toBe(1);
    const rows = await db.ledgerEntry.findMany({ where: { source: 'SCHEME', asset: 'MONEY' } });
    expect(rows.map((r) => [r.direction, r.bankAccountId])).toEqual([['IN', s.bank.id]]);
    await schemes.reversePayment(s.ctx, paid.payments[0]!.id);
    expect(await db.ledgerEntry.count({ where: { source: 'SCHEME', asset: 'MONEY' } })).toBeGreaterThan(1); // reversal row posted
  });

  it('scheme title: set on create, changed and cleared by patch', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx, { kind: 'ANJUMAN', title: 'Ramzan 2027' });
    expect(scheme.title).toBe('Ramzan 2027');
    expect((await schemes.patchScheme(s.ctx, scheme.id, { title: 'Eid' })).title).toBe('Eid');
    expect((await schemes.patchScheme(s.ctx, scheme.id, { title: null })).title).toBeNull();
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

describe('scheme collected (dashboard schemes overview)', () => {
  it('collected = Σ non-reversed money-in payments (CASH/ONLINE/TOKEN/CHEQUE); DRAW and reversed rows excluded', async () => {
    const s = await setup();
    const scheme = await cashScheme(s.ctx);
    const other = await cashScheme(s.ctx, { name: 'Other' });
    expect((await schemes.getScheme(s.ctx, scheme.id)).collected).toBe('0.00');
    const e = await schemes.enroll(s.ctx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'A1', displayName: 'C', tokenAmount: 500 } as any);
    await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 1, amount: 2000, medium: 'CASH' } as any);
    const rev = await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 2, amount: 2000, medium: 'CASH' } as any);
    await schemes.reversePayment(s.ctx, rev.payments.find((p) => p.emiNo === 2)!.id);
    await schemes.addPayment(s.ctx, { enrollmentId: e.id, emiNo: 3, amount: 2000, medium: 'DRAW' } as any);
    const e2 = await schemes.enroll(s.ctx, { schemeId: other.id, partyId: s.party.id, assignId: 'B1', displayName: 'C', tokenAmount: 0 } as any);
    await schemes.addPayment(s.ctx, { enrollmentId: e2.id, emiNo: 1, amount: 2000, medium: 'CASH' } as any);

    const list = await schemes.listSchemes(s.ctx, { page: 1, pageSize: 20 });
    expect(list.items.find((x) => x.id === scheme.id)!.collected).toBe('2500.00'); // token 500 + EMI 1
    expect(list.items.find((x) => x.id === other.id)!.collected).toBe('2000.00');
  });
});
