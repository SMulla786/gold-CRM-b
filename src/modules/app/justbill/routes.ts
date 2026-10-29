import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { HttpError } from '../../../middleware/error';
import { requireMpin, requirePermission } from '../../../middleware/guards';
import { id as idSchema, justBillBody, justBillListQuery } from '../../../shared';
import * as jb from './service';
import { justBillItemPhotoPath, saveJustBillItemPhoto } from '../uploads';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

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
// Line item photo (JPEG/PNG/WebP, magic-byte checked) — same pattern as girvi item photos; scoped via the item's just bill.
justBillRouter.post('/justbill/items/:itemId/photo', requirePermission(PERM, 'edit'), upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'VALIDATION', 'No file uploaded (field "file")');
  const itemId = idSchema.parse(req.params.itemId);
  await saveJustBillItemPhoto(req.ctx!, itemId, req.file.buffer);
  res.status(201).json({ url: `/api/app/justbill/items/${itemId}/photo` });
});
justBillRouter.get('/justbill/items/:itemId/photo', requirePermission(PERM, 'view'), async (req, res) => {
  const abs = await justBillItemPhotoPath(req.ctx!, idSchema.parse(req.params.itemId));
  res.type({ '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(abs)] ?? 'application/octet-stream').sendFile(abs);
});
