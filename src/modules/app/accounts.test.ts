import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import * as acc from './accounts';
import * as ledger from '../../lib/ledger';
import type { TenantContext } from '../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1,
  level: 'ADMIN',
  isOwner: true,
  businessId,
  scopeBranchId: branchId,
  branchIds: [branchId],
  activeBranchId: branchId,
  readOnly: false,
  modules: ['income_expense', 'daybook'],
  limits: null,
  permissions: {},
  impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

const ie = (over: Record<string, unknown>) => ({ type: 'INCOME' as const, reason: 'Misc', cash: 0, online: 0, gold: 0, silver: 0, ...over });

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '123456', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  return { business, root, ctx: ctxFor(business.id, root.id), bank };
}

describe('income/expense + asset ledgers', () => {
  it('create posts money + gold ledger rows, list returns the dto, money ledger carries a running balance', async () => {
    const s = await setup();
    const dto = await acc.createIncomeExpense(s.ctx, ie({ cash: 1000, online: 500, bankAccountId: s.bank.id, gold: 2, reason: 'Sale extra' }));
    expect(dto.bankAccount?.name).toBe('HDFC');

    const list = await acc.listIncomeExpense(s.ctx, { page: 1, pageSize: 20 });
    expect(list.total).toBe(1);
    expect(Number(list.items[0]!.cash)).toBe(1000);
    expect(Number(list.items[0]!.gold)).toBe(2);

    const money = await acc.getLedgerPage(s.ctx, { page: 1, pageSize: 20, asset: 'MONEY' });
    expect(Number(money.opening)).toBe(0);
    expect(money.total).toBe(2);
    expect(money.items.map((r) => Number(r.balance))).toEqual([1000, 1500]); // cash then online, running
    expect(money.items.every((r) => r.direction === 'IN')).toBe(true);

    const gold = await acc.getLedgerPage(s.ctx, { page: 1, pageSize: 20, asset: 'GOLD' });
    expect(gold.total).toBe(1);
    expect(Number(gold.items[0]!.balance)).toBe(2);
  });

  it('expense nets against income and the Day-Book totals reconcile', async () => {
    const s = await setup();
    await acc.createIncomeExpense(s.ctx, ie({ cash: 1000 }));
    await acc.createIncomeExpense(s.ctx, ie({ type: 'EXPENSE', cash: 300, reason: 'Tea' }));

    const money = await acc.getLedgerPage(s.ctx, { page: 1, pageSize: 20, asset: 'MONEY' });
    expect(money.items.map((r) => Number(r.balance))).toEqual([1000, 700]);

    const book = await acc.getDayBook(s.ctx, {});
    const m = book.totals.find((t) => t.asset === 'MONEY')!;
    expect(Number(m.opening)).toBe(0);
    expect(Number(m.in)).toBe(1000);
    expect(Number(m.out)).toBe(300);
    expect(Number(m.closing)).toBe(700);
  });

  it('Day-Book opening carries over balances from prior days', async () => {
    const s = await setup();
    await acc.createIncomeExpense(s.ctx, ie({ cash: 100, txnDate: new Date('2020-01-01') }));
    await acc.createIncomeExpense(s.ctx, ie({ cash: 50 }));

    const book = await acc.getDayBook(s.ctx, {}); // defaults to today
    const m = book.totals.find((t) => t.asset === 'MONEY')!;
    expect(Number(m.opening)).toBe(100);
    expect(Number(m.in)).toBe(50);
    expect(Number(m.closing)).toBe(150);
  });

  it('TASK-97 groupBy=DATE: one row per day, newest first, each opening = previous closing', async () => {
    const s = await setup();
    await acc.createIncomeExpense(s.ctx, ie({ cash: 100, txnDate: new Date('2020-01-01') }));
    await acc.createIncomeExpense(s.ctx, ie({ cash: 40, txnDate: new Date('2020-01-03') }));
    const book = await acc.getDayBook(s.ctx, { from: new Date('2020-01-02'), to: new Date('2020-01-03'), groupBy: 'DATE' });
    expect(book.days?.map((d) => d.date)).toEqual(['2020-01-03', '2020-01-02']);
    const money = (i: number) => book.days![i]!.totals.find((t) => t.asset === 'MONEY')!;
    expect(Number(money(1).opening)).toBe(100); // Jan 2: carried from Jan 1, quiet day
    expect(Number(money(1).closing)).toBe(100);
    expect(Number(money(0).opening)).toBe(100); // Jan 3 opens on Jan 2's closing
    expect(Number(money(0).in)).toBe(40);
    expect(Number(money(0).closing)).toBe(140);
    expect(book.days![0]!.status).toBe('OPEN');
    expect((await acc.getDayBook(s.ctx, {})).days).toBeUndefined(); // only on request
  });

  it('only today\'s entries can be edited; an edit reverses the old ledger rows', async () => {
    const s = await setup();
    // gold-only past entry: proves the today-guard without touching the MONEY ledger asserted below.
    const past = await acc.createIncomeExpense(s.ctx, ie({ gold: 5, txnDate: new Date('2020-01-01') }));
    await expect(acc.updateIncomeExpense(s.ctx, past.id, ie({ gold: 7 }))).rejects.toMatchObject({ status: 400 });

    const todays = await acc.createIncomeExpense(s.ctx, ie({ cash: 50, reason: 'Today' }));
    const updated = await acc.updateIncomeExpense(s.ctx, todays.id, ie({ cash: 777, reason: 'Fixed' }));
    expect(Number(updated.cash)).toBe(777);

    const money = await acc.getLedgerPage(s.ctx, { page: 1, pageSize: 50, asset: 'MONEY' });
    expect(money.items.some((r) => r.isReversal)).toBe(true); // the old 50 row was reversed
    expect(money.items.some((r) => r.reversed)).toBe(true);
    expect(Number(money.items.at(-1)!.balance)).toBe(777); // net balance after reverse + repost
  });
});

describe('TASK-81 income/expense daily summary + sourceType', () => {
  const autoRow = (businessId: number, branchId: number, over: Record<string, unknown>) =>
    db.ledgerEntry.create({ data: { businessId, branchId, txnDate: ledger.businessDate(), asset: 'MONEY', direction: 'IN', amount: 0, source: 'SELL_BILL', sourceId: '42', createdById: 1, ...over } });

  it('daily summary rolls up cash in/out, profit (money IN−OUT) and metal net for the day', async () => {
    const s = await setup();
    await acc.createIncomeExpense(s.ctx, ie({ cash: 1000, gold: 2 }));
    await acc.createIncomeExpense(s.ctx, ie({ type: 'EXPENSE', cash: 300, reason: 'Tea' }));
    const summary = await acc.incomeExpenseDailySummary(s.ctx, {});
    expect(summary).toHaveLength(1);
    expect(Number(summary[0]!.cashIn)).toBe(1000);
    expect(Number(summary[0]!.cashOut)).toBe(300);
    expect(Number(summary[0]!.profit)).toBe(700);
    expect(Number(summary[0]!.goldNet)).toBe(2);
    expect(Number(summary[0]!.goldIn)).toBe(2); // TASK-97 split in/out
    expect(Number(summary[0]!.goldOut)).toBe(0);
  });

  it('sourceType: DIRECT lists manual entries; an auto source lists per-document aggregates', async () => {
    const s = await setup();
    await acc.createIncomeExpense(s.ctx, ie({ cash: 1000, reason: 'Manual' }));
    await autoRow(s.business.id, s.root.id, { amount: 5000, sourceId: '42' }); // a sale bill posting money IN

    const direct = await acc.listIncomeExpense(s.ctx, { page: 1, pageSize: 20, sourceType: 'DIRECT' });
    expect(direct.total).toBe(1);
    expect(direct.items[0]!.reason).toBe('Manual');
    expect(direct.items[0]!.sourceType).toBe('DIRECT');

    // no sourceType = All sources: manual + auto rows, each tagged (TASK-97: used to silently mean DIRECT)
    const all = await acc.listIncomeExpense(s.ctx, { page: 1, pageSize: 20 });
    expect(all.total).toBe(2);
    expect(all.items.map((i) => i.sourceType).sort()).toEqual(['DIRECT', 'SELL_BILL']);
    expect((await acc.listIncomeExpense(s.ctx, { page: 1, pageSize: 20, q: 'manu' })).items.map((i) => i.reason)).toEqual(['Manual']);

    const sales = await acc.listIncomeExpense(s.ctx, { page: 1, pageSize: 20, sourceType: 'SELL_BILL' });
    expect(sales.total).toBe(1);
    expect(sales.items[0]!.id).toBe(42);
    expect(sales.items[0]!.type).toBe('INCOME');
    expect(Number(sales.items[0]!.cash)).toBe(5000);
  });

  it('summary filtered by sourceType counts only that source', async () => {
    const s = await setup();
    await acc.createIncomeExpense(s.ctx, ie({ cash: 1000 })); // INCOME_EXPENSE = DIRECT
    await autoRow(s.business.id, s.root.id, { amount: 5000, sourceId: '42' }); // SELL_BILL
    expect(Number((await acc.incomeExpenseDailySummary(s.ctx, { sourceType: 'SELL_BILL' }))[0]!.profit)).toBe(5000);
    expect(Number((await acc.incomeExpenseDailySummary(s.ctx, { sourceType: 'DIRECT' }))[0]!.profit)).toBe(1000);
  });
});

describe('TASK-90 day-book all-in-one', () => {
  it('one row per source document with each asset in/out side by side, plus party + narration', async () => {
    const s = await setup();
    const party = await db.party.create({ data: { businessId: s.business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000099' } });
    const today = ledger.businessDate();
    const row = (over: Record<string, unknown>) => db.ledgerEntry.create({ data: { businessId: s.business.id, branchId: s.root.id, txnDate: today, asset: 'MONEY', direction: 'IN', amount: 0, source: 'SELL_BILL', sourceId: '1', createdById: 1, ...over } });
    await row({ asset: 'MONEY', direction: 'IN', amount: 1000, partyId: party.id, narration: 'Sale #1' });
    await row({ asset: 'GOLD', direction: 'OUT', net: 5, fine: 5, partyId: party.id, narration: 'Sale #1' });
    await row({ source: 'PURCHASE_BILL', sourceId: '2', asset: 'MONEY', direction: 'OUT', amount: 300 });

    const res = await acc.getDayBookAllInOne(s.ctx, { page: 1, pageSize: 20 });
    expect(res.total).toBe(2);
    const sell = res.items.find((r) => r.source === 'SELL_BILL' && r.sourceId === '1')!;
    expect(Number(sell.assets.MONEY.in)).toBe(1000);
    expect(Number(sell.assets.MONEY.out)).toBe(0);
    expect(Number(sell.assets.GOLD.out)).toBe(5);
    expect(sell.party).toEqual({ id: party.id, name: 'Cust' });
    expect(sell.narration).toBe('Sale #1');
    const pur = res.items.find((r) => r.source === 'PURCHASE_BILL')!;
    expect(Number(pur.assets.MONEY.out)).toBe(300);
    expect(pur.party).toBeNull();
  });
});
