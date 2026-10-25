import { Router } from 'express';
import { requireMpin, requirePermission } from '../../../middleware/guards';
import {
  id as idSchema, schemeBody, schemeListQuery, schemePatchBody, schemeGroupBody, schemeGroupListQuery,
  enrollmentBody, enrollmentListQuery, enrollmentWonBody, redeemBody, addSchemePaymentBody, schemeTxnListQuery, schemeDayBookQuery,
} from '../../../shared';
import * as schemes from './service';

export const schemesRouter = Router();
const ALL = 'schemes.all';
const GROUPS = 'schemes.groups';
const ENROLL = 'schemes.enroll';
const ADD = 'schemes.add_money';
const DUES = 'schemes.due_list';
const TXN = 'schemes.transactions';
const DAYBOOK = 'schemes.daybook';

// specific paths before '/schemes/:id'
schemesRouter.post('/schemes/groups', requirePermission(GROUPS, 'edit'), async (req, res) => res.status(201).json(await schemes.createGroup(req.ctx!, schemeGroupBody.parse(req.body))));
schemesRouter.get('/schemes/groups', requirePermission(GROUPS, 'view'), async (req, res) => res.json(await schemes.listGroups(req.ctx!, schemeGroupListQuery.parse(req.query))));

schemesRouter.post('/schemes/enrollments', requirePermission(ENROLL, 'edit'), async (req, res) => res.status(201).json(await schemes.enroll(req.ctx!, enrollmentBody.parse(req.body))));
schemesRouter.get('/schemes/enrollments', requirePermission(ALL, 'view'), async (req, res) => res.json(await schemes.listEnrollments(req.ctx!, enrollmentListQuery.parse(req.query))));
schemesRouter.get('/schemes/enrollments/:id', requirePermission(ALL, 'view'), async (req, res) => res.json(await schemes.getEnrollment(req.ctx!, idSchema.parse(req.params.id))));
schemesRouter.post('/schemes/enrollments/:id/won', requirePermission(ALL, 'edit'), requireMpin, async (req, res) => res.json(await schemes.markWon(req.ctx!, idSchema.parse(req.params.id))));
schemesRouter.post('/schemes/enrollments/:id/redeem', requirePermission(ALL, 'edit'), requireMpin, async (req, res) => res.json(await schemes.redeem(req.ctx!, idSchema.parse(req.params.id), redeemBody.parse(req.body))));

schemesRouter.post('/schemes/payments', requirePermission(ADD, 'edit'), async (req, res) => res.status(201).json(await schemes.addPayment(req.ctx!, addSchemePaymentBody.parse(req.body))));
schemesRouter.post('/schemes/payments/:id/reverse', requirePermission(ADD, 'delete'), requireMpin, async (req, res) => res.json(await schemes.reversePayment(req.ctx!, idSchema.parse(req.params.id))));

schemesRouter.get('/schemes/dues', requirePermission(DUES, 'view'), async (req, res) => res.json(await schemes.dues(req.ctx!, req.query)));
schemesRouter.get('/schemes/transactions', requirePermission(TXN, 'view'), async (req, res) => res.json(await schemes.transactions(req.ctx!, schemeTxnListQuery.parse(req.query))));
schemesRouter.get('/schemes/day-book', requirePermission(DAYBOOK, 'view'), async (req, res) => res.json(await schemes.dayBook(req.ctx!, schemeDayBookQuery.parse(req.query))));

schemesRouter.post('/schemes', requirePermission(ALL, 'edit'), async (req, res) => res.status(201).json(await schemes.createScheme(req.ctx!, schemeBody.parse(req.body))));
schemesRouter.get('/schemes', requirePermission(ALL, 'view'), async (req, res) => res.json(await schemes.listSchemes(req.ctx!, schemeListQuery.parse(req.query))));
schemesRouter.get('/schemes/:id', requirePermission(ALL, 'view'), async (req, res) => res.json(await schemes.getScheme(req.ctx!, idSchema.parse(req.params.id))));
schemesRouter.patch('/schemes/:id', requirePermission(ALL, 'edit'), async (req, res) => res.json(await schemes.patchScheme(req.ctx!, idSchema.parse(req.params.id), schemePatchBody.parse(req.body))));
