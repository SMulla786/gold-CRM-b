import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { exchangeBody, buySellBody, bhavBookingBody, kachaProcessBody } from '../../../shared';
import * as exchange from './exchange';
import * as kacha from './kacha';
import * as buysell from './buysell';
import * as bhav from './bhav';
import type { TenantContext } from '../../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['exchange', 'buy_sell'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  return { business, root, party, bank, ctx: ctxFor(business.id, root.id) };
}

// Default rate unit for gold is GRAM_10 → rate is per 10 g, so value = fine × rate / 10.
const ex = (o: Record<string, unknown>) => exchangeBody.parse({ partyId: 0, metal: 'GOLD', lines: [{ weight: 10, touch: 100 }], ...o });
const led = (where: Record<string, unknown>) => db.ledgerEntry.findMany({ where });

describe('exchange', () => {
  it('BUY at a rate → KACHA IN + MONEY OUT + party udhar −balance', async () => {
    const s = await setup();
    const e = await exchange.createExchange(s.ctx, ex({ partyId: s.party.id, side: 'BUY', rate: 60000, cash: 50000 }));
    expect(e.exchangeNo).toBe(1);
    expect(e.afterFine).toBe('10.000');
    expect(e.finalAmount).toBe('60000.00');
    expect(e.balance).toBe('-10000.00'); // shop still owes ₹10k to the customer

    const metal = await led({ source: 'EXCHANGE', asset: 'GOLD' });
    expect(metal).toHaveLength(1);
    expect([metal[0]!.direction, metal[0]!.metalForm, Number(metal[0]!.fine)]).toEqual(['IN', 'KACHA', 10]);
    const cash = await led({ source: 'EXCHANGE', asset: 'MONEY' });
    expect([cash[0]!.direction, Number(cash[0]!.amount)]).toEqual(['OUT', 50000]);
    const u = await db.udharEntry.findMany({ where: { source: 'EXCHANGE' } });
    expect(Number(u[0]!.amount)).toBe(-10000);
    expect((await kacha.kachaBalanceCard(s.ctx, { metal: 'GOLD' })).kachaFine).toBe('10.000');
  });

  it('BUY at rate 0 → party gold −afterFine, no money', async () => {
    const s = await setup();
    await exchange.createExchange(s.ctx, ex({ partyId: s.party.id, side: 'BUY', lines: [{ weight: 5, touch: 100 }], rate: 0 }));
    expect(await led({ source: 'EXCHANGE', asset: 'MONEY' })).toHaveLength(0);
    const u = await db.udharEntry.findMany({ where: { source: 'EXCHANGE' } });
    expect([Number(u[0]!.gold), Number(u[0]!.amount)]).toEqual([-5, 0]);
  });

  it('SELL more kacha than held → 409', async () => {
    const s = await setup();
    await exchange.createExchange(s.ctx, ex({ partyId: s.party.id, side: 'BUY', rate: 0 })); // pool = 10
    await expect(exchange.createExchange(s.ctx, ex({ partyId: s.party.id, side: 'SELL', lines: [{ weight: 20, touch: 100 }], rate: 0 }))).rejects.toMatchObject({ status: 409 });
  });

  it('delete after its kacha was melted → 409', async () => {
    const s = await setup();
    const e = await exchange.createExchange(s.ctx, ex({ partyId: s.party.id, side: 'BUY', rate: 0 })); // pool = 10
    await kacha.processKacha(s.ctx, kachaProcessBody.parse({ type: 'MELT', metal: 'GOLD', inFine: 10, outFine: 9.8 })); // pool = 0
    await expect(exchange.deleteExchange(s.ctx, e.id)).rejects.toMatchObject({ status: 409 });
  });

  it('cross-tenant party → 404', async () => {
    const s = await setup();
    const other = await setup();
    await expect(exchange.createExchange(s.ctx, ex({ partyId: other.party.id, side: 'BUY', rate: 0 }))).rejects.toMatchObject({ status: 404 });
  });
});

describe('kacha processing', () => {
  const buy10 = async (s: Awaited<ReturnType<typeof setup>>) => exchange.createExchange(s.ctx, ex({ partyId: s.party.id, side: 'BUY', rate: 0 }));

  it('MELT → KACHA OUT + BULLION IN, difference stored', async () => {
    const s = await setup();
    await buy10(s);
    const kp = await kacha.processKacha(s.ctx, kachaProcessBody.parse({ type: 'MELT', metal: 'GOLD', inFine: 10, outFine: 9.8 }));
    expect(kp.difference).toBe('0.200');
    const card = await kacha.kachaBalanceCard(s.ctx, { metal: 'GOLD' });
    expect([card.kachaFine, card.bullionFine]).toEqual(['0.000', '9.800']);
  });

  it('REFINE with raval → bullion + residual kacha', async () => {
    const s = await setup();
    await buy10(s);
    const kp = await kacha.processKacha(s.ctx, kachaProcessBody.parse({ type: 'REFINE', metal: 'GOLD', inFine: 10, outFine: 8, ravalFine: 1.5 }));
    expect(kp.difference).toBe('0.500');
    const card = await kacha.kachaBalanceCard(s.ctx, { metal: 'GOLD' });
    expect([card.kachaFine, card.bullionFine]).toEqual(['1.500', '8.000']);
  });

  it('melt more than the kacha pool → 409', async () => {
    const s = await setup();
    await buy10(s);
    await expect(kacha.processKacha(s.ctx, kachaProcessBody.parse({ type: 'MELT', metal: 'GOLD', inFine: 11, outFine: 10 }))).rejects.toMatchObject({ status: 409 });
  });

  it('two concurrent melts of the whole pool → one 409', async () => {
    const s = await setup();
    await buy10(s);
    const melt = () => kacha.processKacha(s.ctx, kachaProcessBody.parse({ type: 'MELT', metal: 'GOLD', inFine: 10, outFine: 9.8 }));
    const r = await Promise.allSettled([melt(), melt()]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
  });

  it('revert twice → 409', async () => {
    const s = await setup();
    await buy10(s);
    const kp = await kacha.processKacha(s.ctx, kachaProcessBody.parse({ type: 'MELT', metal: 'GOLD', inFine: 10, outFine: 9.8 }));
    await kacha.revertKacha(s.ctx, kp.id);
    await expect(kacha.revertKacha(s.ctx, kp.id)).rejects.toMatchObject({ status: 409 });
    expect((await kacha.kachaBalanceCard(s.ctx, { metal: 'GOLD' })).kachaFine).toBe('10.000'); // pool restored
  });
});

describe('buy-sell', () => {
  const bs = (o: Record<string, unknown>) => buySellBody.parse({ partyId: 0, metal: 'GOLD', side: 'BUY', lines: [{ weight: 10, rate: 60000 }], ...o });

  it('BUY → BULLION IN + MONEY OUT; SELL → BULLION OUT + MONEY IN', async () => {
    const s = await setup();
    await buysell.createBuySell(s.ctx, bs({ partyId: s.party.id, side: 'BUY', cash: 60000 }));
    let m = await led({ source: 'BUY_SELL', asset: 'GOLD' });
    expect([m[0]!.direction, m[0]!.metalForm, Number(m[0]!.fine)]).toEqual(['IN', 'BULLION', 10]);
    expect((await led({ source: 'BUY_SELL', asset: 'MONEY' }))[0]!.direction).toBe('OUT');

    await buysell.createBuySell(s.ctx, bs({ partyId: s.party.id, side: 'SELL', cash: 60000 }));
    m = await led({ source: 'BUY_SELL', asset: 'GOLD', direction: 'OUT' });
    expect(Number(m[0]!.fine)).toBe(10);
  });

  it('booking: advance credit; wrong rate → 400; over-delivery → 409; last delivery → DELIVERED; delete restores pending; cancel keeps credit', async () => {
    const s = await setup();
    const book = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000, cash: 5000 }));
    expect(Number((await db.udharEntry.findMany({ where: { source: 'BHAV_BOOKING' } }))[0]!.amount)).toBe(-5000); // party credit

    await expect(buysell.createBuySell(s.ctx, bs({ partyId: s.party.id, side: 'BUY', lines: [{ weight: 5, rate: 61000 }], bhavBookingId: book.id, cash: 30500 }))).rejects.toMatchObject({ status: 400 });
    await expect(buysell.createBuySell(s.ctx, bs({ partyId: s.party.id, side: 'BUY', lines: [{ weight: 20, rate: 60000 }], bhavBookingId: book.id, cash: 120000 }))).rejects.toMatchObject({ status: 409 });

    const deliver = await buysell.createBuySell(s.ctx, bs({ partyId: s.party.id, side: 'BUY', lines: [{ weight: 10, rate: 60000 }], bhavBookingId: book.id, cash: 60000 }));
    expect((await bhav.getBhav(s.ctx, book.id)).status).toBe('DELIVERED');
    await buysell.deleteBuySell(s.ctx, deliver.id);
    const restored = await bhav.getBhav(s.ctx, book.id);
    expect([restored.status, restored.pendingWeight]).toEqual(['PENDING', '10.000']);

    await bhav.cancelBhav(s.ctx, book.id);
    expect((await bhav.getBhav(s.ctx, book.id)).status).toBe('CANCELLED');
    expect(await db.udharEntry.findMany({ where: { source: 'BHAV_BOOKING', reversalOfId: { not: null } } })).toHaveLength(0); // advance credit untouched
  });

  it('two concurrent deletes restore the booking without a lost update (BUG-11)', async () => {
    const s = await setup();
    const book = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000 }));
    const a = await buysell.createBuySell(s.ctx, bs({ partyId: s.party.id, side: 'BUY', lines: [{ weight: 3, rate: 60000 }], bhavBookingId: book.id, cash: 18000 }));
    const b = await buysell.createBuySell(s.ctx, bs({ partyId: s.party.id, side: 'BUY', lines: [{ weight: 3, rate: 60000 }], bhavBookingId: book.id, cash: 18000 }));
    expect((await bhav.getBhav(s.ctx, book.id)).pendingWeight).toBe('4.000'); // 10 − 3 − 3

    await Promise.all([buysell.deleteBuySell(s.ctx, a.id), buysell.deleteBuySell(s.ctx, b.id)]);
    const back = await bhav.getBhav(s.ctx, book.id);
    expect([back.pendingWeight, back.status]).toEqual(['10.000', 'PENDING']); // both restores applied
  });

  it('cross-tenant booking → 404', async () => {
    const s = await setup();
    const other = await setup();
    const book = await bhav.createBhav(other.ctx, bhavBookingBody.parse({ partyId: other.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000 }));
    await expect(buysell.createBuySell(s.ctx, bs({ partyId: s.party.id, side: 'BUY', bhavBookingId: book.id, cash: 60000 }))).rejects.toMatchObject({ status: 404 });
  });
});

describe('bhav booking', () => {
  it('delete only an undelivered PENDING booking (reverses advance)', async () => {
    const s = await setup();
    const book = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000, cash: 5000 }));
    await bhav.deleteBhav(s.ctx, book.id);
    expect(await db.bhavBooking.findMany({})).toHaveLength(0);
    expect(await db.ledgerEntry.findMany({ where: { source: 'BHAV_BOOKING', reversalOfId: { not: null } } })).toHaveLength(1); // advance reversed
  });
});
