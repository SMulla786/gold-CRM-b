import { Router } from 'express';
import { requireMpin, requirePermission } from '../../../middleware/guards';
import { id as idSchema, justBillBody, justBillListQuery } from '../../../shared';
import * as jb from './service';

export const justBillRouter = Router();
const PERM = 'billing.just_bill';

// next-no before /:id so the literal isn't captured as an id.
justBillRouter.get('/just-bills/next-no', requirePermission(PERM, 'view'), async (req, res) => res.json(await jb.nextJustBillNo(req.ctx!)));
justBillRouter.post('/just-bills', requirePermission(PERM, 'edit'), async (req, res) => res.status(201).json(await jb.createJustBill(req.ctx!, justBillBody.parse(req.body))));
justBillRouter.get('/just-bills', requirePermission(PERM, 'view'), async (req, res) => res.json(await jb.listJustBills(req.ctx!, justBillListQuery.parse(req.query))));
justBillRouter.get('/just-bills/:id', requirePermission(PERM, 'view'), async (req, res) => res.json(await jb.getJustBill(req.ctx!, idSchema.parse(req.params.id))));
justBillRouter.delete('/just-bills/:id', requirePermission(PERM, 'delete'), requireMpin, async (req, res) => {
  await jb.deleteJustBill(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});
