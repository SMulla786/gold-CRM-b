import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { HttpError } from '../../../middleware/error';
import { requireMpin, requirePermission } from '../../../middleware/guards';
import {
  girviAsOfQuery,
  girviBody,
  girviImportFields,
  girviInterestBody,
  girviItemReplaceBody,
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
import { girviImportSampleCsv, importGirvi } from './import';
import { girviDocPath, girviItemPhotoPath, saveGirviDoc, saveGirviItemPhoto } from '../uploads';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // scanned PDFs run larger than photos

export const girviRouter = Router();
const ENTRY = 'girvi.entry';
const LEDGER = 'girvi.ledger';
const TRANSFER = 'girvi.transfer';

// Phase 9b — bulk import (dryRun=true validates only; a real run imports only when every loan is valid)
girviRouter.get('/girvi/import/sample.csv', requirePermission(ENTRY, 'view'), (_req, res) => res.type('text/csv').send(girviImportSampleCsv()));
girviRouter.post('/girvi/import', requirePermission(ENTRY, 'edit'), upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'VALIDATION', 'No CSV file uploaded (field "file")');
  const f = girviImportFields.parse(req.body);
  res.json(await importGirvi(req.ctx!, req.file.buffer.toString('utf8'), { dryRun: f.dryRun === 'true', bankAccountId: f.bankAccountId }));
});
// Item photo (JPEG/PNG/WebP, magic-byte checked)
girviRouter.post('/girvi/items/:itemId/photo', requirePermission(ENTRY, 'edit'), upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'VALIDATION', 'No file uploaded (field "file")');
  const itemId = idSchema.parse(req.params.itemId);
  await saveGirviItemPhoto(req.ctx!, itemId, req.file.buffer);
  res.status(201).json({ url: `/api/app/girvi/items/${itemId}/photo` });
});
girviRouter.get('/girvi/items/:itemId/photo', requirePermission(LEDGER, 'view'), async (req, res) => {
  const abs = await girviItemPhotoPath(req.ctx!, idSchema.parse(req.params.itemId));
  res.type({ '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(abs)] ?? 'application/octet-stream').sendFile(abs);
});
// Customer document on the loan (JPEG/PNG/WebP or PDF, magic-byte checked)
girviRouter.post('/girvi/:id/doc', requirePermission(ENTRY, 'edit'), docUpload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'VALIDATION', 'No file uploaded (field "file")');
  const id = idSchema.parse(req.params.id);
  await saveGirviDoc(req.ctx!, id, req.file.buffer);
  res.status(201).json({ url: `/api/app/girvi/${id}/doc` });
});
girviRouter.get('/girvi/:id/doc', requirePermission(LEDGER, 'view'), async (req, res) => {
  const abs = await girviDocPath(req.ctx!, idSchema.parse(req.params.id));
  res.type({ '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' }[path.extname(abs)] ?? 'application/octet-stream').sendFile(abs);
});
girviRouter.patch('/girvi/:id/items/:itemId', requirePermission(ENTRY, 'edit'), requireMpin, async (req, res) =>
  res.json(await girvi.replaceGirviItem(req.ctx!, idSchema.parse(req.params.id), idSchema.parse(req.params.itemId), girviItemReplaceBody.parse(req.body))),
);
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
