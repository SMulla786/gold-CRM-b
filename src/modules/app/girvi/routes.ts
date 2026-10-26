import { Router } from 'express';
import { requireMpin, requirePermission } from '../../../middleware/guards';
import {
  girviAsOfQuery,
  girviBody,
  girviInterestBody,
  girviListQuery,
  girviReleaseBody,
  girviTopupBody,
  girviTransferBody,
  girviTransferListQuery,
  girviTransferReturnBody,
  id as idSchema,
} from '../../../shared';
import * as girvi from './service';
import * as transfer from './transfer';

export const girviRouter = Router();
const ENTRY = 'girvi.entry';
const LEDGER = 'girvi.ledger';
const TRANSFER = 'girvi.transfer';

// Phase 9b — transfers (re-pledge to a lender); registered before /girvi/:id
girviRouter.get('/girvi/transfers', requirePermission(TRANSFER, 'view'), async (req, res) => res.json(await transfer.listTransfers(req.ctx!, girviTransferListQuery.parse(req.query))));
girviRouter.post('/girvi/transfers', requirePermission(TRANSFER, 'edit'), async (req, res) => res.status(201).json(await transfer.createTransfer(req.ctx!, girviTransferBody.parse(req.body))));
girviRouter.get('/girvi/transfers/:id', requirePermission(TRANSFER, 'view'), async (req, res) => res.json(await transfer.getTransfer(req.ctx!, idSchema.parse(req.params.id))));
girviRouter.post('/girvi/transfers/:id/return', requirePermission(TRANSFER, 'edit'), async (req, res) => res.json(await transfer.returnTransfer(req.ctx!, idSchema.parse(req.params.id), girviTransferReturnBody.parse(req.body))));

girviRouter.post('/girvi', requirePermission(ENTRY, 'edit'), async (req, res) => res.status(201).json(await girvi.createGirvi(req.ctx!, girviBody.parse(req.body))));
girviRouter.get('/girvi', requirePermission(LEDGER, 'view'), async (req, res) => res.json(await girvi.listGirvi(req.ctx!, girviListQuery.parse(req.query))));
girviRouter.get('/girvi/:id', requirePermission(LEDGER, 'view'), async (req, res) => res.json(await girvi.getGirvi(req.ctx!, idSchema.parse(req.params.id), girviAsOfQuery.parse(req.query).asOf ?? new Date())));
girviRouter.post('/girvi/:id/interest', requirePermission(ENTRY, 'edit'), async (req, res) => res.json(await girvi.payInterest(req.ctx!, idSchema.parse(req.params.id), girviInterestBody.parse(req.body))));
girviRouter.post('/girvi/:id/topup', requirePermission(ENTRY, 'edit'), async (req, res) => res.json(await girvi.topupGirvi(req.ctx!, idSchema.parse(req.params.id), girviTopupBody.parse(req.body))));
girviRouter.post('/girvi/:id/release', requirePermission(ENTRY, 'edit'), async (req, res) => res.json(await girvi.releaseGirvi(req.ctx!, idSchema.parse(req.params.id), girviReleaseBody.parse(req.body))));
girviRouter.delete('/girvi/:id', requirePermission(ENTRY, 'delete'), requireMpin, async (req, res) => {
  await girvi.deleteGirvi(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});
