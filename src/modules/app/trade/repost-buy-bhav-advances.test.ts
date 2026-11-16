import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { bhavBookingBody } from '../../../shared';
import * as bhav from './bhav';
import * as udharSvc from '../udhar';
import { findCandidates, repostBuyBhavAdvances } from '../../../../scripts/repost-buy-bhav-advances';
import type { TenantContext } from '../../../middleware/context';

// TRD-04 data fix (scripts/repost-buy-bhav-advances.ts): BUY advances posted under the old rule (MONEY IN + party credit)
// are re-posted as GIVEN through bhav.postAdvance. Old-style rows are seeded by flipping what createBhav posts today.
const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['buy_sell'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  const ctx = ctxFor(business.id, root.id);
  const book = (side: 'BUY' | 'SELL', o: Record<string, unknown> = {}) =>
    bhav.createBhav(ctx, bhavBookingBody.parse({ partyId: party.id, metal: 'GOLD', side, weight: 10, rate: 60000, cash: 5000, txnDate: '2026-10-01', ...o }));
  return { business, root, party, bank, ctx, book };
}
/** Rewrite a booking's advance rows the way the pre-TRD-04 code posted them: MONEY IN + party credit. */
async function toOldStyle(bookingId: number) {
  await db.ledgerEntry.updateMany({ where: { source: 'BHAV_BOOKING', sourceId: String(bookingId) }, data: { direction: 'IN' } });
  await db.$executeRaw`UPDATE "UdharEntry" SET amount = -amount WHERE source::text = 'BHAV_BOOKING' AND "sourceId" = ${String(bookingId)}`;
}
/** Net shop money of a business from bhav advances (+ = IN), and every BHAV_BOOKING row (to prove "nothing changed"). */
const netMoney = async (businessId: number) =>
  (await db.ledgerEntry.findMany({ where: { businessId, source: 'BHAV_BOOKING', asset: 'MONEY' } })).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0);
const allRows = async () => [
  await db.ledgerEntry.findMany({ where: { source: 'BHAV_BOOKING' }, orderBy: { id: 'asc' } }),
  await db.udharEntry.findMany({ where: { source: 'BHAV_BOOKING' }, orderBy: { id: 'asc' } }),
];
const bal = async (s: Awaited<ReturnType<typeof setup>>) => (await udharSvc.partyBalance(s.ctx, s.party.id)).amount;

describe('repost-buy-bhav-advances', () => {
  it('dry run lists old-style BUY bookings only (ids, no., advance) and changes nothing', async () => {
    const s = await setup();
    const buy = await s.book('BUY');
    await toOldStyle(buy.id);
    await s.book('SELL', { cash: 1000 }); // a SELL advance is IN by rule: never listed
    await s.book('BUY', { cash: 700 }); // a BUY already posted the TRD-04 way: never listed
    await s.book('BUY', { entryType: 'ONLY_ENTRY' }); // record-only: posts nothing
    const before = await allRows();

    const r = await repostBuyBhavAdvances({ apply: false });
    expect(r).toEqual({ candidates: [{ businessId: s.business.id, bookingId: buy.id, bookingNo: buy.bookingNo, advance: '5000.00' }], applied: [], skipped: [], failed: [] });
    expect(await allRows()).toEqual(before);
  });

  it('apply: party +advance and MONEY OUT net, split payments re-posted per row (bank kept); a second apply changes nothing', async () => {
    const s = await setup();
    const a = await s.book('BUY');
    const b = await s.book('BUY', { cash: 0, payments: [{ mode: 'CASH', amount: 2000 }, { mode: 'ONLINE', amount: 3000, bankAccountId: s.bank.id }] });
    await toOldStyle(a.id);
    await toOldStyle(b.id);
    expect([await bal(s), await netMoney(s.business.id)]).toEqual(['-10000.00', 10000]); // the double-counting being fixed

    const r = await repostBuyBhavAdvances({ apply: true, userId: 1 });
    expect([r.applied, r.skipped, r.failed]).toEqual([[a.id, b.id], [], []]);
    expect([await bal(s), await netMoney(s.business.id)]).toEqual(['10000.00', -10000]); // the party holds both advances
    const active = await db.ledgerEntry.findMany({ where: { source: 'BHAV_BOOKING', sourceId: String(b.id), reversalOfId: null, createdById: 1, narration: { startsWith: 'Bhav' } }, orderBy: { id: 'asc' } });
    expect(active.slice(-2).map((x) => [x.direction, Number(x.amount), x.bankAccountId])).toEqual([['OUT', 2000, null], ['OUT', 3000, s.bank.id]]);
    expect(await findCandidates()).toEqual([]);

    const after = await allRows();
    expect(await repostBuyBhavAdvances({ apply: true, userId: 1 })).toEqual({ candidates: [], applied: [], skipped: [], failed: [] });
    expect(await allRows()).toEqual(after);
  });

  it('SELL bookings and another tenant are untouched; --business limits the run', async () => {
    const s = await setup('A');
    const o = await setup('B');
    const mine = await s.book('BUY');
    const sell = await s.book('SELL', { cash: 1000 });
    const theirs = await o.book('BUY');
    await toOldStyle(mine.id);
    await toOldStyle(theirs.id);
    const sellRows = await db.ledgerEntry.findMany({ where: { sourceId: String(sell.id), source: 'BHAV_BOOKING' } });
    const otherBefore = [await bal(o), await netMoney(o.business.id)];

    const r = await repostBuyBhavAdvances({ apply: true, userId: 1, businessId: s.business.id });
    expect(r.applied).toEqual([mine.id]);
    expect([await bal(o), await netMoney(o.business.id)]).toEqual(otherBefore);
    expect((await findCandidates()).map((c) => c.bookingId)).toEqual([theirs.id]); // B still waits for its own run
    expect(await db.ledgerEntry.findMany({ where: { sourceId: String(sell.id), source: 'BHAV_BOOKING' } })).toEqual(sellRows);
    expect(await bal(s)).toBe('4000.00'); // +5,000 BUY advance given − 1,000 SELL advance received
  });

  it("the booking's day is closed → that booking fails with DAY_CLOSED and is rolled back; the others still apply", async () => {
    const s = await setup();
    const closedDay = await s.book('BUY');
    const open = await s.book('BUY', { txnDate: '2026-10-02' });
    await toOldStyle(closedDay.id);
    await toOldStyle(open.id);
    await db.dayBook.create({ data: { businessId: s.business.id, branchId: s.root.id, date: new Date('2026-10-01'), status: 'CLOSED' } });
    const closedRows = await db.ledgerEntry.findMany({ where: { source: 'BHAV_BOOKING', sourceId: String(closedDay.id) } });

    const r = await repostBuyBhavAdvances({ apply: true, userId: 1 });
    expect([r.applied, r.failed]).toEqual([[open.id], [{ bookingId: closedDay.id, error: 'DAY_CLOSED' }]]);
    expect(await db.ledgerEntry.findMany({ where: { source: 'BHAV_BOOKING', sourceId: String(closedDay.id) } })).toEqual(closedRows);
  });

  it('apply without a user id is refused before touching anything', async () => {
    const s = await setup();
    const b = await s.book('BUY');
    await toOldStyle(b.id);
    const before = await allRows();
    await expect(repostBuyBhavAdvances({ apply: true })).rejects.toThrow(/--user/);
    expect(await allRows()).toEqual(before);
  });
});
