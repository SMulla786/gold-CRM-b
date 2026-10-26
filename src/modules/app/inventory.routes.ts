import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { requireMpin, requirePermission } from '../../middleware/guards';
import { HttpError } from '../../middleware/error';
import { saveStockImage, stockImagePath } from './uploads';
import {
  bulkStockDeleteBody,
  bulkStockEditBody,
  id as idSchema,
  itemGroupBody,
  itemGroupListQuery,
  itemNameBody,
  itemNameListQuery,
  jewelleryTypeBody,
  shortageQuery,
  stockEntryBody,
  stockImportFields,
  stockListQuery,
  stockTransferBody,
  stockTransferListQuery,
  updateItemGroupBody,
  updateItemNameBody,
  updateStockItemBody,
} from '../../shared';
import type { StockClass } from '../../shared';
import * as inv from './inventory';

export const inventoryRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const MASTERS = 'inventory.item_masters';
const stockClassParam = (v: unknown): StockClass | undefined => (typeof v === 'string' ? (v as StockClass) : undefined);

// Masters
inventoryRouter.get('/jewellery-types', requirePermission(MASTERS, 'view'), async (req, res) => res.json(await inv.listJewelleryTypes(req.ctx!, stockClassParam(req.query.stockClass))));
inventoryRouter.post('/jewellery-types', requirePermission(MASTERS, 'edit'), async (req, res) => res.status(201).json(await inv.createJewelleryType(req.ctx!, jewelleryTypeBody.parse(req.body))));
inventoryRouter.get('/item-groups', requirePermission(MASTERS, 'view'), async (req, res) => res.json(await inv.listItemGroups(req.ctx!, itemGroupListQuery.parse(req.query))));
inventoryRouter.post('/item-groups', requirePermission(MASTERS, 'edit'), async (req, res) => res.status(201).json(await inv.createItemGroups(req.ctx!, itemGroupBody.parse(req.body))));
inventoryRouter.patch('/item-groups/:id', requirePermission(MASTERS, 'edit'), async (req, res) => res.json(await inv.updateItemGroup(req.ctx!, idSchema.parse(req.params.id), updateItemGroupBody.parse(req.body))));
inventoryRouter.get('/item-names', requirePermission(MASTERS, 'view'), async (req, res) => res.json(await inv.listItemNames(req.ctx!, itemNameListQuery.parse(req.query))));
inventoryRouter.post('/item-names', requirePermission(MASTERS, 'edit'), async (req, res) => res.status(201).json(await inv.createItemName(req.ctx!, itemNameBody.parse(req.body))));
inventoryRouter.patch('/item-names/:id', requirePermission(MASTERS, 'edit'), async (req, res) => res.json(await inv.updateItemName(req.ctx!, idSchema.parse(req.params.id), updateItemNameBody.parse(req.body))));

// Stock — specific paths before /stock/:id so they aren't captured as an id.
inventoryRouter.post('/stock/entries', requirePermission('inventory.new_stock', 'edit'), async (req, res) => res.status(201).json(await inv.createStockEntry(req.ctx!, stockEntryBody.parse(req.body))));
inventoryRouter.get('/stock/summary', requirePermission('inventory.all_stock', 'view'), async (req, res) => res.json(await inv.stockSummary(req.ctx!)));
inventoryRouter.get('/stock/groups', requirePermission('inventory.all_stock', 'view'), async (req, res) => res.json(await inv.stockGroups(req.ctx!, stockListQuery.parse(req.query))));
inventoryRouter.get('/stock/shortage', requirePermission('inventory.all_stock', 'view'), async (req, res) => res.json(await inv.shortage(req.ctx!, shortageQuery.parse(req.query))));
inventoryRouter.get('/stock/import/sample.csv', requirePermission('inventory.import_stock', 'view'), (_req, res) => res.type('text/csv').send(inv.sampleCsv()));
inventoryRouter.post('/stock/import', requirePermission('inventory.import_stock', 'edit'), upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'VALIDATION', 'No CSV file uploaded (field "file")');
  const fields = stockImportFields.parse(req.body);
  res.json(await inv.importStock(req.ctx!, req.file.buffer.toString('utf8'), { stockClass: fields.stockClass, method: fields.method, groupId: fields.groupId, dryRun: fields.dryRun === 'true' }));
});
// Phase 2b bulk + transfers — all before /stock/:id so the literal segments aren't captured as an id.
inventoryRouter.patch('/stock/bulk', requirePermission('inventory.all_stock', 'edit'), async (req, res) => {
  const b = bulkStockEditBody.parse(req.body);
  res.json(await inv.bulkEditStock(req.ctx!, b.ids, b.patch));
});
inventoryRouter.post('/stock/bulk-delete', requirePermission('inventory.all_stock', 'delete'), requireMpin, async (req, res) => res.json(await inv.bulkDeleteStock(req.ctx!, bulkStockDeleteBody.parse(req.body).ids)));
inventoryRouter.post('/stock/transfers', requirePermission('inventory.stock_transfer', 'edit'), async (req, res) => res.status(201).json(await inv.createStockTransfer(req.ctx!, stockTransferBody.parse(req.body))));
inventoryRouter.get('/stock/transfers', requirePermission('inventory.stock_transfer', 'view'), async (req, res) => res.json(await inv.listStockTransfers(req.ctx!, stockTransferListQuery.parse(req.query))));
inventoryRouter.get('/stock/transfers/:id', requirePermission('inventory.stock_transfer', 'view'), async (req, res) => res.json(await inv.getStockTransfer(req.ctx!, idSchema.parse(req.params.id))));
inventoryRouter.get('/stock/by-tag/:tagNo', requirePermission('inventory.all_stock', 'view'), async (req, res) => res.json(await inv.getStockByTag(req.ctx!, String(req.params.tagNo))));
inventoryRouter.get('/stock', requirePermission('inventory.all_stock', 'view'), async (req, res) => res.json(await inv.listStock(req.ctx!, stockListQuery.parse(req.query))));
inventoryRouter.get('/stock/:id', requirePermission('inventory.all_stock', 'view'), async (req, res) => res.json(await inv.getStock(req.ctx!, idSchema.parse(req.params.id))));
inventoryRouter.patch('/stock/:id', requirePermission('inventory.all_stock', 'edit'), async (req, res) => res.json(await inv.updateStock(req.ctx!, idSchema.parse(req.params.id), updateStockItemBody.parse(req.body))));
inventoryRouter.delete('/stock/:id', requirePermission('inventory.all_stock', 'delete'), requireMpin, async (req, res) => {
  await inv.deleteStock(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});

// Per-row stock image — magic-byte validated + scoped in uploads.ts; served via the files route.
const CONTENT_TYPE: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
inventoryRouter.post('/stock/:id/photo', requirePermission('inventory.all_stock', 'edit'), upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'VALIDATION', 'No file uploaded (field "file")');
  const id = idSchema.parse(req.params.id);
  const rel = await saveStockImage(req.ctx!, id, req.file.buffer);
  res.status(201).json({ url: `/api/app/files/stock/${id}/photo`, path: rel });
});
inventoryRouter.delete('/stock/:id/photo', requirePermission('inventory.all_stock', 'edit'), async (req, res) => {
  await inv.removeStockPhoto(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});
inventoryRouter.get('/files/stock/:id/photo', requirePermission('inventory.all_stock', 'view'), async (req, res) => {
  const abs = await stockImagePath(req.ctx!, idSchema.parse(req.params.id));
  res.type(CONTENT_TYPE[path.extname(abs)] ?? 'application/octet-stream').sendFile(abs);
});
