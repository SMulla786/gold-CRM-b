import { Router } from 'express';
import { requireAnyPermission, requireMpin, requirePermission } from '../../middleware/guards';
import { id as idSchema, pendingBillsQuery, statementQuery, udharBody, udharEntryListQuery, udharLedgerQuery } from '../../shared';
import * as svc from './udhar';

export const udharRouter = Router();
const ENTRY = 'udhari.entry';
const LEDGER = 'udhari.ledger';

udharRouter.post('/udhar', requirePermission(ENTRY, 'edit'), async (req, res) => res.status(201).json(await svc.createUdharTxn(req.ctx!, udharBody.parse(req.body))));

// static/collection routes before '/udhar/:id' so it doesn't swallow them
udharRouter.get('/udhar/entries', requirePermission(LEDGER, 'view'), async (req, res) => res.json(await svc.listEntries(req.ctx!, udharEntryListQuery.parse(req.query))));
udharRouter.get('/udhar/ledger', requirePermission(LEDGER, 'view'), async (req, res) => res.json(await svc.listLedger(req.ctx!, udharLedgerQuery.parse(req.query))));
udharRouter.get('/udhar/pending-bills', requirePermission(LEDGER, 'view'), async (req, res) => res.json(await svc.pendingBills(req.ctx!, pendingBillsQuery.parse(req.query))));
// balance is shown on every transaction screen → any of udhar/billing view may read it
udharRouter.get('/udhar/parties/:partyId/balance', requireAnyPermission([LEDGER, ENTRY, 'billing.sell_bill', 'billing.purchase_bill']), async (req, res) => res.json(await svc.partyBalance(req.ctx!, idSchema.parse(req.params.partyId))));
udharRouter.get('/udhar/parties/:partyId/statement', requirePermission(LEDGER, 'view'), async (req, res) => res.json(await svc.statement(req.ctx!, idSchema.parse(req.params.partyId), statementQuery.parse(req.query))));

udharRouter.get('/udhar/:id', requirePermission(LEDGER, 'view'), async (req, res) => res.json(await svc.getUdharTxn(req.ctx!, idSchema.parse(req.params.id))));
// edit = reverse + re-post (same body as create), MPIN-gated like delete
udharRouter.put('/udhar/:id', requirePermission(ENTRY, 'edit'), requireMpin, async (req, res) => res.json(await svc.updateUdharTxn(req.ctx!, idSchema.parse(req.params.id), udharBody.parse(req.body))));
udharRouter.delete('/udhar/:id', requirePermission(ENTRY, 'delete'), requireMpin, async (req, res) => {
  await svc.deleteUdharTxn(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});
