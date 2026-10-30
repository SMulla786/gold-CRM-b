import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../test/helpers/factory';
import { billBody, exchangeBody, kachaProcessBody, openingBalanceBody } from '../../shared';
import { businessDate } from '../../lib/ledger';
import { getOldMetalSummary } from './accounts';
import { createOpeningBalances } from './opening';
import * as billing from './billing/service';
import * as inv from './inventory';
import * as exchange from './trade/exchange';
import * as kacha from './trade/kacha';
import type { TenantContext } from '../../middleware/context';

/** ACC-05: Old Metal (kacha) IN/OUT/net per source reconciles with the ledger rows and the kacha card; reverts and
 *  deletes net out; 3-dp fine sums stay exact; other tenants and branches never leak in. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['exchange', 'billing', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  return { business, root, party, ctx: ctxFor(business.id, root.id) };
}
type S = Awaited<ReturnType<typeof setup>>;

const ex = (s: S, side: 'BUY' | 'SELL', weight: number, touch = 100, metal = 'GOLD') =>
  exchange.createExchange(s.ctx, exchangeBody.parse({ partyId: s.party.id, metal, side, lines: [{ weight, touch }], rate: 0 }));
const proc = (s: S, o: Record<string, unknown>) => kacha.processKacha(s.ctx, kachaProcessBody.parse({ metal: 'GOLD', ...o }));
const summary = (s: S, q: { from?: Date; to?: Date } = {}) => getOldMetalSummary(s.ctx, q);
const card = async (s: S) => (await kacha.kachaBalanceCard(s.ctx, {})).byMetal!.map((m) => [m.metal, m.kachaFine]);

/** The expected summary, straight from the KACHA ledger rows of one business (reversals included). */
async function fromLedger(businessId: number) {
  const z = () => new Prisma.Decimal(0);
  const acc = new Map<string, Record<'goldIn' | 'goldOut' | 'silverIn' | 'silverOut', Prisma.Decimal>>();
  for (const r of await db.ledgerEntry.findMany({ where: { businessId, metalForm: 'KACHA' } })) {
    const a = acc.get(r.source) ?? { goldIn: z(), goldOut: z(), silverIn: z(), silverOut: z() };
    const k = `${r.asset === 'GOLD' ? 'gold' : 'silver'}${r.direction === 'IN' ? 'In' : 'Out'}` as const;
    a[k] = a[k].plus(r.fine ?? 0);
    acc.set(r.source, a);
  }
  return [...acc].map(([source, v]) => ({
    source, goldIn: v.goldIn.toFixed(3), goldOut: v.goldOut.toFixed(3), goldNet: v.goldIn.minus(v.goldOut).toFixed(3),
    silverIn: v.silverIn.toFixed(3), silverOut: v.silverOut.toFixed(3), silverNet: v.silverIn.minus(v.silverOut).toFixed(3),
  }));
}
const bySource = <T extends { source: string }>(rows: T[]) => [...rows].sort((a, b) => a.source.localeCompare(b.source));
const netOf = (rows: { goldNet: string; silverNet: string }[], k: 'goldNet' | 'silverNet') => rows.reduce((a, r) => a.plus(r[k]), new Prisma.Decimal(0)).toFixed(3);

describe('old metal summary (ACC-05)', () => {
  it('every source that touches kacha: IN/OUT/net per source equal the ledger rows, and Σ net equals the kacha card', async () => {
    const s = await setup();
    await createOpeningBalances(s.ctx, openingBalanceBody.parse({ entries: [{ kind: 'METAL', metal: 'GOLD', metalForm: 'KACHA', fine: 5 }, { kind: 'METAL', metal: 'GOLD', metalForm: 'BULLION', fine: 50 }] }));
    await ex(s, 'BUY', 10, 91.6); // + 9.160
    await ex(s, 'SELL', 2); // − 2
    await ex(s, 'BUY', 1000, 92.5, 'SILVER'); // + 925 silver
    await proc(s, { type: 'REFINE', inFine: 8, outFine: 7, ravalFine: 0.6 }); // − 8 kacha, + 0.6 raval kacha, + 7 bullion (not kacha)
    await billing.createBill(s.ctx, billBody.parse({
      kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 10, rate: 60000 }],
      payments: [{ mode: 'METAL', metal: 'GOLD', metalForm: 'KACHA', gross: 2, tunch: 91.6, rate: 60000 }], // + 1.832 old gold taken in
    }));

    const rows = await summary(s);
    expect(bySource(rows)).toEqual(bySource(await fromLedger(s.business.id)));
    expect(Object.fromEntries(rows.map((r) => [r.source, [r.goldIn, r.goldOut, r.goldNet]]))).toEqual({
      OPENING_BALANCE: ['5.000', '0.000', '5.000'], // the BULLION opening row is not old metal
      EXCHANGE: ['9.160', '2.000', '7.160'],
      EXCHANGE_REFINE: ['0.600', '8.000', '-7.400'],
      SELL_BILL: ['1.832', '0.000', '1.832'],
    });
    expect(rows.find((r) => r.source === 'EXCHANGE')).toMatchObject({ silverIn: '925.000', silverOut: '0.000', silverNet: '925.000' });
    expect(netOf(rows, 'goldNet')).toBe('6.592');
    expect(await card(s)).toEqual([['GOLD', netOf(rows, 'goldNet')], ['SILVER', netOf(rows, 'silverNet')]]);
  });

  it('a reverted melt and a deleted exchange net to zero for their source; the card returns to where it was', async () => {
    const s = await setup();
    const e1 = await ex(s, 'BUY', 10);
    await ex(s, 'BUY', 4);
    const kp = await proc(s, { type: 'MELT', inFine: 6, outFine: 5.9 });
    expect(await card(s)).toEqual([['GOLD', '8.000'], ['SILVER', '0.000']]);

    await kacha.revertKacha(s.ctx, kp.id);
    expect(await card(s)).toEqual([['GOLD', '14.000'], ['SILVER', '0.000']]);
    await exchange.deleteExchange(s.ctx, e1.id);
    expect(await card(s)).toEqual([['GOLD', '4.000'], ['SILVER', '0.000']]);

    const rows = await summary(s);
    expect(bySource(rows)).toEqual(bySource(await fromLedger(s.business.id)));
    expect(rows.find((r) => r.source === 'EXCHANGE_MELT_PROCESS')).toMatchObject({ goldIn: '6.000', goldOut: '6.000', goldNet: '0.000' });
    expect(rows.find((r) => r.source === 'EXCHANGE')).toMatchObject({ goldIn: '14.000', goldOut: '10.000', goldNet: '4.000' });
  });

  it('a reversal lands on today: a window ending before today still shows the original, one including today nets it out', async () => {
    const s = await setup();
    const past = new Date(Date.now() - 3 * 86400000);
    await exchange.createExchange(s.ctx, exchangeBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight: 10, touch: 100 }], rate: 0, txnDate: past }));
    const kp = await proc(s, { type: 'MELT', inFine: 10, outFine: 9.9, txnDate: past });
    await kacha.revertKacha(s.ctx, kp.id);

    const yesterday = new Date(businessDate().getTime() - 86400000);
    const before = await summary(s, { to: yesterday });
    expect(before.find((r) => r.source === 'EXCHANGE_MELT_PROCESS')).toMatchObject({ goldIn: '0.000', goldOut: '10.000', goldNet: '-10.000' });
    expect(netOf(before, 'goldNet')).toBe('0.000');
    const all = await summary(s, { to: new Date() });
    expect(all.find((r) => r.source === 'EXCHANGE_MELT_PROCESS')).toMatchObject({ goldIn: '10.000', goldOut: '10.000', goldNet: '0.000' });
    expect(netOf(all, 'goldNet')).toBe((await card(s))[0]![1]);
  });

  it('rounding: fine is stored at 3 dp per row and the summary adds the stored values exactly (no float drift)', async () => {
    const s = await setup();
    const docs = [];
    for (let i = 0; i < 7; i++) docs.push(await ex(s, 'BUY', 3.333, 91.6)); // 3.053028 → 3.053 each
    docs.push(await ex(s, 'BUY', 0.1, 91.6)); // 0.0916 → 0.092
    expect(docs.map((d) => d.afterFine)).toEqual([...Array(7).fill('3.053'), '0.092']);
    const rows = await summary(s);
    expect(rows).toEqual([expect.objectContaining({ source: 'EXCHANGE', goldIn: '21.463', goldOut: '0.000', goldNet: '21.463' })]);
    expect((await card(s))[0]).toEqual(['GOLD', '21.463']);
    await proc(s, { type: 'MELT', inFine: 21.463, outFine: 21.1 });
    expect((await card(s))[0]).toEqual(['GOLD', '0.000']);
    expect(netOf(await summary(s), 'goldNet')).toBe('0.000');
  });

  it('tenant + branch isolation: another business and another branch of the same business never show up', async () => {
    const a = await setup('A');
    const b = await setup('B');
    await ex(a, 'BUY', 10);
    await ex(b, 'BUY', 7);
    const branch2 = await createBranch({ businessId: a.business.id, parentId: a.root.id, name: 'B2', isAdminNode: false });
    const a2: S = { ...a, ctx: ctxFor(a.business.id, branch2.id) };
    await ex(a2, 'BUY', 3);

    expect(await summary(a)).toEqual([expect.objectContaining({ source: 'EXCHANGE', goldIn: '10.000' })]);
    expect(await summary(b)).toEqual([expect.objectContaining({ source: 'EXCHANGE', goldIn: '7.000' })]);
    expect(await summary(a2)).toEqual([expect.objectContaining({ source: 'EXCHANGE', goldIn: '3.000' })]);
    expect([(await card(a))[0], (await card(b))[0], (await card(a2))[0]]).toEqual([['GOLD', '10.000'], ['GOLD', '7.000'], ['GOLD', '3.000']]);
    // all-branches view (no active branch) = only this business's branches
    const all: S = { ...a, ctx: { ...a.ctx, activeBranchId: null, branchIds: [a.root.id, branch2.id] } };
    expect(await summary(all)).toEqual([expect.objectContaining({ source: 'EXCHANGE', goldIn: '13.000' })]);
  });
});

// Known gap (sent to the money owner, not fixed here): bill METAL payments in KACHA post to the pool without
// assertKachaAvailable, so it can go negative. it.fails pins today's behaviour — flip each to it() with the fix.
describe('kacha pool guard on bills (ACC-05 gap)', () => {
  const sellKacha = (s: S, payments: unknown[] = [{ mode: 'METAL', metal: 'GOLD', metalForm: 'KACHA', gross: 2, tunch: 100, rate: 60000 }]) =>
    billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 10, rate: 60000 }], payments });

  it.fails('a purchase bill paid in more kacha than the pool holds → 409', async () => {
    const s = await setup();
    const supplier = await db.party.create({ data: { businessId: s.business.id, type: 'SUPPLIER', name: 'Supp', mobile: '9000000003', countryCode: '+91' } });
    const [group] = await inv.createItemGroups(s.ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
    const name = await inv.createItemName(s.ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
    const body = billBody.parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: supplier.id, items: [{ itemNameId: name!.id, gross: 5, rate: 5000 }], payments: [{ mode: 'METAL', metal: 'GOLD', metalForm: 'KACHA', gross: 3, tunch: 100, rate: 50000 }] });
    await expect(billing.createBill(s.ctx, body)).rejects.toMatchObject({ status: 409 }); // today: created, card −3.000
  });

  it.fails('deleting a sell bill whose kacha was already melted → 409', async () => {
    const s = await setup();
    const b = await billing.createBill(s.ctx, sellKacha(s));
    await proc(s, { type: 'MELT', inFine: 2, outFine: 1.9 });
    await expect(billing.deleteBill(s.ctx, b.id, false)).rejects.toMatchObject({ status: 409 }); // today: deleted, card −2.000
  });

  it.fails('editing a sell bill to drop a kacha payment that was already melted → 409', async () => {
    const s = await setup();
    const b = await billing.createBill(s.ctx, sellKacha(s));
    await proc(s, { type: 'MELT', inFine: 2, outFine: 1.9 });
    await expect(billing.editBill(s.ctx, b.id, sellKacha(s, [{ mode: 'CASH', amount: 1000 }]))).rejects.toMatchObject({ status: 409 });
  });
});
