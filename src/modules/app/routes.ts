import { Router } from 'express';
import { assertMpin, requireMpin, requirePermission } from '../../middleware/guards';
import {
  HEADERS,
  bankAccountBody,
  hsnListQuery,
  hsnToggleBody,
  id as idSchema,
  karatBody,
  partyBody,
  partyListQuery,
  partySearchQuery,
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

export const appRouter = Router();

const PARTIES = 'settings.parties';
const MISC = 'settings.misc';

// ───────────── Parties ─────────────
appRouter.get('/parties', requirePermission(PARTIES, 'view'), async (req, res) => res.json(await svc.listParties(req.ctx!, partyListQuery.parse(req.query))));
appRouter.get('/parties/search', requirePermission(PARTIES, 'view'), async (req, res) => res.json(await svc.searchParties(req.ctx!, partySearchQuery.parse(req.query))));
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
for (const p of ['/parties/:id/photo', '/parties/:id/shop-logo']) {
  appRouter.post(p, requirePermission(PARTIES, 'edit'), (_req, res) => {
    // shortcut: file upload needs multer (dependency add = lead's package.json); stubbed until then.
    res.status(501).json({ error: { code: 'INTERNAL', message: 'File upload not yet enabled (needs multer)' } });
  });
}

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
appRouter.get('/rates/current', requirePermission(MISC, 'view'), async (req, res) => res.json(await svc.currentRates(req.ctx!)));
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
