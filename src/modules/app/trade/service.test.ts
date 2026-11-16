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

  it('booking: advance given; wrong rate → 400; over-delivery → 409; last delivery → DELIVERED; delete restores pending; cancel keeps the advance', async () => {
    const s = await setup();
    const book = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000, cash: 5000 }));
    expect(Number((await db.udharEntry.findMany({ where: { source: 'BHAV_BOOKING' } }))[0]!.amount)).toBe(5000); // BUY advance given = party debit (TRD-04)

    await expect(buysell.createBuySell(s.ctx, bs({ partyId: s.party.id, side: 'BUY', lines: [{ weight: 5, rate: 61000 }], bhavBookingId: book.id, cash: 30500 }))).rejects.toMatchObject({ status: 400 });
    await expect(buysell.createBuySell(s.ctx, bs({ partyId: s.party.id, side: 'BUY', lines: [{ weight: 20, rate: 60000 }], bhavBookingId: book.id, cash: 120000 }))).rejects.toMatchObject({ status: 409 });

    const deliver = await buysell.createBuySell(s.ctx, bs({ partyId: s.party.id, side: 'BUY', lines: [{ weight: 10, rate: 60000 }], bhavBookingId: book.id, cash: 60000 }));
    expect((await bhav.getBhav(s.ctx, book.id)).status).toBe('DELIVERED');
    await buysell.deleteBuySell(s.ctx, deliver.id);
    const restored = await bhav.getBhav(s.ctx, book.id);
    expect([restored.status, restored.pendingWeight]).toEqual(['PENDING', '10.000']);

    await bhav.cancelBhav(s.ctx, book.id);
    expect((await bhav.getBhav(s.ctx, book.id)).status).toBe('CANCELLED');
    expect(await db.udharEntry.findMany({ where: { source: 'BHAV_BOOKING', reversalOfId: { not: null } } })).toHaveLength(0); // advance untouched
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

// ───────────── TASK-97: split payments, ONLY_ENTRY, edit, undeliver ─────────────

/** Net effect of a document: MONEY by bank ("null" = cash, + = IN), bulk-metal fine (+ = IN) and udhar totals. */
async function netOf(source: string, sourceId: number) {
  const rows = await db.ledgerEntry.findMany({ where: { source: source as never, sourceId: String(sourceId) } });
  const sign = (d: string) => (d === 'IN' ? 1 : -1);
  const moneyBy: Record<string, number> = {};
  let fine = 0;
  for (const r of rows) {
    if (r.asset === 'MONEY') moneyBy[String(r.bankAccountId)] = Math.round(((moneyBy[String(r.bankAccountId)] ?? 0) + sign(r.direction) * Number(r.amount)) * 100) / 100;
    else fine = Math.round((fine + sign(r.direction) * Number(r.fine)) * 1000) / 1000;
  }
  for (const k of Object.keys(moneyBy)) if (moneyBy[k] === 0) delete moneyBy[k];
  const u = await db.udharEntry.findMany({ where: { source: source as never, sourceId: String(sourceId) } });
  const sum = (k: 'amount' | 'gold' | 'silver') => Math.round(u.reduce((a, r) => a + Number(r[k]), 0) * 1000) / 1000;
  return { moneyBy, fine, udhar: { amount: sum('amount'), gold: sum('gold'), silver: sum('silver') } };
}

describe('split payments', () => {
  it('buy-sell payments[] has the same ledger + udhar effect as single cash + online', async () => {
    const s = await setup();
    const base = { partyId: s.party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight: 10, rate: 60000 }] };
    const single = await buysell.createBuySell(s.ctx, buySellBody.parse({ ...base, cash: 30000, online: 25000, bankAccountId: s.bank.id }));
    const split = await buysell.createBuySell(s.ctx, buySellBody.parse({ ...base, payments: [{ mode: 'CASH', amount: 10000 }, { mode: 'CASH', amount: 20000 }, { mode: 'ONLINE', amount: 25000, bankAccountId: s.bank.id, reference: 'UTR1' }] }));
    expect([split.cash, split.online, split.balance]).toEqual([single.cash, single.online, single.balance]);
    expect(await netOf('BUY_SELL', split.id)).toEqual(await netOf('BUY_SELL', single.id));
    expect(await led({ source: 'BUY_SELL', sourceId: String(split.id), asset: 'MONEY' })).toHaveLength(3); // one row per payment
    expect(split.payments?.map((p) => [p.mode, p.amount, p.reference])).toEqual([['CASH', '10000.00', null], ['CASH', '20000.00', null], ['ONLINE', '25000.00', 'UTR1']]);
    expect(single.payments).toEqual([]);
  });

  it('exchange + bhav payments[] match single cash + online', async () => {
    const s = await setup();
    const exA = await exchange.createExchange(s.ctx, ex({ partyId: s.party.id, side: 'BUY', rate: 60000, cash: 20000, online: 10000, bankAccountId: s.bank.id }));
    const exB = await exchange.createExchange(s.ctx, ex({ partyId: s.party.id, side: 'BUY', rate: 60000, payments: [{ mode: 'ONLINE', amount: 10000, bankAccountId: s.bank.id }, { mode: 'CASH', amount: 20000 }] }));
    expect(await netOf('EXCHANGE', exB.id)).toEqual(await netOf('EXCHANGE', exA.id));
    const bk = { partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000 };
    const bA = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ ...bk, cash: 3000, online: 2000, bankAccountId: s.bank.id }));
    const bB = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ ...bk, payments: [{ mode: 'CASH', amount: 3000 }, { mode: 'ONLINE', amount: 2000, bankAccountId: s.bank.id }] }));
    expect(bB.advance).toBe(bA.advance);
    expect(await netOf('BHAV_BOOKING', bB.id)).toEqual(await netOf('BHAV_BOOKING', bA.id));
  });

  it('payments[] with cash, or ONLINE without a bank → schema error', () => {
    const base = { partyId: 1, metal: 'GOLD', side: 'BUY', lines: [{ weight: 1, rate: 1 }] };
    expect(() => buySellBody.parse({ ...base, cash: 5, payments: [{ mode: 'CASH', amount: 5 }] })).toThrow();
    expect(() => buySellBody.parse({ ...base, payments: [{ mode: 'ONLINE', amount: 5 }] })).toThrow();
  });
});

describe('bhav entry type + rows', () => {
  it('ONLY_ENTRY posts nothing; delete reverses nothing', async () => {
    const s = await setup();
    const b = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000, cash: 5000, entryType: 'ONLY_ENTRY' }));
    expect([b.entryType, b.advance]).toEqual(['ONLY_ENTRY', '5000.00']);
    expect(await led({ source: 'BHAV_BOOKING' })).toHaveLength(0);
    expect(await db.udharEntry.findMany({ where: { source: 'BHAV_BOOKING' } })).toHaveLength(0);
    await bhav.deleteBhav(s.ctx, b.id);
    expect(await led({ source: 'BHAV_BOOKING' })).toHaveLength(0);
  });

  it('lines[] → weight = sum, amount = sum of rows, rate = weight-weighted average (2 dp)', async () => {
    const s = await setup();
    const b = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight: 10, rate: 60000 }, { weight: 5, rate: 61000 }] }));
    expect([b.weight, b.amount, b.rate, b.pendingWeight]).toEqual(['15.000', '90500.00', '60333.33', '15.000']); // 60000 + 30500; 905000 / 15
    expect(b.lines).toHaveLength(2);
  });
});

describe('edit', () => {
  it('exchange edit nets to the same ledger/udhar as a fresh create of the new body', async () => {
    const s = await setup();
    const edited = await exchange.createExchange(s.ctx, ex({ partyId: s.party.id, side: 'BUY', rate: 60000, cash: 50000 }));
    const newBody = ex({ partyId: s.party.id, side: 'BUY', lines: [{ weight: 5, touch: 100 }], rate: 0 });
    const after = await exchange.updateExchange(s.ctx, edited.id, newBody);
    expect([after.id, after.exchangeNo, after.afterFine]).toEqual([edited.id, edited.exchangeNo, '5.000']);
    const fresh = await exchange.createExchange(s.ctx, newBody);
    expect(await netOf('EXCHANGE', edited.id)).toEqual(await netOf('EXCHANGE', fresh.id));
    const hist = await exchange.exchangeHistory(s.ctx, edited.id);
    expect(hist.map((h) => h.action)).toEqual(['CREATED', 'EDITED']);
    const meta = hist[1]!.meta as { before: { afterFine: string }; after: { afterFine: string } };
    expect([Number(meta.before.afterFine), Number(meta.after.afterFine)]).toEqual([10, 5]);
  });

  it('buy-sell edit gives the weight back to the booking and nets like a fresh create', async () => {
    const s = await setup();
    const bs = (o: Record<string, unknown>) => buySellBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight: 10, rate: 60000 }], ...o });
    const book = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000 }));
    const t = await buysell.createBuySell(s.ctx, bs({ bhavBookingId: book.id, cash: 60000 }));
    expect((await bhav.getBhav(s.ctx, book.id)).status).toBe('DELIVERED');
    const newBody = bs({ lines: [{ weight: 4, rate: 62000 }], cash: 10000 });
    await buysell.updateBuySell(s.ctx, t.id, newBody);
    const back = await bhav.getBhav(s.ctx, book.id);
    expect([back.status, back.pendingWeight]).toEqual(['PENDING', '10.000']);
    const fresh = await buysell.createBuySell(s.ctx, newBody);
    expect(await netOf('BUY_SELL', t.id)).toEqual(await netOf('BUY_SELL', fresh.id));
  });

  it('bhav edit nets like a fresh create; only PENDING is editable', async () => {
    const s = await setup();
    const b = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000, cash: 5000 }));
    const newBody = bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 8, rate: 61000, payments: [{ mode: 'ONLINE', amount: 7000, bankAccountId: s.bank.id }] });
    await bhav.updateBhav(s.ctx, b.id, newBody);
    const fresh = await bhav.createBhav(s.ctx, newBody);
    expect(await netOf('BHAV_BOOKING', b.id)).toEqual(await netOf('BHAV_BOOKING', fresh.id));
    await buysell.createBuySell(s.ctx, buySellBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight: 2, rate: 61000 }], bhavBookingId: b.id, cash: 12200 }));
    await expect(bhav.updateBhav(s.ctx, b.id, newBody)).rejects.toMatchObject({ status: 409 }); // now PARTIAL
  });

  it('exchange edit after it was sent to melt → 409', async () => {
    const s = await setup();
    const e = await exchange.createExchange(s.ctx, ex({ partyId: s.party.id, side: 'BUY', rate: 0 }));
    await kacha.processKacha(s.ctx, kachaProcessBody.parse({ type: 'MELT', metal: 'GOLD', inFine: 10, outFine: 9.8, exchangeId: e.id }));
    await expect(exchange.updateExchange(s.ctx, e.id, ex({ partyId: s.party.id, side: 'BUY', rate: 0 }))).rejects.toMatchObject({ status: 409 });
  });
});

describe('bhav undeliver / verify', () => {
  it('undeliver → 409 while a buy-sell is linked; PENDING again once nothing is linked', async () => {
    const s = await setup();
    const book = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000 }));
    await buysell.createBuySell(s.ctx, buySellBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight: 10, rate: 60000 }], bhavBookingId: book.id, cash: 60000 }));
    await expect(bhav.undeliverBhav(s.ctx, book.id)).rejects.toMatchObject({ status: 409 });

    const orphan = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000 }));
    await db.bhavBooking.update({ where: { id: orphan.id }, data: { status: 'DELIVERED', pendingWeight: 0 } });
    const back = await bhav.undeliverBhav(s.ctx, orphan.id);
    expect([back.status, back.pendingWeight]).toEqual(['PENDING', '10.000']);
    await expect(bhav.undeliverBhav(s.ctx, orphan.id)).rejects.toMatchObject({ status: 409 }); // already pending
  });

  it('verify is idempotent; unverify clears it', async () => {
    const s = await setup();
    const book = await bhav.createBhav(s.ctx, bhavBookingBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', weight: 10, rate: 60000 }));
    const v1 = await bhav.verifyBhav(s.ctx, book.id, true);
    const v2 = await bhav.verifyBhav(s.ctx, book.id, true);
    expect(v1.verifiedAt).not.toBeNull();
    expect(v2.verifiedAt).toBe(v1.verifiedAt);
    expect((await bhav.verifyBhav(s.ctx, book.id, false)).verifiedAt).toBeNull();
  });
});
