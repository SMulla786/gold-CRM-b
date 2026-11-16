import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../../test/helpers/factory';
import { billBody, buySellBody, exchangeBody, kachaProcessBody, openingBalanceBody } from '../../../shared';
import { createOpeningBalances, deleteOpeningBalances } from '../opening';
import * as billing from '../billing/service';
import * as inv from '../inventory';
import * as buysell from './buysell';
import * as exchange from './exchange';
import * as kacha from './kacha';
import { lockedKacha } from '../../../lib/kacha';
import type { TenantContext } from '../../../middleware/context';

/** G5 P0 — exchange / kacha / bullion integrity under the owner-approved rules (2026-10-30):
 *  bullion is guarded like kacha (never below 0); linked melts: Σ active inFine ≤ the exchange's afterFine, BUY only, same
 *  metal; global lock order = document row, then branch pools GOLD before SILVER. it.fails = today's code breaks the rule
 *  (flip each to it() with its fix); plain it = already holds. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['exchange', 'buy_sell', 'billing', 'inventory'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const supplier = await db.party.create({ data: { businessId: business.id, type: 'SUPPLIER', name: 'Supp', mobile: '9000000003', countryCode: '+91' } });
  return { business, root, party, supplier, ctx: ctxFor(business.id, root.id) };
}
type S = Awaited<ReturnType<typeof setup>>;

const ROUNDS = 4; // races are timing-dependent: repeat so a broken guard shows up reliably
const exBody = (s: S, o: Record<string, unknown> = {}) => exchangeBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight: 10, touch: 100 }], rate: 0, ...o });
const buy = (s: S, weight = 10, metal = 'GOLD') => exchange.createExchange(s.ctx, exBody(s, { metal, lines: [{ weight, touch: 100 }] }));
const melt = (s: S, inFine: number, o: Record<string, unknown> = {}) => kacha.processKacha(s.ctx, kachaProcessBody.parse({ type: 'MELT', metal: 'GOLD', inFine, outFine: inFine, ...o }));
const pools = async (s: S, metal: 'GOLD' | 'SILVER' = 'GOLD') => {
  const c = await kacha.kachaBalanceCard(s.ctx, { metal });
  return { kacha: c.kachaFine, bullion: c.bullionFine };
};
const sellBullion = (s: S, weight: number) => buysell.createBuySell(s.ctx, buySellBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'SELL', lines: [{ weight, rate: 6000 }] }));
const statusOf = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 200 : ((r.reason as { status?: number }).status ?? 500));
/** signed net of a document's rows: ledger fine per metal asset + MONEY amount, udhar amount/gold/silver */
async function net(source: string, sourceId: number) {
  const n = (v: unknown) => new Prisma.Decimal((v as Prisma.Decimal.Value) ?? 0);
  const l = await db.ledgerEntry.findMany({ where: { source: source as never, sourceId: String(sourceId) } });
  const u = await db.udharEntry.findMany({ where: { source: source as never, sourceId: String(sourceId) } });
  const sum = (rows: typeof l, asset: string, f: 'fine' | 'amount') => rows.filter((r) => r.asset === asset).reduce((a, r) => (r.direction === 'IN' ? a.plus(n(r[f])) : a.minus(n(r[f]))), n(0)).toFixed(3);
  return { gold: sum(l, 'GOLD', 'fine'), money: sum(l, 'MONEY', 'amount'), udharGold: u.reduce((a, r) => a.plus(n(r.gold)), n(0)).toFixed(3), udharAmount: u.reduce((a, r) => a.plus(n(r.amount)), n(0)).toFixed(3) };
}
async function itemName(s: S) {
  const [group] = await inv.createItemGroups(s.ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  return (await inv.createItemName(s.ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 }))!.id;
}

describe('1 · concurrent edits of one exchange', () => {
  it('two edits at once: every outcome is a 200 or a 409, and the ledger + udhar hold exactly the saved body once', async () => {
    const s = await setup();
    for (let i = 0; i < ROUNDS; i++) {
      const e = await buy(s, 10);
      const r = await Promise.allSettled([12, 14].map((w) => exchange.updateExchange(s.ctx, e.id, exBody(s, { lines: [{ weight: w, touch: 100 }] }))));
      expect(r.map(statusOf).every((c) => c === 200 || c === 409)).toBe(true);
      const saved = await exchange.getExchange(s.ctx, e.id);
      expect(await net('EXCHANGE', e.id)).toMatchObject({ gold: saved.afterFine, udharGold: `-${saved.afterFine}` });
    }
  });

  it('edit vs delete at once: never a 500; a deleted exchange leaves nothing posted, a surviving one is posted once', async () => {
    const s = await setup();
    for (let i = 0; i < ROUNDS; i++) {
      const e = await buy(s, 10);
      const r = await Promise.allSettled([exchange.updateExchange(s.ctx, e.id, exBody(s, { lines: [{ weight: 12, touch: 100 }] })), exchange.deleteExchange(s.ctx, e.id)]);
      expect(r.map(statusOf).every((c) => [200, 404, 409].includes(c))).toBe(true);
      const left = await db.exchange.findUnique({ where: { id: e.id } });
      expect(await net('EXCHANGE', e.id)).toMatchObject(left ? { gold: left.afterFine.toFixed(3) } : { gold: '0.000', udharGold: '0.000' });
    }
  });
});

describe('2 · melts linked to an exchange (Σ active inFine ≤ afterFine, BUY only, same metal)', () => {
  it('two partial melts within the exchange are fine', async () => {
    const s = await setup();
    const e = await buy(s, 10);
    await melt(s, 6, { exchangeId: e.id });
    await melt(s, 4, { exchangeId: e.id });
    expect((await pools(s)).kacha).toBe('0.000');
  });

  it('melting the same exchange beyond its afterFine → 409 (even when other kacha is in the pool)', async () => {
    const s = await setup();
    const e = await buy(s, 10);
    await buy(s, 50); // other kacha: a linked melt must never borrow it
    await melt(s, 10, { exchangeId: e.id });
    await expect(melt(s, 5, { exchangeId: e.id })).rejects.toMatchObject({ status: 409 });
    expect((await pools(s)).kacha).toBe('50.000');
  });

  it('concurrent linked melts never take more than the exchange\'s afterFine', async () => {
    const s = await setup();
    await buy(s, 100);
    for (let i = 0; i < ROUNDS; i++) {
      const e = await buy(s, 10);
      await Promise.allSettled([melt(s, 6, { exchangeId: e.id }), melt(s, 6, { exchangeId: e.id })]);
      const linked = await db.kachaProcess.aggregate({ where: { exchangeId: e.id, reverted: false }, _sum: { inFine: true } });
      expect(Number(linked._sum.inFine)).toBeLessThanOrEqual(10);
    }
  });

  it('a melt of another metal than the exchange → 4xx', async () => {
    const s = await setup();
    const e = await buy(s, 10);
    await buy(s, 10, 'SILVER');
    const r = await melt(s, 5, { metal: 'SILVER', exchangeId: e.id }).then(() => 200, (x) => x.status as number);
    expect(r).toBeGreaterThanOrEqual(400);
    expect(r).toBeLessThan(500);
  });

  it('a melt linked to a SELL exchange → 4xx', async () => {
    const s = await setup();
    await buy(s, 20);
    const sold = await exchange.createExchange(s.ctx, exBody(s, { side: 'SELL', lines: [{ weight: 5, touch: 100 }] }));
    const r = await melt(s, 5, { exchangeId: sold.id }).then(() => 200, (x) => x.status as number);
    expect(r).toBeGreaterThanOrEqual(400);
    expect(r).toBeLessThan(500);
  });

  it('delete vs a concurrent linked melt: no active process is ever left linked to a deleted exchange', async () => {
    const s = await setup();
    await buy(s, 100); // enough other kacha that the delete's pool check alone can't stop it
    for (let i = 0; i < ROUNDS; i++) {
      const e = await buy(s, 10);
      await Promise.allSettled([exchange.deleteExchange(s.ctx, e.id), melt(s, 5, { exchangeId: e.id })]);
      const gone = !(await db.exchange.findUnique({ where: { id: e.id } }));
      if (gone) expect(await db.kachaProcess.count({ where: { exchangeId: e.id, reverted: false } })).toBe(0);
    }
  });

  it('another branch\'s exchange cannot be linked (404)', async () => {
    const s = await setup();
    const b2 = await createBranch({ businessId: s.business.id, parentId: s.root.id, name: 'B2' });
    const s2: S = { ...s, ctx: ctxFor(s.business.id, b2.id) };
    const theirs = await buy(s2, 10);
    await buy(s, 10);
    await expect(melt(s, 5, { exchangeId: theirs.id })).rejects.toMatchObject({ status: 404 });
  });
});

describe('3 · lock order: GOLD + SILVER at once never deadlocks', () => {
  // A SILVER→GOLD edit locks the pools SILVER first (new Set([old, new])); every other writer (bills) locks GOLD first.
  // Deterministic: a transaction holds GOLD (as a bill's kacha guard does), waits until the edit holds SILVER, then wants SILVER.
  it('an exchange edit SILVER→GOLD while another write holds GOLD then takes SILVER: both complete, never a deadlock 500', async () => {
    const s = await setup();
    await buy(s, 50);
    const e = await buy(s, 10, 'SILVER');
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const billLike = db.$transaction(async (tx) => {
      await lockedKacha(tx, s.root.id, 'GOLD');
      await sleep(800);
      await lockedKacha(tx, s.root.id, 'SILVER');
    }, { timeout: 20_000 });
    await sleep(50);
    const r = await Promise.allSettled([exchange.updateExchange(s.ctx, e.id, exBody(s, { metal: 'GOLD' })), billLike]);
    expect(r.map(statusOf)).toEqual([200, 200]);
    expect((await exchange.getExchange(s.ctx, e.id)).metal).toBe('GOLD');
  });
});

describe('4 · opening-balance delete', () => {
  it('deleting an opening KACHA row after it was melted → 409, pool unchanged', async () => {
    const s = await setup();
    const o = await createOpeningBalances(s.ctx, openingBalanceBody.parse({ entries: [{ kind: 'METAL', metal: 'GOLD', metalForm: 'KACHA', fine: 10 }] }));
    await melt(s, 10);
    await expect(deleteOpeningBalances(s.ctx, o.sourceId)).rejects.toMatchObject({ status: 409 });
    expect((await pools(s)).kacha).toBe('0.000');
  });

  it('deleting an opening BULLION row after the bullion was sold → 409', async () => {
    const s = await setup();
    const o = await createOpeningBalances(s.ctx, openingBalanceBody.parse({ entries: [{ kind: 'METAL', metal: 'GOLD', metalForm: 'BULLION', fine: 10 }] }));
    await sellBullion(s, 10);
    await expect(deleteOpeningBalances(s.ctx, o.sourceId)).rejects.toMatchObject({ status: 409 });
    expect((await pools(s)).bullion).toBe('0.000');
  });
});

describe('5 · bullion never below zero', () => {
  it('buy-sell SELL beyond the bullion pool → 409', async () => {
    const s = await setup();
    await expect(sellBullion(s, 5)).rejects.toMatchObject({ status: 409 });
    expect((await pools(s)).bullion).toBe('0.000');
  });

  it('a purchase bill paid in BULLION beyond the pool → 409', async () => {
    const s = await setup();
    const ring = await itemName(s);
    const bill = billBody.parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: s.supplier.id, items: [{ itemNameId: ring, gross: 5, rate: 5000 }], payments: [{ mode: 'METAL', metal: 'GOLD', metalForm: 'BULLION', gross: 3, tunch: 100, rate: 60000 }] });
    await expect(billing.createBill(s.ctx, bill)).rejects.toMatchObject({ status: 409 });
    expect((await pools(s)).bullion).toBe('0.000');
  });

  it('reverting a MELT after its bullion was sold → 409, nothing changes', async () => {
    const s = await setup();
    await buy(s, 10);
    const m = await melt(s, 10);
    await sellBullion(s, 10);
    await expect(kacha.revertKacha(s.ctx, m.id)).rejects.toMatchObject({ status: 409 });
    expect(await pools(s)).toEqual({ kacha: '0.000', bullion: '0.000' });
  });

  it('within the pool every bullion draw works', async () => {
    const s = await setup();
    await buy(s, 10);
    await melt(s, 10);
    await sellBullion(s, 4);
    expect((await pools(s)).bullion).toBe('6.000');
  });
});

describe('6 · the new guards count only this branch\'s pools', () => {
  it('another branch or business holding bullion does not let this branch sell bullion it lacks', async () => {
    const s = await setup('A');
    const other = await setup('B');
    const b2 = await createBranch({ businessId: s.business.id, parentId: s.root.id, name: 'B2' });
    const s2: S = { ...s, ctx: ctxFor(s.business.id, b2.id) };
    for (const t of [other, s2]) {
      await buy(t, 50);
      await melt(t, 50);
    }
    await expect(sellBullion(s, 5)).rejects.toMatchObject({ status: 409 });
    expect([(await pools(s)).bullion, (await pools(s2)).bullion, (await pools(other)).bullion]).toEqual(['0.000', '50.000', '50.000']);
  });

  it('another branch\'s kacha does not count for a melt here (409)', async () => {
    const s = await setup();
    const b2 = await createBranch({ businessId: s.business.id, parentId: s.root.id, name: 'B2' });
    await buy({ ...s, ctx: ctxFor(s.business.id, b2.id) }, 50);
    await expect(melt(s, 5)).rejects.toMatchObject({ status: 409 });
  });
});

describe('7 · no-decision gaps (already hold)', () => {
  it('deleting a SELL exchange puts the kacha back; ledger and udhar net to zero', async () => {
    const s = await setup();
    await buy(s, 20);
    const sold = await exchange.createExchange(s.ctx, exBody(s, { side: 'SELL', lines: [{ weight: 5, touch: 100 }] }));
    expect((await pools(s)).kacha).toBe('15.000');
    await exchange.deleteExchange(s.ctx, sold.id);
    expect((await pools(s)).kacha).toBe('20.000');
    expect(await net('EXCHANGE', sold.id)).toEqual({ gold: '0.000', money: '0.000', udharGold: '0.000', udharAmount: '0.000' });
  });

  it('an exchange SELL at a rate: KACHA OUT, MONEY IN for the cash, the unpaid rest on the party (+)', async () => {
    const s = await setup();
    await buy(s, 20);
    // gold rate per 10 g: 5 g × 60000 / 10 = 30000; 20000 cash now, 10000 owed by the party
    const sold = await exchange.createExchange(s.ctx, exBody(s, { side: 'SELL', lines: [{ weight: 5, touch: 100 }], rate: 60000, cash: 20000 }));
    expect([sold.finalAmount, sold.balance]).toEqual(['30000.00', '10000.00']);
    expect(await net('EXCHANGE', sold.id)).toEqual({ gold: '-5.000', money: '20000.000', udharGold: '0.000', udharAmount: '10000.000' });
  });

  it('reverting a REFINE whose raval was already melted → 409, pools unchanged', async () => {
    const s = await setup();
    await buy(s, 10);
    const r = await kacha.processKacha(s.ctx, kachaProcessBody.parse({ type: 'REFINE', metal: 'GOLD', inFine: 10, outFine: 8, ravalFine: 1.5 }));
    await melt(s, 1.5);
    const before = await pools(s);
    await expect(kacha.revertKacha(s.ctx, r.id)).rejects.toMatchObject({ status: 409 });
    expect(await pools(s)).toEqual(before);
    expect((await db.kachaProcess.findUniqueOrThrow({ where: { id: r.id } })).reverted).toBe(false);
  });
});
