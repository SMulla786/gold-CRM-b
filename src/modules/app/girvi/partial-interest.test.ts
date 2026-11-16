import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { girviBody, girviReleaseBody } from '../../../shared';
import { businessDate } from '../../../lib/ledger';
import * as girvi from './service';
import type { TenantContext } from '../../../middleware/context';

/** G7 D-b: a partial interest payment must count — the due is what accrued since interestFrom minus the INTEREST paid since. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['girvi'], limits: null, permissions: {}, impersonatorId: null,
});
const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };
const iso = (d: Date) => businessDate(d).toISOString().slice(0, 10);

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/** ₹50,000 at 2 % / month, day-wise SI, issued 30 days ago → about ₹1,000 due today. */
async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx = ctxFor(business.id, root.id);
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const g = await girvi.createGirvi(ctx, girviBody.parse({
    partyId: party.id, issueDate: daysAgo(30), items: [{ category: 'Gold', name: 'Chain', gross: 12, net: 10, purity: 91.67, rate: 6000 }],
    principal: 50000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', tenureMonths: 3, cash: 50000, online: 0,
  }));
  const due = Number(g.interestDue);
  const half = Math.round(due * 50) / 100; // ≈ due / 2, to the paisa
  return { ctx, g, due, half, rest: Number((due - half).toFixed(2)) };
}
/** Resolves once another connection of this DB is waiting on a row lock. */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('no connection ever blocked on the loan row');
}
const pay = (s: Awaited<ReturnType<typeof setup>>, interest: number) => girvi.payInterest(s.ctx, s.g.id, { interest, discount: 0, cash: interest, online: 0 });
const view = (s: Awaited<ReturnType<typeof setup>>) => girvi.getGirvi(s.ctx, s.g.id, new Date());

describe('girvi partial interest', () => {
  it('a partial payment lowers the due; paying the rest settles it and moves interestFrom; over the remainder → 400', async () => {
    const s = await setup();
    expect(s.due).toBeGreaterThan(0);
    await pay(s, s.half);
    expect([Number((await view(s)).interestDue), (await view(s)).interestFrom]).toEqual([s.rest, iso(daysAgo(30))]);
    await expect(pay(s, s.rest + 1)).rejects.toMatchObject({ status: 400 });
    await pay(s, s.rest);
    expect([Number((await view(s)).interestDue), (await view(s)).interestFrom]).toEqual([0, iso(new Date())]);
  });

  it('release takes the remainder after a partial payment (partial + payment + discount = due)', async () => {
    const s = await setup();
    await pay(s, s.half);
    const items = (await view(s)).items.map((i) => i.id);
    const body = (interestPaid: number) => girviReleaseBody.parse({ itemIds: items, principalPaid: 50000, interestPaid, discount: 0, cash: 50000 + interestPaid, online: 0 });
    await expect(girvi.releaseGirvi(s.ctx, s.g.id, body(s.due))).rejects.toMatchObject({ status: 400 }); // the paid half would be charged twice
    expect((await girvi.releaseGirvi(s.ctx, s.g.id, body(s.rest))).status).toBe('CLOSED');
  });

  it('top-up: a partial payment alone is not "paid up to date" (409); with the remainder paid it goes through', async () => {
    const s = await setup();
    await pay(s, s.half);
    const topup = () => girvi.topupGirvi(s.ctx, s.g.id, { principal: 1000, cash: 1000, online: 0 });
    await expect(topup()).rejects.toMatchObject({ status: 409 });
    await pay(s, s.rest);
    expect(Number((await topup()).principal)).toBe(51000);
  });

  it('two interest payments at once cannot both take the same due (the loan row is locked)', async () => {
    const s = await setup();
    let paidIn!: () => void;
    const first = new Promise<void>((r) => (paidIn = r));
    // a full payment mid-flight, holding the loan row the way payInterest does
    const hold = db.$transaction(async (t) => {
      await t.$queryRaw`SELECT id FROM "GirviBatch" WHERE id = ${s.g.id} FOR NO KEY UPDATE`;
      await t.girviTxn.create({ data: { batchId: s.g.id, type: 'INTEREST', txnDate: businessDate(), interest: s.due, cash: s.due } });
      await t.girviBatch.update({ where: { id: s.g.id }, data: { interestFrom: businessDate() } });
      paidIn();
      await lockWaiter(); // the second payment is waiting for the row
    });
    await first;
    const second = pay(s, s.due).catch((e: unknown) => e);
    await hold;
    expect(await second).toMatchObject({ status: 400 }); // it saw the settled loan: nothing left to pay
    const paid = await db.girviTxn.aggregate({ where: { batchId: s.g.id, type: 'INTEREST' }, _sum: { interest: true } });
    expect(Number(paid._sum.interest)).toBe(s.due);
  });
});
