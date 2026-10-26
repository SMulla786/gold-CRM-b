import path from 'node:path';
import { Router } from 'express';
import { requirePermission } from '../../../middleware/guards';
import { HttpError } from '../../../middleware/error';
import {
  id as idSchema,
  repairBody,
  repairStatusBody,
  repairDeliverBody,
  repairListQuery,
  repairConsumableBody,
  updateRepairConsumableBody,
  repairConsumableAdjustBody,
} from '../../../shared';
import * as repair from './service';
import { CONTENT_TYPE, upload } from '../orders/files';

export const repairRouter = Router();
const REPAIR = 'repair.entry';

repairRouter.post('/repairs', requirePermission(REPAIR, 'edit'), async (req, res) => res.status(201).json(await repair.createRepair(req.ctx!, repairBody.parse(req.body))));
repairRouter.get('/repairs', requirePermission(REPAIR, 'view'), async (req, res) => res.json(await repair.listRepairs(req.ctx!, repairListQuery.parse(req.query))));
repairRouter.get('/repairs/:id', requirePermission(REPAIR, 'view'), async (req, res) => res.json(await repair.getRepair(req.ctx!, idSchema.parse(req.params.id))));
repairRouter.post('/repairs/:id/status', requirePermission(REPAIR, 'edit'), async (req, res) => res.json(await repair.updateRepairStatus(req.ctx!, idSchema.parse(req.params.id), repairStatusBody.parse(req.body))));
repairRouter.post('/repairs/:id/deliver', requirePermission(REPAIR, 'edit'), async (req, res) => res.json(await repair.deliverRepair(req.ctx!, idSchema.parse(req.params.id), repairDeliverBody.parse(req.body))));

// TASK-97 photo (JPEG/PNG/WebP, magic-byte checked, 2 MB) — multipart field "photo"
repairRouter.post('/repairs/:id/photo', requirePermission(REPAIR, 'edit'), upload.single('photo'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'VALIDATION', 'No file uploaded (field "photo")');
  const id = idSchema.parse(req.params.id);
  await repair.saveRepairPhoto(req.ctx!, id, req.file.buffer);
  res.status(201).json({ url: `/api/app/repairs/${id}/photo` });
});
repairRouter.get('/repairs/:id/photo', requirePermission(REPAIR, 'view'), async (req, res) => {
  const abs = await repair.repairPhotoPath(req.ctx!, idSchema.parse(req.params.id));
  res.type(CONTENT_TYPE[path.extname(abs)] ?? 'application/octet-stream').sendFile(abs);
});

// TASK-97 consumables
repairRouter.get('/repair/consumables', requirePermission(REPAIR, 'view'), async (req, res) => res.json(await repair.listConsumables(req.ctx!)));
repairRouter.post('/repair/consumables', requirePermission(REPAIR, 'edit'), async (req, res) => res.status(201).json(await repair.createConsumable(req.ctx!, repairConsumableBody.parse(req.body))));
repairRouter.patch('/repair/consumables/:id', requirePermission(REPAIR, 'edit'), async (req, res) => res.json(await repair.updateConsumable(req.ctx!, idSchema.parse(req.params.id), updateRepairConsumableBody.parse(req.body))));
repairRouter.post('/repair/consumables/:id/adjust', requirePermission(REPAIR, 'edit'), async (req, res) => res.json(await repair.adjustConsumable(req.ctx!, idSchema.parse(req.params.id), repairConsumableAdjustBody.parse(req.body))));
