import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { exchangeBody } from '../../../shared';
import { getSettings, putSetting } from '../service';
import * as exchange from './exchange';
import type { TenantContext } from '../../../middleware/context';

/** G5 exchange features 1–5 (owner rules 2026-10-30): exchange.defaults; exact fine (never rounded) + money round-off as its
 *  own figure; difference computed by the server; weighing block (sample custody untouched); given metal = KACHA IN by its
 *  fine, settled with the party, reversed exactly. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['exchange', 'settings'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  return { business, root, party, ctx: ctxFor(business.id, root.id) };
}
type S = Awaited<ReturnType<typeof setup>>;
const body = (s: S, o: Record<string, unknown> = {}) => exchangeBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight: 10, touch: 91.6 }], rate: 0, ...o });
const defaults = (s: S, v: Record<string, unknown>) => putSetting(s.ctx, 'exchange.defaults', undefined, v);
const kachaNet = async (s: S, id: number) => (await db.ledgerEntry.findMany({ where: { businessId: s.business.id, source: 'EXCHANGE', sourceId: String(id), metalForm: 'KACHA' } }))
  .reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.fine), 0);
const udharGold = async (s: S) => (await db.udharEntry.findMany({ where: { partyId: s.party.id } })).reduce((a, r) => a + Number(r.gold), 0);
const udharMoney = async (s: S) => (await db.udharEntry.findMany({ where: { partyId: s.party.id } })).reduce((a, r) => a + Number(r.amount), 0);

describe('1 · exchange.defaults', () => {
  it('defaults: no round-off, step ₹1, difference by fine; bad values are refused', async () => {
    const s = await setup();
    expect((await getSettings(s.ctx))['exchange.defaults']).toEqual({ roundOff: 'NONE', roundStep: 1, diffBy: 'FINE' });
    await defaults(s, { roundOff: 'NEAREST', roundStep: 10, diffBy: 'WEIGHT' });
    expect((await getSettings(s.ctx))['exchange.defaults']).toEqual({ roundOff: 'NEAREST', roundStep: 10, diffBy: 'WEIGHT' });
    await expect(defaults(s, { roundOff: 'SOMETIMES' })).rejects.toBeTruthy();
    await expect(defaults(s, { roundStep: 0 })).rejects.toBeTruthy();
  });
});

describe('2 · exact fine and money round-off', () => {
  it('fine is never rounded; the final money amount is rounded per the setting and the round-off is its own figure', async () => {
    const s = await setup();
    // 10 g @ 91.6 = 9.16 fine; rate ₹61,234 / 10 g → 56090.344 → exact 56090.34
    const exact = await exchange.createExchange(s.ctx, body(s, { rate: 61234 }));
    expect([exact.totalFine, exact.exactFine, exact.afterFine, exact.finalAmount, exact.roundOff]).toEqual(['9.160', '9.160', '9.160', '56090.34', '0.00']);

    await defaults(s, { roundOff: 'NEAREST', roundStep: 10 });
    const near = await exchange.createExchange(s.ctx, body(s, { rate: 61234 }));
    expect([near.afterFine, near.finalAmount, near.roundOff]).toEqual(['9.160', '56090.00', '-0.34']);
    await defaults(s, { roundOff: 'UP', roundStep: 1 });
    expect((await exchange.createExchange(s.ctx, body(s, { rate: 61234 }))).finalAmount).toBe('56091.00');
    await defaults(s, { roundOff: 'DOWN', roundStep: 1 });
    const down = await exchange.createExchange(s.ctx, body(s, { rate: 61234, cash: 50000 }));
    expect([down.finalAmount, down.roundOff, down.balance]).toEqual(['56090.00', '-0.34', '-6090.00']); // BUY: shop still owes 6090
    expect(await udharMoney(s)).toBeCloseTo(-56090.34 - 56090 - 56091 - 6090, 2); // each exchange's unpaid, rounded amount

    // rate 0 settles in metal: nothing to round
    const metal = await exchange.createExchange(s.ctx, body(s));
    expect([metal.finalAmount, metal.roundOff]).toEqual(['0.00', '0.00']);
  });
});

describe('3 · difference (server-computed)', () => {
  it('% of the FINE or WEIGHT base plus grams, each side; the client diffFine is ignored when parts are sent', async () => {
    const s = await setup();
    // base FINE 9.16: +1% = 0.0916, +0.1 g; −0.5% = 0.0458 → diff 0.1458 → 0.146
    const byFine = await exchange.createExchange(s.ctx, body(s, { diffPctPlus: 1, diffGmPlus: 0.1, diffPctMinus: 0.5, diffFine: 99 }));
    expect([byFine.diffFine, byFine.afterFine, byFine.diff]).toEqual(['0.146', '9.306', { pctPlus: '1', gmPlus: '0.100', pctMinus: '0.5', gmMinus: '0.000', plusBy: 'FINE', minusBy: 'FINE' }]);
    expect(await kachaNet(s, byFine.id)).toBeCloseTo(9.306, 6);

    await defaults(s, { diffBy: 'WEIGHT' });
    const byWeight = await exchange.createExchange(s.ctx, body(s, { diffPctMinus: 2, diffGmMinus: 0.05 })); // −0.2 −0.05
    expect([byWeight.diffFine, byWeight.afterFine, byWeight.diff?.minusBy]).toEqual(['-0.250', '8.910', 'WEIGHT']);

    const legacy = await exchange.createExchange(s.ctx, body(s, { diffFine: -0.06 })); // old body: grams on its side
    expect([legacy.diffFine, legacy.diff?.gmMinus, legacy.diff?.plusBy]).toEqual(['-0.060', '0.060', null]);

    await expect(exchange.createExchange(s.ctx, body(s, { diffGmMinus: 9.16 }))).rejects.toMatchObject({ status: 400 });
    const edited = await exchange.updateExchange(s.ctx, byFine.id, body(s, { diffGmPlus: 0.5 }));
    expect([edited.diffFine, edited.afterFine]).toEqual(['0.500', '9.660']);
    expect(await kachaNet(s, byFine.id)).toBeCloseTo(9.66, 6); // the edit re-posted once
  });
});

describe('4 · weighing block', () => {
  it('gross / less / melt / sample weight + sample id are stored and returned; the sample keeps its custody; a foreign sample → 404', async () => {
    const s = await setup();
    const sample = await db.sample.create({ data: { businessId: s.business.id, branchId: s.root.id, sampleNo: 1, metal: 'GOLD', grossWt: 0.5, tounchPercent: 91.6, fine: 0.458 } });
    const before = await db.sample.findUniqueOrThrow({ where: { id: sample.id } });
    const moves = await db.sampleMovement.count({ where: { sampleId: sample.id } });
    const ex = await exchange.createExchange(s.ctx, body(s, { lines: [{ weight: 10, touch: 91.6, grossWeight: 10.8, lessWeight: 0.3, meltWeight: 10.5, sampleWeight: 0.5, sampleId: sample.id }] }));
    expect(ex.lines[0]).toMatchObject({ weight: '10.000', fine: '9.160', grossWeight: '10.800', lessWeight: '0.300', meltWeight: '10.500', sampleWeight: '0.500', sampleId: sample.id });
    const after = await db.sample.findUniqueOrThrow({ where: { id: sample.id } });
    expect([after.status, after.updatedAt.getTime()]).toEqual([before.status, before.updatedAt.getTime()]);
    expect(await db.sampleMovement.count({ where: { sampleId: sample.id } })).toBe(moves);

    const b = await setup('B');
    const foreign = await db.sample.create({ data: { businessId: b.business.id, branchId: b.root.id, sampleNo: 1, metal: 'GOLD', grossWt: 1, tounchPercent: 90, fine: 0.9 } });
    await expect(exchange.createExchange(s.ctx, body(s, { lines: [{ weight: 1, touch: 90, sampleId: foreign.id }] }))).rejects.toMatchObject({ status: 404 });
  });
});

describe('5 · given metal', () => {
  it('BUY: given metal is extra KACHA IN by its fine (measurements kept) and the party is owed it too; delete reverses exactly', async () => {
    const s = await setup();
    // given 2.5 g gross, 0.5 less, 80 touch → net 2 → fine 1.6
    const ex = await exchange.createExchange(s.ctx, body(s, { given: { gross: 2.5, less: 0.5, touch: 80 } }));
    expect(ex.given).toEqual({ gross: '2.500', net: '2.000', touch: '80', fine: '1.600' });
    expect(await kachaNet(s, ex.id)).toBeCloseTo(9.16 + 1.6, 6);
    expect(await udharGold(s)).toBeCloseTo(-(9.16 + 1.6), 6);
    const rows = await db.ledgerEntry.findMany({ where: { source: 'EXCHANGE', sourceId: String(ex.id), narration: { endsWith: 'given metal' } } });
    expect(rows.map((r) => [r.direction, r.metalForm, String(r.net), String(r.fine)])).toEqual([['IN', 'KACHA', '2', '1.6']]);

    await exchange.deleteExchange(s.ctx, ex.id);
    expect(await kachaNet(s, ex.id)).toBeCloseTo(0, 6);
    expect(await udharGold(s)).toBeCloseTo(0, 6);
  });

  it('SELL: the given metal reduces what the party takes (money or metal); more than they take → 400; an edit dropping it reverses it', async () => {
    const s = await setup();
    await exchange.createExchange(s.ctx, body(s, { lines: [{ weight: 20, touch: 100 }] })); // pool 20
    const sell = await exchange.createExchange(s.ctx, body(s, { side: 'SELL', lines: [{ weight: 10, touch: 100 }], given: { gross: 4, touch: 100 }, rate: 60000 }));
    expect(sell.finalAmount).toBe('36000.00'); // (10 − 4) g × ₹6,000 / g
    expect(await kachaNet(s, sell.id)).toBeCloseTo(-10 + 4, 6);
    await expect(exchange.createExchange(s.ctx, body(s, { side: 'SELL', lines: [{ weight: 1, touch: 100 }], given: { gross: 2, touch: 100 } }))).rejects.toMatchObject({ status: 400 });

    const edited = await exchange.updateExchange(s.ctx, sell.id, body(s, { side: 'SELL', lines: [{ weight: 10, touch: 100 }], rate: 60000 }));
    expect([edited.given, edited.finalAmount]).toEqual([null, '60000.00']);
    expect(await kachaNet(s, sell.id)).toBeCloseTo(-10, 6);
  });
});
