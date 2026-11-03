/* eslint-disable @typescript-eslint/no-explicit-any -- service inputs are zod-parsed upstream; tests pass partial bodies */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import * as schemes from './service';
import type { TenantContext } from '../../../middleware/context';

/** G7 D-h: a GOLD scheme takes today's rate from the purest rated karat, converted to the scheme's /10 g; with no gold rate it takes no money and redeems nothing. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.karatMapping.createMany({ data: [
    { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 },
    { businessId: business.id, metal: 'GOLD', code: '24K', title: '24K', touch: 99.9 },
  ] });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['billing', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
  };
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const scheme = await schemes.createScheme(ctx, { kind: 'SAVING', type: 'GOLD', name: 'GoldGram', emiAmount: 6000, tenureMonths: 12, bonusType: 'NONE', bonusValue: 0, startDate: new Date() } as any);
  /** one rate save: these karats, in this order, at one instant */
  const rates = (rateUnit: string, rows: [string, number][]) => {
    const effectiveAt = new Date();
    return db.metalRate.createMany({ data: rows.map(([karatCode, sellRate]) => ({ businessId: business.id, metal: 'GOLD' as const, branchId: root.id, rateUnit: rateUnit as any, karatCode, sellRate, buyRate: sellRate - 100, effectiveAt })) });
  };
  const enroll = (over: Record<string, unknown> = {}) => schemes.enroll(ctx, { schemeId: scheme.id, partyId: party.id, assignId: 'G1', displayName: 'C', tokenAmount: 0, ...over } as any);
  const pay = (enrollmentId: number, over: Record<string, unknown> = {}) => schemes.addPayment(ctx, { enrollmentId, emiNo: 1, amount: 6000, medium: 'CASH', ...over } as any);
  return { ctx, scheme, rates, enroll, pay };
}
const fineOf = (e: { payments: { emiNo: number | null; fine: string | null }[] }) => Number(e.payments.find((p) => p.emiNo === 1)!.fine);

describe('GOLD scheme rate', () => {
  it('unit: a shop that rates gold per gram — ₹6,000 at ₹6,000 / g credits 1 g (not 10 g)', async () => {
    const s = await setup();
    await s.rates('GRAM_1', [['24K', 6000]]);
    expect(fineOf(await s.pay((await s.enroll()).id))).toBeCloseTo(1, 3);
  });

  it('karat: the highest-touch karat is the rate, whatever order the rows come in', async () => {
    const s = await setup();
    await s.rates('GRAM_10', [['22K', 55000], ['24K', 60000]]);
    expect(fineOf(await s.pay((await s.enroll()).id))).toBeCloseTo(1, 3); // 6000 / (60000 / 10 g)
  });

  it('karat: a karat saved at rate 0 (not dealt in) is skipped, not taken as "no rate"', async () => {
    const s = await setup();
    await s.rates('GRAM_10', [['22K', 60000], ['24K', 0]]);
    expect(fineOf(await s.pay((await s.enroll()).id))).toBeCloseTo(1, 3); // the 22K rate, not a 409
  });

  it('no gold rate set: a payment, a joining token or a first payment → 409 and nothing is written', async () => {
    const s = await setup();
    await expect(s.enroll({ tokenAmount: 500 })).rejects.toMatchObject({ status: 409 });
    await expect(s.enroll({ firstPayment: { amount: 6000, medium: 'CASH' } })).rejects.toMatchObject({ status: 409 });
    const e = await s.enroll();
    await expect(s.pay(e.id)).rejects.toMatchObject({ status: 409 });
    expect(await db.schemePayment.count()).toBe(0);
  });

  it('no gold rate set: redeem → 409 and the enrollment stays open (not closed at ₹0)', async () => {
    const s = await setup();
    const e = await s.enroll();
    await s.pay(e.id, { rate: 60000 }); // an explicit rate still works
    await expect(schemes.redeem(s.ctx, e.id, { early: true } as any)).rejects.toMatchObject({ status: 409 });
    expect((await db.schemeEnrollment.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('ACTIVE');
  });
});
