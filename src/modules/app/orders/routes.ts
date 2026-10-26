import path from 'node:path';
import { Router } from 'express';
import { requireAnyPermission, requireMpin, requirePermission } from '../../../middleware/guards';
import { HttpError } from '../../../middleware/error';
import { id as idSchema, orderBody, addOrderAdvanceBody, orderListQuery, karigarIssueBody, karigarReceiveBody, karigarIssueListQuery } from '../../../shared';
import * as orders from './service';
import { CONTENT_TYPE, upload } from './files';

export const ordersRouter = Router();
const CREATE = 'orders.create';
const LIST = 'orders.list';
const KARIGAR = 'orders.karigar_list';
const BILLING = 'orders.billing';

ordersRouter.post('/orders', requirePermission(CREATE, 'edit'), async (req, res) => res.status(201).json(await orders.createOrder(req.ctx!, orderBody.parse(req.body))));
ordersRouter.get('/orders', requireAnyPermission([LIST, BILLING], 'view'), async (req, res) => res.json(await orders.listOrders(req.ctx!, orderListQuery.parse(req.query))));
ordersRouter.get('/orders/:id', requirePermission(LIST, 'view'), async (req, res) => res.json(await orders.getOrder(req.ctx!, idSchema.parse(req.params.id))));
ordersRouter.post('/orders/:id/advance', requirePermission(CREATE, 'edit'), async (req, res) => res.json(await orders.addOrderAdvance(req.ctx!, idSchema.parse(req.params.id), addOrderAdvanceBody.parse(req.body).payments)));
ordersRouter.post('/orders/:id/cancel', requirePermission(CREATE, 'delete'), requireMpin, async (req, res) => {
  await orders.cancelOrder(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});
// TASK-97 design file (JPEG/PNG/WebP/PDF, magic-byte checked, 2 MB)
ordersRouter.post('/orders/:id/design', requirePermission(CREATE, 'edit'), upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'VALIDATION', 'No file uploaded (field "file")');
  const id = idSchema.parse(req.params.id);
  await orders.saveOrderDesign(req.ctx!, id, req.file.buffer);
  res.status(201).json({ url: `/api/app/orders/${id}/design` });
});
ordersRouter.get('/orders/:id/design', requirePermission(LIST, 'view'), async (req, res) => {
  const abs = await orders.orderDesignPath(req.ctx!, idSchema.parse(req.params.id));
  res.type(CONTENT_TYPE[path.extname(abs)] ?? 'application/octet-stream').sendFile(abs);
});
ordersRouter.delete('/orders/:id/design', requirePermission(CREATE, 'edit'), async (req, res) => {
  await orders.removeOrderDesign(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});

ordersRouter.post('/karigar-issues', requirePermission(KARIGAR, 'edit'), async (req, res) => res.status(201).json(await orders.createKarigarIssue(req.ctx!, karigarIssueBody.parse(req.body))));
ordersRouter.get('/karigar-issues', requirePermission(KARIGAR, 'view'), async (req, res) => res.json(await orders.listKarigarIssues(req.ctx!, karigarIssueListQuery.parse(req.query))));
ordersRouter.get('/karigar-issues/:id', requirePermission(KARIGAR, 'view'), async (req, res) => res.json(await orders.getKarigarIssue(req.ctx!, idSchema.parse(req.params.id))));
ordersRouter.post('/karigar-issues/:id/receive', requirePermission(KARIGAR, 'edit'), async (req, res) => res.json(await orders.receiveKarigar(req.ctx!, idSchema.parse(req.params.id), karigarReceiveBody.parse(req.body))));
