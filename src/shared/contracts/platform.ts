import { z } from 'zod';
import { MODULE_KEYS } from '../permissions';
import { gstin, id, mobile, pageQuery, password, username } from './common';

/** Public business sign-up ("Create Account"). */
export const signupBody = z.object({
  shopName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(120),
  countryCode: z.string().default('+91'),
  whatsapp: mobile,
  email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  address: z.string().trim().min(3).max(500),
  stateId: id,
  districtId: id.optional(),
});

const moduleKey = z.enum(MODULE_KEYS as [string, ...string[]]);

export const planBody = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().max(500).optional(),
  durationDays: z.number().int().min(1),
  price: z.number().min(0),
  maxBranches: z.number().int().min(1),
  maxUsers: z.number().int().min(1),
  modules: z.array(moduleKey).min(1),
  isActive: z.boolean().default(true),
});

const ownerBody = z.object({
  name: z.string().trim().min(2),
  username,
  password,
  mobile: mobile.optional(),
  email: z.string().email().optional(),
});

export const createBusinessBody = z.object({
  name: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(120),
  mobile,
  email: z.string().email().optional(),
  gstin: gstin.optional(),
  address: z.string().max(500).optional(),
  stateId: id.optional(),
  districtId: id.optional(),
  /** Name of the root (main) branch; defaults to business name. */
  rootBranchName: z.string().trim().min(2).optional(),
  owner: ownerBody,
  planId: id,
});

/** Approving a sign-up request creates the business from the request data + these. */
export const approveSignupBody = z.object({ planId: id, owner: ownerBody });
export const rejectSignupBody = z.object({ reason: z.string().trim().min(3).max(500) });

export const updateBusinessBody = createBusinessBody.omit({ owner: true, planId: true, rootBranchName: true }).partial();

export const assignSubscriptionBody = z.object({
  planId: id,
  startsAt: z.coerce.date().optional(),
  /** Override plan snapshot values for this business. */
  durationDays: z.number().int().min(1).optional(),
  maxBranches: z.number().int().min(1).optional(),
  maxUsers: z.number().int().min(1).optional(),
  modules: z.array(moduleKey).optional(),
  notes: z.string().max(500).optional(),
});
export const updateSubscriptionBody = z.object({
  endsAt: z.coerce.date().optional(),
  status: z.enum(['ACTIVE', 'CANCELLED']).optional(),
  maxBranches: z.number().int().min(1).optional(),
  maxUsers: z.number().int().min(1).optional(),
  modules: z.array(moduleKey).optional(),
  notes: z.string().max(500).optional(),
});

export const recordPaymentBody = z.object({
  amount: z.number().positive(),
  method: z.enum(['UPI', 'CASH', 'BANK', 'GATEWAY']),
  utr: z.string().trim().max(40).optional(),
  paidAt: z.coerce.date().optional(),
  subscriptionId: id.optional(),
  status: z.enum(['PENDING', 'CONFIRMED', 'REJECTED']).default('CONFIRMED'),
});

export const impersonateBody = z.object({ reason: z.string().trim().min(3).max(300) });

export const businessListQuery = pageQuery.extend({
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  /** active | expiring (≤15 days) | expired */
  subscription: z.enum(['active', 'expiring', 'expired']).optional(),
});
export const signupListQuery = pageQuery.extend({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() });

export interface PlatformDashboardDto {
  businesses: { total: number; active: number; suspended: number; expired: number; expiringIn15Days: number };
  pendingSignups: number;
  revenue: { thisMonth: number; thisYear: number };
  branches: number;
  users: number;
}
