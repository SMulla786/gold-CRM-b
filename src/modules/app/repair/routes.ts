import { Router } from 'express';
import { requirePermission } from '../../../middleware/guards';
import { id as idSchema, repairBody, repairStatusBody, repairDeliverBody, repairListQuery } from '../../../shared';
import * as repair from './service';

export const repairRouter = Router();
const REPAIR = 'repair.entry';

repairRouter.post('/repairs', requirePermission(REPAIR, 'edit'), async (req, res) => res.status(201).json(await repair.createRepair(req.ctx!, repairBody.parse(req.body))));
repairRouter.get('/repairs', requirePermission(REPAIR, 'view'), async (req, res) => res.json(await repair.listRepairs(req.ctx!, repairListQuery.parse(req.query))));
repairRouter.get('/repairs/:id', requirePermission(REPAIR, 'view'), async (req, res) => res.json(await repair.getRepair(req.ctx!, idSchema.parse(req.params.id))));
repairRouter.post('/repairs/:id/status', requirePermission(REPAIR, 'edit'), async (req, res) => res.json(await repair.updateRepairStatus(req.ctx!, idSchema.parse(req.params.id), repairStatusBody.parse(req.body))));
repairRouter.post('/repairs/:id/deliver', requirePermission(REPAIR, 'edit'), async (req, res) => res.json(await repair.deliverRepair(req.ctx!, idSchema.parse(req.params.id), repairDeliverBody.parse(req.body))));
