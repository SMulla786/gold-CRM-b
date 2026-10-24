import argon2 from 'argon2';
import type { RequestHandler } from 'express';
import { prisma } from '../lib/prisma';
import { HEADERS, moduleOf } from '../shared';
import type { PermissionAction, UserLevel } from '../shared';
import type { TenantContext } from './context';
import { HttpError } from './error';

/** Restrict a route tree to specific user levels (e.g. SUPER_ADMIN for /platform, ADMIN for /admin). */
export function requireLevel(...levels: UserLevel[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.ctx || !levels.includes(req.ctx.level)) throw new HttpError(403, 'FORBIDDEN', 'Not allowed for your account');
    next();
  };
}

/** Admins/super admins pass everything; branch users are checked against their effective permission map. */
export function hasPermission(ctx: TenantContext, pageKey: string, action: PermissionAction): boolean {
  if (ctx.level === 'SUPER_ADMIN' || ctx.level === 'ADMIN') return true;
  return ctx.permissions[pageKey]?.[action] === true;
}

/** Guard a page+action; also 403 MODULE_DISABLED when the page's module isn't in the plan. Requires loadContext first. */
export function requirePermission(pageKey: string, action: PermissionAction = 'view'): RequestHandler {
  return (req, _res, next) => {
    const ctx = req.ctx!;
    if (ctx.level !== 'SUPER_ADMIN' && !ctx.modules.includes(moduleOf(pageKey))) throw new HttpError(403, 'MODULE_DISABLED', 'Module not enabled in your plan');
    if (!hasPermission(ctx, pageKey, action)) throw new HttpError(403, 'FORBIDDEN', 'You do not have permission for this action');
    next();
  };
}

/** Blocks writes (any non-GET) when the subscription is read-only. Mount on tenant/admin routers, not on /auth or owner subscription routes. */
export const requireWrite: RequestHandler = (req, _res, next) => {
  if (req.method !== 'GET' && req.ctx?.readOnly) throw new HttpError(403, 'READ_ONLY', 'Subscription inactive — read-only mode');
  next();
};

/** Throw PLAN_LIMIT when a create would exceed the plan's snapshot limit. */
export function assertWithinLimit(used: number, max: number | null | undefined, what: string): void {
  if (max != null && used >= max) throw new HttpError(403, 'PLAN_LIMIT', `Plan limit reached (${what})`);
}

/** Verifies the given MPIN against the user's stored MPIN; throws 403 MPIN_REQUIRED if missing/invalid. */
export async function assertMpin(userId: number, mpin: string | undefined): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { mpinHash: true } });
  if (!mpin || !user?.mpinHash || !(await argon2.verify(user.mpinHash, mpin).catch(() => false))) {
    throw new HttpError(403, 'MPIN_REQUIRED', 'Valid MPIN required');
  }
}

/** Requires a valid X-MPIN header. For sensitive actions (deletes, settings, set stock). */
export const requireMpin: RequestHandler = async (req, _res, next) => {
  await assertMpin(req.ctx!.userId, req.header(HEADERS.MPIN));
  next();
};
