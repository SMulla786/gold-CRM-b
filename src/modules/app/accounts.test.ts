import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import * as acc from './accounts';
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
