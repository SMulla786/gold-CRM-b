import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { assertMpin, requireMpin, requirePermission } from '../../middleware/guards';
import {
  HEADERS,
  bankAccountBody,
  hsnListQuery,
  hsnToggleBody,
  id as idSchema,
  karatBody,
  occasionsQuery,
  partyBody,
  partyListQuery,
  partySearchQuery,
  permissionEnquiryBody,
  putSettingBody,
  rateHistoryQuery,
  rateLimitsBody,
  setRatesBody,
  updateKaratBody,
  updatePartyBody,
} from '../../shared';
import type { Metal } from '../../shared';
import { HttpError } from '../../middleware/error';
import * as svc from './service';
import { invoiceImagePath, partyImagePath, savePartyImage, saveInvoiceImage } from './uploads';
import type { InvoiceImageField, PartyImageField } from './uploads';
import { inventoryRouter } from './inventory.routes';
import { daybookRouter } from './daybook/routes';
import { accountsRouter } from './accounts.routes';
import { udharRouter } from './udhar.routes';
import * as enquiry from '../admin/enquiry';
import { billingRouter } from './billing/routes';
import { reportsRouter } from './reports.routes';
import { businessProfileRouter } from './business-profile.routes';
import { openingRouter } from './opening.routes';
import { draftsRouter } from './drafts/routes';
import { justBillRouter } from './justbill/routes';
import { girviRouter } from './girvi/routes';
import { ordersRouter } from './orders/routes';
import { repairRouter } from './repair/routes';
import { tradeRouter } from './trade/routes';
import { schemesRouter } from './schemes/routes';
import { samplesRouter } from './samples/routes';

export const appRouter = Router();
appRouter.use(inventoryRouter);
appRouter.use(accountsRouter);
appRouter.use(daybookRouter);
appRouter.use(udharRouter);
appRouter.use(billingRouter);
appRouter.use(reportsRouter);
appRouter.use(businessProfileRouter);
appRouter.use(openingRouter);
appRouter.use(draftsRouter);
appRouter.use(justBillRouter);
appRouter.use(girviRouter);
appRouter.use(ordersRouter);
appRouter.use(repairRouter);
appRouter.use(tradeRouter);
appRouter.use(schemesRouter);
appRouter.use(samplesRouter);

const PARTIES = 'settings.parties';
const MISC = 'settings.misc';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// ───────────── Parties ─────────────
appRouter.get('/parties', requirePermission(PARTIES, 'view'), async (req, res) => res.json(await svc.listParties(req.ctx!, partyListQuery.parse(req.query))));
appRouter.get('/parties/search', requirePermission(PARTIES, 'view'), async (req, res) => res.json(await svc.searchParties(req.ctx!, partySearchQuery.parse(req.query))));
appRouter.get('/parties/occasions', requirePermission(PARTIES, 'view'), async (req, res) => res.json(await svc.listOccasions(req.ctx!, occasionsQuery.parse(req.query).days))); // TASK-89, before /parties/:id
appRouter.get('/parties/:id', requirePermission(PARTIES, 'view'), async (req, res) => res.json(await svc.getParty(req.ctx!, idSchema.parse(req.params.id))));
appRouter.post('/parties', requirePermission(PARTIES, 'edit'), async (req, res) => {
  const { dto, duplicateIds } = await svc.createParty(req.ctx!, partyBody.parse(req.body));
  if (duplicateIds.length) res.setHeader('X-Duplicate-Mobile', duplicateIds.join(','));
  res.status(201).json(dto);
});
appRouter.patch('/parties/:id', requirePermission(PARTIES, 'edit'), async (req, res) => res.json(await svc.updateParty(req.ctx!, idSchema.parse(req.params.id), updatePartyBody.parse(req.body))));
appRouter.delete('/parties/:id', requirePermission(PARTIES, 'delete'), async (req, res) => {
  await svc.deleteParty(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});
const FIELD: Record<'photo' | 'shop-logo', PartyImageField> = { photo: 'photoUrl', 'shop-logo': 'shopLogoUrl' };
const CONTENT_TYPE: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
for (const kind of ['photo', 'shop-logo'] as const) {
  appRouter.post(`/parties/:id/${kind}`, requirePermission(PARTIES, 'edit'), upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'VALIDATION', 'No file uploaded (field "file")');
    const rel = await savePartyImage(req.ctx!, idSchema.parse(req.params.id), FIELD[kind], req.file.buffer);
    res.status(201).json({ url: `/api/app/files/parties/${idSchema.parse(req.params.id)}/${kind}`, path: rel });
  });
  appRouter.get(`/files/parties/:id/${kind}`, requirePermission(PARTIES, 'view'), async (req, res) => {
    const abs = await partyImagePath(req.ctx!, idSchema.parse(req.params.id), FIELD[kind]);
    res.type(CONTENT_TYPE[path.extname(abs)] ?? 'application/octet-stream').sendFile(abs);
  });
}

// ───────────── Invoice media (TASK-84) ─────────────
// Upload = settings write (settings.misc edit + MPIN); GET serves branding to any signed-in app user (prints on every invoice).
const INVOICE_FIELD: Record<'logo' | 'signature' | 'watermark', InvoiceImageField> = { logo: 'logoUrl', signature: 'signatureUrl', watermark: 'watermarkUrl' };
for (const kind of ['logo', 'signature', 'watermark'] as const) {
  appRouter.post(`/settings/invoice/${kind}`, requirePermission(MISC, 'edit'), requireMpin, upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'VALIDATION', 'No file uploaded (field "file")');
    const rel = await saveInvoiceImage(req.ctx!, INVOICE_FIELD[kind], req.file.buffer);
    res.status(201).json({ url: `/api/app/files/invoice/${kind}`, path: rel });
  });
  // TASK-98 Remove: same guard as upload; nulls the invoice.media field, then deletes its file (uuid-named and referenced
  // only by this field — the same thing upload does to a replaced file). No file / no row → still 204.
  appRouter.delete(`/settings/invoice/${kind}`, requirePermission(MISC, 'edit'), requireMpin, async (req, res) => {
    const field = INVOICE_FIELD[kind];
    const abs = await invoiceImagePath(req.ctx!, field).catch(() => null); // traversal-guarded absolute path, null when unset
    const media = (await svc.getSettings(req.ctx!))['invoice.media'];
    await svc.putSetting(req.ctx!, 'invoice.media', undefined, { ...media, [field]: null });
    if (abs) await (await import('node:fs/promises')).rm(abs, { force: true }).catch(() => {});
    res.status(204).end();
  });
  appRouter.get(`/files/invoice/${kind}`, async (req, res) => {
    const abs = await invoiceImagePath(req.ctx!, INVOICE_FIELD[kind]);
    res.type(CONTENT_TYPE[path.extname(abs)] ?? 'application/octet-stream').sendFile(abs);
  });
}

// ───────────── Permission enquiries (staff side) ─────────────
// Any signed-in store user may request access; no requirePermission. requireWrite still gates POST on read-only subs.
appRouter.post('/permission-enquiries', async (req, res) => res.status(201).json(await enquiry.createEnquiry(req.ctx!, permissionEnquiryBody.parse(req.body))));
appRouter.get('/permission-enquiries/mine', async (req, res) => res.json(await enquiry.myEnquiries(req.ctx!)));

// ───────────── Bank accounts ─────────────
appRouter.get('/bank-accounts', requirePermission(MISC, 'view'), async (req, res) => res.json(await svc.listBankAccounts(req.ctx!, typeof req.query.applyTo === 'string' ? req.query.applyTo : undefined)));
appRouter.post('/bank-accounts', requirePermission(MISC, 'edit'), async (req, res) => res.status(201).json(await svc.createBankAccount(req.ctx!, bankAccountBody.parse(req.body))));
appRouter.patch('/bank-accounts/:id', requirePermission(MISC, 'edit'), async (req, res) => res.json(await svc.updateBankAccount(req.ctx!, idSchema.parse(req.params.id), bankAccountBody.partial().parse(req.body))));
appRouter.delete('/bank-accounts/:id', requirePermission(MISC, 'delete'), async (req, res) => {
  await svc.deleteBankAccount(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});

// ───────────── HSN ─────────────
appRouter.get('/hsn', requirePermission(MISC, 'view'), async (req, res) => res.json(await svc.listHsn(req.ctx!, hsnListQuery.parse(req.query))));
appRouter.put('/hsn/:id', requirePermission(MISC, 'edit'), async (req, res) => {
  await svc.toggleHsn(req.ctx!, idSchema.parse(req.params.id), hsnToggleBody.parse(req.body).active);
  res.status(204).end();
});

// ───────────── Karats ─────────────
appRouter.get('/karats', requirePermission(MISC, 'view'), async (req, res) => {
  const metal = typeof req.query.metal === 'string' ? (req.query.metal as Metal) : undefined;
  res.json(await svc.listKarats(req.ctx!, metal));
});
appRouter.post('/karats', requirePermission(MISC, 'edit'), async (req, res) => res.status(201).json(await svc.createKarat(req.ctx!, karatBody.parse(req.body))));
appRouter.patch('/karats/:id', requirePermission(MISC, 'edit'), requireMpin, async (req, res) => res.json(await svc.updateKarat(req.ctx!, idSchema.parse(req.params.id), updateKaratBody.parse(req.body))));
appRouter.delete('/karats/:id', requirePermission(MISC, 'delete'), requireMpin, async (req, res) => {
  await svc.deleteKarat(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});

// ───────────── Rates & limits ─────────────
// Current rates are readable by ANY authenticated tenant user (no module/permission gate) — the dashboard rate card and
// every billing/udhar screen show them, so cashiers/billing-only users must see them. setRates + rate limits stay gated (edit).
appRouter.get('/rates/current', async (req, res) => res.json(await svc.currentRates(req.ctx!)));
appRouter.post('/rates', requirePermission(MISC, 'edit'), async (req, res) => {
  const body = setRatesBody.parse(req.body);
  const offending = await svc.checkRateLimits(req.ctx!, body);
  if (offending.length) {
    if (!body.overrideLimits) throw new HttpError(400, 'VALIDATION', 'Rates outside allowed limits', { offending });
    await assertMpin(req.ctx!.userId, req.header(HEADERS.MPIN)); // override requires MPIN
  }
  res.json(await svc.setRates(req.ctx!, body));
});
appRouter.get('/rates/history', requirePermission(MISC, 'view'), async (req, res) => res.json(await svc.rateHistory(req.ctx!, rateHistoryQuery.parse(req.query))));
appRouter.get('/rate-limits', requirePermission(MISC, 'view'), async (req, res) => res.json(await svc.listRateLimits(req.ctx!)));
appRouter.put('/rate-limits', requirePermission(MISC, 'edit'), requireMpin, async (req, res) => res.json(await svc.putRateLimits(req.ctx!, rateLimitsBody.parse(req.body).limits)));

// ───────────── Settings ─────────────
appRouter.get('/settings', requirePermission(MISC, 'view'), async (req, res) => res.json(await svc.getSettings(req.ctx!)));
appRouter.put('/settings/:key', requirePermission(MISC, 'edit'), requireMpin, async (req, res) => {
  const body = putSettingBody.parse(req.body);
  res.json(await svc.putSetting(req.ctx!, String(req.params.key), body.branchId, body.value));
});
