import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../test/helpers/factory';
import { billBody, exchangeBody, LEDGER_ASSETS } from '../../shared';
import { businessDate } from '../../lib/ledger';
import * as acc from './accounts';
import * as billing from './billing/service';
import * as exchange from './trade/exchange';
import * as inv from './inventory';
import type { DayBookAllInOneRowDto } from '../../shared';
import type { TenantContext } from '../../middleware/context';

/** ACC-04: Day-Book All-in-One over real postings (bill + payments, exchange, income/expense, reversals) — the per-document
 *  rows add up to the ledger and to the Day-Book totals, the last running balance is the Day-Book closing, paging and the
 *  source filter don't change the numbers, and other tenants/branches never leak in. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'exchange', 'income_expense', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
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

const sell = (s: S) => billing.createBill(s.ctx, billBody.parse({
  kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 10, rate: 60000 }],
  payments: [{ mode: 'CASH', amount: 10000 }, { mode: 'ONLINE', amount: 5000, bankAccountId: s.bank.id }, { mode: 'METAL', metal: 'GOLD', metalForm: 'KACHA', gross: 2, tunch: 100, rate: 60000 }],
}));
const buy = (s: S, o: Record<string, unknown> = {}) =>
  exchange.createExchange(s.ctx, exchangeBody.parse({ partyId: s.party.id, metal: 'SILVER', side: 'BUY', lines: [{ weight: 500, touch: 90 }], rate: 80000, cash: 36000, ...o }));
const income = (s: S, o: Record<string, unknown> = {}) =>
  acc.createIncomeExpense(s.ctx, { type: 'INCOME', reason: 'Misc', cash: 700, online: 0, gold: 1.5, silver: 0, ...o } as never);

const all = async (s: S, q: { from?: Date; to?: Date; source?: DayBookAllInOneRowDto['source'] } = {}) => {
  const r = await acc.getDayBookAllInOne(s.ctx, { page: 1, pageSize: 500, ...q });
  expect(r.items).toHaveLength(r.total);
  return r.items;
};
const UNIT = { MONEY: 'amount', GOLD: 'fine', SILVER: 'fine', STONE: 'pcs', ARTIFICIAL: 'pcs', FRANCHISE: 'pcs' } as const;
/** Σ of every row's in/out per asset, as strings with trailing zeros dropped (Decimal.toString). */
const rowTotals = (rows: DayBookAllInOneRowDto[]) => Object.fromEntries(LEDGER_ASSETS.map((a) => [a, {
  in: rows.reduce((t, r) => t.plus(r.assets[a].in), new Prisma.Decimal(0)).toString(),
  out: rows.reduce((t, r) => t.plus(r.assets[a].out), new Prisma.Decimal(0)).toString(),
}]));
/** The same totals straight from this business's ledger rows. */
async function ledgerTotals(businessId: number, where: Prisma.LedgerEntryWhereInput = {}) {
  const rows = await db.ledgerEntry.findMany({ where: { businessId, ...where } });
  return Object.fromEntries(LEDGER_ASSETS.map((a) => {
    const of = (dir: 'IN' | 'OUT') => rows.filter((r) => r.asset === a && r.direction === dir).reduce((t, r) => t.plus(r[UNIT[a]] ?? 0), new Prisma.Decimal(0)).toString();
    return [a, { in: of('IN'), out: of('OUT') }];
  }));
}
const docKeys = (rows: DayBookAllInOneRowDto[]) => rows.map((r) => `${r.source}:${r.sourceId}`).sort();

describe('day-book all-in-one (ACC-04)', () => {
  it('real postings: rows add up to the ledger and to the Day-Book totals; newest balance = Day-Book closing', async () => {
    const s = await setup();
    await income(s, { txnDate: new Date('2020-01-01') }); // opening: 700 money, 1.5 g gold
    const bill = await sell(s);
    const ex = await buy(s);
    await income(s, { type: 'EXPENSE', reason: 'Tea', cash: 120, gold: 0 });

    const rows = await all(s);
    // a bill is one row per ledger sourceId: its own id (stock rows; none for a direct line) and one per payment
    const [p1, p2, p3] = bill.payments.map((p) => `SELL_BILL:${bill.id}-P${p.id}`);
    expect(docKeys(rows)).toEqual(expect.arrayContaining([p1, p2, p3, `EXCHANGE:${ex.id}`]));
    expect(rows).toHaveLength(5);
    const pay = (k: string) => rows.find((r) => `${r.source}:${r.sourceId}` === k)!;
    expect(pay(p1!).money).toMatchObject({ cashIn: '10000', bankIn: '0' });
    expect(pay(p2!).money).toMatchObject({ cashIn: '0', bankIn: '5000' });
    expect([pay(p3!).assets.GOLD.in, pay(p3!).metal?.GOLD.forms]).toEqual(['2', ['KACHA']]);
    expect(pay(`EXCHANGE:${ex.id}`)).toMatchObject({ party: { id: s.party.id, name: 'Cust' }, money: expect.objectContaining({ cashOut: '36000' }), assets: expect.objectContaining({ SILVER: { in: '450', out: '0' } }) });

    const today = rows[0]!.txnDate;
    const t = rowTotals(rows);
    expect(t).toEqual(await ledgerTotals(s.business.id, { txnDate: { gte: new Date(today) } }));
    const book = await acc.getDayBook(s.ctx, {});
    for (const a of book.totals) expect([a.asset, t[a.asset]!.in, t[a.asset]!.out]).toEqual([a.asset, String(a.in), String(a.out)]);
    const closing = Object.fromEntries(book.totals.map((a) => [a.asset, a.closing]));
    expect(rows[0]!.balance).toEqual({ MONEY: closing.MONEY, GOLD: closing.GOLD, SILVER: closing.SILVER });
    expect(rows[0]!.balance).toEqual({ MONEY: '-20420', GOLD: '3.5', SILVER: '450' }); // 700 + 15000 − 36000 − 120; 1.5 + 2; 450
  });

  it('a same-day delete folds into its document row (in = out); a past document reversed today shows on both days', async () => {
    const s = await setup();
    const past = new Date(Date.now() - 3 * 86400000);
    const today = await buy(s);
    const old = await buy(s, { txnDate: past });
    await exchange.deleteExchange(s.ctx, today.id);
    await exchange.deleteExchange(s.ctx, old.id);

    const rows = await all(s, { from: past });
    const ofEx = (id: number) => rows.filter((r) => r.source === 'EXCHANGE' && r.sourceId === String(id));
    expect(ofEx(today.id)).toHaveLength(1);
    expect(ofEx(today.id)[0]!.assets.MONEY).toEqual({ in: '36000', out: '36000' });
    expect(ofEx(old.id).map((r) => [r.txnDate, r.assets.SILVER])).toEqual([
      [rows[0]!.txnDate, { in: '0', out: '450' }], // reversal, today (newest first)
      [businessDate(past).toISOString().slice(0, 10), { in: '450', out: '0' }], // the IST business day, as booked (UTC differs 00:00–05:30 IST)
    ]);
    expect(rowTotals(rows)).toEqual(await ledgerTotals(s.business.id));
  });

  // regression: the running-balance sums used to stop at the page's OLDEST date, so newer documents on a multi-day page added nothing
  it('running balance across days: the newest row of a multi-day page carries every document', async () => {
    const s = await setup();
    await buy(s, { txnDate: new Date(Date.now() - 3 * 86400000) });
    await buy(s);
    const rows = await all(s, { from: new Date(Date.now() - 3 * 86400000) });
    expect(rows.map((r) => r.balance?.MONEY)).toEqual(['-72000', '-36000']); // today: ['-36000', '-36000']
  });

  it('paging and the source filter keep the numbers: pages concatenate to the full list; a filtered balance counts only that source', async () => {
    const s = await setup();
    await income(s, { txnDate: new Date('2020-01-01') });
    await sell(s);
    await buy(s);
    await buy(s);
    await income(s, { cash: 50, gold: 0 });

    const full = await all(s);
    const paged: DayBookAllInOneRowDto[] = [];
    for (let p = 1; p <= 4; p++) {
      const r = await acc.getDayBookAllInOne(s.ctx, { page: p, pageSize: 2 });
      expect(r.total).toBe(full.length);
      paged.push(...r.items);
    }
    expect(paged).toEqual(full);

    const ex = await all(s, { source: 'EXCHANGE' });
    expect(ex.map((r) => r.source)).toEqual(['EXCHANGE', 'EXCHANGE']);
    expect(ex[0]!.balance).toEqual({ MONEY: '-72000', GOLD: '0', SILVER: '900' }); // no income opening, no bill
    expect(rowTotals(ex)).toEqual(await ledgerTotals(s.business.id, { source: 'EXCHANGE' }));
  });

  it('tenant + branch isolation: another business and another branch of the same business never appear', async () => {
    const a = await setup('A');
    const b = await setup('B');
    await buy(a);
    await income(b);
    const branch2 = await createBranch({ businessId: a.business.id, parentId: a.root.id, name: 'B2', isAdminNode: false });
    const a2: S = { ...a, ctx: ctxFor(a.business.id, branch2.id) };
    await income(a2, { cash: 5, gold: 0 });

    expect((await all(a)).map((r) => r.source)).toEqual(['EXCHANGE']);
    expect((await all(b)).map((r) => r.assets.MONEY.in)).toEqual(['700']);
    expect((await all(a2)).map((r) => r.assets.MONEY.in)).toEqual(['5']);
    const both: S = { ...a, ctx: { ...a.ctx, activeBranchId: null, branchIds: [a.root.id, branch2.id] } };
    const rows = await all(both);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.balance?.MONEY).toBe('-35995'); // −36000 + 5, never B's 700
  });
});

describe('day-book all-in-one: bill link (G2b C2)', () => {
  it('a bill and its payments stay separate rows, each linked by billId; Σ MONEY over them = Σ payments (never the bill total); the bill row has MONEY 0', async () => {
    const s = await setup();
    const supplier = await db.party.create({ data: { businessId: s.business.id, type: 'SUPPLIER', name: 'Supp', mobile: '9000000003', countryCode: '+91' } });
    const [group] = await inv.createItemGroups(s.ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
    const name = await inv.createItemName(s.ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
    const bill = await billing.createBill(s.ctx, billBody.parse({
      kind: 'PURCHASE', billType: 'ROUGH', partyId: supplier.id, items: [{ itemNameId: name!.id, gross: 5, rate: 5000 }], // ₹25,000 final
      payments: [{ mode: 'CASH', amount: 4000 }, { mode: 'ONLINE', amount: 6000, bankAccountId: s.bank.id }],
    }));
    const ex = await buy(s);

    const rows = await all(s);
    const ofBill = rows.filter((r) => r.billId === bill.id);
    expect(ofBill.map((r) => r.sourceId).sort()).toEqual([String(bill.id), ...bill.payments.map((p) => `${bill.id}-P${p.id}`)].sort());
    const own = ofBill.find((r) => r.sourceId === String(bill.id))!;
    expect([own.assets.MONEY, own.assets.GOLD.in]).toEqual([{ in: '0', out: '0' }, '5']); // stock only, no money
    const moneyOut = ofBill.reduce((t, r) => t + Number(r.assets.MONEY.out), 0);
    expect([Number(bill.final), moneyOut]).toEqual([25000, 10000]); // payments, not the ₹25,000 total
    expect(ofBill.reduce((t, r) => t + Number(r.assets.MONEY.in), 0)).toBe(0);
    expect(rows.find((r) => r.sourceId === String(ex.id) && r.source === 'EXCHANGE')!.billId).toBeNull();
    expect(rowTotals(rows)).toEqual(await ledgerTotals(s.business.id));
  });
});

