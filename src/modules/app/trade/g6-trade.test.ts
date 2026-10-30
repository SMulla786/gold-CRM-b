import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../../test/helpers/factory';
import { bhavBookingBody, buySellBody, exchangeBody, moneyToMetal, udharBody } from '../../../shared';
import * as buysell from './buysell';
import * as bhav from './bhav';
import * as exchange from './exchange';
import * as udharSvc from '../udhar';
import type { TenantContext } from '../../../middleware/context';

/** G6 — TRD-02 inline udhar + bhav cut on buy-sell / exchange; TRD-03 buy-sell delivered against several bhav bookings. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['exchange', 'buy_sell', 'udhari'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  return { business, root, party, bank, ctx: ctxFor(business.id, root.id) };
}
type S = Awaited<ReturnType<typeof setup>>;
// gold rate unit = per 10 g → amount = weight × rate / 10
const bs = (s: S, o: Record<string, unknown>) => buySellBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight: 10, rate: 60000 }], cash: 60000, ...o });
const bal = (s: S) => udharSvc.partyBalance(s.ctx, s.party.id);
const book = (s: S, weight: number, rate: number, o: Record<string, unknown> = {}) => bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight, rate, ...o }));
const pending = async (s: S, id: number) => { const b = await bhav.getBhav(s.ctx, id); return [b.status, b.pendingWeight]; };
const sumNet = (rows: { amount: unknown; gold: unknown }[]) => rows.reduce((a, r) => [a[0]! + Number(r.amount), a[1]! + Number(r.gold)], [0, 0]);

describe('TRD-02 · inline udhar + bhav cut on buy-sell', () => {
  it('jama settles old dues partly, then fully on edit (same udhar no.); delete reverses everything to the old balance', async () => {
    const s = await setup();
    await udharSvc.createUdharTxn(s.ctx, udharBody.parse({ partyId: s.party.id, cashOut: 10000 })); // party owes ₹10,000
    const t = await buysell.createBuySell(s.ctx, bs(s, { udhar: { cashIn: 4000 } }));
    expect(t.udhar).toMatchObject({ cashIn: '4000.00', bhav: null, remark: `Buy-sell #${t.buySellNo}` });
    expect((await bal(s)).amount).toBe('6000.00'); // trade fully paid → only the jama moved the balance
    expect((await db.ledgerEntry.findMany({ where: { source: 'UDHAR', sourceId: String(t.udhar!.txnId), asset: 'MONEY' } })).map((r) => [r.direction, Number(r.amount)])).toEqual([['IN', 4000]]);

    const e = await buysell.updateBuySell(s.ctx, t.id, bs(s, { udhar: { cashIn: 10000 } }));
    expect([e.udhar!.txnId, e.udhar!.txnNo]).toEqual([t.udhar!.txnId, t.udhar!.txnNo]);
    expect((await bal(s)).amount).toBe('0.00'); // fully settled

    await buysell.deleteBuySell(s.ctx, t.id);
    expect((await bal(s)).amount).toBe('10000.00');
    expect((await db.udharTxn.findUniqueOrThrow({ where: { id: t.udhar!.txnId } })).isDeleted).toBe(true);
    const cashRows = await db.ledgerEntry.findMany({ where: { source: 'UDHAR', sourceId: String(t.udhar!.txnId) } });
    expect(cashRows.reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0)).toBe(0); // reversals equal the postings
  });

  it('bhav cut: metal dues converted at the rate (same calc as New Udhar); weight from moneyToMetal, never re-rounded', async () => {
    const s = await setup();
    await udharSvc.createUdharTxn(s.ctx, udharBody.parse({ partyId: s.party.id, goldOut: 2 })); // party owes 2 g gold
    const t = await buysell.createBuySell(s.ctx, bs(s, { udhar: { bhav: { direction: 'METAL_TO_MONEY', metal: 'GOLD', amount: 6001, rate: 60000, unitGrams: 10 } } }));
    const w = moneyToMetal(6001, 60000, 10);
    expect(t.udhar!.bhav).toEqual({ direction: 'METAL_TO_MONEY', metal: 'GOLD', amount: '6001.00', rate: '60000.00', unitGrams: 10, weight: w });
    expect(await bal(s)).toMatchObject({ amount: '6001.00', gold: (2 - Number(w)).toFixed(3) });
    const rows = await db.udharEntry.findMany({ where: { source: 'BHAV_CUT', sourceId: String(t.udhar!.txnId), reversalOfId: null } });
    expect(sumNet(rows)).toEqual([6001, -Number(w)]);
    // no shop asset moves on a bhav cut
    expect(await db.ledgerEntry.count({ where: { source: 'UDHAR', sourceId: String(t.udhar!.txnId) } })).toBe(0);
  });

  it('edit can add and drop the inline udhar; the udhar screens cannot edit or delete a linked entry', async () => {
    const s = await setup();
    const t = await buysell.createBuySell(s.ctx, bs(s, {}));
    expect(t.udhar).toBeNull();
    const withU = await buysell.updateBuySell(s.ctx, t.id, bs(s, { udhar: { goldIn: 1.5 } }));
    expect((await bal(s)).gold).toBe('-1.500');
    await expect(udharSvc.updateUdharTxn(s.ctx, withU.udhar!.txnId, udharBody.parse({ partyId: s.party.id, cashIn: 1 }))).rejects.toMatchObject({ status: 409 });
    await expect(udharSvc.deleteUdharTxn(s.ctx, withU.udhar!.txnId)).rejects.toMatchObject({ status: 409 });
    const without = await buysell.updateBuySell(s.ctx, t.id, bs(s, {}));
    expect([without.udhar, (await bal(s)).gold]).toEqual([null, '0.000']);
  });

  it('two concurrent edits: the trade row lock serialises them; the inline udhar is never posted twice', async () => {
    const s = await setup();
    const t = await buysell.createBuySell(s.ctx, bs(s, { udhar: { cashIn: 1000 } }));
    await Promise.all([buysell.updateBuySell(s.ctx, t.id, bs(s, { udhar: { cashIn: 2000 } })), buysell.updateBuySell(s.ctx, t.id, bs(s, { udhar: { cashIn: 3000 } }))]);
    const live = await db.udharEntry.findMany({ where: { source: 'UDHAR', sourceId: String(t.udhar!.txnId) } });
    const net = live.reduce((a, r) => a + Number(r.amount), 0);
    expect([-2000, -3000]).toContain(net); // exactly one edit's figure, not a sum
    expect((await bal(s)).amount).toBe(net.toFixed(2));
  });

  it('isolation + validation: another business\'s bank account → 404; an empty inline udhar is refused by the contract', async () => {
    const s = await setup();
    const b = await setup('B');
    await expect(buysell.createBuySell(s.ctx, bs(s, { udhar: { onlineIn: 100, inBankId: b.bank.id } }))).rejects.toMatchObject({ status: 404 });
    expect(await db.buySell.count()).toBe(0);
    expect(() => bs(s, { udhar: {} })).toThrow();
  });
});

describe('TRD-02 · inline udhar on exchange', () => {
  it('create / edit / delete carry the linked udhar entry with the exchange', async () => {
    const s = await setup();
    const body = (o: Record<string, unknown>) => exchangeBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight: 10, touch: 100 }], rate: 0, ...o });
    const e = await exchange.createExchange(s.ctx, body({ udhar: { cashOut: 500 } }));
    expect(e.udhar).toMatchObject({ cashOut: '500.00', remark: `Exchange #${e.exchangeNo}` });
    expect((await bal(s)).amount).toBe('500.00');
    const e2 = await exchange.updateExchange(s.ctx, e.id, body({ udhar: { cashOut: 700 } }));
    expect([e2.udhar!.txnNo, (await bal(s)).amount]).toEqual([e.udhar!.txnNo, '700.00']);
    await exchange.deleteExchange(s.ctx, e.id);
    expect((await bal(s)).amount).toBe('0.00');
  });
});

describe('TRD-03 · buy-sell delivered against several bhav bookings', () => {
  it('single booking, partial then full; DTO lists the delivery', async () => {
    const s = await setup();
    const a = await book(s, 10, 60000);
    const t = await buysell.createBuySell(s.ctx, bs(s, { lines: [{ weight: 4, rate: 60000 }], cash: 24000, deliveries: [{ bookingId: a.id, weight: 4 }] }));
    expect(await pending(s, a.id)).toEqual(['PARTIAL', '6.000']);
    expect(t.deliveries).toEqual([{ bookingId: a.id, bookingNo: a.bookingNo, rate: '60000.00', weight: '4.000' }]);
    expect(t.bhavBooking).toEqual({ id: a.id, bookingNo: a.bookingNo });
    await buysell.createBuySell(s.ctx, bs(s, { lines: [{ weight: 6, rate: 60000 }], cash: 36000, deliveries: [{ bookingId: a.id, weight: 6 }] }));
    expect(await pending(s, a.id)).toEqual(['DELIVERED', '0.000']);
  });

  it('two bookings at two rates in one trade; edit and delete give back exactly what was taken', async () => {
    const s = await setup();
    const a = await book(s, 10, 60000);
    const b = await book(s, 5, 61000);
    const lines = [{ weight: 10, rate: 60000 }, { weight: 3, rate: 61000 }];
    const t = await buysell.createBuySell(s.ctx, bs(s, { lines, cash: 78300, deliveries: [{ bookingId: b.id, weight: 3 }, { bookingId: a.id, weight: 10 }] }));
    expect([await pending(s, a.id), await pending(s, b.id)]).toEqual([['DELIVERED', '0.000'], ['PARTIAL', '2.000']]);
    expect(t.deliveries!.map((d) => [d.bookingId, d.weight])).toEqual([[a.id, '10.000'], [b.id, '3.000']]);

    await buysell.updateBuySell(s.ctx, t.id, bs(s, { lines: [{ weight: 5, rate: 61000 }], cash: 30500, deliveries: [{ bookingId: b.id, weight: 5 }] }));
    expect([await pending(s, a.id), await pending(s, b.id)]).toEqual([['PENDING', '10.000'], ['DELIVERED', '0.000']]);
    expect(await db.buySellBhavDelivery.count({ where: { buySellId: t.id } })).toBe(1);

    await buysell.deleteBuySell(s.ctx, t.id);
    expect([await pending(s, a.id), await pending(s, b.id)]).toEqual([['PENDING', '10.000'], ['PENDING', '5.000']]);
    expect(await db.buySellBhavDelivery.count()).toBe(0);
  });

  it('per-rate rule: weight from a booking must match the lines at its rate → 400; nothing is taken', async () => {
    const s = await setup();
    const a = await book(s, 10, 60000);
    const b = await book(s, 5, 61000);
    await expect(buysell.createBuySell(s.ctx, bs(s, { lines: [{ weight: 10, rate: 60000 }], deliveries: [{ bookingId: a.id, weight: 6 }, { bookingId: b.id, weight: 4 }] }))).rejects.toMatchObject({ status: 400 });
    await expect(buysell.createBuySell(s.ctx, bs(s, { lines: [{ weight: 10, rate: 60000 }], deliveries: [{ bookingId: a.id, weight: 9 }] }))).rejects.toMatchObject({ status: 400 }); // part undelivered
    expect([await pending(s, a.id), await pending(s, b.id)]).toEqual([['PENDING', '10.000'], ['PENDING', '5.000']]);
  });

  it('over-allocation → 409 and atomic: the other booking of the same trade is not taken either', async () => {
    const s = await setup();
    const a = await book(s, 10, 60000);
    const b = await book(s, 2, 60000);
    await expect(buysell.createBuySell(s.ctx, bs(s, { lines: [{ weight: 13, rate: 60000 }], cash: 78000, deliveries: [{ bookingId: a.id, weight: 10 }, { bookingId: b.id, weight: 3 }] }))).rejects.toMatchObject({ status: 409 });
    expect([await pending(s, a.id), await pending(s, b.id)]).toEqual([['PENDING', '10.000'], ['PENDING', '2.000']]);
    expect(await db.buySell.count()).toBe(0);
  });

  it('the same weight is never delivered twice: two racing trades on one booking → one wins, pending never negative', async () => {
    const s = await setup();
    const a = await book(s, 10, 60000);
    const runs = await Promise.allSettled([1, 2].map(() => buysell.createBuySell(s.ctx, bs(s, { deliveries: [{ bookingId: a.id, weight: 10 }] }))));
    expect(runs.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await pending(s, a.id)).toEqual(['DELIVERED', '0.000']);
    expect(() => bs(s, { deliveries: [{ bookingId: a.id, weight: 5 }, { bookingId: a.id, weight: 5 }] })).toThrow(); // listed twice
    expect(() => bs(s, { bhavBookingId: a.id, deliveries: [{ bookingId: a.id, weight: 10 }] })).toThrow(); // both forms
  });

  it('incompatible bookings: other party / metal / side → 400; another branch or business → 404', async () => {
    const s = await setup();
    const other = await db.party.create({ data: { businessId: s.business.id, type: 'CUSTOMER', name: 'Other', mobile: '9000000002', countryCode: '+91' } });
    const wrongParty = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: other.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000 }));
    const wrongMetal = await book(s, 10, 60000, { metal: 'SILVER' });
    const wrongSide = await book(s, 10, 60000, { side: 'SELL' });
    for (const x of [wrongParty, wrongMetal, wrongSide]) {
      await expect(buysell.createBuySell(s.ctx, bs(s, { deliveries: [{ bookingId: x.id, weight: 10 }] }))).rejects.toMatchObject({ status: 400 });
    }
    const branch2 = await createBranch({ businessId: s.business.id, parentId: s.root.id, name: 'B2', isAdminNode: false });
    const far = await bhav.createBhav(ctxFor(s.business.id, branch2.id), bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000 }));
    const t = await setup('T');
    const foreign = await book(t, 10, 60000);
    for (const x of [far, foreign]) {
      await expect(buysell.createBuySell(s.ctx, bs(s, { deliveries: [{ bookingId: x.id, weight: 10 }] }))).rejects.toMatchObject({ status: 404 });
    }
  });

  it('a booking delivered as the 2nd of a trade cannot be marked undelivered; legacy bhavBookingId still works', async () => {
    const s = await setup();
    const a = await book(s, 10, 60000);
    const b = await book(s, 4, 60000);
    await buysell.createBuySell(s.ctx, bs(s, { lines: [{ weight: 14, rate: 60000 }], cash: 84000, deliveries: [{ bookingId: a.id, weight: 10 }, { bookingId: b.id, weight: 4 }] }));
    await expect(bhav.undeliverBhav(s.ctx, b.id)).rejects.toMatchObject({ status: 409 });

    const c = await book(s, 5, 60000);
    const legacy = await buysell.createBuySell(s.ctx, bs(s, { lines: [{ weight: 5, rate: 60000 }], cash: 30000, bhavBookingId: c.id }));
    expect(legacy.deliveries).toEqual([{ bookingId: c.id, bookingNo: c.bookingNo, rate: '60000.00', weight: '5.000' }]);
    await buysell.deleteBuySell(s.ctx, legacy.id);
    expect(await pending(s, c.id)).toEqual(['PENDING', '5.000']);
  });
});
