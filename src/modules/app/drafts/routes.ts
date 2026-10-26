import { Router } from 'express';
import { requireMpin, requirePermission } from '../../../middleware/guards';
import { id as idSchema, salesDraftBody, draftDecisionBody, draftListQuery } from '../../../shared';
import * as drafts from './service';

export const draftsRouter = Router();
const DRAFTS = 'billing.showroom_drafts';
const APPROVALS = 'billing.draft_approvals';

draftsRouter.post('/drafts', requirePermission(DRAFTS, 'edit'), async (req, res) => res.status(201).json(await drafts.createDraft(req.ctx!, salesDraftBody.parse(req.body))));
draftsRouter.get('/drafts', requirePermission(DRAFTS, 'view'), async (req, res) => res.json(await drafts.listDrafts(req.ctx!, draftListQuery.parse(req.query))));
// by-no is matched before :id
draftsRouter.get('/drafts/by-no/:draftNo', requirePermission(DRAFTS, 'view'), async (req, res) => res.json(await drafts.getDraftByNo(req.ctx!, idSchema.parse(req.params.draftNo))));
draftsRouter.get('/drafts/:id', requirePermission(DRAFTS, 'view'), async (req, res) => res.json(await drafts.getDraft(req.ctx!, idSchema.parse(req.params.id))));
draftsRouter.post('/drafts/:id/decision', requirePermission(APPROVALS, 'edit'), async (req, res) => res.json(await drafts.decideDraft(req.ctx!, idSchema.parse(req.params.id), draftDecisionBody.parse(req.body))));
draftsRouter.post('/drafts/:id/cancel', requirePermission(DRAFTS, 'edit'), async (req, res) => res.json(await drafts.cancelDraft(req.ctx!, idSchema.parse(req.params.id))));
draftsRouter.delete('/drafts/:id', requirePermission(DRAFTS, 'delete'), requireMpin, async (req, res) => {
  await drafts.deleteDraft(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});
