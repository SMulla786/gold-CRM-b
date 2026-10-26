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

/** TASK-95: Super Admin decides a business-submitted payment (only while PENDING). */
export const reviewPaymentBody = z.object({ status: z.enum(['CONFIRMED', 'REJECTED']) });

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

// ───── Response DTOs (dates are ISO strings, money/decimals are strings) ─────

export interface SignupRequestDto {
  id: number;
  shopName: string;
  ownerName: string;
  countryCode: string;
  whatsapp: string;
  email: string | null;
  address: string;
  state: { id: number; name: string };
  district: { id: number; name: string } | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  businessId: number | null;
  rejectReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface PlanDto {
  id: number;
  name: string;
  description: string | null;
  durationDays: number;
  price: string;
  maxBranches: number;
  maxUsers: number;
  modules: string[];
  isActive: boolean;
  activeSubscriptions: number;
}

export interface SubscriptionDto {
  id: number;
  planId: number;
  planName: string;
  startsAt: string;
  endsAt: string;
  status: 'ACTIVE' | 'CANCELLED';
  maxBranches: number;
  maxUsers: number;
  modules: string[];
  notes: string | null;
  createdAt: string;
}

export interface PaymentDto {
  id: number;
  businessId: number;
  businessName: string;
  subscriptionId: number | null;
  amount: string;
  method: 'UPI' | 'CASH' | 'BANK' | 'GATEWAY';
  utr: string | null;
  status: 'PENDING' | 'CONFIRMED' | 'REJECTED';
  paidAt: string | null;
  createdAt: string;
  /** TASK-95: a payment screenshot was uploaded (GET /platform/payments/:id/proof) */
  hasProof: boolean;
}

/** Row in /platform/businesses. subscriptionState: active | expiring (≤15 days) | expired | none */
export interface BusinessListItemDto {
  id: number;
  name: string;
  ownerName: string;
  mobile: string;
  status: 'ACTIVE' | 'SUSPENDED';
  subscriptionState: 'active' | 'expiring' | 'expired' | 'none';
  planName: string | null;
  endsAt: string | null;
  branchCount: number;
  userCount: number;
  createdAt: string;
}

export interface BusinessDetailDto extends BusinessListItemDto {
  email: string | null;
  gstin: string | null;
  address: string | null;
  state: { id: number; name: string } | null;
  district: { id: number; name: string } | null;
  owner: { id: number; name: string; username: string; mobile: string | null; email: string | null; lastLoginAt: string | null } | null;
  subscriptions: SubscriptionDto[];
  payments: PaymentDto[];
}

export interface GeoDto {
  id: number;
  name: string;
}
