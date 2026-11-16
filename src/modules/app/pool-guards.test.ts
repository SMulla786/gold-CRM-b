/* eslint-disable @typescript-eslint/no-explicit-any -- service inputs are zod-parsed upstream; tests pass partial bodies */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import { addBillPaymentsBody, billBody, buySellBody, exchangeBody, justBillBody, kachaProcessBody, openingBalanceBody } from '../../shared';
import { businessDate } from '../../lib/ledger';
import { kachaBalance, lockedKacha, reservedKacha } from '../../lib/kacha';
import { createOpeningBalances, deleteOpeningBalances } from './opening';
import * as billing from './billing/service';
import * as extras from './inventory-extras';
import * as inv from './inventory';
import * as jb from './justbill/service';
import * as orders from './orders/service';
import * as buysell from './trade/buysell';
import * as exchange from './trade/exchange';
import * as kacha from './trade/kacha';
import type { TenantContext } from '../../middleware/context';

/**
 * G7 closure (A3): every write that takes metal out of a branch's KACHA or BULLION pool — a draw (OUT) or the reversal of
 * something that brought it in — is refused once the pool would end below zero (or a legacy negative pool would get worse):
 * 409 with details.code KACHA_SHORT / BULLION_SHORT, and nothing at all is written (every table of the business and both
 * pools as before). One case per code path; the bill KACHA paths are in old-metal.test.ts, the just-bill KACHA delete in
 * justbill/delete-kacha.test.ts.
 */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['exchange', 'buy_sell', 'billing', 'inventory', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeAll(truncateAll); // each case runs in a business of its own
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness();
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const supplier = await db.party.create({ data: { businessId: business.id, type: 'SUPPLIER', name: 'Supp', mobile: '9000000003', countryCode: '+91' } });
  const karigar = await db.party.create({ data: { businessId: business.id, type: 'KARIGAR', name: 'Kari', mobile: '9000000004', countryCode: '+91' } });
  return { business, root, party, supplier, karigar, ctx: ctxFor(business.id, root.id) };
}
type S = Awaited<ReturnType<typeof setup>>;

// ── the documents that move pool metal ──
const opening = (s: S, metalForm: 'KACHA' | 'BULLION', fine: number) => createOpeningBalances(s.ctx, openingBalanceBody.parse({ entries: [{ kind: 'METAL', metal: 'GOLD', metalForm, fine }] }));
const exBody = (s: S, side: 'BUY' | 'SELL', weight: number) => exchangeBody.parse({ partyId: s.party.id, metal: 'GOLD', side, lines: [{ weight, touch: 100 }], rate: 0 });
const ex = (s: S, side: 'BUY' | 'SELL', weight: number) => exchange.createExchange(s.ctx, exBody(s, side, weight));
const proc = (s: S, o: Record<string, unknown>) => kacha.processKacha(s.ctx, kachaProcessBody.parse({ metal: 'GOLD', ...o }));
const melt = (s: S, inFine: number) => proc(s, { type: 'MELT', inFine, outFine: inFine });
const bsBody = (s: S, side: 'BUY' | 'SELL', weight: number) => buySellBody.parse({ partyId: s.party.id, metal: 'GOLD', side, lines: [{ weight, rate: 6000 }] });
const trade = (s: S, side: 'BUY' | 'SELL', weight: number) => buysell.createBuySell(s.ctx, bsBody(s, side, weight));
const metalPay = (metalForm: 'KACHA' | 'BULLION', gross: number) => ({ mode: 'METAL', metal: 'GOLD', metalForm, gross, tunch: 100, rate: 60000 });
const sellBody = (s: S, payments: unknown[]) => billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 10, rate: 60000 }], payments });
async function purchaseBody(s: S) {
  const [group] = await inv.createItemGroups(s.ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const name = await inv.createItemName(s.ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
  return (payments: unknown[]) => billBody.parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: s.supplier.id, items: [{ itemNameId: name!.id, gross: 5, rate: 5000 }], payments });
}
/** An order with one PENDING gold item, and the karigar issue of it with `goldFine` g of fine gold. */
async function karigarIssue(s: S, goldFine: number) {
  const [group] = await inv.createItemGroups(s.ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const name = await inv.createItemName(s.ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
  const order = await orders.createOrder(s.ctx, { partyId: s.party.id, rateType: 'ON_DELIVERY', isUrgent: false, items: [{ itemNameId: name!.id, metal: 'GOLD', karatCode: '22K', gross: 10, making: 500, makingUnit: 'PER_GRAM', pcs: 1 }], payments: [] } as any);
  return () => orders.createKarigarIssue(s.ctx, { karigarId: s.karigar.id, orderItemIds: [order.items[0]!.id], goldFine, silverFine: 0, cash: 0, online: 0 } as any);
}
/** The dev DB's state (G7 review 6): a GOLD BULLION pool already at −170.367 g from writes made before the guards. */
const legacyNegativeBullion = (s: S) =>
  db.ledgerEntry.create({ data: { businessId: s.business.id, branchId: s.root.id, txnDate: businessDate(), asset: 'GOLD', metalForm: 'BULLION', direction: 'OUT', net: 170.367, fine: 170.367, source: 'KARIGAR_ISSUE', sourceId: 'legacy' } });

/** Everything a refused write could have touched: every document table of the business, and both GOLD pools (+ reservation). */
async function snapshot(s: S) {
  const b = s.business.id;
  const str = (rows: object[]) => JSON.stringify(rows);
  return {
    ledger: await db.ledgerEntry.count({ where: { businessId: b } }),
    udhar: await db.udharEntry.count({ where: { businessId: b } }),
    bills: str(await db.bill.findMany({ where: { businessId: b }, select: { id: true, status: true, paid: true, final: true }, orderBy: { id: 'asc' } })),
    billPayments: str(await db.billPayment.findMany({ where: { bill: { businessId: b } }, select: { id: true, isActive: true, amount: true }, orderBy: { id: 'asc' } })),
    justBills: str(await db.justBill.findMany({ where: { businessId: b }, select: { id: true, status: true }, orderBy: { id: 'asc' } })),
    buySells: str(await db.buySell.findMany({ where: { businessId: b }, select: { id: true, side: true, totalWeight: true }, orderBy: { id: 'asc' } })),
    exchanges: str(await db.exchange.findMany({ where: { businessId: b }, select: { id: true, side: true, afterFine: true }, orderBy: { id: 'asc' } })),
    processes: str(await db.kachaProcess.findMany({ where: { businessId: b }, select: { id: true, type: true, reverted: true }, orderBy: { id: 'asc' } })),
    karigarIssues: await db.karigarIssue.count({ where: { businessId: b } }),
    orderItems: str(await db.orderItem.findMany({ where: { order: { businessId: b } }, select: { id: true, status: true }, orderBy: { id: 'asc' } })),
    stock: str(await db.stockItem.findMany({ where: { businessId: b }, select: { id: true, status: true, gross: true }, orderBy: { id: 'asc' } })),
    setStockLogs: await db.setStockLog.count({ where: { businessId: b } }),
    activity: await db.activityLog.count({ where: { businessId: b } }),
    pools: { ...(await kachaBalance(db, s.root.id, 'GOLD')), reserved: (await reservedKacha(db, s.root.id, 'GOLD')).toFixed(3) },
  };
}

type Case = [name: string, code: 'KACHA_SHORT' | 'BULLION_SHORT', run: (s: S) => Promise<() => Promise<unknown>>];
const CASES: Case[] = [
  // ── BULLION ──
  ['karigar issue beyond the bullion pool (G7 D-i)', 'BULLION_SHORT', async (s) => { await opening(s, 'BULLION', 5); return karigarIssue(s, 10); }],
  ['karigar issue on a pool already negative, as the dev DB (−170.367 g)', 'BULLION_SHORT', async (s) => { await legacyNegativeBullion(s); return karigarIssue(s, 1); }],
  ['buy-sell SELL beyond the bullion pool', 'BULLION_SHORT', async (s) => { await opening(s, 'BULLION', 5); return () => trade(s, 'SELL', 10); }],
  ['buy-sell SELL on a pool already negative, as the dev DB', 'BULLION_SHORT', async (s) => { await legacyNegativeBullion(s); return () => trade(s, 'SELL', 1); }],
  ['deleting a buy-sell BUY whose bullion was sold', 'BULLION_SHORT', async (s) => { const b = await trade(s, 'BUY', 10); await trade(s, 'SELL', 10); return () => buysell.deleteBuySell(s.ctx, b.id); }],
  ['editing a buy-sell BUY down after its bullion was sold', 'BULLION_SHORT', async (s) => { const b = await trade(s, 'BUY', 10); await trade(s, 'SELL', 10); return () => buysell.updateBuySell(s.ctx, b.id, bsBody(s, 'BUY', 4)); }],
  ['a purchase bill paid in bullion beyond the pool', 'BULLION_SHORT', async (s) => { await opening(s, 'BULLION', 1); const body = await purchaseBody(s); return () => billing.createBill(s.ctx, body([metalPay('BULLION', 3)])); }],
  ['a later bullion payment on a purchase bill beyond the pool', 'BULLION_SHORT', async (s) => {
    const body = await purchaseBody(s);
    const b = await billing.createBill(s.ctx, body([{ mode: 'CASH', amount: 1000 }]));
    await opening(s, 'BULLION', 1);
    return () => billing.addBillPayments(s.ctx, b.id, addBillPaymentsBody.parse({ payments: [metalPay('BULLION', 2)] }));
  }],
  ['deleting a sell bill paid in bullion after that bullion was sold', 'BULLION_SHORT', async (s) => { const b = await billing.createBill(s.ctx, sellBody(s, [metalPay('BULLION', 2)])); await trade(s, 'SELL', 2); return () => billing.deleteBill(s.ctx, b.id, true); }],
  ['editing a sell bill to drop its bullion payment after it was sold', 'BULLION_SHORT', async (s) => { const b = await billing.createBill(s.ctx, sellBody(s, [metalPay('BULLION', 2)])); await trade(s, 'SELL', 2); return () => billing.editBill(s.ctx, b.id, sellBody(s, [{ mode: 'CASH', amount: 1000 }])); }],
  ['deleting a just bill paid in bullion after the bullion was sold (G7 D-g)', 'BULLION_SHORT', async (s) => {
    const b = await jb.createJustBill(s.ctx, justBillBody.parse({ partyId: s.party.id, items: [{ name: 'Coin', quantity: 1, unit: 'PCS', rate: 20000 }], payments: [metalPay('BULLION', 2)] }));
    await trade(s, 'SELL', 2);
    return () => jb.deleteJustBill(s.ctx, b.id);
  }],
  ['deleting an opening BULLION batch after the bullion was sold', 'BULLION_SHORT', async (s) => { const o = await opening(s, 'BULLION', 10); await trade(s, 'SELL', 10); return () => deleteOpeningBalances(s.ctx, o.sourceId); }],
  ['reverting a melt after its bullion was sold', 'BULLION_SHORT', async (s) => { await ex(s, 'BUY', 10); const m = await melt(s, 10); await trade(s, 'SELL', 10); return () => kacha.revertKacha(s.ctx, m.id); }],
  // ── KACHA ──
  ['exchange SELL beyond the kacha pool', 'KACHA_SHORT', async (s) => { await ex(s, 'BUY', 5); return () => ex(s, 'SELL', 10); }],
  ['deleting an exchange BUY whose kacha was melted', 'KACHA_SHORT', async (s) => { const e = await ex(s, 'BUY', 10); await melt(s, 10); return () => exchange.deleteExchange(s.ctx, e.id); }],
  ['editing an exchange BUY down after its kacha was melted', 'KACHA_SHORT', async (s) => { const e = await ex(s, 'BUY', 10); await melt(s, 10); return () => exchange.updateExchange(s.ctx, e.id, exBody(s, 'BUY', 4)); }],
  ['a melt beyond the kacha pool', 'KACHA_SHORT', async (s) => { await ex(s, 'BUY', 5); return () => melt(s, 10); }],
  ['a refine beyond the kacha pool', 'KACHA_SHORT', async (s) => { await ex(s, 'BUY', 5); return () => proc(s, { type: 'REFINE', inFine: 10, outFine: 9 }); }],
  ['a process batch whose exchange kacha was already melted', 'KACHA_SHORT', async (s) => { const e = await ex(s, 'BUY', 10); await melt(s, 10); return () => proc(s, { type: 'PROCESS', exchangeIds: [e.id] }); }],
  ['reverting a refine whose raval kacha was melted since', 'KACHA_SHORT', async (s) => { await ex(s, 'BUY', 10); const r = await proc(s, { type: 'REFINE', inFine: 10, outFine: 8, ravalFine: 1.5 }); await melt(s, 1.5); return () => kacha.revertKacha(s.ctx, r.id); }],
  ['deleting an opening KACHA batch after it was melted', 'KACHA_SHORT', async (s) => { const o = await opening(s, 'KACHA', 10); await melt(s, 10); return () => deleteOpeningBalances(s.ctx, o.sourceId); }],
  ['a purchase bill paid in kacha beyond the pool', 'KACHA_SHORT', async (s) => { await ex(s, 'BUY', 1); const body = await purchaseBody(s); return () => billing.createBill(s.ctx, body([metalPay('KACHA', 3)])); }],
  ['set stock: the kaccha card below what an open process batch reserves', 'KACHA_SHORT', async (s) => { const e = await ex(s, 'BUY', 10); await proc(s, { type: 'PROCESS', exchangeIds: [e.id] }); return () => extras.setStock(s.ctx, { card: 'KACCHA_GOLD', newBalance: 4 }); }],
];

describe('G7 closure: a KACHA / BULLION draw below zero is refused and writes nothing', () => {
  it.each(CASES)('%s → 409 %s', async (_name, code, run) => {
    const s = await setup();
    const attempt = await run(s);
    const before = await snapshot(s);
    await expect(attempt()).rejects.toMatchObject({ status: 409, details: { code, metal: 'GOLD' } });
    expect(await snapshot(s)).toEqual(before);
  });

  it('a pool already negative (legacy) still takes metal IN: a bullion BUY and a melt are accepted; the pool improves', async () => {
    const s = await setup();
    await legacyNegativeBullion(s);
    await trade(s, 'BUY', 5);
    await ex(s, 'BUY', 3);
    await melt(s, 3);
    expect(Number((await kachaBalance(db, s.root.id, 'GOLD')).bullion)).toBe(-162.367);
  });
});

/** Resolves 'waiting' once another connection of this DB waits on a lock (an advisory pool lock counts), else 'never' after ~6 s. */
async function lockWaiter(): Promise<'waiting' | 'never'> {
  for (let i = 0; i < 200; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return 'waiting';
    await new Promise((r) => setTimeout(r, 30));
  }
  return 'never';
}

describe('set stock on a kaccha card is serialised with the pool', () => {
  it('race: a melt holding the kacha pool lock mid-flight → set stock waits for it, then sets the card from the settled balance (never below zero)', async () => {
    const s = await setup();
    await ex(s, 'BUY', 10);
    let locked!: () => void;
    let release!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const held = new Promise<void>((r) => (release = r));
    // a melt mid-flight: it holds the pool lock and has written its 10 g KACHA OUT, not committed yet
    const meltInFlight = db.$transaction(async (t) => {
      await lockedKacha(t, s.root.id, 'GOLD');
      await t.ledgerEntry.create({ data: { businessId: s.business.id, branchId: s.root.id, txnDate: businessDate(), asset: 'GOLD', metalForm: 'KACHA', direction: 'OUT', net: 10, fine: 10, source: 'EXCHANGE_MELT_PROCESS', sourceId: 'in-flight' } });
      locked();
      await held;
    }, { timeout: 30_000 });
    await isLocked;
    const set = extras.setStock(s.ctx, { card: 'KACCHA_GOLD', newBalance: 0 }).then(() => 'set' as const, (e: unknown) => e);
    const first = await Promise.race([set, lockWaiter()]);
    release();
    await meltInFlight;
    await set;
    expect(first).toBe('waiting'); // it waited for the pool, it did not read the 10 g the melt was taking
    expect(Number((await kachaBalance(db, s.root.id, 'GOLD')).kacha)).toBe(0);
    expect(await db.ledgerEntry.count({ where: { businessId: s.business.id, source: 'SET_STOCK' } })).toBe(0); // 0 → 0: logged, nothing posted
    expect(await db.setStockLog.count({ where: { businessId: s.business.id } })).toBe(1);
  });

  it('within the pool a kaccha set still works both ways (raise, lower to what is not reserved)', async () => {
    const s = await setup();
    const e = await ex(s, 'BUY', 10);
    await proc(s, { type: 'PROCESS', exchangeIds: [e.id] }); // 10 g reserved
    await extras.setStock(s.ctx, { card: 'KACCHA_GOLD', newBalance: 15 });
    await extras.setStock(s.ctx, { card: 'KACCHA_GOLD', newBalance: 10 }); // down to exactly the reservation
    expect(Number((await kachaBalance(db, s.root.id, 'GOLD')).kacha)).toBe(10);
    expect(await db.ledgerEntry.count({ where: { businessId: s.business.id, source: 'SET_STOCK' } })).toBe(2);
  });
});
