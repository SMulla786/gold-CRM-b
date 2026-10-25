import { Router } from 'express';
import { requirePermission } from '../../middleware/guards';
import { activityQuery, gstRangeQuery, gstRegisterQuery, gstSummaryQuery } from '../../shared';
import * as svc from './reports';

export const reportsRouter = Router();
const HOME = 'dashboard.home';
const GST = 'billing.gst_report';

reportsRouter.get('/dashboard', requirePermission(HOME, 'view'), async (req, res) => res.json(await svc.dashboard(req.ctx!)));
reportsRouter.get('/activity', requirePermission(HOME, 'view'), async (req, res) => res.json(await svc.activity(req.ctx!, activityQuery.parse(req.query))));
reportsRouter.get('/gst/register', requirePermission(GST, 'view'), async (req, res) => res.json(await svc.gstRegister(req.ctx!, gstRegisterQuery.parse(req.query))));
reportsRouter.get('/gst/hsn', requirePermission(GST, 'view'), async (req, res) => res.json(await svc.gstHsn(req.ctx!, gstRangeQuery.parse(req.query))));
reportsRouter.get('/gst/summary', requirePermission(GST, 'view'), async (req, res) => res.json(await svc.gstSummary(req.ctx!, gstSummaryQuery.parse(req.query))));
