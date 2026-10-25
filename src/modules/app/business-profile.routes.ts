import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { scopedDb } from '../../lib/db';
import { HttpError } from '../../middleware/error';

export const businessProfileRouter = Router();

// Shop header for bill views/invoices — readable by ANY authenticated tenant user (no module/permission gate),
// since every billing/udhar screen shows it. Business is the tenant root, so it is read via raw prisma by ctx.businessId.
// The active branch's own GSTIN / state override the business ones (a branch can be registered in another state).
businessProfileRouter.get('/business-profile', async (req, res) => {
  const ctx = req.ctx!;
  if (ctx.businessId == null) throw new HttpError(404, 'NOT_FOUND', 'No business in context');
  const b = await prisma.business.findUnique({
    where: { id: ctx.businessId },
    select: { id: true, name: true, ownerName: true, countryCode: true, mobile: true, email: true, gstin: true, address: true, stateId: true, districtId: true, status: true },
  });
  if (!b) throw new HttpError(404, 'NOT_FOUND', 'Business not found');

  let gstin = b.gstin;
  let stateId = b.stateId;
  let districtId = b.districtId;
  if (ctx.activeBranchId != null) {
    const br = await scopedDb(ctx).branch.findUnique({ where: { id: ctx.activeBranchId }, select: { gstin: true, stateId: true, districtId: true } });
    if (br?.gstin) gstin = br.gstin;
    if (br?.stateId != null) {
      stateId = br.stateId;
      districtId = br.districtId;
    }
  }
  const state = stateId != null ? await prisma.state.findUnique({ where: { id: stateId }, select: { id: true, name: true } }) : null;
  res.json({ ...b, gstin, stateId, districtId, state });
});
