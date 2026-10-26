import { Router } from 'express';
import { requirePermission } from '../../../middleware/guards';
import { id as idSchema, sampleBody, sampleIssueBody, sampleListQuery, sampleNoteBody, sampleSearchQuery, updateSampleBody } from '../../../shared';
import * as samples from './service';

/** TASK-98 Samples / Tounch register (custody only, no ledger). Permission: catalog key 'inventory.samples' (view = reads, edit = create/edit/issue/return/melt). */
export const samplesRouter = Router();
const PERM = 'inventory.samples';

// literal paths before /samples/:id
samplesRouter.get('/samples/search', requirePermission(PERM, 'view'), async (req, res) => res.json(await samples.searchSamples(req.ctx!, sampleSearchQuery.parse(req.query))));
samplesRouter.get('/samples', requirePermission(PERM, 'view'), async (req, res) => res.json(await samples.listSamples(req.ctx!, sampleListQuery.parse(req.query))));
samplesRouter.post('/samples', requirePermission(PERM, 'edit'), async (req, res) => res.status(201).json(await samples.createSample(req.ctx!, sampleBody.parse(req.body))));
samplesRouter.get('/samples/:id', requirePermission(PERM, 'view'), async (req, res) => res.json(await samples.getSample(req.ctx!, idSchema.parse(req.params.id))));
samplesRouter.patch('/samples/:id', requirePermission(PERM, 'edit'), async (req, res) => res.json(await samples.updateSample(req.ctx!, idSchema.parse(req.params.id), updateSampleBody.parse(req.body))));
samplesRouter.post('/samples/:id/issue', requirePermission(PERM, 'edit'), async (req, res) => res.json(await samples.issueSample(req.ctx!, idSchema.parse(req.params.id), sampleIssueBody.parse(req.body ?? {}))));
samplesRouter.post('/samples/:id/return', requirePermission(PERM, 'edit'), async (req, res) => res.json(await samples.returnSample(req.ctx!, idSchema.parse(req.params.id), sampleNoteBody.parse(req.body ?? {}))));
samplesRouter.post('/samples/:id/melt', requirePermission(PERM, 'edit'), async (req, res) => res.json(await samples.meltSample(req.ctx!, idSchema.parse(req.params.id), sampleNoteBody.parse(req.body ?? {}))));
