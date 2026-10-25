import { Router } from 'express';
import { hasPermission, requireMpin, requirePermission } from '../../middleware/guards';
import { HttpError } from '../../middleware/error';
import { dayBookQuery, id as idSchema, incomeExpenseBody, incomeExpenseListQuery, ledgerQuery, moduleOf } from '../../shared';
import type { LedgerAsset } from '../../shared';
import type { TenantContext } from '../../middleware/context';
import * as acc from './accounts';

export const accountsRouter = Router();

const IE_ENTRY = 'income_expense.entry';
const IE_LIST = 'income_expense.list';
const DAYBOOK_PERM: Record<LedgerAsset, string> = { MONEY: 'daybook.money', GOLD: 'daybook.gold', SILVER: 'daybook.silver', STONE: 'daybook.stone', ARTIFICIAL: 'daybook.artificial', FRANCHISE: 'daybook.franchise' };

/** Per-asset daybook permission can't be a static middleware (asset comes from the query) — same checks as requirePermission. */
function assertPerm(ctx: TenantContext, pageKey: string): void {
  if (ctx.level !== 'SUPER_ADMIN' && !ctx.modules.includes(moduleOf(pageKey))) throw new HttpError(403, 'MODULE_DISABLED', 'Module not enabled in your plan');
  if (!hasPermission(ctx, pageKey, 'view')) throw new HttpError(403, 'FORBIDDEN', 'You do not have permission for this action');
}

// ───────────── Income / Expense ─────────────
accountsRouter.post('/income-expense', requirePermission(IE_ENTRY, 'edit'), async (req, res) => res.status(201).json(await acc.createIncomeExpense(req.ctx!, incomeExpenseBody.parse(req.body))));
accountsRouter.get('/income-expense', requirePermission(IE_LIST, 'view'), async (req, res) => res.json(await acc.listIncomeExpense(req.ctx!, incomeExpenseListQuery.parse(req.query))));
accountsRouter.patch('/income-expense/:id', requirePermission(IE_ENTRY, 'edit'), requireMpin, async (req, res) => res.json(await acc.updateIncomeExpense(req.ctx!, idSchema.parse(req.params.id), incomeExpenseBody.parse(req.body))));
accountsRouter.delete('/income-expense/:id', requirePermission(IE_ENTRY, 'delete'), requireMpin, async (req, res) => {
  await acc.deleteIncomeExpense(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});

// ───────────── Asset ledgers (perm by asset) + Day-Book ─────────────
accountsRouter.get('/ledgers', async (req, res) => {
  const q = ledgerQuery.parse(req.query);
  assertPerm(req.ctx!, DAYBOOK_PERM[q.asset]);
  res.json(await acc.getLedgerPage(req.ctx!, q));
});
accountsRouter.get('/day-book', requirePermission('daybook.all_in_one', 'view'), async (req, res) => res.json(await acc.getDayBook(req.ctx!, dayBookQuery.parse(req.query))));
