import { Router } from 'express';
import { hasPermission, requireMpin } from '../../../middleware/guards';
import { HttpError } from '../../../middleware/error';
import { addBillPaymentsBody, billBody, billListQuery, deleteBillQuery, editBillBody, id as idSchema, nextBillNoQuery } from '../../../shared';
import type { BillKind } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import * as billing from './service';

export const billingRouter = Router();

const permKey = (kind: BillKind): string => (kind === 'SELL' ? 'billing.sell_bill' : 'billing.purchase_bill');

/** Per-kind permission (SELL vs PURCHASE) can't be a static middleware — same checks as requirePermission. */
function assertPerm(ctx: TenantContext, kind: BillKind, action: 'view' | 'edit' | 'delete'): void {
  if (ctx.level !== 'SUPER_ADMIN' && !ctx.modules.includes('billing')) throw new HttpError(403, 'MODULE_DISABLED', 'Module not enabled in your plan');
  if (!hasPermission(ctx, permKey(kind), action)) throw new HttpError(403, 'FORBIDDEN', 'You do not have permission for this action');
}

// next-no must be registered before /bills/:id so the literal segment isn't captured as an id.
billingRouter.get('/bills/next-no', async (req, res) => {
  const q = nextBillNoQuery.parse(req.query);
  assertPerm(req.ctx!, q.kind, 'view');
  res.json(await billing.nextBillNo(req.ctx!, q));
});

billingRouter.post('/bills', async (req, res) => {
  const body = billBody.parse(req.body);
  assertPerm(req.ctx!, body.kind, 'edit');
  res.status(201).json(await billing.createBill(req.ctx!, body));
});

billingRouter.get('/bills', async (req, res) => {
  const q = billListQuery.parse(req.query);
  assertPerm(req.ctx!, q.kind, 'view');
  res.json(await billing.listBills(req.ctx!, q));
});

billingRouter.get('/bills/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  assertPerm(req.ctx!, await billing.billKind(req.ctx!, id), 'view');
  res.json(await billing.getBill(req.ctx!, id));
});

billingRouter.patch('/bills/:id', requireMpin, async (req, res) => {
  const id = idSchema.parse(req.params.id);
  assertPerm(req.ctx!, await billing.billKind(req.ctx!, id), 'edit');
  res.json(await billing.editBill(req.ctx!, id, editBillBody.parse(req.body)));
});

billingRouter.post('/bills/:id/payments', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  assertPerm(req.ctx!, await billing.billKind(req.ctx!, id), 'edit');
  res.json(await billing.addBillPayments(req.ctx!, id, addBillPaymentsBody.parse(req.body)));
});

billingRouter.delete('/bills/:id', requireMpin, async (req, res) => {
  const id = idSchema.parse(req.params.id);
  assertPerm(req.ctx!, await billing.billKind(req.ctx!, id), 'delete');
  await billing.deleteBill(req.ctx!, id, deleteBillQuery.parse(req.query).returnStock === 'true');
  res.status(204).end();
});
