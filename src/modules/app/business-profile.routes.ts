import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../middleware/error';

export const businessProfileRouter = Router();

// Shop header for bill views/invoices — readable by ANY authenticated tenant user (no module/permission gate),
// since every billing/udhar screen shows it. Business is the tenant root, so it is read via raw prisma by ctx.businessId.
businessProfileRouter.get('/business-profile', async (req, res) => {
  const ctx = req.ctx!;
  if (ctx.businessId == null) throw new HttpError(404, 'NOT_FOUND', 'No business in context');
  const b = await prisma.business.findUnique({
    where: { id: ctx.businessId },
    select: { id: true, name: true, ownerName: true, countryCode: true, mobile: true, email: true, gstin: true, address: true, stateId: true, districtId: true, status: true },
  });
  if (!b) throw new HttpError(404, 'NOT_FOUND', 'Business not found');
  const state = b.stateId != null ? await prisma.state.findUnique({ where: { id: b.stateId }, select: { id: true, name: true } }) : null;
  res.json({ ...b, state });
});
