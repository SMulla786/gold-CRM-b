import { z } from 'zod';
import { PAGE_KEYS } from '../permissions';
import { gstin, id, mobile, mpin, pageQuery, password, username } from './common';

export const branchBody = z.object({
  /** Must be inside caller's subtree; required (root is created with the business). */
  parentId: id,
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().max(20).optional(),
  isAdminNode: z.boolean().default(false),
  inchargeName: z.string().trim().max(120).optional(),
  countryCode: z.string().default('+91'),
  mobile: mobile.optional(),
  gstin: gstin.optional(),
  stateId: id.optional(),
  districtId: id.optional(),
  address: z.string().max(500).optional(),
  disclaimer: z.string().max(1000).optional(),
});
export const updateBranchBody = branchBody.omit({ parentId: true }).partial().extend({ isActive: z.boolean().optional() });
/** Moves the branch (and its subtree) under a new parent inside caller's subtree; cannot move under own descendant. */
export const moveBranchBody = z.object({ newParentId: id });

export const counterBody = z.object({ branchId: id, name: z.string().trim().min(1).max(60) });

const permissionGrant = z.object({
  key: z.enum(PAGE_KEYS as [string, ...string[]]),
  view: z.boolean(),
  edit: z.boolean().default(false),
  delete: z.boolean().default(false),
});
export const permissionsBody = z.object({ grants: z.array(permissionGrant) });

export const createUserBody = z.object({
  name: z.string().trim().min(2).max(120),
  username,
  password,
  mpin: mpin.optional(),
  email: z.string().email().optional(),
  mobile: mobile.optional(),
  /** ADMIN only allowed when branchId is an admin node inside caller's subtree. */
  level: z.enum(['ADMIN', 'BRANCH_USER']),
  branchId: id,
  roleId: id.optional(),
  extraBranchIds: z.array(id).default([]),
  /** null/undefined = unlimited history */
  viewDaysLimit: z.number().int().min(1).nullable().optional(),
});
export const updateUserBody = createUserBody.omit({ username: true, password: true, mpin: true }).partial();
export const resetUserPasswordBody = z.object({ password });

export const roleBody = z.object({ name: z.string().trim().min(2).max(60) });

export const userListQuery = pageQuery.extend({
  branchId: id.optional(),
  status: z.enum(['ACTIVE', 'BLOCKED', 'DELETED']).optional(),
});

export interface BranchNodeDto {
  id: number;
  parentId: number | null;
  name: string;
  code: string | null;
  path: string;
  depth: number;
  isAdminNode: boolean;
  isActive: boolean;
  userCount: number;
  children: BranchNodeDto[];
}

export interface UserDto {
  id: number;
  name: string;
  username: string;
  email: string | null;
  mobile: string | null;
  level: 'ADMIN' | 'BRANCH_USER';
  isOwner: boolean;
  status: 'ACTIVE' | 'BLOCKED' | 'DELETED';
  branch: { id: number; name: string };
  role: { id: number; name: string } | null;
  extraBranchIds: number[];
  viewDaysLimit: number | null;
  lastLoginAt: string | null;
}

export interface SubscriptionViewDto {
  planName: string;
  startsAt: string;
  endsAt: string;
  readOnly: boolean;
  maxBranches: number;
  maxUsers: number;
  usedBranches: number;
  usedUsers: number;
  modules: string[];
}
