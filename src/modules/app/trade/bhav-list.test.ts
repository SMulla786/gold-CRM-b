import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { bhavBookingBody, bhavListQuery } from '../../../shared';
import * as bhav from './bhav';
import type { TenantContext } from '../../../middleware/context';

// Phase 8: GET /bhav-booking (listBhav) filters had no test: q (party name / mobile / booking no), side, metal,
// status, open / closed, txn-date range, paging, tenant scope.
const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['exchange', 'buy_sell'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx = ctxFor(business.id, root.id);
  const party = (name: string, mobile: string) => db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name, mobile, countryCode: '+91' } });
  const [ramesh, suresh] = [await party('Ramesh', '9000000001'), await party('Suresh', '9000000002')];
  const book = (partyId: number, side: 'BUY' | 'SELL', metal: 'GOLD' | 'SILVER', txnDate: string) =>
    bhav.createBhav(ctx, bhavBookingBody.parse({ partyId, side, metal, weight: 10, rate: metal === 'GOLD' ? 60000 : 70000, txnDate }));
  await book(ramesh.id, 'BUY', 'GOLD', '2026-10-01'); // #1 PENDING
  const b2 = await book(ramesh.id, 'SELL', 'SILVER', '2026-10-15');
  await bhav.cancelBhav(ctx, b2.id); // CANCELLED
  const b3 = await book(suresh.id, 'BUY', 'SILVER', '2026-10-15');
  await db.bhavBooking.update({ where: { id: b3.id }, data: { status: 'DELIVERED', pendingWeight: 0 } });
  const b4 = await book(suresh.id, 'SELL', 'GOLD', '2026-10-28');
  await db.bhavBooking.update({ where: { id: b4.id }, data: { status: 'PARTIAL', pendingWeight: 4 } });

  // another business with a look-alike party: never listed here
  const x = await createBusiness({ name: 'X' });
  const xctx = ctxFor(x.business.id, x.root.id);
  const xp = await db.party.create({ data: { businessId: x.business.id, type: 'CUSTOMER', name: 'Ramesh', mobile: '9000000001', countryCode: '+91' } });
  await bhav.createBhav(xctx, bhavBookingBody.parse({ partyId: xp.id, side: 'BUY', metal: 'GOLD', weight: 1, rate: 60000 }));
  return { ctx, xctx };
}
const nos = async (ctx: TenantContext, q: Record<string, string | number> = {}) => (await bhav.listBhav(ctx, bhavListQuery.parse(q))).items.map((b) => b.bookingNo);

describe('listBhav filters', () => {
  it('side / metal / status / open / closed, newest first', async () => {
    const { ctx } = await setup();
    expect(await nos(ctx)).toEqual([4, 3, 2, 1]);
    expect(await nos(ctx, { side: 'BUY' })).toEqual([3, 1]);
    expect(await nos(ctx, { metal: 'SILVER' })).toEqual([3, 2]);
    expect(await nos(ctx, { status: 'CANCELLED' })).toEqual([2]);
    expect(await nos(ctx, { open: 'true' })).toEqual([4, 1]); // PENDING + PARTIAL
    expect(await nos(ctx, { closed: 'true' })).toEqual([3, 2]); // DELIVERED + CANCELLED
    expect(await nos(ctx, { side: 'SELL', open: 'true' })).toEqual([4]);
  });

  it('q matches party name (any case), mobile, or the booking number', async () => {
    const { ctx } = await setup();
    expect(await nos(ctx, { q: 'rAmEs' })).toEqual([2, 1]);
    expect(await nos(ctx, { q: '9000000002' })).toEqual([4, 3]); // full mobile; beyond Int4 so never read as a booking no
    expect(await nos(ctx, { q: '3' })).toEqual([3]);
    expect(await nos(ctx, { q: 'nobody' })).toEqual([]);
  });

  it('txn-date range is inclusive; paging keeps the total', async () => {
    const { ctx } = await setup();
    expect(await nos(ctx, { from: '2026-10-15', to: '2026-10-15' })).toEqual([3, 2]);
    expect(await nos(ctx, { from: '2026-10-16' })).toEqual([4]);
    const p2 = await bhav.listBhav(ctx, bhavListQuery.parse({ page: 2, pageSize: 2 }));
    expect([p2.items.map((b) => b.bookingNo), p2.total]).toEqual([[2, 1], 4]);
  });

  it('tenant scope: each business sees only its own bookings, also by party search', async () => {
    const { ctx, xctx } = await setup();
    expect((await bhav.listBhav(ctx, bhavListQuery.parse({}))).total).toBe(4);
    expect(await nos(xctx, { q: 'Ramesh' })).toEqual([1]);
  });
});
