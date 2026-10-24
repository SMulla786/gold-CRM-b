import argon2 from 'argon2';
import type { BusinessStatus, SubscriptionStatus, UserLevel, UserStatus } from '@prisma/client';
import { db } from './db';

export const TEST_PASSWORD = 'Passw0rd!';
export const TEST_MPIN = '1234';

let seq = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36)}${seq++}`;

export async function createPlan(
  over: Partial<{ maxBranches: number; maxUsers: number; modules: string[] }> = {},
) {
  return db.plan.create({
    data: {
      name: uniq('plan-'),
      durationDays: 365,
      price: '0',
      maxBranches: over.maxBranches ?? 10,
      maxUsers: over.maxUsers ?? 50,
      modules: over.modules ?? [],
    },
  });
}

/** Creates a business + its root branch (isAdminNode, owned by the owner admin). */
export async function createBusiness(over: Partial<{ status: BusinessStatus; name: string }> = {}) {
  const business = await db.business.create({
    data: {
      name: over.name ?? uniq('biz-'),
      ownerName: 'Owner',
      mobile: '9999999999',
      status: over.status ?? 'ACTIVE',
    },
  });
  const root = await createBranch({ businessId: business.id, parentId: null, name: 'HQ', isAdminNode: true });
  return { business, root };
}

/** path = parent.path + "<id>/" (root = "/<id>/"); depth = parent.depth + 1. */
export async function createBranch(args: {
  businessId: number;
  parentId: number | null;
  name: string;
  isAdminNode?: boolean;
}) {
  const parent = args.parentId ? await db.branch.findUniqueOrThrow({ where: { id: args.parentId } }) : null;
  const branch = await db.branch.create({
    data: {
      businessId: args.businessId,
      parentId: args.parentId,
      name: args.name,
      isAdminNode: args.isAdminNode ?? false,
      path: '/',
      depth: parent ? parent.depth + 1 : 0,
    },
  });
  const path = parent ? `${parent.path}${branch.id}/` : `/${branch.id}/`;
  return db.branch.update({ where: { id: branch.id }, data: { path } });
}

export async function createSubscription(args: {
  businessId: number;
  planId: number;
  status?: SubscriptionStatus;
  endsAt?: Date;
  maxBranches?: number;
  maxUsers?: number;
  modules?: string[];
}) {
  const now = new Date();
  return db.subscription.create({
    data: {
      businessId: args.businessId,
      planId: args.planId,
      startsAt: now,
      endsAt: args.endsAt ?? new Date(now.getTime() + 365 * 864e5),
      status: args.status ?? 'ACTIVE',
      maxBranches: args.maxBranches ?? 10,
      maxUsers: args.maxUsers ?? 50,
      modules: args.modules ?? [],
    },
  });
}

export async function createUser(args: {
  businessId?: number | null;
  branchId?: number | null;
  level: UserLevel;
  isOwner?: boolean;
  status?: UserStatus;
  roleId?: number | null;
  password?: string;
  mpin?: string | null;
  viewDaysLimit?: number | null;
}) {
  const password = args.password ?? TEST_PASSWORD;
  const passwordHash = await argon2.hash(password);
  const mpinHash = args.mpin ? await argon2.hash(args.mpin) : null;
  const username = uniq('user-');
  const user = await db.user.create({
    data: {
      level: args.level,
      businessId: args.businessId ?? null,
      branchId: args.branchId ?? null,
      isOwner: args.isOwner ?? false,
      roleId: args.roleId ?? null,
      name: 'Test User',
      username,
      passwordHash,
      mpinHash,
      status: args.status ?? 'ACTIVE',
      viewDaysLimit: args.viewDaysLimit ?? null,
    },
  });
  return { user, username, password, mpin: args.mpin ?? null };
}
