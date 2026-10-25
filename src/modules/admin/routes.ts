import { Router } from 'express';
import { HttpError } from '../../middleware/error';
import {
  branchBody,
  counterBody,
  createUserBody,
  enquiryListQuery,
  enquiryRejectBody,
  id as idSchema,
  moveBranchBody,
  permissionsBody,
  recordPaymentBody,
  resetUserPasswordBody,
  roleBody,
  updateBranchBody,
  updateBusinessBody,
  updateUserBody,
  userListQuery,
} from '../../shared';
import * as svc from './service';
import { adminOverview } from './overview';
import * as enquiry from './enquiry';

export const adminRouter = Router();

// Read-only mode blocks writes to tenant data, but the owner must still be able to pay to restore service.
adminRouter.use((req, _res, next) => {
  if (req.method !== 'GET' && req.ctx?.readOnly && !req.path.startsWith('/subscription')) {
    throw new HttpError(403, 'READ_ONLY', 'Subscription inactive — read-only mode');
  }
  next();
});

const ownerOnly = (req: { ctx?: { isOwner: boolean } }): void => {
  if (!req.ctx?.isOwner) throw new HttpError(403, 'FORBIDDEN', 'Owner only');
};

// Consolidated per-branch + business overview across the caller's accessible subtree (read-only).
adminRouter.get('/overview', async (req, res) => res.json(await adminOverview(req.ctx!)));

// Branches
adminRouter.get('/branches', async (req, res) => res.json(await svc.getBranchTree(req.ctx!)));
adminRouter.post('/branches', async (req, res) => res.status(201).json(await svc.createBranch(req.ctx!, branchBody.parse(req.body))));
adminRouter.patch('/branches/:id', async (req, res) => res.json(await svc.updateBranch(req.ctx!, idSchema.parse(req.params.id), updateBranchBody.parse(req.body))));
adminRouter.post('/branches/:id/move', async (req, res) => {
  await svc.moveBranch(req.ctx!, idSchema.parse(req.params.id), moveBranchBody.parse(req.body).newParentId);
  res.status(204).end();
});

// Counters
adminRouter.get('/counters', async (req, res) => {
  const branchId = req.query.branchId != null ? idSchema.parse(req.query.branchId) : undefined;
  res.json(await svc.listCounters(req.ctx!, branchId));
});
adminRouter.post('/counters', async (req, res) => res.status(201).json(await svc.createCounter(req.ctx!, counterBody.parse(req.body))));
adminRouter.patch('/counters/:id', async (req, res) => res.json(await svc.updateCounter(req.ctx!, idSchema.parse(req.params.id), counterBody.pick({ name: true }).parse(req.body))));

// Users
adminRouter.get('/users', async (req, res) => res.json(await svc.listUsers(req.ctx!, userListQuery.parse(req.query))));
adminRouter.get('/users/:id', async (req, res) => res.json(await svc.getUser(req.ctx!, idSchema.parse(req.params.id))));
adminRouter.post('/users', async (req, res) => res.status(201).json(await svc.createUser(req.ctx!, createUserBody.parse(req.body))));
adminRouter.patch('/users/:id', async (req, res) => res.json(await svc.updateUser(req.ctx!, idSchema.parse(req.params.id), updateUserBody.parse(req.body))));
adminRouter.post('/users/:id/block', async (req, res) => {
  await svc.setUserStatus(req.ctx!, idSchema.parse(req.params.id), 'BLOCKED');
  res.status(204).end();
});
adminRouter.post('/users/:id/unblock', async (req, res) => {
  await svc.setUserStatus(req.ctx!, idSchema.parse(req.params.id), 'ACTIVE');
  res.status(204).end();
});
adminRouter.post('/users/:id/reset-password', async (req, res) => {
  await svc.resetUserPassword(req.ctx!, idSchema.parse(req.params.id), resetUserPasswordBody.parse(req.body).password);
  res.status(204).end();
});

// Permissions & roles
adminRouter.get('/permissions', (_req, res) => res.json(svc.permissionCatalog()));
adminRouter.get('/users/:id/permissions', async (req, res) => res.json(await svc.getUserPermissions(req.ctx!, idSchema.parse(req.params.id))));
adminRouter.put('/users/:id/permissions', async (req, res) => res.json(await svc.putUserPermissions(req.ctx!, idSchema.parse(req.params.id), permissionsBody.parse(req.body).grants)));
// TASK-87 permission enquiries (manager side): list + approve (merge grant) / reject, requester-branch-scoped in the service.
adminRouter.get('/permission-enquiries', async (req, res) => res.json(await enquiry.listEnquiries(req.ctx!, enquiryListQuery.parse(req.query))));
adminRouter.post('/permission-enquiries/:id/approve', async (req, res) => res.json(await enquiry.approveEnquiry(req.ctx!, idSchema.parse(req.params.id))));
adminRouter.post('/permission-enquiries/:id/reject', async (req, res) => res.json(await enquiry.rejectEnquiry(req.ctx!, idSchema.parse(req.params.id), enquiryRejectBody.parse(req.body).note)));
adminRouter.get('/roles', async (req, res) => res.json(await svc.listRoles(req.ctx!)));
adminRouter.post('/roles', async (req, res) => res.status(201).json(await svc.createRole(req.ctx!, roleBody.parse(req.body).name)));
adminRouter.put('/roles/:id/permissions', async (req, res) => res.json(await svc.putRolePermissions(req.ctx!, idSchema.parse(req.params.id), permissionsBody.parse(req.body).grants)));

// Business profile & subscription (owner only)
adminRouter.get('/business', async (req, res) => {
  ownerOnly(req);
  res.json(await svc.getBusiness(req.ctx!));
});
adminRouter.patch('/business', async (req, res) => {
  ownerOnly(req);
  res.json(await svc.updateBusiness(req.ctx!, updateBusinessBody.parse(req.body)));
});
adminRouter.get('/subscription', async (req, res) => {
  ownerOnly(req);
  res.json(await svc.subscriptionView(req.ctx!));
});
adminRouter.post('/subscription/payments', async (req, res) => {
  ownerOnly(req);
  await svc.recordSubscriptionPayment(req.ctx!, recordPaymentBody.parse(req.body));
  res.status(201).json({ ok: true });
});
