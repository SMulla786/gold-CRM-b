import path from 'node:path';
import { Router } from 'express';
import type { Request } from 'express';
import { HttpError } from '../../middleware/error';
import {
  approveSignupBody,
  assignSubscriptionBody,
  businessListQuery,
  createBusinessBody,
  id as idSchema,
  impersonateBody,
  pageQuery,
  planBody,
  recordPaymentBody,
  rejectSignupBody,
  reviewPaymentBody,
  signupListQuery,
  updateBusinessBody,
  updateSubscriptionBody,
} from '../../shared';
import * as svc from './service';
import { platformPaymentProofPath } from '../app/uploads';

export const platformRouter = Router();

const uid = (req: Request): number => {
  if (!req.ctx) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
  return req.ctx.userId;
};

platformRouter.get('/dashboard', async (_req, res) => res.json(await svc.dashboard()));

// Sign-ups
platformRouter.get('/signups', async (req, res) => res.json(await svc.listSignups(signupListQuery.parse(req.query))));
platformRouter.post('/signups/:id/approve', async (req, res) => res.status(201).json(await svc.approveSignup(uid(req), idSchema.parse(req.params.id), approveSignupBody.parse(req.body))));
platformRouter.post('/signups/:id/reject', async (req, res) => {
  await svc.rejectSignup(uid(req), idSchema.parse(req.params.id), rejectSignupBody.parse(req.body).reason);
  res.status(204).end();
});

// Businesses
platformRouter.get('/businesses', async (req, res) => res.json(await svc.listBusinesses(businessListQuery.parse(req.query))));
platformRouter.post('/businesses', async (req, res) => res.status(201).json(await svc.createBusiness(uid(req), createBusinessBody.parse(req.body))));
platformRouter.get('/businesses/:id', async (req, res) => res.json(await svc.businessDetail(idSchema.parse(req.params.id))));
platformRouter.patch('/businesses/:id', async (req, res) => res.json(await svc.updateBusiness(idSchema.parse(req.params.id), updateBusinessBody.parse(req.body))));
platformRouter.post('/businesses/:id/suspend', async (req, res) => {
  await svc.setBusinessStatus(idSchema.parse(req.params.id), 'SUSPENDED');
  res.status(204).end();
});
platformRouter.post('/businesses/:id/activate', async (req, res) => {
  await svc.setBusinessStatus(idSchema.parse(req.params.id), 'ACTIVE');
  res.status(204).end();
});

// Plans
platformRouter.get('/plans', async (_req, res) => res.json(await svc.listPlans()));
platformRouter.post('/plans', async (req, res) => res.status(201).json(await svc.createPlan(planBody.parse(req.body))));
platformRouter.patch('/plans/:id', async (req, res) => res.json(await svc.updatePlan(idSchema.parse(req.params.id), planBody.partial().parse(req.body))));

// Subscriptions
platformRouter.post('/businesses/:id/subscriptions', async (req, res) => res.status(201).json(await svc.assignSubscription(uid(req), idSchema.parse(req.params.id), assignSubscriptionBody.parse(req.body))));
platformRouter.patch('/subscriptions/:id', async (req, res) => res.json(await svc.updateSubscription(idSchema.parse(req.params.id), updateSubscriptionBody.parse(req.body))));

// Payments
platformRouter.get('/payments', async (req, res) => res.json(await svc.listPayments(pageQuery.parse(req.query))));
platformRouter.patch('/payments/:id', async (req, res) => {
  const { status, renew } = reviewPaymentBody.parse(req.body);
  res.json(await svc.reviewPayment(uid(req), idSchema.parse(req.params.id), status, renew));
});
platformRouter.get('/payments/:id/proof', async (req, res) => {
  const abs = await platformPaymentProofPath(idSchema.parse(req.params.id));
  res.type({ '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(abs)] ?? 'application/octet-stream').sendFile(abs);
});
platformRouter.post('/businesses/:id/payments', async (req, res) => res.status(201).json(await svc.recordPayment(idSchema.parse(req.params.id), recordPaymentBody.parse(req.body))));

// Impersonation
platformRouter.post('/businesses/:id/impersonate', async (req, res) => {
  const meta = { userAgent: req.headers['user-agent'] ?? null, ip: req.ip ?? null };
  res.status(201).json(await svc.impersonate(uid(req), idSchema.parse(req.params.id), impersonateBody.parse(req.body).reason, meta));
});
platformRouter.post('/impersonation/end', async (req, res) => {
  await svc.endImpersonation(uid(req));
  res.status(204).end();
});
