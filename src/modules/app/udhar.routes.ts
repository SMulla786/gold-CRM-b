import { Router } from 'express';
import { requireMpin, requirePermission } from '../../middleware/guards';
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
udharRouter.get('/udhar/parties/:partyId/balance', requirePermission(LEDGER, 'view'), async (req, res) => res.json(await svc.partyBalance(req.ctx!, idSchema.parse(req.params.partyId))));
udharRouter.get('/udhar/parties/:partyId/statement', requirePermission(LEDGER, 'view'), async (req, res) => res.json(await svc.statement(req.ctx!, idSchema.parse(req.params.partyId), statementQuery.parse(req.query))));

udharRouter.get('/udhar/:id', requirePermission(LEDGER, 'view'), async (req, res) => res.json(await svc.getUdharTxn(req.ctx!, idSchema.parse(req.params.id))));
udharRouter.delete('/udhar/:id', requirePermission(ENTRY, 'delete'), requireMpin, async (req, res) => {
  await svc.deleteUdharTxn(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});
