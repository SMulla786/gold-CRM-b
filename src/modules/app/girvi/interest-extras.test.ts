import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { girviBody, girviDue, girviListQuery } from '../../../shared';
import { businessDate } from '../../../lib/ledger';
import * as girvi from './service';
import type { TenantContext } from '../../../middleware/context';

// GIR-02: first-month interest, penalty after the return date and per-item rates reach the stored loan and its interest
// breakdown, computed by the shared girviDue (the calc itself is covered in shared/calc/calc.test.ts).
const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['girvi'], limits: null, permissions: {}, impersonatorId: null,
});
const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };
const iso = (d: Date) => businessDate(d).toISOString().slice(0, 10);

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  return { party, ctx: ctxFor(business.id, root.id) };
}
const loan = (partyId: number, over: Record<string, unknown>) => girviBody.parse({
  partyId, issueDate: daysAgo(200), principal: 50000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', tenureMonths: 3, cash: 50000, online: 0,
  items: [{ category: 'Gold', name: 'Chain', gross: 12, net: 10, purity: 91.67, rate: 6000 }],
  ...over,
});
// expected = shared girviDue over what the API returns, so the service can't drift from the calc
const expectedDue = (g: Awaited<ReturnType<typeof girvi.getGirvi>>) => girviDue({
  principal: g.principal, ratePercent: g.ratePercent, ratePeriod: g.ratePeriod, interestType: g.interestType, ciPeriod: g.ciPeriod ?? undefined, method: g.method,
  items: g.items.filter((i) => i.status === 'PLEDGED').map((i) => ({ valuation: i.valuation, ratePercent: i.ratePercent })),
  issueDate: g.issueDate, interestFrom: g.interestFrom, returnDate: g.returnDate, to: iso(new Date()),
  firstMonthInterest: g.firstMonthInterest ?? 0, penaltyRatePercent: g.penaltyRatePercent ?? 0,
});

describe('girvi interest extras (GIR-02)', () => {
  it('first-month interest + penalty past the return date: stored, broken down, and summed into interestDue', async () => {
    const s = await setup();
    const created = await girvi.createGirvi(s.ctx, loan(s.party.id, { firstMonthInterest: 1500, penaltyRatePercent: 1 }));
    const g = await girvi.getGirvi(s.ctx, created.id, new Date());
    expect(Number(g.firstMonthInterest)).toBe(1500);
    expect(Number(g.penaltyRatePercent)).toBe(1);
    const due = expectedDue(g);
    expect(g.interestBreakdown).toMatchObject({ regular: due.regular, firstMonth: '1500.00', penalty: due.penalty, effectiveRate: '2' });
    expect(Number(due.penalty)).toBeGreaterThan(0); // 200 days in, 3-month tenure → past the return date
    expect(g.interestDue).toBe(due.interest);
  });

  it('per-item rate: effective rate is the valuation-weighted mix; items without one use the loan rate', async () => {
    const s = await setup();
    const items = [
      { category: 'Gold', name: 'Chain', gross: 12, net: 10, purity: 100, rate: 6000, ratePercent: 3 }, // valuation 60000 @ 3%
      { category: 'Gold', name: 'Ring', gross: 12, net: 10, purity: 100, rate: 6000 }, // valuation 60000 @ loan 2%
    ];
    const created = await girvi.createGirvi(s.ctx, loan(s.party.id, { items, issueDate: daysAgo(30), tenureMonths: 12 }));
    const g = await girvi.getGirvi(s.ctx, created.id, new Date());
    expect(g.items.map((i) => i.ratePercent)).toEqual(expect.arrayContaining(['3', null]));
    expect(g.interestBreakdown?.effectiveRate).toBe('2.5');
    expect(g.interestBreakdown).toMatchObject({ firstMonth: '0.00', penalty: '0.00' });
    expect(g.interestDue).toBe(expectedDue(g).interest);
  });

  it('list shows the same interest as the detail view', async () => {
    const s = await setup();
    const created = await girvi.createGirvi(s.ctx, loan(s.party.id, { firstMonthInterest: 1500, penaltyRatePercent: 1 }));
    const g = await girvi.getGirvi(s.ctx, created.id, new Date());
    const list = await girvi.listGirvi(s.ctx, girviListQuery.parse({}));
    expect(list.items.find((r) => r.id === created.id)?.interestDue).toBe(g.interestDue);
  });
});
