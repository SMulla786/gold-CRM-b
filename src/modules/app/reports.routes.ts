import { Router } from 'express';
import { requirePermission } from '../../middleware/guards';
import { activityQuery, gstFilingQuery, gstRangeQuery, gstRegisterQuery, gstSummaryQuery } from '../../shared';
import * as svc from './reports';

export const reportsRouter = Router();
const HOME = 'dashboard.home';
const GST = 'billing.gst_report';

reportsRouter.get('/dashboard', requirePermission(HOME, 'view'), async (req, res) => res.json(await svc.dashboard(req.ctx!)));
reportsRouter.get('/activity', requirePermission(HOME, 'view'), async (req, res) => res.json(await svc.activity(req.ctx!, activityQuery.parse(req.query))));
reportsRouter.get('/gst/register', requirePermission(GST, 'view'), async (req, res) => res.json(await svc.gstRegister(req.ctx!, gstRegisterQuery.parse(req.query))));
reportsRouter.get('/gst/hsn', requirePermission(GST, 'view'), async (req, res) => res.json(await svc.gstHsn(req.ctx!, gstRangeQuery.parse(req.query))));
reportsRouter.get('/gst/summary', requirePermission(GST, 'view'), async (req, res) => res.json(await svc.gstSummary(req.ctx!, gstSummaryQuery.parse(req.query))));
reportsRouter.get('/gst/gstr1', requirePermission(GST, 'view'), async (req, res) => res.json(await svc.gstr1(req.ctx!, gstFilingQuery.parse(req.query))));
reportsRouter.get('/gst/gstr3b', requirePermission(GST, 'view'), async (req, res) => res.json(await svc.gstr3b(req.ctx!, gstFilingQuery.parse(req.query))));
reportsRouter.get('/gst/gstr1.json', requirePermission(GST, 'view'), async (req, res) => {
  const json = await svc.gstr1Json(req.ctx!, gstFilingQuery.parse(req.query));
  res.setHeader('Content-Disposition', `attachment; filename="gstr1-${(json as { fp?: string }).fp ?? 'period'}.json"`);
  res.json(json);
});
