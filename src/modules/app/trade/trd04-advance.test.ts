import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { bhavBookingBody, bhavListQuery, buySellBody } from '../../../shared';
import * as buysell from './buysell';
import * as bhav from './bhav';
import * as udharSvc from '../udhar';
import type { TenantContext } from '../../../middleware/context';

/** TRD-04 — a BUY booking's advance is GIVEN, a SELL booking's RECEIVED, posted once; delivery settlements shown separately. */

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
  return { business, party, bank, ctx: ctxFor(business.id, root.id) };
}
type S = Awaited<ReturnType<typeof setup>>;
type Side = 'BUY' | 'SELL';
// gold rate unit = per 10 g → 10 g @ 60,000 = ₹60,000
const book = (s: S, side: Side, o: Record<string, unknown> = {}) => bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side, weight: 10, rate: 60000, cash: 5000, ...o }));
const trade = (s: S, side: Side, o: Record<string, unknown>) => buySellBody.parse({ partyId: s.party.id, metal: 'GOLD', side, lines: [{ weight: 10, rate: 60000 }], ...o });
const bal = async (s: S) => (await udharSvc.partyBalance(s.ctx, s.party.id)).amount;
/** Shop money of a business: + = net IN, over every source. */
const cash = async (s: S) => (await db.ledgerEntry.findMany({ where: { businessId: s.business.id, asset: 'MONEY' } })).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0);
const figs = async (s: S, id: number) => { const b = await bhav.getBhav(s.ctx, id); return [b.advance, b.settlement]; };

describe('TRD-04 · bhav advance direction + delivery settlements', () => {
  it('BUY: ₹5,000 advance GIVEN, ₹55,000 given on delivery → party settles at zero, shop paid ₹60,000 once', async () => {
    const s = await setup();
    const b = await book(s, 'BUY');
    expect((await db.ledgerEntry.findMany({ where: { source: 'BHAV_BOOKING' } })).map((r) => [r.asset, r.direction, Number(r.amount)])).toEqual([['MONEY', 'OUT', 5000]]);
    expect(await bal(s)).toBe('5000.00'); // the party holds the shop's advance

    await buysell.createBuySell(s.ctx, trade(s, 'BUY', { bhavBookingId: b.id, cash: 55000 }));
    expect(await bal(s)).toBe('0.00');
    expect(await cash(s)).toBe(-60000);
    expect(await figs(s, b.id)).toEqual(['5000.00', '55000.00']);
  });

  it('SELL: ₹5,000 advance RECEIVED, ₹55,000 received on delivery → zero', async () => {
    const s = await setup();
    await buysell.createBuySell(s.ctx, trade(s, 'BUY', { cash: 60000 })); // stock the bullion the SELL delivers (party square, cash −60,000)
    const b = await book(s, 'SELL');
    expect((await db.ledgerEntry.findMany({ where: { source: 'BHAV_BOOKING' } })).map((r) => [r.direction, Number(r.amount)])).toEqual([['IN', 5000]]);
    expect(await bal(s)).toBe('-5000.00');

    await buysell.createBuySell(s.ctx, trade(s, 'SELL', { bhavBookingId: b.id, cash: 55000 }));
    expect([await bal(s), await cash(s)]).toEqual(['0.00', 0]);
    expect(await figs(s, b.id)).toEqual(['5000.00', '55000.00']);
  });

  it('partial delivery: 5 g of 10 g with ₹20,000 given → party is owed ₹5,000; the rest delivered and settled → zero', async () => {
    const s = await setup();
    const b = await book(s, 'BUY');
    await buysell.createBuySell(s.ctx, trade(s, 'BUY', { lines: [{ weight: 5, rate: 60000 }], bhavBookingId: b.id, cash: 20000 }));
    expect(await bal(s)).toBe('-5000.00'); // +5,000 advance − (30,000 − 20,000)
    expect(await figs(s, b.id)).toEqual(['5000.00', '20000.00']);

    await buysell.createBuySell(s.ctx, trade(s, 'BUY', { lines: [{ weight: 5, rate: 60000 }], bhavBookingId: b.id, cash: 35000 }));
    expect([await bal(s), await cash(s)]).toEqual(['0.00', -60000]);
    expect(await figs(s, b.id)).toEqual(['5000.00', '55000.00']);
    expect((await bhav.getBhav(s.ctx, b.id)).status).toBe('DELIVERED');
  });

  it('edit: the booking advance is re-posted once in its direction; a delivery edit replaces its settlement', async () => {
    const s = await setup();
    const b = await book(s, 'BUY');
    await bhav.updateBhav(s.ctx, b.id, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000, cash: 8000 }));
    expect([await bal(s), await cash(s)]).toEqual(['8000.00', -8000]);

    const t = await buysell.createBuySell(s.ctx, trade(s, 'BUY', { bhavBookingId: b.id, cash: 50000 }));
    expect(await bal(s)).toBe('-2000.00');
    await buysell.updateBuySell(s.ctx, t.id, trade(s, 'BUY', { bhavBookingId: b.id, cash: 52000 }));
    expect([await bal(s), await cash(s)]).toEqual(['0.00', -60000]);
    expect(await figs(s, b.id)).toEqual(['8000.00', '52000.00']);

    // a SELL booking edited to BUY flips its advance from received to given
    const sb = await book(s, 'SELL', { cash: 1000 });
    expect(await bal(s)).toBe('-1000.00');
    await bhav.updateBhav(s.ctx, sb.id, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000, cash: 1000 }));
    expect([await bal(s), await cash(s)]).toEqual(['1000.00', -61000]);
  });

  it('reversal: deleting the delivery, then the booking, returns party and cash to zero', async () => {
    const s = await setup();
    const b = await book(s, 'BUY', { cash: 2000, online: 3000, bankAccountId: s.bank.id });
    expect((await db.ledgerEntry.findMany({ where: { source: 'BHAV_BOOKING' } })).map((r) => r.direction)).toEqual(['OUT', 'OUT']);
    const t = await buysell.createBuySell(s.ctx, trade(s, 'BUY', { bhavBookingId: b.id, cash: 55000 }));
    await buysell.deleteBuySell(s.ctx, t.id);
    expect([await bal(s), await figs(s, b.id)]).toEqual(['5000.00', ['5000.00', '0.00']]);
    await bhav.deleteBhav(s.ctx, b.id);
    expect([await bal(s), await cash(s)]).toEqual(['0.00', 0]);
  });

  it('a trade delivered from two bookings shares its payment by delivered value; the shares add up to the payment', async () => {
    const s = await setup();
    const a = await book(s, 'BUY', { weight: 3, rate: 60000, cash: 1000 });
    const b = await book(s, 'BUY', { weight: 7, rate: 61000, cash: 1000 });
    // values 3 × 60,000 : 7 × 61,000 = 180,000 : 427,000; paid 50,000.01
    await buysell.createBuySell(s.ctx, trade(s, 'BUY', { lines: [{ weight: 3, rate: 60000 }, { weight: 7, rate: 61000 }], deliveries: [{ bookingId: a.id, weight: 3 }, { bookingId: b.id, weight: 7 }], cash: 50000.01 }));
    expect([(await bhav.getBhav(s.ctx, a.id)).settlement, (await bhav.getBhav(s.ctx, b.id)).settlement]).toEqual(['14827.02', '35172.99']);
    const list = await bhav.listBhav(s.ctx, bhavListQuery.parse({}));
    expect(list.items.map((x) => [x.id, x.settlement])).toEqual([[b.id, '35172.99'], [a.id, '14827.02']]); // list = get
  });

  it("another business's trades never count toward a booking's settlement", async () => {
    const s = await setup('A');
    const o = await setup('B');
    const b = await book(s, 'BUY');
    const ob = await book(o, 'BUY');
    await buysell.createBuySell(o.ctx, trade(o, 'BUY', { bhavBookingId: ob.id, cash: 55000 }));
    expect(await figs(s, b.id)).toEqual(['5000.00', '0.00']);
    expect(await figs(o, ob.id)).toEqual(['5000.00', '55000.00']);
  });

  it('a BUY booking cancelled after a partial delivery keeps +advance − (delivered bill − payments); settlement = the delivered payments', async () => {
    const s = await setup();
    const b = await book(s, 'BUY');
    await buysell.createBuySell(s.ctx, trade(s, 'BUY', { lines: [{ weight: 5, rate: 60000 }], bhavBookingId: b.id, cash: 20000 }));
    await bhav.cancelBhav(s.ctx, b.id);
    const after = await bhav.getBhav(s.ctx, b.id);
    expect([after.status, after.pendingWeight]).toEqual(['CANCELLED', '5.000']);
    expect([await bal(s), await cash(s)]).toEqual(['-5000.00', -25000]); // +5,000 − (30,000 − 20,000); shop paid 5,000 + 20,000
    expect(await figs(s, b.id)).toEqual(['5000.00', '20000.00']);
  });

  it('a pre-TRD-03 trade (bhavBookingId only, no delivery rows) counts its whole payment toward that booking', async () => {
    const s = await setup();
    const b = await book(s, 'BUY');
    const t = await buysell.createBuySell(s.ctx, trade(s, 'BUY', { bhavBookingId: b.id, cash: 55000 }));
    await db.buySellBhavDelivery.deleteMany({ where: { buySellId: t.id } }); // the shape trades saved before TRD-03 have
    expect(await db.buySell.findUniqueOrThrow({ where: { id: t.id }, select: { bhavBookingId: true } })).toEqual({ bhavBookingId: b.id });
    expect(await figs(s, b.id)).toEqual(['5000.00', '55000.00']);
    expect((await bhav.listBhav(s.ctx, bhavListQuery.parse({}))).items.map((x) => x.settlement)).toEqual(['55000.00']); // list = get
  });
});
