import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { girviBody, girviItemReplaceBody, girviReleaseBody } from '../../../shared';
import { businessDate } from '../../../lib/ledger';
import * as girvi from './service';
import type { TenantContext } from '../../../middleware/context';

/** G7 D-b2: (a) every girvi write locks the loan row before its items (release does; item replace did it the other way round → deadlock);
 *  (b) no interest / release / top-up dated before the loan's settled point — the due of an earlier date ignores the later payments, so they'd be collected twice. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['girvi'], limits: null, permissions: {}, impersonatorId: null,
});
const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };
const BEFORE = { status: 400, message: expect.stringMatching(/before/) };

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/** ₹50,000 at 2 % / month, day-wise SI, two items, issued 60 days ago. */
async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx = ctxFor(business.id, root.id);
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const item = (name: string) => ({ category: 'Gold', name, gross: 12, net: 10, purity: 91.67, rate: 6000 });
  const g = await girvi.createGirvi(ctx, girviBody.parse({
    partyId: party.id, issueDate: daysAgo(60), items: [item('Chain'), item('Ring')],
    principal: 50000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', tenureMonths: 6, cash: 50000, online: 0,
  }));
  const pay = (interest: number, txnDate?: Date) => girvi.payInterest(ctx, g.id, { txnDate, interest, discount: 0, cash: interest, online: 0 });
  const dueOn = async (d: Date) => Number((await girvi.getGirvi(ctx, g.id, d)).interestDue);
  return { ctx, g, pay, dueOn };
}
/** Resolves once another connection of this DB is waiting on a row lock. */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('no connection ever blocked');
}

describe('girvi lock order', () => {
  it('item replace while a release holds the loan row: both finish (no deadlock)', async () => {
    const s = await setup();
    const [chain] = s.g.items;
    let held!: () => void;
    const loanLocked = new Promise<void>((r) => (held = r));
    // a release mid-flight, in releaseGirvi's order: the loan row, then (once the replace is waiting) the items
    const release = db.$transaction(async (t) => {
      await t.$queryRaw`SELECT id FROM "GirviBatch" WHERE id = ${s.g.id} FOR NO KEY UPDATE`;
      held();
      await lockWaiter();
      await t.$queryRaw`SELECT id FROM "GirviItem" WHERE id = ${chain!.id} FOR UPDATE`;
    });
    await loanLocked;
    const replace = girvi.replaceGirviItem(s.ctx, s.g.id, chain!.id, girviItemReplaceBody.parse({ category: 'Gold', name: 'Chain (new clasp)', gross: 12, net: 10, purity: 91.67, rate: 6000, remark: 'clasp replaced' }));
    const done = await Promise.allSettled([release, replace]);
    expect(done.map((r) => (r.status === 'rejected' ? String((r.reason as Error).message).slice(0, 120) : 'ok'))).toEqual(['ok', 'ok']);
  });
});

describe('girvi backdating', () => {
  it('interest dated before the last interest payment → 400 (the earlier due ignores that payment)', async () => {
    const s = await setup();
    await s.pay(100, daysAgo(10));
    const dueThen = await s.dueOn(daysAgo(30));
    expect(dueThen).toBeGreaterThan(0);
    await expect(s.pay(dueThen, daysAgo(30))).rejects.toMatchObject(BEFORE);
    const paid = await db.girviTxn.aggregate({ where: { batchId: s.g.id, type: 'INTEREST' }, _sum: { interest: true } });
    expect(Number(paid._sum.interest)).toBe(100);
  });

  it('release dated before the last interest payment → 400', async () => {
    const s = await setup();
    await s.pay(100, daysAgo(10));
    const dueThen = await s.dueOn(daysAgo(30));
    const body = girviReleaseBody.parse({ txnDate: daysAgo(30), itemIds: [s.g.items[0]!.id], principalPaid: 0, interestPaid: dueThen, discount: 0, cash: dueThen, online: 0 });
    await expect(girvi.releaseGirvi(s.ctx, s.g.id, body)).rejects.toMatchObject(BEFORE);
    expect((await girvi.getGirvi(s.ctx, s.g.id, new Date())).items.map((i) => i.status)).toEqual(['PLEDGED', 'PLEDGED']);
  });

  it('top-up dated before the date interest is settled to → 400 (it would move interestFrom back and charge those days again)', async () => {
    const s = await setup();
    await s.pay(await s.dueOn(new Date())); // settled to today
    await expect(girvi.topupGirvi(s.ctx, s.g.id, { txnDate: daysAgo(1), principal: 1000, cash: 1000, online: 0 })).rejects.toMatchObject(BEFORE);
    expect((await girvi.getGirvi(s.ctx, s.g.id, new Date())).interestFrom).toBe(businessDate().toISOString().slice(0, 10));
  });
});
