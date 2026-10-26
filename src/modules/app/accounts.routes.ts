import { Router } from 'express';
import { assertAnyPermission, requireMpin, requirePermission } from '../../middleware/guards';
import { dayBookAllInOneQuery, dayBookQuery, id as idSchema, incomeExpenseBody, incomeExpenseListQuery, ledgerQuery } from '../../shared';
import type { LedgerAsset } from '../../shared';
import * as acc from './accounts';

export const accountsRouter = Router();

const IE_ENTRY = 'income_expense.entry';
const IE_LIST = 'income_expense.list';
const DAYBOOK_PERM: Record<LedgerAsset, string> = { MONEY: 'daybook.money', GOLD: 'daybook.gold', SILVER: 'daybook.silver', STONE: 'daybook.stone', ARTIFICIAL: 'daybook.artificial', FRANCHISE: 'daybook.franchise' };

// ───────────── Income / Expense ─────────────
accountsRouter.post('/income-expense', requirePermission(IE_ENTRY, 'edit'), async (req, res) => res.status(201).json(await acc.createIncomeExpense(req.ctx!, incomeExpenseBody.parse(req.body))));
accountsRouter.get('/income-expense/summary', requirePermission(IE_LIST, 'view'), async (req, res) => res.json(await acc.incomeExpenseDailySummary(req.ctx!, incomeExpenseListQuery.parse(req.query))));
accountsRouter.get('/income-expense', requirePermission(IE_LIST, 'view'), async (req, res) => res.json(await acc.listIncomeExpense(req.ctx!, incomeExpenseListQuery.parse(req.query))));
accountsRouter.patch('/income-expense/:id', requirePermission(IE_ENTRY, 'edit'), requireMpin, async (req, res) => res.json(await acc.updateIncomeExpense(req.ctx!, idSchema.parse(req.params.id), incomeExpenseBody.parse(req.body))));
accountsRouter.delete('/income-expense/:id', requirePermission(IE_ENTRY, 'delete'), requireMpin, async (req, res) => {
  await acc.deleteIncomeExpense(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});

// ───────────── Asset ledgers (perm by asset) + Day-Book ─────────────
accountsRouter.get('/ledgers', async (req, res) => {
  const q = ledgerQuery.parse(req.query);
  // stock movement history (with stockItemId) is also readable by an inventory viewer; otherwise daybook.<asset> only
  const keys = q.stockItemId != null ? [DAYBOOK_PERM[q.asset], 'inventory.all_stock'] : [DAYBOOK_PERM[q.asset]];
  assertAnyPermission(req.ctx!, keys);
  res.json(await acc.getLedgerPage(req.ctx!, q));
});
accountsRouter.get('/day-book', requirePermission('daybook.all_in_one', 'view'), async (req, res) => res.json(await acc.getDayBook(req.ctx!, dayBookQuery.parse(req.query))));
accountsRouter.get('/day-book/all-in-one', requirePermission('daybook.all_in_one', 'view'), async (req, res) => res.json(await acc.getDayBookAllInOne(req.ctx!, dayBookAllInOneQuery.parse(req.query))));
