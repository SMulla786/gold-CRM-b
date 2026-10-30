import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { bhavBookingBody, buySellBody } from '../../../shared';
import * as buysell from './buysell';
import * as bhav from './bhav';
import type { TenantContext } from '../../../middleware/context';

// TRD-03: a buy-sell can deliver against several bookings (BuySellBhavDelivery rows); BuySell.bhavBookingId is only the
// first. Undeliver must refuse while ANY buy-sell holds the booking, in either form.

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['exchange', 'buy_sell'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  return { party, ctx: ctxFor(business.id, root.id) };
}
const book = (partyId: number) => bhavBookingBody.parse({ partyId, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000 });

describe('undeliverBhav with multi-booking deliveries (TRD-03)', () => {
  it('a booking delivered as the 2nd booking of a trade (delivery row only) cannot be undelivered; an unlinked delivered one can', async () => {
    const s = await setup();
    const first = await bhav.createBhav(s.ctx, book(s.party.id));
    const second = await bhav.createBhav(s.ctx, book(s.party.id));
    const loose = await bhav.createBhav(s.ctx, book(s.party.id));
    const trade = await buysell.createBuySell(s.ctx, buySellBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight: 10, rate: 60000 }], bhavBookingId: first.id, cash: 60000 }));
    // what TRD-03's multi-delivery records for the 2nd booking (built directly so this test doesn't depend on that code)
    await db.buySellBhavDelivery.create({ data: { buySellId: trade.id, bookingId: second.id, weight: 10 } });
    await db.bhavBooking.updateMany({ where: { id: { in: [second.id, loose.id] } }, data: { status: 'DELIVERED', pendingWeight: 0 } });

    for (const id of [first.id, second.id]) await expect(bhav.undeliverBhav(s.ctx, id)).rejects.toMatchObject({ status: 409 });
    expect((await bhav.getBhav(s.ctx, second.id)).status).toBe('DELIVERED'); // untouched

    const back = await bhav.undeliverBhav(s.ctx, loose.id);
    expect([back.status, back.pendingWeight]).toEqual(['PENDING', '10.000']);
  });
});
